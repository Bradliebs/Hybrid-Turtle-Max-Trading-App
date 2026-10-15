/**
 * DEPENDENCIES
 * Consumed by: nightly.ts, /api/nightly/route.ts, /api/snapshot/route.ts (if present)
 * Consumes: market-data.ts, modules/adaptive-atr-buffer.ts, breakout-integrity.ts, modules/data-validator.ts, signals/breakout-signals.ts, signals/entropy-signal.ts, signals/network-isolation.ts, signals/novel-signals.ts, prisma.ts, @/types
 * Risk-sensitive: YES
 * Last modified: 2026-03-11
 * Notes: Snapshot sync should reject stale/invalid data.
 *        Breakout evidence, entropy, and network isolation are Layer 2 advisory captures.
 */
// ============================================================
// Snapshot Sync — Builds SnapshotTicker rows from live data
// ============================================================
// Replaces the Python master_snapshot pipeline.  Pulls market data
// from Yahoo Finance (via market-data.ts), enriches with cluster /
// regime / T212 info from the DB, and writes a full Snapshot.
// ============================================================

import prisma from './prisma';
import {
  getDailyPrices,
  getWeeklyPrices,
  calculateMA,
  calculateATR,
  calculateADX,
  calculateTrendEfficiency,
  getMarketRegime,
  getVolRegime,
  getFXRate,
} from './market-data';
import { validateTickerData } from './modules/data-validator';
import { INSUFFICIENT_DATA_PREFIX } from './modules/data-validation-codes';
import { calculateAdaptiveBuffer } from './modules/adaptive-atr-buffer';
import { calcBIS } from './breakout-integrity';
import { getEarningsInfo } from './earnings-calendar';
import { computeBreakoutSignal } from './signals/breakout-signals';
import { computeEntropy } from './signals/entropy-signal';
import { computeNetworkIsolation } from './signals/network-isolation';
import { computeAllNovelSignals } from './signals/novel-signals';
import type { Sleeve } from '@/types';
import { ATR_STOP_MULTIPLIER, SNAPSHOT_CLUSTER_WARNING, SNAPSHOT_SUPER_CLUSTER_WARNING } from '@/types';

// ── Types ─────────────────────────────────────────────────────
export interface SyncProgress {
  total: number;
  done: number;
  failed: number;
  ticker: string;
}

export type SyncProgressCallback = (p: SyncProgress) => void;

export interface SyncResult {
  snapshotId: string;
  rowCount: number;
  failed: string[];
  /** Map of ticker → failure reason for diagnostics and stale tracking */
  failureReasons: Map<string, string>;
  regime: string;
  durationMs: number;
}

// ── Constants ─────────────────────────────────────────────────
const BATCH_SIZE = 8;          // concurrent Yahoo requests per batch
const BATCH_DELAY_MS = 400;    // pause between batches

// ── Helpers ───────────────────────────────────────────────────

function nDayHigh(data: { high: number }[], n: number): number {
  const highs = data.slice(0, n).map((d) => d.high);
  return highs.length > 0 ? Math.max(...highs) : 0;
}

function nDayLow(data: { low: number }[], n: number): number {
  const lows = data.slice(0, n).map((d) => d.low);
  return lows.length > 0 ? Math.min(...lows) : 0;
}

/**
 * Check if the PRIOR 20-day (or 55-day) high was set in the last `lookback`
 * bars BEFORE today (indices 1..lookback).
 *
 * Starting at index 1 (excluding today's breakout bar, index 0) is essential:
 * when `data[0]` breaks out above the prior N-day high, `data[0].high` IS the
 * new N-day high (`nDayHigh(data, N)`), so including `i = 0` caused 100% of
 * fresh Day-1 breakouts to return `true` and suffer an automatic +5 to +10 FWS
 * chasing penalty (`fws_extension`). Checking `data.slice(1)` detects genuine
 * multi-day chasing (where the prior N-day high was already reached in the
 * preceding `lookback` sessions).
 */
export function chasingLastN(
  data: { high: number }[],
  breakoutPeriod: number,
  lookback: number = 5
): boolean {
  if (data.length < breakoutPeriod + 1) return false;
  const priorWindow = data.slice(1, breakoutPeriod + 1);
  const priorPeriodHigh = nDayHigh(priorWindow, breakoutPeriod);
  if (priorPeriodHigh <= 0) return false;
  for (let i = 0; i < Math.min(lookback, priorWindow.length); i++) {
    if (priorWindow[i].high >= priorPeriodHigh * 0.999) return true;
  }
  return false;
}

/** ATR 20 days ago for spike detection */
function atr20DaysAgo(data: { high: number; low: number; close: number }[]): number {
  if (data.length < 34) return 0;
  return calculateATR(data.slice(20), 14);
}

/** Dollar volume (20-day average) */
function dollarVol20(data: { close: number; volume: number }[]): number {
  const slice = data.slice(0, 20);
  if (slice.length === 0) return 0;
  const total = slice.reduce((s, d) => s + d.close * d.volume, 0);
  return total / slice.length;
}

/**
 * Volume ratio — today (`data[0]`) vs prior 20-day average (`data.slice(1, 21)`),
 * matching `getTechnicalData` in `market-data.ts` so a breakout day's volume
 * surge is not diluted in its own denominator.
 */
export function volumeRatio(data: { volume: number }[]): number {
  if (data.length < 2) return 1;
  const prior = data.slice(1, 21);
  const avg20 = prior.reduce((s, d) => s + d.volume, 0) / prior.length;
  return avg20 > 0 ? data[0].volume / avg20 : 1;
}

/** Relative strength vs SPY over 3 months (%) */
async function rsVsBenchmark(
  closes: number[],
  spyCloses: number[]
): Promise<number> {
  const period = 63; // ~3 months
  if (closes.length < period || spyCloses.length < period) return 0;
  const stockReturn = (closes[0] - closes[period - 1]) / closes[period - 1];
  const spyReturn = (spyCloses[0] - spyCloses[period - 1]) / spyCloses[period - 1];
  return (stockReturn - spyReturn) * 100;
}

// ── Main sync function ────────────────────────────────────────

export async function syncSnapshot(
  onProgress?: SyncProgressCallback
): Promise<SyncResult> {
  const t0 = Date.now();

  // 1. Get universe from DB
  const stocks = await prisma.stock.findMany({
    where: { active: true },
    orderBy: { ticker: 'asc' },
  });

  if (stocks.length === 0) {
    throw new Error('No active stocks in the database. Run the seed first.');
  }

  // 2. Detect market regime
  const regime = await getMarketRegime();

  // 2b. Detect volatility regime (SPY ATR%-based)
  const volRegimeResult = await getVolRegime();
  const volRegime = volRegimeResult.volRegime;

  // 3. Get SPY data for relative strength calc (fetch once)
  const spyData = await getDailyPrices('SPY', 'full');
  const spyCloses = spyData.map((d) => d.close);
  const spyMa200 = calculateMA(spyCloses, 200);
  const spyPrice = spyCloses[0] || 0;

  // 3b. Get VWRL data to check dual-benchmark alignment for DRS scoring.
  // Uses cached data from getMarketRegime() call above — no extra Yahoo request.
  const vwrlData = await getDailyPrices('VWRL.L', 'full');
  const hasVwrl = vwrlData.length >= 200;
  let dualRegimeAligned = false;
  if (hasVwrl) {
    const vwrlCloses = vwrlData.map((d) => d.close);
    const vwrlMa200 = calculateMA(vwrlCloses, 200);
    const vwrlPrice = vwrlCloses[0] || 0;
    // Both benchmarks individually above their MA200 → aligned
    dualRegimeAligned = spyPrice > spyMa200 && vwrlPrice > vwrlMa200;
  } else {
    // VWRL unavailable — can't confirm alignment, default conservative
    dualRegimeAligned = false;
  }

  // Check regime stability (simple: is SPY clearly above/below MA200?)
  // Guard against division by zero when SPY data is unavailable
  const regimeStable = spyMa200 > 0
    ? Math.abs(spyPrice - spyMa200) / spyMa200 > 0.02
    : true; // Default to stable when data is unavailable

  // 4. Get open positions for cluster exposure calc
  const openPositions = await prisma.position.findMany({
    where: { status: 'OPEN' },
    include: { stock: true },
  });

  // Get user equity
  const defaultUser = await prisma.user.findFirst();
  const equity = defaultUser?.equity || 10000;

  // Calculate cluster/super-cluster risk exposure from open positions
  // HEDGE positions excluded from open risk per CLAUDE.md
  const clusterRisk = new Map<string, number>();
  const superClusterRisk = new Map<string, number>();
  let totalRisk = 0;

  for (const pos of openPositions) {
    // Skip HEDGE — excluded from risk calculations
    if ((pos.stock as { sleeve?: string }).sleeve === 'HEDGE') continue;
    const rawRisk = Math.max(0, (pos.entryPrice - pos.currentStop) * pos.shares);
    // Approximate GBP conversion
    const currency = (pos.stock.currency || 'USD').toUpperCase();
    let fxToGbp = 1;
    if (currency !== 'GBP' && currency !== 'GBX') {
      try { fxToGbp = await getFXRate(currency, 'GBP'); } catch { fxToGbp = 0.79; }
    } else if (currency === 'GBX') {
      fxToGbp = 0.01;
    }
    const riskGbp = rawRisk * fxToGbp;
    totalRisk += riskGbp;

    const cluster = pos.stock.cluster || 'General';
    clusterRisk.set(cluster, (clusterRisk.get(cluster) || 0) + riskGbp);

    const superCluster = pos.stock.superCluster || 'Other';
    superClusterRisk.set(superCluster, (superClusterRisk.get(superCluster) || 0) + riskGbp);
  }

  // Early-warning thresholds for snapshot display (not hard trading gates)
  const maxClusterPct = SNAPSHOT_CLUSTER_WARNING;
  const maxSuperClusterPct = SNAPSHOT_SUPER_CLUSTER_WARNING;

  // 5. Create the snapshot record
  const snapshot = await prisma.snapshot.create({
    data: {
      source: 'sync',
      filename: null,
      rowCount: 0,
    },
  });

  // 6. Process each stock in batches
  const failed: string[] = [];
  const failureReasons = new Map<string, string>();
  let done = 0;
  const batchData: Record<string, unknown>[] = [];
  // Cache daily bars (close only) for post-batch network isolation computation
  const dailyBarsCache = new Map<string, { date: string; close: number }[]>();

  for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
    const batch = stocks.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (stock) => {
        try {
          // Batch daily + weekly fetch together to avoid separate API calls
          const [daily, weekly] = await Promise.all([
            getDailyPrices(stock.ticker, 'full'),
            getWeeklyPrices(stock.ticker),
          ]);
          if (daily.length < 55) {
            throw new Error(`${INSUFFICIENT_DATA_PREFIX} ${daily.length} bars`);
          }

          const validation = validateTickerData(stock.ticker, daily);
          if (!validation.isValid) {
            throw new Error(`Invalid data: ${validation.issues.join('; ')}`);
          }

          const closes = daily.map((d) => d.close);
          const close = closes[0];

          // ── Technical indicators ──
          const atr14 = calculateATR(daily, 14);
          const atrPct = close > 0 ? (atr14 / close) * 100 : 0;
          const { adx, plusDI, minusDI } = calculateADX(daily, 14);
          const ma200 = closes.length >= 200 ? calculateMA(closes, 200) : 0;
          const ma50 = closes.length >= 50 ? calculateMA(closes, 50) : 0;
          const efficiency = calculateTrendEfficiency(closes, 20);

          // ── Highs / distances ──
          const high20 = nDayHigh(daily, 20);
          const high55 = nDayHigh(daily, 55);
          // Prior 20d high (excl today) — for USE_PRIOR_20D_HIGH_FOR_TRIGGER env var
          const priorHigh20 = daily.length > 1 ? nDayHigh(daily.slice(1), 20) : high20;
          const distTo20 = high20 > 0 ? ((high20 - close) / close) * 100 : 0;
          const distTo55 = high55 > 0 ? ((high55 - close) / close) * 100 : 0;

          // ── Entry / Stop levels (adaptive buffer — aligned with scan engine) ──
          const adaptiveBuffer = calculateAdaptiveBuffer(
            stock.ticker, high20, atr14, atrPct, priorHigh20, volRegime
          );
          const entryTrigger = adaptiveBuffer.adjustedEntryTrigger;
          const stopLevel = entryTrigger - atr14 * ATR_STOP_MULTIPLIER;

          // ── Chasing detection ──
          const chasing20 = chasingLastN(daily, 20, 5);
          const chasing55 = chasingLastN(daily, 55, 5);

          // ── ATR spike / collapse / compression ──
          const atrOld = atr20DaysAgo(daily);
          const atrSpiking = atrOld > 0 ? atr14 >= atrOld * 1.3 : false;
          const atrCollapsing = atrOld > 0 ? atr14 <= atrOld * 0.5 : false;
          // Ratio < 1 = compression (consolidation), > 1 = expansion
          const atrCompressionRatio = atrOld && atrOld > 0 ? atr14 / atrOld : null;

          // ── Volume ──
          const volRatio = volumeRatio(daily);
          const dVol20 = dollarVol20(daily);
          const liquidityOk = dVol20 > 500_000;

          // ── Breakout Integrity Score ──
          const avgVol10 = daily.length > 10
            ? daily.slice(1, 11).reduce((s, d) => s + d.volume, 0) / 10
            : 0;
          const bisScore = calcBIS(daily[0], avgVol10);

          // ── Relative strength ──
          const rsPct = await rsVsBenchmark(closes, spyCloses);

          // ── Weekly ADX (requires 28+ weeks) ──
          const weeklyAdx = weekly.length >= 29
            ? calculateADX(weekly, 14).adx
            : 0;

          // ── Status classification (aligned with scan-engine classifyCandidate) ──
          // Uses distance to ENTRY TRIGGER (not raw 20d high) to match scan engine
          const distToTrigger = entryTrigger > 0 ? ((entryTrigger - close) / close) * 100 : 0;
          let status: string;
          const priceAboveMa200 = ma200 > 0 && close > ma200;
          const bullishDI = plusDI > minusDI;

          if (!priceAboveMa200 || !bullishDI) {
            status = 'IGNORE';
          } else if (distToTrigger <= 2) {
            status = 'READY';
          } else if (distToTrigger <= 3) {
            status = 'WATCH';
          } else {
            status = 'FAR';
          }

          // Trend override
          if (priceAboveMa200 && adx >= 20 && bullishDI && distTo20 > 5) {
            status = 'TREND';
          }

          // ── Cluster exposure ──
          const cluster = stock.cluster || 'General';
          const superCluster = stock.superCluster || 'Other';
          const clusterRiskPct = equity > 0 ? ((clusterRisk.get(cluster) || 0) / equity) * 100 : 0;
          const superClusterRiskPct = equity > 0 ? ((superClusterRisk.get(superCluster) || 0) / equity) * 100 : 0;

          // ── Build raw JSON (all key-value pairs) ──
          const rawJson = JSON.stringify({
            ticker: stock.ticker,
            name: stock.name,
            sleeve: stock.sleeve,
            close, atr14, atrPct, adx14: adx, plusDI, minusDI,
            ma50, ma200, efficiency, weeklyAdx,
            high20, high55, distTo20, distTo55,
            entryTrigger, stopLevel,
            chasing20, chasing55,
            atrSpiking, atrCollapsing,
            volRatio, dVol20, liquidityOk,
            rsPct, regime, regimeStable,
            volRegime, dualRegimeAligned,
            status, cluster, superCluster,
            clusterRiskPct, superClusterRiskPct,
            bisScore,
          });

          // ── Earnings calendar lookup (from DB cache — no Yahoo call) ──
          let earningsInfo: { daysUntilEarnings: number | null } | null = null;
          try {
            earningsInfo = await getEarningsInfo(stock.ticker);
          } catch {
            // Non-critical — defaults to null (no penalty)
          }

          // ── Breakout evidence capture (Layer 2 advisory — never affects scan decisions) ──
          const breakoutSignal = computeBreakoutSignal(daily);
          const entropySignal = computeEntropy(daily);

          // ── Novel signals — passive capture for Phase 6 prediction engine ──
          const novelSignals = computeAllNovelSignals(daily);

          // Cache daily bars for post-batch network isolation computation
          dailyBarsCache.set(stock.ticker, daily.slice(0, 127).map((d) => ({ date: d.date, close: d.close })));

          return {
            snapshotId: snapshot.id,
            ticker: stock.ticker,
            name: stock.name,
            sleeve: stock.sleeve,
            status,
            currency: stock.currency,
            close,
            atr14,
            atrPct,
            adx14: adx,
            plusDi: plusDI,
            minusDi: minusDI,
            weeklyAdx,
            volRatio,
            dollarVol20: dVol20,
            liquidityOk,
            marketRegime: regime,
            marketRegimeStable: regimeStable,
            volRegime,
            dualRegimeAligned,
            high20,
            high55,
            distanceTo20dHighPct: distTo20,
            distanceTo55dHighPct: distTo55,
            entryTrigger,
            stopLevel,
            chasing20Last5: chasing20,
            chasing55Last5: chasing55,
            atrSpiking,
            atrCollapsing,
            atrCompressionRatio,
            rsVsBenchmarkPct: rsPct,
            // Earnings data from EarningsCache (populated nightly)
            daysToEarnings: earningsInfo?.daysUntilEarnings ?? null,
            earningsInNext5d: (earningsInfo?.daysUntilEarnings ?? 999) <= 5,
            clusterName: cluster,
            superClusterName: superCluster,
            clusterExposurePct: clusterRiskPct,
            superClusterExposurePct: superClusterRiskPct,
            maxClusterPct: maxClusterPct * 100,
            maxSuperClusterPct: maxSuperClusterPct * 100,
            bisScore,
            rawJson,
            // ── Breakout evidence (Layer 2 advisory, nullable) ──
            isBreakout20: breakoutSignal?.isBreakout20 ?? null,
            breakoutDistancePct: breakoutSignal?.breakoutDistancePct ?? null,
            breakoutWindowDays: breakoutSignal?.breakoutWindowDays ?? null,
            entropy63: entropySignal?.entropy63 ?? null,
            entropyObsCount: entropySignal?.obsCount ?? null,
            // ── Novel signals — passive Phase 6 capture ──
            smartMoney21: novelSignals.smartMoney21,
            fractalDim: novelSignals.fractalDim,
            complexity: novelSignals.complexity,
            novelSignalVersion: 2,
          };
        } catch (err) {
          const reason = (err as Error).message;
          console.warn(`[Sync] Failed ${stock.ticker}:`, reason);
          failed.push(stock.ticker);
          failureReasons.set(stock.ticker, reason);
          return null;
        }
      })
    );

    // Collect successful results for batch write at end
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        batchData.push(result.value);
        done++;
      }
    }

    // Report progress
    if (onProgress) {
      onProgress({
        total: stocks.length,
        done,
        failed: failed.length,
        ticker: batch[batch.length - 1]?.ticker || '',
      });
    }

    // Pause between batches (be kind to Yahoo)
    if (i + BATCH_SIZE < stocks.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // 6b. Post-batch: compute network isolation scores using cached daily bars.
  //     Each ticker is correlated against same-cluster peers. Layer 2 advisory only.
  try {
    // Group tickers by cluster for peer-based isolation scoring
    const clusterTickers = new Map<string, string[]>();
    for (const row of batchData) {
      const r = row as { ticker: string; clusterName?: string };
      const cl = r.clusterName || 'General';
      const list = clusterTickers.get(cl) || [];
      list.push(r.ticker);
      clusterTickers.set(cl, list);
    }

    for (const row of batchData) {
      const r = row as { ticker: string; clusterName?: string; netIsolation?: number | null; netIsolationPeerCount?: number | null; netIsolationObsCount?: number | null };
      const cl = r.clusterName || 'General';
      const peers = clusterTickers.get(cl) || [];
      const targetBars = dailyBarsCache.get(r.ticker);
      if (!targetBars || peers.length < 4) continue; // need ≥3 peers (excl self)

      const peerBarsMap = new Map<string, { date: string; close: number }[]>();
      for (const peer of peers) {
        if (peer === r.ticker) continue;
        const peerBars = dailyBarsCache.get(peer);
        if (peerBars) peerBarsMap.set(peer, peerBars);
      }

      const isolation = computeNetworkIsolation(targetBars, peerBarsMap);
      if (isolation) {
        r.netIsolation = isolation.netIsolation;
        r.netIsolationPeerCount = isolation.peerCount;
        r.netIsolationObsCount = isolation.obsCount;
      }
    }
  } catch (err) {
    // Network isolation failure is non-critical — continue with null values
    console.warn('[Sync] Network isolation post-processing failed:', (err as Error).message);
  }

  // Free memory — daily bars cache no longer needed
  dailyBarsCache.clear();

  // 7. Write collected rows in batches to reduce SQLite write-lock duration.
  //    Each batch holds the lock only for ~50 inserts instead of ~268.
  const WRITE_BATCH_SIZE = 50;
  for (let b = 0; b < batchData.length; b += WRITE_BATCH_SIZE) {
    const chunk = batchData.slice(b, b + WRITE_BATCH_SIZE);
    await prisma.$transaction(
      chunk.map((d) =>
        prisma.snapshotTicker.create({
          data: d as Parameters<typeof prisma.snapshotTicker.create>[0]['data'],
        })
      )
    );
  }

  // Only update rowCount after all batches committed successfully
  await prisma.snapshot.update({
    where: { id: snapshot.id },
    data: { rowCount: done },
  });

  return {
    snapshotId: snapshot.id,
    rowCount: done,
    failed,
    failureReasons,
    regime,
    durationMs: Date.now() - t0,
  };
}
