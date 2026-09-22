export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { runFullScan } from '@/lib/scan-engine';
import {
  clearScanCache,
  getScanCache,
  isScanCacheFresh,
  SCAN_CACHE_TTL_MS,
  setScanCache,
} from '@/lib/scan-cache';
import {
  ATR_VOLATILITY_CAP_ALL,
  ATR_VOLATILITY_CAP_HIGH_RISK,
  DEFAULT_GAP_GUARD_CONFIG,
  type RiskProfileType,
  type GapGuardConfig,
  type GapGuardMode,
  type MarketRegime,
  type ScanCandidate,
  type Sleeve,
} from '@/types';
import prisma from '@/lib/prisma';
import { apiError } from '@/lib/api-response';
import { z } from 'zod';
import { parseJsonBody } from '@/lib/request-validation';
import { isNightlyRunning } from '@/lib/nightly-guard';
import { normalizePersistedPassFlag } from '@/lib/scan-pass-flags';
import { updateScanProgress, clearScanProgress } from '@/lib/scan-progress';
import { getSlippageStats } from '@/lib/slippage-tracker';
import { persistScanSnapshot } from '@/lib/persist-scan-snapshot';
import { applyModelLayerToCandidates } from '../../../../packages/model/src';
import { assertScanAllowed, SafetyControlError } from '../../../../packages/workflow/src';

const scanRequestSchema = z.object({
  userId: z.string().trim().min(1),
  riskProfile: z.enum(['CONSERVATIVE', 'BALANCED', 'SMALL_ACCOUNT', 'AGGRESSIVE']),
  equity: z.coerce.number().positive(),
});

// ── POST: Run a fresh scan, persist to DB + cache in memory ─────────
export async function POST(request: NextRequest) {
  // Guard: block bulk Yahoo calls while nightly is running
  if (await isNightlyRunning()) {
    return apiError(503, 'NIGHTLY_RUNNING',
      'Nightly scan is currently running — manual scan unavailable for a few minutes. Try again shortly.');
  }

  try {
    await assertScanAllowed();
  } catch (error) {
    if (error instanceof SafetyControlError) {
      return apiError(423, error.code, error.message);
    }
    throw error;
  }

  try {
    const parsed = await parseJsonBody(request, scanRequestSchema);
    if (!parsed.ok) {
      return parsed.response;
    }
    const { userId, riskProfile, equity } = parsed.data;

    // Read user's gap guard config from DB (falls back to defaults if not set)
    const userSettings = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        gapGuardMode: true,
        gapGuardWeekendATR: true,
        gapGuardWeekendPct: true,
        gapGuardDailyATR: true,
        gapGuardDailyPct: true,
        modelLayerEnabled: true,
      },
    });
    const gapGuardConfig: GapGuardConfig = {
      enabledDays: (userSettings?.gapGuardMode as GapGuardMode) || DEFAULT_GAP_GUARD_CONFIG.enabledDays,
      weekendThresholdATR: userSettings?.gapGuardWeekendATR ?? DEFAULT_GAP_GUARD_CONFIG.weekendThresholdATR,
      weekendThresholdPct: userSettings?.gapGuardWeekendPct ?? DEFAULT_GAP_GUARD_CONFIG.weekendThresholdPct,
      dailyThresholdATR: userSettings?.gapGuardDailyATR ?? DEFAULT_GAP_GUARD_CONFIG.dailyThresholdATR,
      dailyThresholdPct: userSettings?.gapGuardDailyPct ?? DEFAULT_GAP_GUARD_CONFIG.dailyThresholdPct,
    };

    clearScanProgress();
    // Fetch historical slippage to dynamically tighten anti-chase guard
    let slippageBuffer = 0;
    try {
      const slippageStats = await getSlippageStats();
      slippageBuffer = slippageStats.atrBufferAdjustment;
    } catch {
      // Non-critical — use default thresholds if slippage query fails
    }

    const result = await runFullScan(
      userId,
      riskProfile as RiskProfileType,
      equity,
      gapGuardConfig,
      (stage, processed, total) => updateScanProgress(stage, processed, total),
      slippageBuffer
    );
    // Apply model layer, grade all candidates, and persist the full snapshot
    // (Scan + ScanResult + FilterAttribution + CandidateOutcome). Shared with
    // the scheduled scan-only session so both produce identical snapshots and
    // the persisted scan stays fresh without a manual click. Grading is
    // returned even if DB persistence fails (non-fatal — results still served).
    const { scanId, gradedCandidates, modelLayer } = await persistScanSnapshot({
      userId,
      scanResult: result,
      modelLayerEnabled: userSettings?.modelLayerEnabled ?? false,
    });

    const responseResult = {
      ...result,
      scanId,
      candidates: gradedCandidates,
      modelLayer,
    };
    clearScanProgress();

    // Cache the result so GET can return it without re-scanning
    const cached = setScanCache({
      ...responseResult,
      userId,
      riskProfile,
      equity,
    });

    return NextResponse.json({ ...responseResult, cachedAt: cached.cachedAt });
  } catch (error) {
    console.error('Scan error:', error);
    const msg = (error as Error).message || '';
    const isYahooRateLimit = msg.includes('429') || msg.toLowerCase().includes('too many');
    return apiError(
      isYahooRateLimit ? 429 : 500,
      isYahooRateLimit ? 'YAHOO_RATE_LIMITED' : 'SCAN_FAILED',
      isYahooRateLimit
        ? 'Yahoo Finance rate limit hit. Wait a few minutes and retry.'
        : 'Scan failed',
      msg,
      true
    );
  }
}

// ── GET: Return cached scan results, fallback to DB ─────────────────
export async function GET() {
  try {
    // Try in-memory cache first
    const cached = getScanCache();
    if (cached && isScanCacheFresh(cached)) {
      return NextResponse.json({ ...cached, hasCache: true, source: 'memory' });
    }
    if (cached && !isScanCacheFresh(cached)) {
      clearScanCache();
    }

    if (!process.env.DATABASE_URL) {
      return apiError(
        404,
        'SCAN_CACHE_MISS',
        'No fresh scan cache available',
        'Run Full Scan to generate fresh results.'
      );
    }

    // Fallback: load most recent scan from database
    const latestScan = await prisma.scan.findFirst({
      orderBy: { runDate: 'desc' },
      include: {
        results: {
          include: { stock: true },
          orderBy: { rankScore: 'desc' },
        },
      },
    });

    if (!latestScan || latestScan.results.length === 0) {
      return apiError(
        404,
        'SCAN_CACHE_MISS',
        'No cached scan',
        'Click "Run Full Scan" to generate results. They will be persisted across restarts.'
      );
    }

    const latestScanAgeMs = Date.now() - latestScan.runDate.getTime();
    if (latestScanAgeMs > SCAN_CACHE_TTL_MS) {
      return apiError(
        404,
        'SCAN_CACHE_STALE',
        'Latest scan cache is stale',
        'Run Full Scan to refresh candidates.'
      );
    }

    // Reconstruct the scan result shape from DB rows
    const candidates = latestScan.results.map((r) => {
      const atrCap = r.stock.sleeve === 'HIGH_RISK'
        ? ATR_VOLATILITY_CAP_HIGH_RISK
        : ATR_VOLATILITY_CAP_ALL;

      return {
        id: r.stock.ticker,
        ticker: r.stock.ticker,
        yahooTicker: r.stock.yahooTicker || undefined,
        name: r.stock.name,
        sleeve: r.stock.sleeve as Sleeve,
        sector: r.stock.sector || 'Unknown',
        cluster: r.stock.cluster || 'General',
        price: r.price,
        priceCurrency: r.stock.ticker.endsWith('.L') ? 'GBX' : (r.stock.currency || 'USD'),
        technicals: {
          currentPrice: r.price,
          ma200: r.ma200,
          adx: r.adx,
          plusDI: r.plusDI,
          minusDI: r.minusDI,
          atr: 0,
          atr20DayAgo: 0,
          medianAtr14: 0,
          atrPercent: r.atrPercent,
          twentyDayHigh: r.twentyDayHigh,
          efficiency: r.efficiency,
          volumeRatio: 1,
          relativeStrength: 0,
          atrSpiking: false,
          failedBreakoutAt: null,
        },
        entryTrigger: r.entryTrigger,
        stopPrice: r.stopPrice,
        distancePercent: r.distancePercent,
        status: r.status,
        antiChaseResult: r.stage6Reason
          ? {
              passed: !r.stage6Reason.includes('WAIT_PULLBACK') && !r.stage6Reason.includes('CHASE RISK'),
              reason: r.stage6Reason,
            }
          : undefined,
        pullbackSignal: r.entryMode === 'PULLBACK_CONTINUATION'
          ? {
              triggered: true,
              mode: 'PULLBACK_CONTINUATION' as const,
              anchor: r.entryTrigger,
              zoneLow: r.entryTrigger,
              zoneHigh: r.entryTrigger,
              entryPrice: r.entryTrigger,
              stopPrice: r.stopPrice,
              reason: r.stage6Reason || 'PULLBACK_CONTINUATION',
            }
          : undefined,
        rankScore: r.rankScore,
        passesAllFilters: r.passesAllFilters,
        passesRiskGates: normalizePersistedPassFlag(r.passesRiskGates),
        passesAntiChase: normalizePersistedPassFlag(r.passesAntiChase),
        shares: r.shares,
        riskDollars: r.riskDollars,
        filterResults: {
          priceAboveMa200: r.price > r.ma200,
          adxAbove20: r.adx >= 20,
          plusDIAboveMinusDI: r.plusDI > r.minusDI,
          atrPercentBelow8: r.atrPercent < atrCap,
          efficiencyAbove30: r.efficiency >= 30,
          dataQuality: r.ma200 > 0 && r.adx > 0,
          passesAll: r.passesAllFilters,
          atrSpiking: false,
          atrSpikeAction: 'NONE' as const,
        },
      };
    }) as ScanCandidate[];

    const passedFilters = candidates.filter((c) => c.passesAllFilters);

    // Look up actual user profile/equity so DB fallback uses real values
    const scanUser = await prisma.user.findUnique({
      where: { id: latestScan.userId },
      select: { riskProfile: true, equity: true, modelLayerEnabled: true },
    });

    const modelLayer = applyModelLayerToCandidates(candidates, {
      enabled: scanUser?.modelLayerEnabled ?? false,
    }, latestScan.regime as MarketRegime);
    const scoredCandidates = modelLayer.candidates;
    const scoredPassedFilters = scoredCandidates.filter((c) => c.passesAllFilters);

    const dbResult = {
      scanId: latestScan.id,
      regime: latestScan.regime,
      candidates: scoredCandidates,
      readyCount: scoredPassedFilters.filter((c) => c.status === 'READY').length,
      watchCount: scoredPassedFilters.filter((c) => c.status === 'WATCH' || c.status === 'WAIT_PULLBACK').length,
      farCount: scoredCandidates.filter((c) => c.status === 'FAR').length,
      totalScanned: scoredCandidates.length,
      passedFilters: scoredPassedFilters.length,
      passedRiskGates: scoredPassedFilters.filter((c) => c.passesRiskGates === true).length,
      passedAntiChase: scoredPassedFilters.filter((c) => c.passesAntiChase === true).length,
      cachedAt: latestScan.runDate.toISOString(),
      userId: latestScan.userId,
      riskProfile: scanUser?.riskProfile || 'BALANCED',
      equity: scanUser?.equity || 0,
      modelLayer: {
        enabled: modelLayer.settings.enabled,
        versions: modelLayer.versions,
      },
      hasCache: true,
      source: 'database',
    };

    // Re-populate the in-memory cache so subsequent GETs are fast
    setScanCache(dbResult);

    return NextResponse.json(dbResult);
  } catch (error) {
    console.error('Scan cache error:', error);
    return apiError(
      500,
      'SCAN_CACHE_ERROR',
      'Failed to retrieve scan data',
      (error as Error).message,
      true
    );
  }
}
