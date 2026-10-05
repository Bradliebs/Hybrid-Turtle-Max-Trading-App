/**
 * Unit tests for src/lib/persist-scan-snapshot.ts
 *
 * Mocks the database and the downstream persistence/grading helpers so the
 * orchestration can be tested without a real DB or the full scan engine.
 * The critical guarantee under test: graded candidates and the model-layer
 * metadata are always returned to the caller, even when the DB write throws
 * (non-fatal persistence), so neither the dashboard nor the scheduled scan
 * loses its result because of a transient DB problem.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const healthFindFirst = vi.fn();
const stockFindMany = vi.fn();
const scanCreate = vi.fn();

vi.mock('@/lib/prisma', () => ({
  default: {
    healthCheck: { findFirst: (args: unknown) => healthFindFirst(args) },
    stock: { findMany: (args: unknown) => stockFindMany(args) },
    scan: { create: (args: unknown) => scanCreate(args) },
  },
}));

// scan-engine is only imported for its return type, but the runtime import
// must resolve — stub it so the heavy/sacred engine is never loaded here.
vi.mock('@/lib/scan-engine', () => ({ runFullScan: vi.fn() }));

const applyModelLayerToCandidates = vi.fn();
vi.mock('../../packages/model/src', () => ({
  applyModelLayerToCandidates: (...args: unknown[]) => applyModelLayerToCandidates(...args),
}));

const classifyCandidates = vi.fn();
vi.mock('@/lib/candidate-grade', () => ({
  classifyCandidates: (...args: unknown[]) => classifyCandidates(...args),
}));

const getLatestScoresByTicker = vi.fn();
vi.mock('@/lib/score-lookup', async (importOriginal) => ({
  isScoreStale: (await importOriginal<typeof import('./score-lookup')>()).isScoreStale,
  getLatestScoresByTicker: (...args: unknown[]) => getLatestScoresByTicker(...args),
}));

const saveFilterAttributions = vi.fn();
vi.mock('@/lib/filter-attribution', () => ({
  saveFilterAttributions: (...args: unknown[]) => saveFilterAttributions(...args),
}));

const saveCandidateOutcomes = vi.fn();
vi.mock('@/lib/candidate-outcome', () => ({
  saveCandidateOutcomes: (...args: unknown[]) => saveCandidateOutcomes(...args),
}));

vi.mock('@/lib/market-data', () => ({
  getDataFreshness: () => ({ source: 'YAHOO' }),
  getTickerDataFreshness: (ticker: string) => ({ source: 'LIVE', ageMinutes: 2, asOf: new Date(`2026-08-04T20:00:00Z`) }),
}));

const { persistScanSnapshot } = await import('./persist-scan-snapshot');

const VERSIONS = { ncs: 'v1', fws: 'v1', bqs: 'v1' };

function makeScanResult() {
  return {
    regime: 'GREEN',
    readyCount: 1,
    totalScanned: 1,
    candidates: [
      {
        ticker: 'AAPL',
        price: 180,
        technicals: { ma200: 165, adx: 32, plusDI: 28, minusDI: 14, atrPercent: 1.9, efficiency: 55, twentyDayHigh: 182 },
        entryTrigger: 182,
        stopPrice: 176,
        distancePercent: 1.1,
        status: 'READY',
        rankScore: 72,
        passesAllFilters: true,
        passesRiskGates: true,
        passesAntiChase: true,
      },
    ],
  } as unknown as Parameters<typeof persistScanSnapshot>[0]['scanResult'];
}

beforeEach(() => {
  healthFindFirst.mockReset().mockResolvedValue({ overall: 'GREEN' });
  stockFindMany.mockReset().mockResolvedValue([{ id: 'stock-1', ticker: 'AAPL' }]);
  scanCreate.mockReset().mockResolvedValue({ id: 'scan-123' });
  getLatestScoresByTicker.mockReset().mockResolvedValue(
    new Map([['AAPL', { ncs: 75, fws: 20, bqs: 80, scoredAt: new Date() }]]),
  );
  saveFilterAttributions.mockReset().mockResolvedValue({ saved: 1, errors: 0 });
  saveCandidateOutcomes.mockReset().mockResolvedValue({ saved: 1, errors: 0 });

  // Model layer passes candidates through, exposing settings + versions.
  applyModelLayerToCandidates.mockReset().mockImplementation((candidates: unknown[]) => ({
    candidates,
    settings: { enabled: false },
    versions: VERSIONS,
  }));

  // Grading attaches a classification to each candidate.
  classifyCandidates.mockReset().mockImplementation((candidates: Array<{ ticker: string }>) =>
    candidates.map((c) => ({ ...c, classification: { grade: 'A', reason: 'ok' } })),
  );
});

describe('persistScanSnapshot', () => {
  it('preserves actual execution-session inputs and grades without replacing the full universe', async () => {
    const scanResult = makeScanResult();
    const executionCandidate = { ...scanResult.candidates[0], rankScore: 81,
      classification: { grade: 'A_GRADE_BUY', reason: 'Session threshold passed' } };
    scanResult.candidates.push({ ...scanResult.candidates[0], ticker: 'MSFT' });
    stockFindMany.mockResolvedValue([{ id: 'stock-1', ticker: 'AAPL' }, { id: 'stock-2', ticker: 'MSFT' }]);
    const result = await persistScanSnapshot({ userId: 'user-1', scanResult,
      modelLayerEnabled: false, executionCandidates: [executionCandidate],
      executionScoresByTicker: new Map() });
    expect(result.gradedCandidates).toHaveLength(2);
    expect(result.gradedCandidates[0]).toBe(executionCandidate);
    expect(scanCreate.mock.calls[0][0].data.results.create[0]).toMatchObject({
      grade: 'A_GRADE_BUY', gradeReason: 'Session threshold passed', rankScore: 81,
      ncs: null, fws: null, bqs: null,
    });
    expect(saveCandidateOutcomes.mock.calls[0][0][0]).toBe(executionCandidate);
  });

  it('persists the snapshot and returns scanId, graded candidates, and model layer', async () => {
    const result = await persistScanSnapshot({
      userId: 'user-1',
      scanResult: makeScanResult(),
      modelLayerEnabled: false,
    });

    expect(result.scanId).toBe('scan-123');
    expect(result.gradedCandidates).toHaveLength(1);
    expect(result.gradedCandidates[0].classification).toEqual({ grade: 'A', reason: 'ok' });
    expect(result.modelLayer).toEqual({ enabled: false, versions: VERSIONS });

    expect(scanCreate).toHaveBeenCalledTimes(1);
    expect(saveFilterAttributions).toHaveBeenCalledTimes(1);
    expect(saveCandidateOutcomes).toHaveBeenCalledTimes(1);
    const provenance = saveCandidateOutcomes.mock.calls[0][4] as Map<string, { source: string; ageMinutes: number }>;
    expect(provenance.get('AAPL')).toMatchObject({ source: 'LIVE', ageMinutes: 2 });
  });

  it('forwards modelLayerEnabled into the model layer', async () => {
    await persistScanSnapshot({
      userId: 'user-1',
      scanResult: makeScanResult(),
      modelLayerEnabled: true,
    });

    expect(applyModelLayerToCandidates).toHaveBeenCalledWith(
      expect.any(Array),
      { enabled: true },
      'GREEN',
    );
  });

  it('still returns graded candidates when the DB write fails (non-fatal)', async () => {
    scanCreate.mockRejectedValueOnce(new Error('DB down'));

    const result = await persistScanSnapshot({
      userId: 'user-1',
      scanResult: makeScanResult(),
      modelLayerEnabled: false,
    });

    expect(result.scanId).toBeNull();
    expect(result.gradedCandidates).toHaveLength(1);
    expect(result.modelLayer).toEqual({ enabled: false, versions: VERSIONS });
  });

  it('falls back to GREEN health when no health check exists', async () => {
    healthFindFirst.mockResolvedValueOnce(null);

    await persistScanSnapshot({
      userId: 'user-1',
      scanResult: makeScanResult(),
      modelLayerEnabled: false,
    });

    // The grading context the helper builds should carry the GREEN fallback.
    const contextResolver = classifyCandidates.mock.calls[0][1] as (c: { ticker: string }) => { healthOverall: string };
    expect(contextResolver({ ticker: 'AAPL' }).healthOverall).toBe('GREEN');
  });
});
