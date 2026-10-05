import { describe, expect, it } from 'vitest';
import {
  classifyCandidate,
  classifyCandidates,
  gradeLabel,
  gradeColor,
  DEFAULT_GRADE_THRESHOLDS,
  type CandidateGrade,
  type GradingContext,
  type GradeThresholds,
} from './candidate-grade';
import type { ScanCandidate } from '@/types';

// ── Test fixtures ────────────────────────────────────────────

function makeCandidate(overrides: Partial<ScanCandidate> = {}): ScanCandidate {
  return {
    id: 'test-1',
    ticker: 'AAPL',
    name: 'Apple Inc',
    sleeve: 'CORE',
    sector: 'Technology',
    cluster: 'Big Tech',
    price: 183,
    technicals: {
      currentPrice: 183,
      ma200: 160,
      adx: 30,
      plusDI: 25,
      minusDI: 15,
      atr: 3,
      atr20DayAgo: 2.8,
      atrSpiking: false,
      medianAtr14: 2.9,
      atrPercent: 1.7,
      twentyDayHigh: 182,
      efficiency: 55,
      relativeStrength: 62,
      volumeRatio: 1.3,
      failedBreakoutAt: null,
    },
    entryTrigger: 182,
    stopPrice: 175,
    distancePercent: -0.55,
    status: 'READY',
    rankScore: 75,
    passesAllFilters: true,
    passesRiskGates: true,
    passesAntiChase: true,
    shares: 5,
    riskDollars: 35,
    riskPercent: 1.75,
    totalCost: 900,
    filterResults: {
      priceAboveMa200: true,
      adxAbove20: true,
      plusDIAboveMinusDI: true,
      atrPercentBelow8: true,
      efficiencyAbove30: true,
      dataQuality: true,
      atrSpiking: false,
      atrSpikeAction: 'NONE',
    },
    ...overrides,
  };
}

const BULLISH_GREEN: GradingContext = {
  regime: 'BULLISH',
  healthOverall: 'GREEN',
  ncs: 75,
  bqs: 65,
  fws: 20,
};

// ── A_GRADE_BUY tests ────────────────────────────────────────

describe('candidate-grade: A_GRADE_BUY', () => {
  it('standard strong candidate gets A_GRADE_BUY', () => {
    const result = classifyCandidate(makeCandidate(), BULLISH_GREEN);
    expect(result.grade).toBe('A_GRADE_BUY');
    expect(result.reason).toContain('All filters pass');
  });

  it('trigger-met candidate gets A_GRADE_BUY', () => {
    const result = classifyCandidate(
      makeCandidate({ price: 183, entryTrigger: 182 }),
      BULLISH_GREEN,
    );
    expect(result.grade).toBe('A_GRADE_BUY');
    expect(result.reason).toContain('Trigger met');
  });

  it('READY but price below entryTrigger → B_GRADE_WATCH (breakout not confirmed)', () => {
    // Regression guard for F-1: anticipatory READY entries must not auto-trade.
    // Documented spec is breakout-confirmed; un-triggered READY is watchlist-only.
    const result = classifyCandidate(
      makeCandidate({ price: 180, entryTrigger: 182, status: 'READY' }),
      BULLISH_GREEN,
    );
    expect(result.grade).toBe('B_GRADE_WATCH');
    const statusCheck = result.checks.find(c => c.name === 'status');
    expect(statusCheck?.passed).toBe(false);
    expect(statusCheck?.detail).toContain('breakout not yet confirmed');
  });

  it('READY below entryTrigger stays B_GRADE_WATCH even with exceptional scores', () => {
    // Auto-buy requires confirmed breakout. Strong scores must not promote
    // a below-trigger READY candidate into A-grade.
    const result = classifyCandidate(
      makeCandidate({ price: 181, entryTrigger: 182, status: 'READY' }),
      { ...BULLISH_GREEN, ncs: 85, fws: 15, bqs: 80 },
    );
    expect(result.grade).toBe('B_GRADE_WATCH');
    expect(result.reason).toContain('breakout not yet confirmed');
  });

  it('checks include all required fields', () => {
    const result = classifyCandidate(makeCandidate(), BULLISH_GREEN);
    const checkNames = result.checks.map(c => c.name);
    expect(checkNames).toContain('regime');
    expect(checkNames).toContain('health');
    expect(checkNames).toContain('earnings');
    expect(checkNames).toContain('riskGates');
    expect(checkNames).toContain('volume');
    expect(checkNames).toContain('relativeStrength');
    expect(checkNames).toContain('ncs');
    expect(checkNames).toContain('fws');
    expect(checkNames).toContain('bqs');
  });
});

// ── B_GRADE_WATCH tests ─────────────────────────────────────

describe('candidate-grade: B_GRADE_WATCH', () => {
  it('low NCS → B_GRADE_WATCH', () => {
    const result = classifyCandidate(makeCandidate(), { ...BULLISH_GREEN, ncs: 60 });
    expect(result.grade).toBe('B_GRADE_WATCH');
    expect(result.reason).toContain('not A-grade');
  });

  it('high FWS → B_GRADE_WATCH', () => {
    const result = classifyCandidate(makeCandidate(), { ...BULLISH_GREEN, fws: 40 });
    expect(result.grade).toBe('B_GRADE_WATCH');
  });

  it('low volume ratio → B_GRADE_WATCH', () => {
    const result = classifyCandidate(
      makeCandidate({ technicals: { ...makeCandidate().technicals, volumeRatio: 0.5 } }),
      BULLISH_GREEN,
    );
    expect(result.grade).toBe('B_GRADE_WATCH');
  });

  it('ATR spiking → B_GRADE_WATCH (not blocked)', () => {
    const result = classifyCandidate(
      makeCandidate({ filterResults: { ...makeCandidate().filterResults, atrSpiking: true } }),
      BULLISH_GREEN,
    );
    expect(result.grade).toBe('B_GRADE_WATCH');
  });

  it('WATCH status → B_GRADE_WATCH', () => {
    // WATCH = >2% but ≤3% from trigger — by construction price < entryTrigger.
    const result = classifyCandidate(
      makeCandidate({ status: 'WATCH', price: 180, entryTrigger: 184 }),
      BULLISH_GREEN,
    );
    expect(result.grade).toBe('B_GRADE_WATCH');
  });

  it('relative strength below 50 (lagging SPY) → B_GRADE_WATCH; 50 (level, or the missing-data default) passes', () => {
    const lagging = classifyCandidate(
      makeCandidate({ technicals: { ...makeCandidate().technicals, relativeStrength: 49.9 } }),
      BULLISH_GREEN,
    );
    expect(lagging.grade).toBe('B_GRADE_WATCH');
    expect(lagging.reason).toContain('RS 49.9 < 50 (50 = level with SPY)');
    const level = classifyCandidate(
      makeCandidate({ technicals: { ...makeCandidate().technicals, relativeStrength: 50 } }),
      BULLISH_GREEN,
    );
    expect(level.grade).toBe('A_GRADE_BUY');
  });

  it('stale scores (missed nightly) → B_GRADE_WATCH even when the numbers pass', () => {
    const result = classifyCandidate(makeCandidate(), { ...BULLISH_GREEN, scoresStale: true });
    expect(result.grade).toBe('B_GRADE_WATCH');
    expect(result.checks.find(c => c.name === 'scoreFreshness')?.passed).toBe(false);
  });

  it('earnings in 3–5 days (scanner DEMOTE_WATCH) → B_GRADE_WATCH even after the trigger is met', () => {
    const result = classifyCandidate(
      makeCandidate({
        status: 'WATCH',
        earningsInfo: { daysUntilEarnings: 4, nextEarningsDate: '2026-10-09', confidence: 'HIGH', action: 'DEMOTE_WATCH', reason: 'earnings in 4 days' },
      }),
      BULLISH_GREEN,
    );
    expect(result.grade).toBe('B_GRADE_WATCH');
    expect(result.reason).toContain('Earnings in 4 days');
  });

  it('low-efficiency demotion to WATCH stays advisory: a triggered candidate can still be A-grade', () => {
    const result = classifyCandidate(
      makeCandidate({ status: 'WATCH', filterResults: { ...makeCandidate().filterResults, efficiencyAbove30: false } }),
      BULLISH_GREEN,
    );
    expect(result.grade).toBe('A_GRADE_BUY');
  });
});

// ── C_GRADE_IGNORE tests ────────────────────────────────────

describe('candidate-grade: C_GRADE_IGNORE', () => {
  it('FAR status → C_GRADE_IGNORE', () => {
    const result = classifyCandidate(
      makeCandidate({ status: 'FAR', passesAllFilters: false }),
      BULLISH_GREEN,
    );
    expect(result.grade).toBe('C_GRADE_IGNORE');
  });

  it('failed technical filters + FAR → C_GRADE_IGNORE', () => {
    const result = classifyCandidate(
      makeCandidate({ passesAllFilters: false, status: 'FAR' }),
      BULLISH_GREEN,
    );
    expect(result.grade).toBe('C_GRADE_IGNORE');
  });
});

// ── BLOCKED tests ───────────────────────────────────────────

describe('candidate-grade: BLOCKED_REGIME', () => {
  it('BEARISH regime → BLOCKED_REGIME', () => {
    const result = classifyCandidate(makeCandidate(), { ...BULLISH_GREEN, regime: 'BEARISH' });
    expect(result.grade).toBe('BLOCKED_REGIME');
    expect(result.reason).toContain('BEARISH');
  });

  it('SIDEWAYS regime → BLOCKED_REGIME', () => {
    const result = classifyCandidate(makeCandidate(), { ...BULLISH_GREEN, regime: 'SIDEWAYS' });
    expect(result.grade).toBe('BLOCKED_REGIME');
  });
});

describe('candidate-grade: BLOCKED_DATA', () => {
  it('RED health → BLOCKED_DATA', () => {
    const result = classifyCandidate(makeCandidate(), { ...BULLISH_GREEN, healthOverall: 'RED' });
    expect(result.grade).toBe('BLOCKED_DATA');
    expect(result.reason).toContain('RED');
  });

  it('data quality false → BLOCKED_DATA', () => {
    const result = classifyCandidate(
      makeCandidate({ filterResults: { ...makeCandidate().filterResults, dataQuality: false } }),
      BULLISH_GREEN,
    );
    expect(result.grade).toBe('BLOCKED_DATA');
  });
});

describe('candidate-grade: BLOCKED_EVENT', () => {
  it('EARNINGS_BLOCK status → BLOCKED_EVENT', () => {
    const result = classifyCandidate(
      makeCandidate({ status: 'EARNINGS_BLOCK' }),
      BULLISH_GREEN,
    );
    expect(result.grade).toBe('BLOCKED_EVENT');
    expect(result.reason).toContain('earnings');
  });

  it('earningsInfo AUTO_NO → BLOCKED_EVENT', () => {
    const result = classifyCandidate(
      makeCandidate({
        earningsInfo: { daysUntilEarnings: 2, nextEarningsDate: '2026-04-28', confidence: 'HIGH', action: 'AUTO_NO', reason: 'earnings in 2 days' },
      }),
      BULLISH_GREEN,
    );
    expect(result.grade).toBe('BLOCKED_EVENT');
  });
});

describe('candidate-grade: BLOCKED_CHASE', () => {
  it('WAIT_PULLBACK status → BLOCKED_CHASE', () => {
    const result = classifyCandidate(
      makeCandidate({ status: 'WAIT_PULLBACK' }),
      BULLISH_GREEN,
    );
    expect(result.grade).toBe('BLOCKED_CHASE');
    expect(result.reason).toContain('pullback');
  });

  it('anti-chase failed → BLOCKED_CHASE', () => {
    const result = classifyCandidate(
      makeCandidate({ passesAntiChase: false, antiChaseResult: { passed: false, reason: 'gap too large' } }),
      BULLISH_GREEN,
    );
    expect(result.grade).toBe('BLOCKED_CHASE');
  });

  it('COOLDOWN status → BLOCKED_CHASE', () => {
    const result = classifyCandidate(
      makeCandidate({ status: 'COOLDOWN' }),
      BULLISH_GREEN,
    );
    expect(result.grade).toBe('BLOCKED_CHASE');
    expect(result.reason).toContain('cooldown');
  });
});

describe('candidate-grade: BLOCKED_RISK', () => {
  it('risk gates failed → BLOCKED_RISK', () => {
    const result = classifyCandidate(
      makeCandidate({
        passesRiskGates: false,
        riskGateResults: [{ passed: false, gate: 'Max Positions', message: '4/4 positions open', current: 4, limit: 4 }],
      }),
      BULLISH_GREEN,
    );
    expect(result.grade).toBe('BLOCKED_RISK');
    expect(result.reason).toContain('4/4 positions open');
  });

  it('zero shares after sizing → BLOCKED_RISK', () => {
    const result = classifyCandidate(
      makeCandidate({ shares: 0 }),
      BULLISH_GREEN,
    );
    expect(result.grade).toBe('BLOCKED_RISK');
    expect(result.reason).toContain('zero');
  });
});

// ── Threshold customization ─────────────────────────────────

describe('candidate-grade: custom thresholds', () => {
  it('custom minNCS changes A→B boundary', () => {
    const strict: GradeThresholds = { ...DEFAULT_GRADE_THRESHOLDS, minNCS: 80 };
    const result = classifyCandidate(makeCandidate(), { ...BULLISH_GREEN, ncs: 75 }, strict);
    expect(result.grade).toBe('B_GRADE_WATCH');
  });

  it('custom minBQS changes A→B boundary', () => {
    const strict: GradeThresholds = { ...DEFAULT_GRADE_THRESHOLDS, minBQS: 70 };
    const result = classifyCandidate(makeCandidate(), { ...BULLISH_GREEN, bqs: 65 }, strict);
    expect(result.grade).toBe('B_GRADE_WATCH');
  });

  it('relaxed thresholds promote B→A', () => {
    const relaxed: GradeThresholds = { ...DEFAULT_GRADE_THRESHOLDS, minNCS: 50, minBQS: 40 };
    const result = classifyCandidate(makeCandidate(), { ...BULLISH_GREEN, ncs: 55, bqs: 45 }, relaxed);
    expect(result.grade).toBe('A_GRADE_BUY');
  });
});

// ── Batch classification ────────────────────────────────────

describe('candidate-grade: batch', () => {
  it('classifyCandidates returns grade for each candidate', () => {
    const candidates = [
      makeCandidate({ ticker: 'AAPL' }),
      makeCandidate({ ticker: 'GOOG', status: 'WATCH', price: 180, entryTrigger: 184 }),
      makeCandidate({ ticker: 'TSLA', status: 'EARNINGS_BLOCK' }),
    ];
    const results = classifyCandidates(candidates, BULLISH_GREEN);
    expect(results).toHaveLength(3);
    expect(results[0].classification.grade).toBe('A_GRADE_BUY');
    expect(results[1].classification.grade).toBe('B_GRADE_WATCH');
    expect(results[2].classification.grade).toBe('BLOCKED_EVENT');
  });

  it('classifyCandidates accepts a per-candidate context resolver function', () => {
    // Two candidates: one with strong scores via resolver, one with weak
    // scores. The shared base context (regime/health) is derived inside
    // the resolver from the candidate's ticker.
    const baseCtx = { regime: 'BULLISH', healthOverall: 'GREEN' } as const;
    const scoresByTicker = new Map<string, { ncs: number; fws: number; bqs: number }>([
      ['EZPW', { ncs: 100, fws: 12, bqs: 100 }], // A-grade scores
      ['WEAK', { ncs: 40, fws: 60, bqs: 30 }],   // sub-A scores
    ]);

    const results = classifyCandidates(
      [
        makeCandidate({ ticker: 'EZPW' }),
        makeCandidate({ ticker: 'WEAK' }),
      ],
      (candidate) => {
        const s = scoresByTicker.get(candidate.ticker);
        return s ? { ...baseCtx, ncs: s.ncs, fws: s.fws, bqs: s.bqs } : baseCtx;
      },
    );

    expect(results[0].classification.grade).toBe('A_GRADE_BUY');
    expect(results[1].classification.grade).toBe('B_GRADE_WATCH');
  });

  it('classifyCandidates resolver receiving no scores yields B_GRADE_WATCH not A', () => {
    // Reproduces the original bug: when the resolver returns the bare
    // GradingContext (no ncs/fws/bqs), the grader must default to worst
    // case and demote even a perfectly clean candidate.
    const baseCtx = { regime: 'BULLISH', healthOverall: 'GREEN' } as const;
    const results = classifyCandidates(
      [makeCandidate({ ticker: 'NO_SCORES' })],
      () => baseCtx,
    );
    expect(results[0].classification.grade).toBe('B_GRADE_WATCH');
    expect(results[0].classification.reason).toContain('NCS 0');
  });
});

// ── Display helpers ─────────────────────────────────────────

describe('candidate-grade: display helpers', () => {
  it('gradeLabel returns human-readable label for all grades', () => {
    const allGrades: CandidateGrade[] = [
      'A_GRADE_BUY', 'B_GRADE_WATCH', 'C_GRADE_IGNORE',
      'BLOCKED_RISK', 'BLOCKED_REGIME', 'BLOCKED_CHASE', 'BLOCKED_DATA', 'BLOCKED_EVENT',
    ];
    for (const g of allGrades) {
      expect(gradeLabel(g)).toBeTruthy();
      expect(gradeLabel(g).length).toBeGreaterThan(0);
    }
  });

  it('gradeColor returns color triplet for all grades', () => {
    const allGrades: CandidateGrade[] = [
      'A_GRADE_BUY', 'B_GRADE_WATCH', 'C_GRADE_IGNORE',
      'BLOCKED_RISK', 'BLOCKED_REGIME', 'BLOCKED_CHASE', 'BLOCKED_DATA', 'BLOCKED_EVENT',
    ];
    for (const g of allGrades) {
      const c = gradeColor(g);
      expect(c.bg).toBeTruthy();
      expect(c.text).toBeTruthy();
      expect(c.border).toBeTruthy();
    }
  });
});

// ── Priority / ordering tests ───────────────────────────────

describe('candidate-grade: priority ordering', () => {
  it('regime block takes priority over everything else', () => {
    const result = classifyCandidate(
      makeCandidate({ status: 'EARNINGS_BLOCK', passesRiskGates: false }),
      { ...BULLISH_GREEN, regime: 'BEARISH' },
    );
    expect(result.grade).toBe('BLOCKED_REGIME');
  });

  it('health RED takes priority over earnings', () => {
    const result = classifyCandidate(
      makeCandidate({ status: 'EARNINGS_BLOCK' }),
      { ...BULLISH_GREEN, healthOverall: 'RED' },
    );
    expect(result.grade).toBe('BLOCKED_DATA');
  });

  it('earnings block takes priority over anti-chase', () => {
    const result = classifyCandidate(
      makeCandidate({ status: 'EARNINGS_BLOCK', passesAntiChase: false }),
      BULLISH_GREEN,
    );
    expect(result.grade).toBe('BLOCKED_EVENT');
  });

  it('anti-chase takes priority over risk gates', () => {
    const result = classifyCandidate(
      makeCandidate({ passesAntiChase: false, passesRiskGates: false }),
      BULLISH_GREEN,
    );
    expect(result.grade).toBe('BLOCKED_CHASE');
  });
});
