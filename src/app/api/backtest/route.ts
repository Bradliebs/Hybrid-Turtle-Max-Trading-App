/**
 * DEPENDENCIES
 * Consumed by: /backtest page (client-side fetch)
 * Consumes: prisma (SnapshotTicker, Snapshot), dual-score.ts
 * Risk-sensitive: NO — read-only signal audit, no position creation
 * Last modified: 2026-02-28
 * Notes: Signal Replay API. Detects historical trigger crossovers from
 *        existing SnapshotTicker data and computes forward R-multiples.
 *        No new Yahoo Finance calls. No new DB tables.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { apiError } from '@/lib/api-response';
import {
  scoreRow,
  type SnapshotRow,
} from '@/lib/dual-score';
import { calcBPSFromSnapshot, computeRsPercentiles } from '@/lib/breakout-probability';
import { ATR_TRAILING_MULTIPLIER } from '@/types';

export const dynamic = 'force-dynamic';

// ── Types ────────────────────────────────────────────────────

interface ForwardReturn {
  date: string;
  close: number;
  rMultiple: number;
  daysDelta: number;
}

interface SignalHit {
  ticker: string;
  name: string;
  sleeve: string;
  signalDate: string;
  entryPrice: number;
  entryTrigger: number;
  stopLevel: number;
  riskPerShare: number;
  regime: string;
  regimeStable: boolean;
  bqs: number;
  fws: number;
  ncs: number;
  actionNote: string;
  atrPct: number;
  adx: number;
  bps: number;  // Breakout Probability Score (0–19)
  // Forward returns (null if no subsequent snapshot at that horizon)
  fwd5: ForwardReturn | null;
  fwd10: ForwardReturn | null;
  fwd20: ForwardReturn | null;
  // Stop ladder simulation
  stopHit: boolean;
  stopHitDate: string | null;
  stopHitR: number | null;
  maxFavorableR: number | null;
  maxAdverseR: number | null;
}

// ── DB row → SnapshotRow (same mapping as scan/scores) ──────

function dbRowToSnapshotRow(row: Record<string, unknown>): SnapshotRow {
  return {
    ticker: row.ticker as string,
    name: (row.name as string) || (row.ticker as string),
    sleeve: (row.sleeve as string) || '',
    status: (row.status as string) || '',
    currency: (row.currency as string) || '',
    close: (row.close as number) || 0,
    atr_14: (row.atr14 as number) || 0,
    atr_pct: (row.atrPct as number) || 0,
    adx_14: (row.adx14 as number) || 0,
    plus_di: (row.plusDi as number) || 0,
    minus_di: (row.minusDi as number) || 0,
    vol_ratio: (row.volRatio as number) || 1,
    dollar_vol_20: (row.dollarVol20 as number) || 0,
    liquidity_ok: (row.liquidityOk as boolean) ?? true,
    market_regime: (row.marketRegime as string) || 'NEUTRAL',
    market_regime_stable: (row.marketRegimeStable as boolean) ?? true,
    high_20: (row.high20 as number) || 0,
    high_55: (row.high55 as number) || 0,
    distance_to_20d_high_pct: (row.distanceTo20dHighPct as number) || 0,
    distance_to_55d_high_pct: (row.distanceTo55dHighPct as number) || 0,
    entry_trigger: (row.entryTrigger as number) || 0,
    stop_level: (row.stopLevel as number) || 0,
    chasing_20_last5: (row.chasing20Last5 as boolean) ?? false,
    chasing_55_last5: (row.chasing55Last5 as boolean) ?? false,
    atr_spiking: (row.atrSpiking as boolean) ?? false,
    atr_collapsing: (row.atrCollapsing as boolean) ?? false,
    atr_compression_ratio: (row.atrCompressionRatio as number | null) ?? null,
    rs_vs_benchmark_pct: (row.rsVsBenchmarkPct as number) || 0,
    days_to_earnings: (row.daysToEarnings as number | null) ?? null,
    earnings_in_next_5d: (row.earningsInNext5d as boolean) ?? false,
    cluster_name: (row.clusterName as string) || '',
    super_cluster_name: (row.superClusterName as string) || '',
    cluster_exposure_pct: (row.clusterExposurePct as number) || 0,
    super_cluster_exposure_pct: (row.superClusterExposurePct as number) || 0,
    max_cluster_pct: (row.maxClusterPct as number) || 0,
    max_super_cluster_pct: (row.maxSuperClusterPct as number) || 0,
    weekly_adx: (row.weeklyAdx as number) || 0,
    vol_regime: (row.volRegime as string) || 'NORMAL_VOL',
    dual_regime_aligned: (row.dualRegimeAligned as boolean) ?? true,
    bis_score: (row.bisScore as number) || 0,
  };
}

// ── Stop ladder simulation ──────────────────────────────────
// Replays the monotonic stop ladder against subsequent prices
// without actually modifying any data. Pure calculation.

function simulateStopLadder(
  entryPrice: number,
  initialStop: number,
  forwardCloses: { date: string; close: number; atr14: number }[]
): { hit: boolean; hitDate: string | null; hitR: number | null; maxFavR: number; maxAdvR: number } {
  const riskPerShare = entryPrice - initialStop;
  if (riskPerShare <= 0) {
    return { hit: false, hitDate: null, hitR: null, maxFavR: 0, maxAdvR: 0 };
  }

  let currentStop = initialStop;
  let maxFavR = 0;
  let maxAdvR = 0;

  for (const snap of forwardCloses) {
    const rMultiple = (snap.close - entryPrice) / riskPerShare;
    maxFavR = Math.max(maxFavR, rMultiple);
    maxAdvR = Math.min(maxAdvR, rMultiple);

    // Check if stop hit (close fell to or below current stop)
    if (snap.close <= currentStop) {
      const hitR = (currentStop - entryPrice) / riskPerShare;
      return { hit: true, hitDate: snap.date, hitR, maxFavR, maxAdvR };
    }

    // Ratchet stop up based on R-multiple reached (monotonic — never decreases)
    if (rMultiple >= 3.0) {
      // LOCK_1R_TRAIL: max(entry + 1R, close - ATR_TRAILING_MULTIPLIER × ATR), as in live stop-manager
      const trailStop = Math.max(entryPrice + riskPerShare, snap.close - ATR_TRAILING_MULTIPLIER * snap.atr14);
      currentStop = Math.max(currentStop, trailStop);
    } else if (rMultiple >= 2.5) {
      // LOCK_08R: entry + 0.5R
      const lockStop = entryPrice + 0.5 * riskPerShare;
      currentStop = Math.max(currentStop, lockStop);
    } else if (rMultiple >= 1.5) {
      // BREAKEVEN: entry price
      currentStop = Math.max(currentStop, entryPrice);
    }
    // Below 1.5R: stop stays at INITIAL
  }

  return { hit: false, hitDate: null, hitR: null, maxFavR, maxAdvR };
}

// ── Find closest forward snapshot by day gap ────────────────

function findForwardReturn(
  forwardSnaps: { date: string; close: number }[],
  signalDate: Date,
  targetDays: number,
  riskPerShare: number,
  entryPrice: number
): ForwardReturn | null {
  if (forwardSnaps.length === 0 || riskPerShare <= 0) return null;

  // Find the snapshot closest to targetDays from signal date
  let best: { snap: { date: string; close: number }; daysDelta: number } | null = null;
  const tolerance = Math.max(3, targetDays * 0.4); // allow some flexibility

  for (const snap of forwardSnaps) {
    const snapDate = new Date(snap.date);
    const daysDelta = Math.round((snapDate.getTime() - signalDate.getTime()) / (1000 * 60 * 60 * 24));
    const diff = Math.abs(daysDelta - targetDays);

    if (diff <= tolerance) {
      if (!best || diff < Math.abs(best.daysDelta - targetDays)) {
        best = { snap, daysDelta };
      }
    }
  }

  if (!best) return null;

  const rMultiple = (best.snap.close - entryPrice) / riskPerShare;
  return {
    date: best.snap.date,
    close: best.snap.close,
    rMultiple: Math.round(rMultiple * 100) / 100,
    daysDelta: best.daysDelta,
  };
}

// ── Main handler ────────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const tickerFilter = searchParams.get('ticker') || null;
    const sleeveFilter = searchParams.get('sleeve') || null;
    const regimeFilter = searchParams.get('regime') || null;
    const modeParam = searchParams.get('mode') || 'FULL';
    const scanMode = modeParam === 'CORE_LITE' ? 'CORE_LITE' : 'FULL';
    const isCoreLite = scanMode === 'CORE_LITE';
    const limit = Math.min(Number(searchParams.get('limit') || '200'), 500);

    // 1. Load all snapshots ordered chronologically
    const snapshots = await prisma.snapshot.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true },
    });

    if (snapshots.length === 0) {
      return NextResponse.json({ ok: true, signals: [], meta: { snapshotCount: 0, signalCount: 0 } });
    }

    // 2. Load all snapshot tickers with the fields we need
    const where: Record<string, unknown> = {};
    if (tickerFilter) where.ticker = tickerFilter;
    if (sleeveFilter) where.sleeve = sleeveFilter;

    const allTickers = await prisma.snapshotTicker.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        snapshotId: true,
        ticker: true,
        name: true,
        sleeve: true,
        status: true,
        currency: true,
        close: true,
        atr14: true,
        atrPct: true,
        adx14: true,
        plusDi: true,
        minusDi: true,
        weeklyAdx: true,
        volRatio: true,
        dollarVol20: true,
        liquidityOk: true,
        bisScore: true,
        marketRegime: true,
        marketRegimeStable: true,
        volRegime: true,
        dualRegimeAligned: true,
        high20: true,
        high55: true,
        distanceTo20dHighPct: true,
        distanceTo55dHighPct: true,
        entryTrigger: true,
        stopLevel: true,
        chasing20Last5: true,
        chasing55Last5: true,
        atrSpiking: true,
        atrCollapsing: true,
        atrCompressionRatio: true,
        rsVsBenchmarkPct: true,
        daysToEarnings: true,
        earningsInNext5d: true,
        clusterName: true,
        superClusterName: true,
        clusterExposurePct: true,
        superClusterExposurePct: true,
        maxClusterPct: true,
        maxSuperClusterPct: true,
        createdAt: true,
      },
    });

    if (allTickers.length === 0) {
      return NextResponse.json({ ok: true, signals: [], meta: { snapshotCount: snapshots.length, signalCount: 0 } });
    }

    // 3. Build snapshot date lookup
    const snapshotDateMap = new Map<string, Date>();
    for (const s of snapshots) {
      snapshotDateMap.set(s.id, s.createdAt);
    }

    // 4. Group tickers by ticker symbol, sorted by snapshot date
    type TickerRow = (typeof allTickers)[number];
    const tickerHistory = new Map<string, TickerRow[]>();
    for (const row of allTickers) {
      const existing = tickerHistory.get(row.ticker) || [];
      existing.push(row);
      tickerHistory.set(row.ticker, existing);
    }

    // 5. Pre-compute RS percentile ranks per snapshot for cross-sectional Factor 3
    const rsPercentileBySnapshot = new Map<string, Map<string, number>>();
    {
      const bySnapshot = new Map<string, { ticker: string; rs: number }[]>();
      for (const row of allTickers) {
        const arr = bySnapshot.get(row.snapshotId) || [];
        arr.push({ ticker: row.ticker, rs: row.rsVsBenchmarkPct ?? 0 });
        bySnapshot.set(row.snapshotId, arr);
      }
      for (const [snapId, rows] of Array.from(bySnapshot)) {
        rsPercentileBySnapshot.set(snapId, computeRsPercentiles(rows));
      }
    }

    // 6. Detect trigger crossovers and compute signals
    const signals: SignalHit[] = [];

    for (const [ticker, history] of Array.from(tickerHistory)) {
      // Sort by snapshot date (should already be sorted, but ensure)
      history.sort((a: TickerRow, b: TickerRow) => {
        const dateA = snapshotDateMap.get(a.snapshotId)?.getTime() || 0;
        const dateB = snapshotDateMap.get(b.snapshotId)?.getTime() || 0;
        return dateA - dateB;
      });

      for (let i = 0; i < history.length; i++) {
        const current = history[i];
        const prev = i > 0 ? history[i - 1] : null;

        // Skip if entry trigger or stop level is missing/zero
        if (!current.entryTrigger || current.entryTrigger <= 0) continue;
        if (!current.stopLevel || current.stopLevel <= 0) continue;
        if (!current.close || current.close <= 0) continue;

        const entryPrice = current.close;
        const riskPerShare = entryPrice - current.stopLevel;
        if (riskPerShare <= 0) continue; // stop above entry = invalid

        // Detect trigger crossover:
        // Current close >= entryTrigger AND (no prior snapshot OR prior close < entryTrigger)
        const triggered = current.close >= current.entryTrigger;
        const prevBelow = !prev || prev.close < (prev.entryTrigger || current.entryTrigger);

        if (!triggered || !prevBelow) continue;

        // Apply regime filter
        if (regimeFilter && current.marketRegime !== regimeFilter) continue;

        // Score this snapshot row using the existing dual-score engine
        const snapshotRow = dbRowToSnapshotRow(current as unknown as Record<string, unknown>);
        const scored = scoreRow(snapshotRow);

        // CORE_LITE: compute scores for display but override ActionNote
        // In CORE_LITE, no earnings/cluster/super-cluster penalties apply
        const displayBqs = scored.BQS;
        const displayFws = scored.FWS;
        const displayNcs = isCoreLite
          ? Math.round(Math.max(0, Math.min(100, scored.BQS - 0.8 * scored.FWS + 10)) * 100) / 100
          : scored.NCS;  // FULL mode includes penalties
        const displayAction = isCoreLite ? 'CORE_LITE' : scored.ActionNote;

        const signalDate = snapshotDateMap.get(current.snapshotId) || current.createdAt;

        // Build forward snapshots for this ticker (all snapshots after the signal)
        const forwardSnaps = history.slice(i + 1).map((fwd: TickerRow) => ({
          date: (snapshotDateMap.get(fwd.snapshotId) || fwd.createdAt).toISOString(),
          close: fwd.close,
          atr14: fwd.atr14,
        }));

        // Find forward returns at 5, 10, 20 day horizons
        const fwd5 = findForwardReturn(forwardSnaps, signalDate, 5, riskPerShare, entryPrice);
        const fwd10 = findForwardReturn(forwardSnaps, signalDate, 10, riskPerShare, entryPrice);
        const fwd20 = findForwardReturn(forwardSnaps, signalDate, 20, riskPerShare, entryPrice);

        // Simulate stop ladder
        const stopSim = simulateStopLadder(entryPrice, current.stopLevel, forwardSnaps);

        // Compute BPS from snapshot data available at signal time
        const rsPercentile = rsPercentileBySnapshot.get(current.snapshotId)?.get(ticker) ?? null;
        const bpsResult = calcBPSFromSnapshot({
          atr_pct: snapshotRow.atr_pct,
          atr_compression_ratio: snapshotRow.atr_compression_ratio,
          rs_vs_benchmark_pct: snapshotRow.rs_vs_benchmark_pct,
          rsPercentile,
          weekly_adx: snapshotRow.weekly_adx as number | undefined,
          sector: snapshotRow.cluster_name as string | undefined,
        });


        signals.push({
          ticker,
          name: current.name || ticker,
          sleeve: current.sleeve || '',
          signalDate: signalDate.toISOString(),
          entryPrice,
          entryTrigger: current.entryTrigger,
          stopLevel: current.stopLevel,
          riskPerShare: Math.round(riskPerShare * 100) / 100,
          regime: current.marketRegime,
          regimeStable: current.marketRegimeStable,
          bqs: displayBqs,
          fws: displayFws,
          ncs: displayNcs,
          actionNote: displayAction,
          atrPct: current.atrPct,
          adx: current.adx14,
          bps: bpsResult.bps,
          fwd5,
          fwd10,
          fwd20,
          stopHit: stopSim.hit,
          stopHitDate: stopSim.hitDate,
          stopHitR: stopSim.hitR != null ? Math.round(stopSim.hitR * 100) / 100 : null,
          maxFavorableR: Math.round(stopSim.maxFavR * 100) / 100,
          maxAdverseR: Math.round(stopSim.maxAdvR * 100) / 100,
        });
      }
    }

    // Sort by signal date descending (most recent first)
    signals.sort((a, b) => new Date(b.signalDate).getTime() - new Date(a.signalDate).getTime());

    // Apply limit
    const limited = signals.slice(0, limit);

    // Compute summary stats
    const withOutcomes = signals.filter((s) => s.fwd20 != null);
    const winners = withOutcomes.filter((s) => s.fwd20 && s.fwd20.rMultiple > 0);
    const avgR20 = withOutcomes.length > 0
      ? Math.round((withOutcomes.reduce((sum, s) => sum + (s.fwd20?.rMultiple || 0), 0) / withOutcomes.length) * 100) / 100
      : null;
    const winRate = withOutcomes.length > 0
      ? Math.round((winners.length / withOutcomes.length) * 100)
      : null;
    const stopsHit = signals.filter((s) => s.stopHit).length;

    // 1R / 2R hit rates (for comparison)
    const with1R = withOutcomes.filter((s) => s.maxFavorableR != null && s.maxFavorableR >= 1.0).length;
    const with2R = withOutcomes.filter((s) => s.maxFavorableR != null && s.maxFavorableR >= 2.0).length;

    return NextResponse.json({
      ok: true,
      signals: limited,
      meta: {
        scanMode,
        snapshotCount: snapshots.length,
        totalSignals: signals.length,
        displayedSignals: limited.length,
        withOutcomes: withOutcomes.length,
        avgR20,
        winRate,
        stopsHit,
        stopsHitPct: signals.length > 0 ? Math.round((stopsHit / signals.length) * 100) : null,
        avgMaxFavorableR: signals.length > 0
          ? Math.round((signals.reduce((s, sig) => s + (sig.maxFavorableR || 0), 0) / signals.length) * 100) / 100
          : null,
        avgMaxAdverseR: signals.length > 0
          ? Math.round((signals.reduce((s, sig) => s + (sig.maxAdverseR || 0), 0) / signals.length) * 100) / 100
          : null,
        hit1RPct: withOutcomes.length > 0 ? Math.round((with1R / withOutcomes.length) * 100) : null,
        hit2RPct: withOutcomes.length > 0 ? Math.round((with2R / withOutcomes.length) * 100) : null,
      },
    });
  } catch (error) {
    console.error('[SignalReplay] Error:', error);
    return apiError(500, 'SIGNAL_REPLAY_FAILED', 'Failed to compute signal replay', (error as Error).message, true);
  }
}
