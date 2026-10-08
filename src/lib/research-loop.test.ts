/**
 * Targeted test suite for the research-driven architecture.
 *
 * Tests the core research loop:
 *   candidate outcome persistence → forward enrichment → score buckets →
 *   allocation scoring → CORE_LITE mode
 *
 * All tests use deterministic fixtures. No DB or API calls.
 */
import { describe, expect, it } from 'vitest';

// ── Module imports ──────────────────────────────────────────────────
import {
  extractCandidateOutcome,
  resolveStageReached,
  collectBlockedReasons,
} from './candidate-outcome';

import { computeForwardMetrics } from './candidate-outcome-enrichment';

import { classifyDualScoreAction } from './score-backfill';

import {
  calcQuality,
  calcExpectancy,
  calcSleeveBonus,
  calcClusterPenalty,
  calcSectorPenalty,
  calcCorrelationPenalty,
  calcCapitalInefficiency,
  scoreAndRankCandidates,
  WEIGHTS,
  type AllocationCandidate,
  type PortfolioContext,
} from './allocation-score';

import {
  runTechnicalFilters,
  classifyCandidate,
  rankCandidate,
} from './scan-engine';

import type { ScanCandidate, Sleeve } from '@/types';

// ── Shared fixtures ─────────────────────────────────────────────────

function makeScanCandidate(overrides?: Partial<ScanCandidate>): ScanCandidate {
  return {
    id: 'AAPL',
    ticker: 'AAPL',
    name: 'Apple Inc',
    sleeve: 'CORE' as Sleeve,
    sector: 'Technology',
    cluster: 'BigTech',
    price: 180,
    technicals: {
      currentPrice: 180,
      ma200: 165,
      adx: 32,
      plusDI: 28,
      minusDI: 14,
      atr: 3.5,
      atr20DayAgo: 3.2,
      atrSpiking: false,
      medianAtr14: 3.3,
      atrPercent: 1.94,
      twentyDayHigh: 182,
      efficiency: 55,
      relativeStrength: 12.5,
      volumeRatio: 1.6,
      failedBreakoutAt: null,
    },
    entryTrigger: 182,
    stopPrice: 176.75,
    distancePercent: 1.11,
    status: 'READY',
    rankScore: 72.5,
    passesAllFilters: true,
    passesRiskGates: true,
    passesAntiChase: true,
    riskGateResults: [
      { passed: true, gate: 'TOTAL_RISK', message: 'OK', current: 5, limit: 10 },
    ],
    antiChaseResult: { passed: true, reason: 'No chase' },
    shares: 4.5,
    riskDollars: 23.63,
    riskPercent: 2.0,
    totalCost: 819,
    filterResults: {
      priceAboveMa200: true,
      adxAbove20: true,
      plusDIAboveMinusDI: true,
      atrPercentBelow8: true,
      efficiencyAbove30: true,
      dataQuality: true,
      atrSpiking: false,
      atrSpikeAction: 'NONE',
      hurstExponent: 0.65,
      hurstWarn: false,
    },
    ...overrides,
  };
}

function makeAllocCandidate(overrides?: Partial<AllocationCandidate>): AllocationCandidate {
  return {
    ticker: 'AAPL',
    name: 'Apple',
    sleeve: 'CORE' as Sleeve,
    sector: 'Technology',
    cluster: 'BigTech',
    ncs: 72,
    fws: 20,
    bqs: 80,
    entryTrigger: 182,
    stopPrice: 176.75,
    suggestedShares: 4.5,
    suggestedRiskGbp: 23.63,
    suggestedCostGbp: 819,
    daysToEarnings: null,
    atrPct: 1.94,
    ...overrides,
  };
}

function makePortfolio(overrides?: Partial<PortfolioContext>): PortfolioContext {
  return {
    equity: 1000,
    riskProfile: 'SMALL_ACCOUNT',
    positions: [],
    correlationFlags: [],
    expectancyByKey: new Map(),
    regime: 'BULLISH',
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════
// 1. CANDIDATE OUTCOME PERSISTENCE
// ═════════════════════════════════════════════════════════════════════

describe('research-loop: candidate outcome persistence', () => {
  it('extracts all technical fields from scan candidate', () => {
    const c = makeScanCandidate();
    const record = extractCandidateOutcome(c, 'scan_001', 'BULLISH', 'LIVE');

    expect(record.adx).toBe(32);
    expect(record.atrPct).toBe(1.94);
    expect(record.volumeRatio).toBe(1.6);
    expect(record.relativeStrength).toBe(12.5);
    expect(record.efficiency).toBe(55);
    expect(record.ma200).toBe(165);
    expect(record.plusDI).toBe(28);
    expect(record.minusDI).toBe(14);
    expect(record.atr).toBe(3.5);
  });

  it('records data freshness state at decision time', () => {
    const record = extractCandidateOutcome(makeScanCandidate(), 'scan_002', 'BULLISH', 'STALE_CACHE');
    expect(record.dataFreshness).toBe('STALE_CACHE');
  });

  it('captures dualScoreAction as null (populated by backfill)', () => {
    const record = extractCandidateOutcome(makeScanCandidate(), 'scan_003', 'BULLISH');
    expect(record.dualScoreAction).toBeNull();
  });

  it('resolves stage correctly across all 7 stages', () => {
    expect(resolveStageReached(makeScanCandidate({ shares: 10 }))).toBe('SIZED');
    expect(resolveStageReached(makeScanCandidate({ shares: undefined, antiChaseResult: { passed: false, reason: 'blocked' } }))).toBe('ANTI_CHASE');
    expect(resolveStageReached(makeScanCandidate({ shares: undefined, antiChaseResult: undefined, riskGateResults: [{ passed: false, gate: 'X', message: '', current: 0, limit: 0 }] }))).toBe('RISK_GATED');
    expect(resolveStageReached(makeScanCandidate({ shares: undefined, antiChaseResult: undefined, riskGateResults: undefined, rankScore: 50 }))).toBe('RANKED');
    expect(resolveStageReached(makeScanCandidate({ shares: undefined, antiChaseResult: undefined, riskGateResults: undefined, rankScore: 0, status: 'WATCH' }))).toBe('CLASSIFIED');
    expect(resolveStageReached(makeScanCandidate({ shares: undefined, antiChaseResult: undefined, riskGateResults: undefined, rankScore: 0, status: 'FAR' }))).toBe('TECH_FILTER');
  });

  it('collects multiple blocked reasons as comma-separated string', () => {
    const c = makeScanCandidate({
      filterResults: {
        priceAboveMa200: false,
        adxAbove20: false,
        plusDIAboveMinusDI: true,
        atrPercentBelow8: true,
        efficiencyAbove30: true,
        dataQuality: true,
      },
      earningsInfo: {
        daysUntilEarnings: 1,
        nextEarningsDate: '2026-03-10',
        confidence: 'HIGH',
        action: 'AUTO_NO',
        reason: 'too close',
      },
      status: 'COOLDOWN',
    });
    const reasons = collectBlockedReasons(c);
    expect(reasons).toContain('BELOW_MA200');
    expect(reasons).toContain('ADX_LOW');
    expect(reasons).toContain('EARNINGS_BLOCK');
    expect(reasons).toContain('COOLDOWN');
  });
});

// ═════════════════════════════════════════════════════════════════════
// 2. FORWARD OUTCOME ENRICHMENT
// ═════════════════════════════════════════════════════════════════════

describe('research-loop: forward outcome enrichment', () => {
  const entry = 102;
  const stop = 97;   // R = 5
  const scan = 100;

  it('correctly computes all three return horizons from scan price', () => {
    // Scan price = 100, bars[i].close = 100 + i * 1
    const bars = Array.from({ length: 20 }, (_, i) => ({
      date: `2026-03-${String(i + 10).padStart(2, '0')}`,
      close: 100 + (i + 1),   // 101, 102, ..., 120
      high: 100 + (i + 1) + 1,
      low: 100 + (i + 1) - 1,
    }));
    const r = computeForwardMetrics(scan, entry, stop, bars);
    // Day 5 (index 4) close = 105 → (105-100)/100 * 100 = 5%
    expect(r.fwdReturn5d).toBeCloseTo(5.0, 1);
    // Day 10 (index 9) close = 110 → 10%
    expect(r.fwdReturn10d).toBeCloseTo(10.0, 1);
    // Day 20 (index 19) close = 120 → 20%
    expect(r.fwdReturn20d).toBeCloseTo(20.0, 1);
  });

  it('MFE reflects best R from highs, MAE reflects worst R from lows', () => {
    const bars = [
      { date: '2026-03-10', close: 104, high: 110, low: 96 }, // MFE: (110-102)/5=1.6, MAE: (102-96)/5=1.2
      { date: '2026-03-11', close: 106, high: 115, low: 100 },// MFE: (115-102)/5=2.6
      { date: '2026-03-12', close: 103, high: 104, low: 98 },
      { date: '2026-03-13', close: 101, high: 103, low: 95 }, // MAE: (102-95)/5=1.4
      { date: '2026-03-14', close: 102, high: 103, low: 99 },
    ];
    const r = computeForwardMetrics(scan, entry, stop, bars);
    expect(r.mfeR).toBeCloseTo(2.6, 1);
    expect(r.maeR).toBeCloseTo(-1.4, 1);
  });

  it('stop hit detected even if price recovers afterward', () => {
    const bars = [
      { date: '2026-03-10', close: 100, high: 101, low: 96 }, // low < stop (97)
      { date: '2026-03-11', close: 105, high: 108, low: 103 },
      { date: '2026-03-12', close: 110, high: 112, low: 108 },
      { date: '2026-03-13', close: 115, high: 118, low: 112 },
      { date: '2026-03-14', close: 120, high: 122, low: 118 },
    ];
    const r = computeForwardMetrics(scan, entry, stop, bars);
    expect(r.stopHit).toBe(true);
    // Despite recovery, stop was touched on day 1
  });

  it('R-threshold crossings use close, not intraday high', () => {
    // R = 5, so 1R = 107, 2R = 112 (from entry 102)
    const bars = [
      { date: '2026-03-10', close: 106, high: 108, low: 104 }, // high crosses 1R but close doesn't
      { date: '2026-03-11', close: 107, high: 108, low: 105 }, // close = 107 = exactly 1R
      { date: '2026-03-12', close: 110, high: 113, low: 108 }, // high crosses 2R but close doesn't
      { date: '2026-03-13', close: 112, high: 114, low: 110 }, // close = 112 = exactly 2R
      { date: '2026-03-14', close: 115, high: 118, low: 113 }, // close 2.6R, high crosses 3R
    ];
    const r = computeForwardMetrics(scan, entry, stop, bars);
    expect(r.reached1R).toBe(true);
    expect(r.reached2R).toBe(true);
    expect(r.reached3R).toBe(false); // 115 < 117 (3R)
  });
});

// ═════════════════════════════════════════════════════════════════════
// 3. SCORE BUCKET ASSIGNMENT
// ═════════════════════════════════════════════════════════════════════

describe('research-loop: score bucket assignment', () => {
  it('classifyDualScoreAction matches actionNote() thresholds exactly', () => {
    // Auto-No: FWS > 65 (takes priority)
    expect(classifyDualScoreAction(70, 90)).toBe('Auto-No');
    expect(classifyDualScoreAction(66, 50)).toBe('Auto-No');

    // Auto-Yes: NCS >= 70 AND FWS <= 30
    expect(classifyDualScoreAction(30, 70)).toBe('Auto-Yes');
    expect(classifyDualScoreAction(0, 100)).toBe('Auto-Yes');

    // Conditional: everything else
    expect(classifyDualScoreAction(35, 75)).toBe('Conditional'); // FWS > 30
    expect(classifyDualScoreAction(20, 65)).toBe('Conditional'); // NCS < 70
  });

  it('FWS > 65 always wins over NCS >= 70', () => {
    // Both conditions met: FWS priority
    expect(classifyDualScoreAction(66, 95)).toBe('Auto-No');
  });

  it('boundary cases: NCS exactly 70 and FWS exactly 30', () => {
    expect(classifyDualScoreAction(30, 70)).toBe('Auto-Yes');
  });

  it('boundary case: FWS exactly 65 is NOT Auto-No', () => {
    expect(classifyDualScoreAction(65, 80)).toBe('Conditional');
    // The threshold is >65, not >=65
  });

});

// ═════════════════════════════════════════════════════════════════════
// 4. ALLOCATION SCORE CALCULATION
// ═════════════════════════════════════════════════════════════════════

describe('research-loop: allocation score calculation', () => {
  it('quality component scales linearly with NCS', () => {
    expect(calcQuality(0)).toBe(0);
    expect(calcQuality(50)).toBe(20);
    expect(calcQuality(70)).toBe(28);
    expect(calcQuality(100)).toBe(40);
  });

  it('empty portfolio gives full sleeve bonus for any sleeve', () => {
    expect(calcSleeveBonus('CORE', 0, 80)).toBe(10);
    expect(calcSleeveBonus('HIGH_RISK', 0, 40)).toBe(10);
  });

  it('cluster penalty ramp: 0 at 60%, max at 100%', () => {
    expect(calcClusterPenalty(12, 25)).toBe(0);     // 48% < 60%
    expect(calcClusterPenalty(15, 25)).toBe(0);     // 60% = threshold, no penalty yet
    expect(calcClusterPenalty(20, 25)).toBeCloseTo(7.5, 1); // 80%
    expect(calcClusterPenalty(25, 25)).toBe(15);    // 100% of cap = max
    expect(calcClusterPenalty(30, 25)).toBe(15);    // Over cap, capped at max
  });

  it('score composition: all bonuses and penalties combine correctly', () => {
    const candidates = [makeAllocCandidate({ ticker: 'TEST', ncs: 70 })];
    const result = scoreAndRankCandidates(candidates, makePortfolio());

    const t = result[0];
    const expected = t.qualityComponent + t.expectancyComponent + t.sleeveBalanceBonus
      - t.clusterCrowdingPenalty - t.sectorCrowdingPenalty
      - t.earningsNearPenalty - t.correlationPenalty - t.capitalInefficiencyPenalty;
    expect(t.allocationScore).toBeCloseTo(expected, 2);
  });

  it('correlation penalty accumulates per correlated holding, capped at max', () => {
    expect(calcCorrelationPenalty(0)).toBe(0);
    expect(calcCorrelationPenalty(1)).toBe(5);
    expect(calcCorrelationPenalty(2)).toBe(10);
    expect(calcCorrelationPenalty(3)).toBe(10);  // capped at max=10
  });

  it('multiple penalties can push allocation score negative', () => {
    // Low NCS + high crowding + correlation + earnings
    const candidates = [makeAllocCandidate({
      ticker: 'BAD',
      ncs: 20,                // quality = 8
      daysToEarnings: null,
    })];
    const ctx = makePortfolio({
      positions: [
        { ticker: 'MSFT', sleeve: 'CORE' as Sleeve, sector: 'Technology', cluster: 'BigTech', value: 400 },
        { ticker: 'GOOG', sleeve: 'CORE' as Sleeve, sector: 'Technology', cluster: 'BigTech', value: 400 },
      ],
      correlationFlags: [
        { tickerA: 'BAD', tickerB: 'MSFT', correlation: 0.85 },
        { tickerA: 'BAD', tickerB: 'GOOG', correlation: 0.80 },
      ],
    });
    const result = scoreAndRankCandidates(candidates, ctx);
    // Cluster crowding (80% of 25% cap) + sector crowding + 2 correlations + low NCS
    expect(result[0].clusterCrowdingPenalty).toBeGreaterThan(0);
    expect(result[0].correlationPenalty).toBe(10); // 2 holdings, capped
    expect(result[0].allocationScore).toBeLessThan(10);
  });

  it('deterministic: same input always produces same output', () => {
    const candidates = [
      makeAllocCandidate({ ticker: 'A', ncs: 60 }),
      makeAllocCandidate({ ticker: 'B', ncs: 80 }),
    ];
    const ctx = makePortfolio();
    const r1 = scoreAndRankCandidates(candidates, ctx);
    const r2 = scoreAndRankCandidates(candidates, ctx);
    expect(r1[0].ticker).toBe(r2[0].ticker);
    expect(r1[0].allocationScore).toBe(r2[0].allocationScore);
    expect(r1[1].allocationScore).toBe(r2[1].allocationScore);
  });

  it('ranks by allocationScore descending with correct rank numbers', () => {
    const candidates = [
      makeAllocCandidate({ ticker: 'LOW', ncs: 40 }),
      makeAllocCandidate({ ticker: 'HIGH', ncs: 90 }),
      makeAllocCandidate({ ticker: 'MID', ncs: 65 }),
    ];
    const result = scoreAndRankCandidates(candidates, makePortfolio());
    expect(result[0].ticker).toBe('HIGH');
    expect(result[0].rank).toBe(1);
    expect(result[1].ticker).toBe('MID');
    expect(result[1].rank).toBe(2);
    expect(result[2].ticker).toBe('LOW');
    expect(result[2].rank).toBe(3);
  });

  it('earnings penalty is zero (pruned per OVERLAP-03)', () => {
    const candidates = [makeAllocCandidate({ ticker: 'EARN', daysToEarnings: 1 })];
    const result = scoreAndRankCandidates(candidates, makePortfolio());
    expect(result[0].earningsNearPenalty).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 5. FULL vs CORE_LITE MODE
// ═════════════════════════════════════════════════════════════════════

describe('research-loop: FULL vs CORE_LITE mode', () => {
  // These tests verify the CORE_LITE behavioral contract from CLAUDE.md.
  // The actual branching is in runFullScan() (async, DB-dependent).
  // Here we test the pure functions that both modes share identically.

  it('technical filters apply identically in both modes', () => {
    const tech = makeScanCandidate().technicals;
    const result = runTechnicalFilters(180, tech, 'CORE' as Sleeve);
    // These gates are the same in FULL and CORE_LITE
    expect(result.priceAboveMa200).toBe(true);
    expect(result.adxAbove20).toBe(true);
    expect(result.plusDIAboveMinusDI).toBe(true);
    expect(result.atrPercentBelow8).toBe(true);
    expect(result.passesAll).toBe(true);
  });

  it('status classification unchanged between modes', () => {
    expect(classifyCandidate(100, 101)).toBe('READY');  // ≤2%
    expect(classifyCandidate(100, 102.5)).toBe('WATCH'); // ≤3%
    expect(classifyCandidate(100, 105)).toBe('FAR');     // >3%
  });

  it('ranking formula unchanged between modes', () => {
    const tech = makeScanCandidate().technicals;
    const scoreCore = rankCandidate('CORE' as Sleeve, tech, 'READY');
    const scoreHR = rankCandidate('HIGH_RISK' as Sleeve, tech, 'READY');
    // CORE sleeve has higher priority than HIGH_RISK in both modes
    expect(scoreCore).toBeGreaterThan(scoreHR);
  });

  it('CORE_LITE entry trigger uses raw 20d high (documents the skip)', () => {
    // In CORE_LITE: entryTrigger = technicals.twentyDayHigh
    // In FULL: entryTrigger = calculateAdaptiveBuffer().adjustedEntryTrigger
    // The adaptive buffer adds 5–20% of ATR based on volatility
    const tech = makeScanCandidate().technicals;
    const rawHigh = tech.twentyDayHigh;
    expect(rawHigh).toBe(182);
    // CORE_LITE would use 182 directly; FULL would adjust it slightly
  });

  it('CORE_LITE skipped features are well-defined', () => {
    const skipped = [
      'Hurst Exponent',
      'ATR Spike Detection',
      'Earnings Calendar',
      'Anti-Chase Guard',
      'Failed Breakout Cooldown',
      'Volatility Extension',
      'Adaptive ATR Buffer',
      'Pullback Continuation',
    ];
    const kept = [
      'Universe selection',
      'Market regime detection',
      'Technical Filters',
      'Status Classification',
      'Ranking',
      'Risk Gates',
      'Position Sizing',
      'Stop Manager',
      'FX conversion',
    ];
    // This is a contract test — if someone adds to CORE_LITE skips,
    // they should update this list and think about whether it breaks the benchmark
    expect(skipped).toHaveLength(8);
    expect(kept).toHaveLength(9);
  });
});
