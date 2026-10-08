/**
 * DEPENDENCIES
 * Consumed by: /api/nightly
 * Consumes: health-check.ts, stop-manager.ts, telegram.ts, market-data.ts, equity-snapshot.ts, snapshot-sync.ts, laggard-detector.ts, breakout-failure-detector.ts, alert-service.ts, modules/*, risk-gates.ts, position-sizer.ts, prisma.ts, @/types
 * Risk-sensitive: YES
 * Last modified: 2026-03-01
 * Notes: API nightly should continue on partial failures.
 */
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { runHealthCheck } from '@/lib/health-check';
import { generateStopRecommendations, generateTrailingStopRecommendations, updateStopLoss } from '@/lib/stop-manager';
import { sendNightlySummary } from '@/lib/telegram';
import type { NightlyPositionDetail, NightlyStopChange, NightlyReadyCandidate, NightlyTriggerMetCandidate, NightlyLaggardAlert, NightlyClimaxAlert, NightlySwapAlert, NightlyWhipsawAlert, NightlyBreadthAlert, NightlyMomentumAlert, NightlyPyramidAlert, NightlyBreakoutFailureAlert } from '@/lib/telegram';
import { detectBreakoutFailures } from '@/lib/breakout-failure-detector';
import type { BreakoutFailureResult } from '@/lib/breakout-failure-detector';
import { sendAlert } from '@/lib/alert-service';
import { normalizeBatchPricesToGBP, getDailyPrices, calculateADX, calculateATR, preCacheHistoricalData } from '@/lib/market-data';
import { fetchWithFallback, toPriceRecord } from '@/lib/data-provider';
import type { DataSourceHealth } from '@/lib/data-provider';
import { recordEquitySnapshot } from '@/lib/equity-snapshot';
import { syncSnapshot } from '@/lib/snapshot-sync';
import { detectLaggards } from '@/lib/laggard-detector';
import { scanClimaxSignals } from '@/lib/modules/climax-detector';
import { findSwapSuggestions } from '@/lib/modules/heatmap-swap';
import { checkWhipsawBlocks } from '@/lib/modules/whipsaw-guard';
import { calculateBreadth, checkBreadthSafety } from '@/lib/modules/breadth-safety';
// Module 13 disabled — import preserved for reference
import { getRiskBudget } from '@/lib/risk-gates';
import { canPyramid, calculatePyramidAddSize } from '@/lib/risk-gates';
import { calculateRMultiple } from '@/lib/position-sizer';
import { RISK_PROFILES, type RiskProfileType, type Sleeve } from '@/types';
import { z } from 'zod';
import { apiError, verifyCronSecret } from '@/lib/api-response';

const nightlyBodySchema = z.object({
  userId: z.string().trim().min(1).optional(),
});

export async function POST(request: NextRequest) {
  const cronAuthError = verifyCronSecret(request);
  if (cronAuthError) return cronAuthError;

  try {
    let hadFailure = false;
    // Track data source health across the pipeline
    let dataSourceHealth: DataSourceHealth = 'LIVE';
    let dataSourceStaleTickers: string[] = [];
    let dataSourceMaxStalenessHours = 0;
    let dataSourceSummary = '';
    let userId = 'default-user';
    const contentLength = Number(request.headers.get('content-length') ?? '0');
    const hasBody = Number.isFinite(contentLength) && contentLength > 0;

    if (hasBody) {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return apiError(400, 'INVALID_JSON', 'Request body must be valid JSON');
      }

      const parsed = nightlyBodySchema.safeParse(raw);
      if (!parsed.success) {
        return apiError(
          400,
          'INVALID_REQUEST',
          'Invalid nightly payload',
          parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
        );
      }
      if (parsed.data.userId) userId = parsed.data.userId;
    }

    // Step 0: Pre-cache historical data (warm the cache for downstream ATR/ADX calls)
    try {
      const preCacheResult = await preCacheHistoricalData();
      console.log(`[Nightly] Pre-cached ${preCacheResult.success}/${preCacheResult.total} tickers (${preCacheResult.failed.length} failed)`);
    } catch (error) {
      console.warn('[Nightly] Pre-cache failed (non-fatal):', (error as Error).message);
    }

    // Step 1: Run health check
    let healthReport: { overall: string; checks: Record<string, string>; results: unknown[]; timestamp: Date } = {
      overall: 'YELLOW', checks: {}, results: [], timestamp: new Date(),
    };
    try {
      healthReport = await runHealthCheck(userId);
    } catch (error) {
      hadFailure = true;
      console.warn('[Nightly] Health check failed:', (error as Error).message);
    }

    // Step 2: Get open positions
    let positions: Awaited<ReturnType<typeof prisma.position.findMany<{ include: { stock: true } }>>> = [];
    try {
      positions = await prisma.position.findMany({
        where: { userId, status: 'OPEN' },
        include: { stock: true },
      });
    } catch (error) {
      hadFailure = true;
      console.warn('[Nightly] Position fetch failed:', (error as Error).message);
    }

    // Step 2b: Fetch live prices for all open positions
    const openTickers = positions.map((p) => p.stock.ticker);
    let livePrices: Record<string, number> = {};
    try {
      if (openTickers.length > 0) {
        // Use resilient fallback chain: Yahoo → AV → EODHD → DB cache
        const fetchResult = await fetchWithFallback(openTickers, 'nightly');
        livePrices = toPriceRecord(fetchResult);
        dataSourceHealth = fetchResult.health;
        dataSourceStaleTickers = fetchResult.staleTickers;
        dataSourceMaxStalenessHours = fetchResult.maxStalenessHours;
        dataSourceSummary = fetchResult.summary;
      }
    } catch (error) {
      hadFailure = true;
      console.warn('[Nightly] Live price fetch failed:', (error as Error).message);
    }
    const stockCurrencies: Record<string, string | null> = {};
    for (const p of positions) {
      stockCurrencies[p.stock.ticker] = p.stock.currency;
    }
    let gbpPrices: Record<string, number> = {};
    try {
      gbpPrices = openTickers.length > 0
        ? await normalizeBatchPricesToGBP(livePrices, stockCurrencies)
        : {};
    } catch (error) {
      hadFailure = true;
      // Fall back to raw prices so downstream steps can still run
      gbpPrices = { ...livePrices };
      console.warn('[Nightly] FX normalisation failed, using raw prices as fallback:', (error as Error).message);
    }

    // Step 3: Generate R-based stop recommendations
    // Pre-fetch ATRs for open positions so LOCK_1R_TRAIL trailing stops
    // use the same ATR-adjusted formula as the bat-file nightly path.
    const livePriceMap = new Map(Object.entries(livePrices));
    const atrMap = new Map<string, number>();
    const PRICE_BATCH = 10;
    try {
      for (let i = 0; i < openTickers.length; i += PRICE_BATCH) {
        const batch = openTickers.slice(i, i + PRICE_BATCH);
        await Promise.allSettled(
          batch.map(async (ticker) => {
            const bars = await getDailyPrices(ticker, 'full');
            if (bars.length >= 15) {
              atrMap.set(ticker, calculateATR(bars, 14));
            }
          })
        );
        if (i + PRICE_BATCH < openTickers.length) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
    } catch (error) {
      hadFailure = true;
      console.warn('[Nightly] ATR prefetch failed:', (error as Error).message);
    }
    let stopRecs: Awaited<ReturnType<typeof generateStopRecommendations>> = [];
    try {
      stopRecs = await generateStopRecommendations(userId, livePriceMap, atrMap);
    } catch (error) {
      hadFailure = true;
      console.warn('[Nightly] Stop recommendations failed:', (error as Error).message);
    }

    // Apply R-based stop changes and collect for Telegram
    // BUG FIX: Previously only mapped recs to display — never called updateStopLoss().
    // This meant BREAKEVEN / LOCK_08R / LOCK_1R_TRAIL stops were silently skipped
    // when running via API route instead of the .bat file.
    const stopChanges: NightlyStopChange[] = [];
    for (const rec of stopRecs) {
      const pos = positions.find((p) => p.id === rec.positionId);
      const isUK = rec.ticker.endsWith('.L') || /^[A-Z]{2,5}l$/.test(rec.ticker);
      const cur = isUK ? 'GBX' : (pos?.stock.currency || 'USD').toUpperCase();
      try {
        await updateStopLoss(rec.positionId, rec.newStop, rec.reason, rec.newLevel);
        stopChanges.push({
          ticker: rec.ticker,
          oldStop: rec.currentStop,
          newStop: rec.newStop,
          level: rec.newLevel,
          reason: rec.reason,
          currency: cur,
        });
      } catch {
        // Monotonic violation or other error — skip silently (stop cannot decrease)
      }
    }

    // Step 3b: Generate trailing ATR stop recommendations and auto-apply
    const trailingStopChanges: NightlyStopChange[] = [];
    try {
      const trailingRecs = await generateTrailingStopRecommendations(userId);
      for (const rec of trailingRecs) {
        try {
          await updateStopLoss(rec.positionId, rec.trailingStop, rec.reason);
          trailingStopChanges.push({
            ticker: rec.ticker,
            oldStop: rec.currentStop,
            newStop: rec.trailingStop,
            level: 'TRAILING_ATR',
            reason: rec.reason,
            currency: rec.priceCurrency,
          });
        } catch {
          // Stop might violate monotonic rule — skip silently
        }
      }
    } catch (error) {
      hadFailure = true;
      console.warn('[Nightly] Trailing stop calculation failed:', (error as Error).message);
    }

    // Step 3c: Breakout failure detection — price closed below entry trigger within 5 days
    let breakoutFailureAlerts: NightlyBreakoutFailureAlert[] = [];
    try {
      const bfInput = positions.map((p) => {
        const currentPrice = livePrices[p.stock.ticker];
        const isUK = p.stock.ticker.endsWith('.L') || /^[A-Z]{2,5}l$/.test(p.stock.ticker);
        const currency = isUK ? 'GBX' : (p.stock.currency || 'USD').toUpperCase();
        return {
          id: p.id,
          ticker: p.stock.ticker,
          entryPrice: p.entryPrice,
          entryDate: p.entryDate,
          entryTrigger: p.entryTrigger,
          initialRisk: p.initialRisk,
          // No live price → 0, which the detector skips (never flag on the entry price).
          currentPrice: currentPrice || 0,
          shares: p.shares,
          currency,
          alreadyFlagged: !!p.breakoutFailureDetectedAt,
        };
      });
      const failures = detectBreakoutFailures(bfInput);

      // Persist the detection timestamp on newly-flagged positions
      for (const f of failures) {
        try {
          await prisma.position.update({
            where: { id: f.positionId },
            data: { breakoutFailureDetectedAt: new Date() },
          });
        } catch {
          // Non-critical — flag best-effort
        }
      }

      breakoutFailureAlerts = failures.map((f) => {
        return {
          ticker: f.ticker,
          daysHeld: f.daysHeld,
          rMultiple: f.rMultiple,
          entryTrigger: f.entryTrigger,
          currentPrice: f.currentPrice,
          estimatedLoss: f.estimatedLoss,
          currency: f.currency,
          reason: f.reason,
        };
      });

      // Send in-app + Telegram alerts for each breakout failure
      for (const bf of breakoutFailureAlerts) {
        const currSymbol = bf.currency === 'GBP' || bf.currency === 'GBX' ? '£' : bf.currency === 'EUR' ? '€' : '$';
        await sendAlert({
          type: 'BREAKOUT_FAILURE',
          title: `⚠ Breakout failure — ${bf.ticker}`,
          message: `${bf.ticker} has closed back below its entry trigger after ${bf.daysHeld} day${bf.daysHeld !== 1 ? 's' : ''}. Consider exiting.\n\nEntry trigger: ${currSymbol}${bf.entryTrigger.toFixed(2)}\nCurrent price: ${currSymbol}${bf.currentPrice.toFixed(2)}\nExpected loss: -${currSymbol}${Math.abs(bf.estimatedLoss).toFixed(2)}\n\nRecommendation: Exit this position in Trading 212. This breakout has failed.`,
          data: { ticker: bf.ticker, daysHeld: bf.daysHeld, rMultiple: bf.rMultiple, entryTrigger: bf.entryTrigger, currentPrice: bf.currentPrice, estimatedLoss: bf.estimatedLoss },
          priority: 'WARNING',
        });
      }
      if (breakoutFailureAlerts.length > 0) {
        console.log(`[Nightly] ${breakoutFailureAlerts.length} breakout failure(s) detected`);
      }
    } catch (error) {
      console.warn('[Nightly] Breakout failure detection failed:', (error as Error).message);
    }

    // Step 4: Get user for equity and risk profile
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const equity = user?.equity || 0;

    // Step 4a: Collect alerts
    const alerts: string[] = [];
    if (healthReport.overall === 'RED') alerts.push('Health check is RED — review issues before trading');
    if (healthReport.overall === 'YELLOW') alerts.push('Health check has warnings');
    if (stopRecs.length > 0) alerts.push(`${stopRecs.length} R-based stop-loss updates recommended`);
    if (trailingStopChanges.length > 0) alerts.push(`${trailingStopChanges.length} trailing ATR stops auto-applied`);
    if (breakoutFailureAlerts.length > 0) alerts.push(`⚠️ ${breakoutFailureAlerts.length} breakout failure(s) — consider exiting`);

    // Step 4b: Detect laggard / dead-money positions
    let laggardAlerts: NightlyLaggardAlert[] = [];
    try {
      const laggardInput = positions.map((p) => {
        const currentPrice = livePrices[p.stock.ticker] || p.entryPrice;
        const isUK = p.stock.ticker.endsWith('.L') || /^[A-Z]{2,5}l$/.test(p.stock.ticker);
        const currency = isUK ? 'GBX' : (p.stock.currency || 'USD').toUpperCase();
        return {
          id: p.id,
          ticker: p.stock.ticker,
          entryPrice: p.entryPrice,
          entryDate: p.entryDate,
          currentStop: p.currentStop,
          shares: p.shares,
          initialRisk: p.initialRisk,
          currentPrice,
          currency,
          sleeve: p.stock.sleeve,
        };
      });
      const laggards = detectLaggards(laggardInput);
      laggardAlerts = laggards.map((l) => ({
        ticker: l.ticker,
        daysHeld: l.daysHeld,
        rMultiple: l.rMultiple,
        lossPct: l.lossPct,
        flag: l.flag,
        reason: l.reason,
        currency: l.currency,
      }));
      if (laggardAlerts.length > 0) {
        const trimCount = laggardAlerts.filter((l) => l.flag === 'TRIM_LAGGARD').length;
        const deadCount = laggardAlerts.filter((l) => l.flag === 'DEAD_MONEY').length;
        const parts: string[] = [];
        if (trimCount > 0) parts.push(`${trimCount} laggard(s)`);
        if (deadCount > 0) parts.push(`${deadCount} dead-money`);
        alerts.push(`${parts.join(' + ')} flagged for review`);
      }
    } catch (error) {
      hadFailure = true;
      console.warn('[Nightly] Laggard detection failed:', (error as Error).message);
    }

    // Step 4c: Run 5 risk-signal modules
    let climaxAlerts: NightlyClimaxAlert[] = [];
    let swapAlerts: NightlySwapAlert[] = [];
    let whipsawAlerts: NightlyWhipsawAlert[] = [];
    let breadthAlert: NightlyBreadthAlert | undefined;
    let momentumAlert: NightlyMomentumAlert | undefined;

    try {
      // Module 5: Climax Top Exit
      const climaxSignals = await scanClimaxSignals(
        positions.map((p) => ({ id: p.id, ticker: p.stock.ticker }))
      );
      climaxAlerts = climaxSignals.map((c) => ({
        ticker: c.ticker,
        priceAboveMa20Pct: c.priceAboveMa20Pct,
        volumeRatio: c.volumeRatio,
        action: c.action,
        reason: c.reason,
      }));
      if (climaxAlerts.length > 0) {
        alerts.push(`🔥 ${climaxAlerts.length} climax top signal(s) — consider trimming`);
      }
    } catch (error) {
      console.warn('[Nightly] Climax detection failed:', (error as Error).message);
    }

    // Shared data for risk-signal modules
    const riskProfile = (user?.riskProfile || 'BALANCED') as RiskProfileType;
    const enrichedForSwap = positions.map((p) => {
      const rawPrice = livePrices[p.stock.ticker] || p.entryPrice;
      const gbpPrice = gbpPrices[p.stock.ticker] ?? rawPrice;
      const rMultiple = calculateRMultiple(rawPrice, p.entryPrice, p.initialRisk);
      return {
        id: p.id,
        ticker: p.stock.ticker,
        cluster: p.stock.cluster || 'General',
        sleeve: p.stock.sleeve as Sleeve,
        value: gbpPrice * p.shares,
        rMultiple,
      };
    });
    const totalPortfolioValue = enrichedForSwap.reduce((s, p) => s + p.value, 0);

    // Module 7: Heat-Map Swap — isolated try-catch so failure doesn't kill downstream modules
    try {
      const latestScan = await prisma.scan.findFirst({
        where: { userId },
        orderBy: { runDate: 'desc' },
        include: { results: { include: { stock: true } } },
      });
      const scanCandidates = (latestScan?.results || [])
        .filter((r) => r.status === 'READY')
        .map((r) => ({
          ticker: r.stock.ticker,
          cluster: r.stock.cluster || 'General',
          rankScore: r.rankScore,
          status: r.status,
        }));

      const swaps = findSwapSuggestions(enrichedForSwap, scanCandidates, totalPortfolioValue, riskProfile);
      swapAlerts = swaps.map((s) => ({
        cluster: s.cluster,
        weakTicker: s.weakTicker,
        weakRMultiple: s.weakRMultiple,
        strongTicker: s.strongTicker,
        reason: s.reason,
      }));
      if (swapAlerts.length > 0) {
        alerts.push(`🔄 ${swapAlerts.length} swap suggestion(s) — stronger candidates available`);
      }
    } catch (error) {
      hadFailure = true;
      console.warn('[Nightly] Swap module failed:', (error as Error).message);
    }

    // Module 11: Whipsaw Kill Switch — isolated try-catch
    try {
      const closedPositions = await prisma.position.findMany({
        where: { userId, status: 'CLOSED' },
        include: { stock: true },
        orderBy: { exitDate: 'desc' },
        take: 50,
      });
      const blocks = checkWhipsawBlocks(
        closedPositions.map((p) => ({
          ticker: p.stock.ticker,
          exitDate: p.exitDate || new Date(),
          exitReason: p.exitReason,
          whipsawCount: p.whipsawCount ?? 0,
        }))
      );
      whipsawAlerts = blocks.map((w) => ({
        ticker: w.ticker,
        stopsInLast30Days: w.stopsInLast30Days,
        reason: w.reason,
      }));
      if (whipsawAlerts.length > 0) {
        alerts.push(`🚫 ${whipsawAlerts.length} ticker(s) blocked by whipsaw kill switch`);
      }
    } catch (error) {
      hadFailure = true;
      console.warn('[Nightly] Whipsaw module failed:', (error as Error).message);
    }

    // Module 10: Breadth Safety Valve — isolated try-catch
    try {
      const stocks = await prisma.stock.findMany({ where: { active: true }, select: { ticker: true } });
      const universeTickers = stocks.map((s) => s.ticker);
      // Sample up to 30 tickers for breadth — avoids 266 sequential Yahoo calls (matches cron version)
      const sampleSize = Math.min(30, universeTickers.length);
      const shuffled = [...universeTickers].sort(() => Math.random() - 0.5);
      const breadthSample = shuffled.slice(0, sampleSize);
      const breadthPct = breadthSample.length > 0 ? await calculateBreadth(breadthSample) : 100;

      const { maxPositions } = getRiskBudget(
        enrichedForSwap.map((p) => ({
          id: p.id,
          ticker: p.ticker,
          sleeve: p.sleeve,
          sector: 'Unknown',
          cluster: p.cluster,
          value: p.value,
          riskDollars: 0,
          shares: 0,
          entryPrice: 0,
          currentStop: 0,
          currentPrice: 0,
        })),
        equity,
        riskProfile
      );
      const breadthResult = checkBreadthSafety(breadthPct, maxPositions);
      breadthAlert = {
        breadthPct: breadthResult.breadthPct,
        isRestricted: breadthResult.isRestricted,
        maxPositionsOverride: breadthResult.maxPositionsOverride,
        reason: breadthResult.reason,
      };
      if (breadthResult.isRestricted) {
        alerts.push(`🔻 Breadth ${breadthPct.toFixed(0)}% < 40% — max positions reduced to ${breadthResult.maxPositionsOverride}`);
      }
    } catch (error) {
      hadFailure = true;
      console.warn('[Nightly] Breadth module failed:', (error as Error).message);
    }

    // Module 13: Momentum Expansion — DISABLED: procyclical risk expansion, adds risk near end of moves not middle
    // Code preserved but skipped permanently.
    console.log('[Nightly] Module 13 (Momentum Expansion) — DISABLED, skipping');

    // Step 5: Record equity snapshot with open risk percent
    let openRiskPercent = 0;
    try {
      const openRisk = positions
        .filter((p) => p.stock.sleeve !== 'HEDGE')
        .reduce((sum, p) => {
          const rawPrice = livePrices[p.stock.ticker] || p.entryPrice;
          const gbpPrice = gbpPrices[p.stock.ticker] ?? rawPrice;
          const fxRatio = rawPrice > 0 ? gbpPrice / rawPrice : 1;
          const currentStopGbp = p.currentStop * fxRatio;
          const risk = Math.max(0, (gbpPrice - currentStopGbp) * p.shares);
          return sum + risk;
        }, 0);

      openRiskPercent = equity > 0 ? (openRisk / equity) * 100 : 0;
      // NIGHTLY-sourced (see lib/equity-snapshot.ts EquitySnapshotSource).
      await recordEquitySnapshot(userId, equity, openRiskPercent, 'NIGHTLY');
    } catch {
      hadFailure = true;
      await recordEquitySnapshot(userId, equity, undefined, 'NIGHTLY');
    }

    // Step 5b: Check pyramid add opportunities for open positions
    let pyramidAlerts: NightlyPyramidAlert[] = [];
    try {
      // Count existing pyramid adds per position from TradeLog
      const addCounts = await prisma.tradeLog.groupBy({
        by: ['positionId'],
        where: { userId, tradeType: 'ADD', positionId: { not: null } },
        _count: { id: true },
      });
      const addsMap = new Map<string, number>();
      for (const row of addCounts) {
        if (row.positionId) addsMap.set(row.positionId, row._count.id);
      }

      // Open risk ratio for pyramid gating (0–1 scale)
      const maxOpenRiskPct = RISK_PROFILES[riskProfile].maxOpenRisk;
      const openRiskRatio = maxOpenRiskPct > 0 ? openRiskPercent / maxOpenRiskPct : 1;

      for (const p of positions) {
        if (p.stock.sleeve === 'HEDGE') continue; // Skip hedge positions
        const currentPrice = livePrices[p.stock.ticker] || p.entryPrice;
        if (currentPrice <= p.entryPrice) continue; // Only check winning positions

        // Fetch ATR for this ticker
        let atr: number | null = null;
        try {
          const bars = await getDailyPrices(p.stock.ticker, 'compact');
          if (bars.length >= 15) {
            atr = calculateATR(bars, 14);
          }
        } catch { /* ATR unavailable — canPyramid will use R-multiple fallback */ }

        const pyramidCheck = canPyramid(
          currentPrice,
          p.entryPrice,
          p.initialRisk,
          atr ?? undefined,
          addsMap.get(p.id) ?? 0,
          openRiskRatio
        );

        if (pyramidCheck.allowed) {
          const isUK = p.stock.ticker.endsWith('.L') || /^[A-Z]{2,5}l$/.test(p.stock.ticker);
          const currency = isUK ? 'GBX' : (p.stock.currency || 'USD').toUpperCase();

          // Compute scaled add sizing
          const rawPrice = livePrices[p.stock.ticker] || p.entryPrice;
          const gbpPrice = gbpPrices[p.stock.ticker] ?? rawPrice;
          const fxRatio = rawPrice > 0 ? gbpPrice / rawPrice : 1;
          const addSizing = calculatePyramidAddSize({
            equity,
            riskProfile,
            addNumber: pyramidCheck.addNumber,
            currentPrice,
            currentStop: p.currentStop,
            sleeve: p.stock.sleeve as Sleeve,
            fxToGbp: fxRatio,
            allowFractional: true, // Trading 212
          });

          pyramidAlerts.push({
            ticker: p.stock.ticker,
            entryPrice: p.entryPrice,
            currentPrice,
            rMultiple: pyramidCheck.rMultiple,
            addNumber: pyramidCheck.addNumber,
            triggerPrice: pyramidCheck.triggerPrice,
            message: pyramidCheck.message,
            currency,
            riskScalar: pyramidCheck.riskScalar,
            addShares: addSizing.shares,
            addRiskAmount: addSizing.riskDollars,
            scaledRiskPercent: addSizing.scaledRiskPercent,
          });
        }
      }
      if (pyramidAlerts.length > 0) {
        alerts.push(`📐 ${pyramidAlerts.length} position(s) eligible for pyramid add`);
      }
    } catch (error) {
      hadFailure = true;
      console.warn('[Nightly] Pyramid check failed:', (error as Error).message);
    }

    // Step 6: Build position detail for Telegram
    // Use GBP-normalised prices for consistent cross-currency P&L aggregation
    const positionDetails: NightlyPositionDetail[] = positions.map((p) => {
      const currentPrice = livePrices[p.stock.ticker] || p.entryPrice;
      const gbpPrice = gbpPrices[p.stock.ticker] ?? currentPrice;
      const fxRatio = currentPrice > 0 ? gbpPrice / currentPrice : 1;
      const pnlValue = (gbpPrice - p.entryPrice * fxRatio) * p.shares;
      const pnlPercent = p.entryPrice > 0 ? ((currentPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
      const rMultiple = p.initialRisk > 0 ? (currentPrice - p.entryPrice) / p.initialRisk : 0;
      const isUK = p.stock.ticker.endsWith('.L') || /^[A-Z]{2,5}l$/.test(p.stock.ticker);
      const currency = isUK ? 'GBX' : (p.stock.currency || 'USD').toUpperCase();

      return {
        ticker: p.stock.ticker,
        sleeve: p.stock.sleeve,
        shares: p.shares,
        entryPrice: p.entryPrice,
        currentPrice,
        currentStop: p.currentStop,
        protectionLevel: p.protectionLevel,
        rMultiple,
        pnl: pnlValue,
        pnlPercent,
        currency,
      };
    });

    // Step 7: Sync snapshot data from Yahoo Finance
    let snapshotSync = { synced: false, rowCount: 0, failed: [] as string[], snapshotId: '' };
    try {
      const result = await syncSnapshot();
      snapshotSync = { synced: true, rowCount: result.rowCount, failed: result.failed, snapshotId: result.snapshotId };
      if (result.failed.length > 0) {
        alerts.push(`Snapshot sync: ${result.rowCount} tickers synced, ${result.failed.length} failed`);
      }
    } catch (error) {
      hadFailure = true;
      console.warn('[Nightly] Snapshot sync failed:', (error as Error).message);
      alerts.push('Snapshot sync failed — scores may be stale');
    }

    // Step 7b: Query READY tickers from the freshly synced snapshot
    let readyToBuy: NightlyReadyCandidate[] = [];
    let triggerMetCandidates: NightlyTriggerMetCandidate[] = [];
    if (snapshotSync.snapshotId) {
      try {
        // Get tickers the user already holds to exclude them
        const heldTickers = new Set(positions.map((p) => p.stock.ticker));

        const readyRows = await prisma.snapshotTicker.findMany({
          where: {
            snapshotId: snapshotSync.snapshotId,
            status: 'READY',
          },
          orderBy: { distanceTo20dHighPct: 'asc' },
          take: 15,
        });

        readyToBuy = readyRows
          .filter((r) => !heldTickers.has(r.ticker) && r.adx14 >= 20)
          .map((r) => ({
            ticker: r.ticker,
            name: r.name || r.ticker,
            sleeve: r.sleeve || 'CORE',
            close: r.close,
            entryTrigger: r.entryTrigger,
            stopLevel: r.stopLevel,
            // Distance to entry trigger (not raw 20d high) — matches classifyCandidate
            distancePct: r.close > 0 && r.entryTrigger > 0
              ? ((r.entryTrigger - r.close) / r.close) * 100
              : r.distanceTo20dHighPct,
            atr14: r.atr14,
            adx14: r.adx14,
            currency: r.currency || 'USD',
          }));

        // Detect trigger-met candidates: close >= entryTrigger and not already held
        const allTriggeredRows = await prisma.snapshotTicker.findMany({
          where: {
            snapshotId: snapshotSync.snapshotId,
            status: { in: ['READY', 'WATCH'] },
          },
          orderBy: { distanceTo20dHighPct: 'asc' },
        });
        triggerMetCandidates = allTriggeredRows
          .filter((r) => !heldTickers.has(r.ticker) && r.close >= r.entryTrigger && r.entryTrigger > 0 && r.adx14 >= 20)
          .map((r) => ({
            ticker: r.ticker,
            name: r.name || r.ticker,
            sleeve: r.sleeve || 'CORE',
            close: r.close,
            entryTrigger: r.entryTrigger,
            stopLevel: r.stopLevel,
            distancePct: ((r.close - r.entryTrigger) / r.entryTrigger) * 100,
            atr14: r.atr14,
            adx14: r.adx14,
            currency: r.currency || 'USD',
          }));
        if (triggerMetCandidates.length > 0) {
          alerts.push(`🚨 ${triggerMetCandidates.length} trigger(s) met — review for immediate entry`);
        }
      } catch (error) {
        hadFailure = true;
        console.warn('[Nightly] Failed to query READY tickers:', (error as Error).message);
      }
    }

    // Step 8: Send Telegram summary
    try {
      await sendNightlySummary({
        date: new Date().toISOString().split('T')[0],
        healthStatus: healthReport.overall,
        regime: snapshotSync.synced ? 'SYNCED' : 'UNKNOWN',
        openPositions: positions.length,
        stopsUpdated: stopRecs.length,
        readyCandidates: readyToBuy.length,
        alerts,
        // Portfolio value in GBP for multi-currency consistency
        portfolioValue: positions.reduce((sum, p) => {
          const rawPrice = livePrices[p.stock.ticker] || p.entryPrice;
          const gbpPrice = gbpPrices[p.stock.ticker] ?? rawPrice;
          return sum + gbpPrice * p.shares;
        }, 0),
        dailyChange: 0,
        dailyChangePercent: 0,
        equity,
        openRiskPercent,
        positions: positionDetails,
        stopChanges,
        trailingStopChanges,
        snapshotSynced: snapshotSync.rowCount,
        snapshotFailed: snapshotSync.failed.length,
        readyToBuy,
        triggerMet: triggerMetCandidates,
        pyramidAlerts,
        laggards: laggardAlerts,
        climaxAlerts,
        swapAlerts,
        whipsawAlerts,
        breadthAlert,
        momentumAlert,
        breakoutFailures: breakoutFailureAlerts,
      });
    } catch (error) {
      // Telegram is optional infrastructure — failure must not degrade heartbeat
      console.warn('[Nightly] Telegram send failed:', (error as Error).message);
    }

    // Step 9: Write heartbeat
    await prisma.heartbeat.create({
      data: {
        kind: 'NIGHTLY',
        status: hadFailure ? 'FAILED' : 'SUCCESS',
        details: JSON.stringify({
          healthStatus: healthReport.overall,
          positionsChecked: positions.length,
          stopsRecommended: stopRecs.length,
          trailingStopsApplied: trailingStopChanges.length,
          alertsCount: alerts.length,
          snapshotSync,
          hadFailure,
          // Data source fallback chain health
          dataSource: {
            health: dataSourceHealth,
            staleTickers: dataSourceStaleTickers,
            maxStalenessHours: dataSourceMaxStalenessHours,
            summary: dataSourceSummary,
          },
        }),
      },
    });

    return NextResponse.json({
      success: true,
      healthStatus: healthReport.overall,
      positionsChecked: positions.length,
      stopRecommendations: stopRecs,
      trailingStopChanges,
      laggards: laggardAlerts,
      climaxAlerts,
      swapAlerts,
      whipsawAlerts,
      breadthAlert,
      momentumAlert,
      breakoutFailures: breakoutFailureAlerts,
      alerts,
      summary: {
        snapshotSync: { tickerCount: snapshotSync.rowCount, failed: snapshotSync.failed.length },
      },
      timestamp: new Date(),
    });
  } catch (error) {
    console.error('Nightly process error:', error);

    // Still write heartbeat on failure
    try {
      await prisma.heartbeat.create({
        data: {
          kind: 'NIGHTLY',
          status: 'FAILED',
          details: JSON.stringify({ error: (error as Error).message }),
        },
      });
    } catch (hbErr) {
      console.error('Failed to write FAILED heartbeat — watchdog may not detect this failure:', (hbErr as Error).message);
    }

    return apiError(500, 'NIGHTLY_FAILED', 'Nightly process failed', (error as Error).message, true);
  }
}
