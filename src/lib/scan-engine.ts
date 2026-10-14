/**
 * DEPENDENCIES
 * Consumed by: /api/scan/route.ts
 * Consumes: market-data.ts, position-sizer.ts, risk-gates.ts, scan-guards.ts, modules/adaptive-atr-buffer.ts, prisma.ts, @/types
 * Risk-sensitive: YES
 * Last modified: 2026-02-22
 * Notes: 7-stage pipeline. Do not add, remove, or reorder stages without explicit instruction.
 */
// ============================================================
// 7-Stage Scan Engine
// ============================================================

import type {
  ScanCandidate,
  CandidateStatus,
  MarketRegime,
  Sleeve,
  TechnicalData,
  RiskProfileType,
  GapGuardConfig,
  ScanMode,
} from '@/types';
import { ATR_VOLATILITY_CAP_ALL, ATR_VOLATILITY_CAP_HIGH_RISK, ATR_STOP_MULTIPLIER, DEFAULT_GAP_GUARD_CONFIG } from '@/types';

const FAILED_BREAKOUT_COOLDOWN_DAYS = 5;
import { getTechnicalData, getMarketRegime, getVolRegime, getQuickPrice, getFXRate, getDailyPrices } from './market-data';
import { fetchT212LivePrices } from './position-sync';
import { calculateAdaptiveBuffer } from './modules/adaptive-atr-buffer';
import { calculatePositionSize } from './position-sizer';
import { validateRiskGates } from './risk-gates';
import { checkAntiChasingGuard, checkPullbackContinuationEntry } from './scan-guards';
import { assessEntryQuality } from './entry-quality-engine';
import { validateTickerData } from './modules/data-validator';
import { getEarningsInfo, evaluateEarningsRisk } from './earnings-calendar';
import { calcHurst } from './hurst';
import prisma from './prisma';

// ---- Stage 1: Universe ----
export async function getUniverse(): Promise<
  { ticker: string; yahooTicker: string | null; name: string; sleeve: Sleeve; sector: string; cluster: string; currency: string | null }[]
> {
  const stocks = await prisma.stock.findMany({
    where: { active: true },
    orderBy: { ticker: 'asc' },
  });
  return stocks.map((s) => ({
    ticker: s.ticker,
    yahooTicker: s.yahooTicker ?? null,
    name: s.name,
    sleeve: s.sleeve as Sleeve,
    sector: s.sector || 'Unknown',
    cluster: s.cluster || 'General',
    currency: s.currency,
  }));
}

// ---- Stage 2: Technical Filters ----
export function runTechnicalFilters(
  price: number,
  technicals: TechnicalData,
  sleeve: Sleeve
): {
  priceAboveMa200: boolean;
  adxAbove20: boolean;
  plusDIAboveMinusDI: boolean;
  atrPercentBelow8: boolean;
  efficiencyAbove30: boolean;
  dataQuality: boolean;
  passesAll: boolean;
} {
  const atrThreshold = sleeve === 'HIGH_RISK'
    ? ATR_VOLATILITY_CAP_HIGH_RISK
    : ATR_VOLATILITY_CAP_ALL;

  const filters = {
    priceAboveMa200: price > technicals.ma200,
    adxAbove20: technicals.adx >= 20,
    plusDIAboveMinusDI: technicals.plusDI > technicals.minusDI,
    atrPercentBelow8: technicals.atrPercent < atrThreshold,
    dataQuality: technicals.ma200 > 0 && technicals.adx > 0,
  };

  return {
    ...filters,
    efficiencyAbove30: technicals.efficiency >= 30,
    passesAll: Object.values(filters).every(Boolean),
  };
}

// ---- Stage 3: Status Classification ----
export function classifyCandidate(
  price: number,
  entryTrigger: number
): CandidateStatus {
  if (price <= 0) return 'FAR'; // Corrupt data guard
  const distance = ((entryTrigger - price) / price) * 100;

  if (distance <= 2) return 'READY';
  if (distance <= 3) return 'WATCH';
  return 'FAR';
}

// ---- Stage 4: Ranking ----
export function rankCandidate(
  sleeve: Sleeve,
  technicals: TechnicalData,
  status: CandidateStatus
): number {
  let score = 0;

  // Sleeve priority (higher = better)
  const sleevePriority: Record<Sleeve, number> = {
    CORE: 40,
    ETF: 20,
    HIGH_RISK: 10,
    HEDGE: 5, // Lowest priority — long-term holds, guidance only
  };
  score += sleevePriority[sleeve];

  // Status bonus
  if (status === 'READY') score += 30;
  else if (status === 'WATCH') score += 10;

  // ADX tiebreaker
  score += Math.min(technicals.adx, 50) * 0.3;

  // Volume ratio
  score += Math.min(technicals.volumeRatio, 3) * 5;

  // Trend efficiency
  score += Math.min(technicals.efficiency, 100) * 0.2;

  // Relative strength
  score += Math.min(technicals.relativeStrength, 100) * 0.1;

  return Math.round(score * 100) / 100;
}

// ---- Stage 5: Risk Cap Gates ----
// Handled by validateRiskGates from risk-gates.ts, called inside runFullScan.

// ---- Stage 6: Anti-Chase / Execution Guard ----
// Handled by checkAntiChasingGuard from scan-guards.ts, called inside runFullScan.

// ---- Stage 7: Position Sizing (uses position-sizer.ts) ----

// ---- Full Scan Pipeline ----
export async function runFullScan(
  userId: string,
  riskProfile: RiskProfileType,
  equity: number,
  gapGuardConfig: GapGuardConfig = DEFAULT_GAP_GUARD_CONFIG,
  onProgress?: (stage: string, processed: number, total: number) => void,
  slippageBuffer = 0,
  scanMode: ScanMode = 'FULL',
  universeFilter?: (stock: { ticker: string; sleeve: Sleeve }) => boolean
): Promise<{
  regime: MarketRegime;
  candidates: ScanCandidate[];
  readyCount: number;
  watchCount: number;
  farCount: number;
  totalScanned: number;
  passedFilters: number;
  passedRiskGates: number;
  passedAntiChase: number;
  scanMode: ScanMode;
}> {
  const isCoreLite = scanMode === 'CORE_LITE';
  const rawUniverse = await getUniverse();
  const universe = universeFilter ? rawUniverse.filter(universeFilter) : rawUniverse;
  const candidates: ScanCandidate[] = [];

  onProgress?.('Stage 1: Loading universe', 0, universe.length);

  // Determine market regime from SPY vs 200 MA (live data)
  onProgress?.('Stage 1: Detecting regime', 0, universe.length);
  const [regime, volRegimeResult] = await Promise.all([
    getMarketRegime(),
    getVolRegime(),
  ]);
  const volRegime = volRegimeResult.volRegime;

  // ── Fetch existing positions for risk gate checks (Stage 5) ──
  const existingPositions = await prisma.position.findMany({
    where: { userId, status: 'OPEN' },
    include: { stock: true },
  });

  // T212 real-time prices for held positions (more accurate than Yahoo for risk calcs)
  const t212Prices = existingPositions.length > 0
    ? await fetchT212LivePrices(userId).catch(() => ({} as Record<string, number>))
    : {};

  const positionResults = await Promise.allSettled(existingPositions.map(async (p) => {
    const currency = (p.stock.currency || 'USD').toUpperCase();
    const isUk = p.stock.ticker.endsWith('.L') || /^[A-Z]{2,5}l$/.test(p.stock.ticker);
    const fxToGbp = isUk || currency === 'GBX' || currency === 'GBP' || currency === 'GBp'
      ? (currency === 'GBP' ? 1 : 0.01)
      : await getFXRate(currency, 'GBP');

    // T212 price preferred (real-time), Yahoo fallback (delayed)
    const currentPriceNative = t212Prices[p.stock.ticker]
      ?? await getQuickPrice(p.stock.ticker)
      ?? p.entryPrice;
    const entryPriceGbp = p.entryPrice * fxToGbp;
    const currentStopGbp = p.currentStop * fxToGbp;
    const currentPriceGbp = currentPriceNative * fxToGbp;

    return {
      id: p.id,
      ticker: p.stock.ticker,
      sleeve: (p.stock.sleeve || 'CORE') as Sleeve,
      sector: p.stock.sector || 'Unknown',
      cluster: p.stock.cluster || 'General',
      // H-4 fix (2026-05-17): concentration must reflect MARKET value, not
      // deployed capital at entry. Using entryPrice systematically under-states
      // sleeve/cluster/sector % for profitable positions, leaving phantom
      // headroom that doesn't exist at market value.
      value: currentPriceGbp * p.shares,
      riskDollars: Math.max(0, (currentPriceGbp - currentStopGbp) * p.shares),
      shares: p.shares,
      entryPrice: entryPriceGbp,
      currentStop: currentStopGbp,
      currentPrice: currentPriceGbp,
    };
  }));

  const positionsForGates = positionResults
    .filter((r): r is PromiseFulfilledResult<typeof r extends PromiseFulfilledResult<infer V> ? V : never> => {
      if (r.status === 'rejected') {
        console.warn('[scan-engine] Position gate data failed, skipping:', r.reason);
      }
      return r.status === 'fulfilled';
    })
    .map((r) => r.value);

  const fxCache = new Map<string, number>();
  async function getFxToGbp(currency: string | null, ticker: string): Promise<number> {
    const curr = (currency || 'USD').toUpperCase();
    // Explicit currency takes priority over .L suffix heuristic
    // (some LSE-listed ETFs are priced in USD, not GBX)
    if (curr === 'GBX' || curr === 'GBp') return 0.01;
    if (curr === 'GBP') return 1;
    // Fallback: if no explicit currency and .L suffix, assume GBX
    const isUk = ticker.endsWith('.L') || /^[A-Z]{2,5}l$/.test(ticker);
    if (isUk && (!currency || currency === '')) return 0.01;
    const cached = fxCache.get(curr);
    if (cached != null) return cached;
    const rate = await getFXRate(curr, 'GBP');
    fxCache.set(curr, rate);
    return rate;
  }

  // Process in smaller batches to avoid overwhelming Yahoo Finance
  const BATCH_SIZE = 10;
  for (let batch = 0; batch < universe.length; batch += BATCH_SIZE) {
    const stockBatch = universe.slice(batch, batch + BATCH_SIZE);

    const batchPromises = stockBatch.map(async (stock) => {
      try {
        // Fetch live technical data from Yahoo Finance (includes current price)
        const technicals = await getTechnicalData(stock.ticker);
        if (!technicals) {
          console.warn(`[Scan] Skipping ${stock.ticker} — insufficient data`);
          return null;
        }

        const validationBars = await getDailyPrices(stock.ticker, 'compact');
        const validation = validateTickerData(stock.ticker, validationBars);
        if (!validation.isValid) {
          console.warn(`[Scan] Skipping ${stock.ticker} — data invalid: ${validation.issues.join('; ')}`);
          return null;
        }

        // ── Stage 2 soft filter: Hurst Exponent ──
        // Uses existing validationBars (no new Yahoo call). H < 0.5 = HURST_WARN flag.
        // CORE_LITE: skip Hurst calculation (soft overlay)
        const closePrices = validationBars.map(b => b.close);
        const hurstExponent = isCoreLite ? null : calcHurst(closePrices);
        const hurstWarn = !isCoreLite && hurstExponent !== null && hurstExponent < 0.5;

        // Use price from chart data — avoids a separate quote() call per ticker
        const price = technicals.currentPrice;
        if (!price) return null;

        const filterResults = runTechnicalFilters(price, technicals, stock.sleeve);
        // CORE_LITE: use raw 20d high as entry trigger (no adaptive buffer)
        const adaptiveBuffer = isCoreLite
          ? { adjustedEntryTrigger: technicals.twentyDayHigh, atrPercent: technicals.atrPercent, bufferPercent: 0, volRegimeMultiplier: 1 }
          : calculateAdaptiveBuffer(
          stock.ticker,
          technicals.twentyDayHigh,
          technicals.atr,
          technicals.atrPercent,
          technicals.priorTwentyDayHigh,
          volRegime
        );
        let entryTrigger = adaptiveBuffer.adjustedEntryTrigger;
        // Guard: ensure stop is always below entry (ATR=0 → use 0.5% min distance)
        const minStopDistance = 0.005 * entryTrigger;
        let stopPrice = entryTrigger - Math.max(technicals.atr * ATR_STOP_MULTIPLIER, minStopDistance);
        let distancePercent = price > 0 ? ((entryTrigger - price) / price) * 100 : 100;
        let status = classifyCandidate(price, entryTrigger);
        let passesAllFilters = filterResults.passesAll;

        // ATR spike detection — use median of last 14 ATR values as baseline.
        // Spike = current ATR ≥ 1.3× median. More robust than comparing to a
        // single 20-day-ago snapshot. Raw ATR is unchanged for stop calculations.
        // CORE_LITE: skip ATR spike detection (advanced overlay)
        const medianSpiking = isCoreLite ? false
          : technicals.medianAtr14 > 0
            ? technicals.atr >= technicals.medianAtr14 * 1.3
            : technicals.atrSpiking;  // fallback if median unavailable
        const bullishDI = technicals.plusDI > technicals.minusDI;
        let atrSpikeAction: 'NONE' | 'SOFT_CAP' | 'HARD_BLOCK' = 'NONE';

        if (medianSpiking) {
          if (bullishDI) {
            atrSpikeAction = 'SOFT_CAP';
            if (status === 'READY') status = 'WATCH';
          } else {
            atrSpikeAction = 'HARD_BLOCK';
            passesAllFilters = false;
            status = 'FAR';
          }
        }

        if (!filterResults.efficiencyAbove30 && status === 'READY') {
          status = 'WATCH';
        }

        // ── Earnings Calendar Check (between Stage 3 and Stage 5) ──
        // Checks DB cache (pre-populated nightly). If cache miss, returns NONE.
        // AUTO_NO for ≤2 days (HIGH confidence), DEMOTE_WATCH for 3-5 days.
        // CORE_LITE: skip earnings check (advanced overlay)
        let earningsCheckResult: ReturnType<typeof evaluateEarningsRisk> | null = null;
        if (!isCoreLite) {
          try {
            const earningsInfo = await getEarningsInfo(stock.ticker);
            earningsCheckResult = evaluateEarningsRisk(earningsInfo);

            if (earningsCheckResult.action === 'AUTO_NO') {
              status = 'EARNINGS_BLOCK';
              passesAllFilters = false;
            } else if (earningsCheckResult.action === 'DEMOTE_WATCH' && status === 'READY') {
              status = 'WATCH';
            }
          } catch {
            // Fail safe — earnings check failure never crashes the scan
          }
        }

        const rankScore = rankCandidate(stock.sleeve, technicals, status);

        let shares: number | undefined;
        let riskDollars: number | undefined;
        let riskPercent: number | undefined;
        let totalCost: number | undefined;
        let riskGateResults: ScanCandidate['riskGateResults'];
        let passesRiskGates = true;
        let antiChaseResult: ScanCandidate['antiChaseResult'];
        let pullbackSignal: ScanCandidate['pullbackSignal'];
        let passesAntiChase = true;

        if (passesAllFilters && status !== 'FAR') {
          const fxToGbp = await getFxToGbp(stock.currency, stock.ticker);

          // ── Stage 7: Position Sizing (with position size cap) ──
          try {
            const sizing = calculatePositionSize({
              equity,
              riskProfile,
              entryPrice: entryTrigger,
              stopPrice,
              sleeve: stock.sleeve,
              fxToGbp,
              allowFractional: true, // Trading 212 supports fractional shares
            });
            shares = sizing.shares;
            riskDollars = sizing.riskDollars;
            riskPercent = sizing.riskPercent;
            totalCost = sizing.totalCost;
          } catch {
            // Sizing failed — mark candidate as non-viable so it doesn't ghost through gates with zero values
            passesAllFilters = false;
          }

          // ── Stage 5: Risk Gates ──
          const gateValue = totalCost ?? 0;
          const gateRisk = riskDollars ?? 0;
          riskGateResults = validateRiskGates(
            {
              sleeve: stock.sleeve,
              sector: stock.sector,
              cluster: stock.cluster,
              value: gateValue,
              riskDollars: gateRisk,
            },
            positionsForGates,
            equity,
            riskProfile
          );
          passesRiskGates = riskGateResults.every((g) => g.passed);

          // ── Stage 6: Anti-Chase / Execution Guard ──
          // CORE_LITE: skip all anti-chase checks (advanced overlay)

          if (!isCoreLite) {
            // Failed breakout cooldown: if the ticker had a failed breakout
            // within FAILED_BREAKOUT_COOLDOWN_DAYS, block re-entry.
            if (technicals.failedBreakoutAt) {
              const daysSinceFailure = Math.floor(
                (Date.now() - technicals.failedBreakoutAt.getTime()) / (1000 * 60 * 60 * 24)
              );
              if (daysSinceFailure < FAILED_BREAKOUT_COOLDOWN_DAYS) {
                antiChaseResult = {
                  passed: false,
                  reason: `COOLDOWN — failed breakout ${daysSinceFailure}d ago (${FAILED_BREAKOUT_COOLDOWN_DAYS}d required)`,
                };
                status = 'COOLDOWN';
                passesAntiChase = false;
              }
            }
          }

          // Skip remaining anti-chase checks if already in cooldown
          if (status !== 'COOLDOWN' && !isCoreLite) {
            const extATR = technicals.atr > 0 ? (price - entryTrigger) / technicals.atr : 0;
            // Volatility expansion anti-chase override (all days):
            // If price stretches too far above trigger in ATR terms (extATR > 0.8),
            // force WAIT_PULLBACK regardless of earlier READY/WATCH classification.
            // This is separate from the gap guard in scan-guards.ts (which uses
            // day-aware thresholds and is configurable via GapGuardConfig).
            if (extATR > 0.8) {
              antiChaseResult = {
                passed: false,
                reason: `WAIT_PULLBACK — ext_atr ${extATR.toFixed(2)} > 0.80`,
              };
              status = 'WAIT_PULLBACK';
            } else {
              antiChaseResult = checkAntiChasingGuard(
                price,
                entryTrigger,
                technicals.atr,
                new Date().getDay(),
                gapGuardConfig,
                slippageBuffer
              );
            }

            if (status === 'WAIT_PULLBACK') {
              pullbackSignal = checkPullbackContinuationEntry({
                status,
                hh20: technicals.twentyDayHigh,
                ema20: technicals.ema20 ?? technicals.twentyDayHigh,
                atr: technicals.atr,
                close: price,
                low: technicals.dayLow ?? price,
              });

              if (pullbackSignal.triggered) {
                entryTrigger = pullbackSignal.entryPrice ?? price;
                stopPrice = pullbackSignal.stopPrice ?? stopPrice;
                distancePercent = price > 0 ? ((entryTrigger - price) / price) * 100 : 100;
                status = 'READY';
                antiChaseResult = {
                  passed: true,
                  reason: `PULLBACK_CONTINUATION — ${pullbackSignal.reason}`,
                };

                try {
                  const sizing = calculatePositionSize({
                    equity,
                    riskProfile,
                    entryPrice: entryTrigger,
                    stopPrice,
                    sleeve: stock.sleeve,
                    fxToGbp,
                    allowFractional: true, // Trading 212 supports fractional shares
                  });
                  shares = sizing.shares;
                  riskDollars = sizing.riskDollars;
                  riskPercent = sizing.riskPercent;
                  totalCost = sizing.totalCost;
                } catch {
                  // Sizing failed — mark candidate as non-viable
                  passesAllFilters = false;
                }

                const gateValueAfterPullback = totalCost ?? 0;
                const gateRiskAfterPullback = riskDollars ?? 0;
                riskGateResults = validateRiskGates(
                  {
                    sleeve: stock.sleeve,
                    sector: stock.sector,
                    cluster: stock.cluster,
                    value: gateValueAfterPullback,
                    riskDollars: gateRiskAfterPullback,
                  },
                  positionsForGates,
                  equity,
                  riskProfile
                );
                passesRiskGates = riskGateResults.every((g) => g.passed);
              }
            }
          } // end if (status !== 'COOLDOWN')

          passesAntiChase = antiChaseResult?.passed ?? passesAntiChase;
        }

        // ── Entry Quality Assessment ──
        const entryQuality = assessEntryQuality({
          price,
          entryTrigger,
          stopPrice,
          atr: technicals.atr,
          atrPercent: technicals.atrPercent,
          status,
          slippageBuffer,
          pullbackTriggered: pullbackSignal?.triggered ?? false,
          pullbackEntryPrice: pullbackSignal?.entryPrice,
          antiChaseFailed: !(antiChaseResult?.passed ?? true),
        });

        // Determine native price currency (matches what T212/Yahoo shows)
        const isUK = stock.ticker.endsWith('.L');
        const priceCurrency = isUK ? 'GBX' : (stock.currency || 'USD').toUpperCase();

        return {
          id: stock.ticker,
          ticker: stock.ticker,
          yahooTicker: stock.yahooTicker || undefined,
          name: stock.name,
          sleeve: stock.sleeve,
          sector: stock.sector,
          cluster: stock.cluster,
          price,
          priceCurrency,
          technicals,
          entryTrigger,
          stopPrice,
          distancePercent,
          status,
          rankScore,
          passesAllFilters,
          riskGateResults,
          passesRiskGates,
          antiChaseResult,
          pullbackSignal,
          passesAntiChase,
          shares,
          riskDollars,
          riskPercent,
          totalCost,
          entryQuality,
          earningsInfo: earningsCheckResult ? {
            daysUntilEarnings: earningsCheckResult.info.daysUntilEarnings,
            nextEarningsDate: earningsCheckResult.info.nextEarningsDate?.toISOString() ?? null,
            confidence: earningsCheckResult.info.confidence,
            action: earningsCheckResult.action,
            reason: earningsCheckResult.reason,
          } : undefined,
          filterResults: {
            ...filterResults,
            atrSpiking: medianSpiking,
            atrSpikeAction,
            hurstExponent,
            hurstWarn,
          },
        } as ScanCandidate;
      } catch (error) {
        console.error(`[Scan] Failed for ${stock.ticker}:`, error);
        return null;
      }
    });

    const batchResults = await Promise.all(batchPromises);
    for (const result of batchResults) {
      if (result) candidates.push(result);
    }

    onProgress?.('Stage 2–6: Scanning tickers', Math.min(batch + BATCH_SIZE, universe.length), universe.length);

    // Brief pause between batches to be respectful to Yahoo
    if (batch + BATCH_SIZE < universe.length) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  onProgress?.('Stage 7: Ranking & sorting', universe.length, universe.length);

  // Sort: triggered first → READY → WATCH → FAR/failed, then by rank score
  const statusOrder: Record<string, number> = { READY: 0, WATCH: 1, WAIT_PULLBACK: 1, COOLDOWN: 2, EARNINGS_BLOCK: 2, FAR: 3 };
  candidates.sort((a, b) => {
    // Trigger-met candidates float to the very top (price ≥ entry trigger + passes filters)
    const aTriggered = a.passesAllFilters && a.price >= a.entryTrigger ? 1 : 0;
    const bTriggered = b.passesAllFilters && b.price >= b.entryTrigger ? 1 : 0;
    if (aTriggered !== bTriggered) return bTriggered - aTriggered;
    // Then by status: READY → WATCH → FAR
    const aStatus = statusOrder[a.status] ?? 3;
    const bStatus = statusOrder[b.status] ?? 3;
    if (aStatus !== bStatus) return aStatus - bStatus;
    // Then by rank score within same group
    return b.rankScore - a.rankScore;
  });

  const passesAll = candidates.filter((c) => c.passesAllFilters);

  return {
    regime,
    candidates,
    readyCount: passesAll.filter((c) => c.status === 'READY').length,
    watchCount: passesAll.filter((c) => c.status === 'WATCH' || c.status === 'WAIT_PULLBACK').length,
    farCount: candidates.filter((c) => c.status === 'FAR').length,
    totalScanned: universe.length,
    passedFilters: passesAll.length,
    passedRiskGates: passesAll.filter((c) => c.passesRiskGates).length,
    passedAntiChase: passesAll.filter((c) => c.passesAntiChase).length,
    scanMode,
  };
}
