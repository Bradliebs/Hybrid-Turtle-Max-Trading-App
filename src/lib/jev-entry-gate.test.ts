import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideJevVerdict, DEFAULT_JEV_VETO_PASS_PROBABILITY, JEV_GATE_MAX_REVIEWS, readJevGateConfig, runJevEntryGate,
  type JevGateDeps,
} from './jev-entry-gate';
import { TypesafeReviewError, type TypesafeResponse } from './typesafe-client';
import { TYPESAFE_MODEL } from './typesafe-candidate-review';
import type { ReviewSnapshot } from './typesafe-review-source';
import { TypesafeReviewStore } from './typesafe-review-store';
import { categorizeSkipReason } from './skip-reason-category';

const now = new Date('2026-09-23T13:50:00Z');
const scanTime = '2026-09-23T13:46:00.000Z';
const directories: string[] = [];
const aGradeReason = 'Trigger met \u2014 price at or above entry. All filters pass, scores strong (NCS 80, BQS 75, FWS 20), volume confirmed.';

function respond(evidence: 'SUPPORTED' | 'CONTRADICTED' | 'MIXED' | 'INSUFFICIENT_EVIDENCE', pass: number): TypesafeResponse {
  const probabilities = { SUPPORTED: 0, CONTRADICTED: 0, MIXED: 0, INSUFFICIENT_EVIDENCE: 0, [evidence]: 1 };
  return {
    model: TYPESAFE_MODEL,
    answers: {
      evidence: { type: 'choice', choice: evidence, confidence: 1, probabilities },
      pick: { type: 'choice', choice: pass >= 0.5 ? 'PASS' : 'TAKE', confidence: 0.5, probabilities: { TAKE: 1 - pass, PASS: pass } },
      move20d: { type: 'score', score: 2, confidence: 0.4, legend: {}, probabilities: { 0: 0.1, 1: 0.2, 2: 0.4, 3: 0.2, 4: 0.1 } },
    },
    usage: { input_tokens: 700, output_tokens: 60 },
  };
}

function setup(tickers = ['AAA', 'BBB']) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-gate-'));
  directories.push(directory);
  const store = new TypesafeReviewStore(directory);
  store.acquire(); store.initialize(new Date(now.getTime() - 60_000)); store.release();
  const snapshot: ReviewSnapshot = {
    id: 'exec-scan', ownerId: 'owner', scanTime,
    candidates: tickers.map((ticker, index) => ({
      resultId: `r${index}`,
      evidence: {
        ticker, regime: 'BULLISH', price: 105, ma200: 90, entryTrigger: 101, adx: 30, ncs: 80, bqs: 75, fws: 20,
        volumeRatio: 1.4, relativeStrength: 12, grade: 'A_GRADE_BUY', gradeReason: aGradeReason,
        source: 'LIVE', dataAsOf: '2026-09-23T13:45:00.000Z', scanTime, provenanceMatches: true,
      },
    })),
  };
  const deps = {
    config: { enabled: true, hasKey: true, passThreshold: DEFAULT_JEV_VETO_PASS_PROBABILITY },
    ownerId: 'owner', scanId: 'exec-scan', tickers, store,
    load: vi.fn((_scanId: string, _tickers: readonly string[]) => snapshot),
    evaluate: vi.fn(async () => respond('SUPPORTED', 0.3)),
    now: () => now, sleep: vi.fn(async () => {}), lockWaitMs: 0,
  } satisfies JevGateDeps;
  return { deps, store, snapshot, directory };
}

afterEach(() => directories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })));

describe('Jev verdict rule', () => {
  it('vetoes contradicted or mixed evidence regardless of pick', () => {
    expect(decideJevVerdict('CONTRADICTED', null, 0.6).action).toBe('VETO');
    expect(decideJevVerdict('MIXED', respond('MIXED', 0).answers.pick, 0.6).action).toBe('VETO');
  });
  it('vetoes a PASS pick only at or above the threshold', () => {
    expect(decideJevVerdict('SUPPORTED', respond('SUPPORTED', 0.6).answers.pick, 0.6)).toMatchObject({ action: 'VETO', reason: 'Jev veto: PASS (60% pass)' });
    expect(decideJevVerdict('SUPPORTED', respond('SUPPORTED', 0.59).answers.pick, 0.6).action).toBe('ALLOW');
  });
  it('allows when the pick is malformed and evidence is not contradicted', () => {
    expect(decideJevVerdict('INSUFFICIENT_EVIDENCE', { choice: 'PASS' }, 0.6).action).toBe('ALLOW');
  });
  it('veto reasons group under the Jev veto category in session summaries', () => {
    expect(categorizeSkipReason(decideJevVerdict('CONTRADICTED', null, 0.6).reason)).toBe('JEV_VETO');
  });
});

describe('Jev gate config', () => {
  it('is off unless both the gate and the pilot are enabled', () => {
    expect(readJevGateConfig({ JEV_AUTO_TRADE_GATE: 'veto' }).enabled).toBe(false);
    expect(readJevGateConfig({ TYPESAFE_REVIEW_ENABLED: 'true' }).enabled).toBe(false);
    expect(readJevGateConfig({ JEV_AUTO_TRADE_GATE: 'veto', TYPESAFE_REVIEW_ENABLED: 'true' }).enabled).toBe(true);
  });
  it('clamps the pass threshold so it can never veto everything', () => {
    expect(readJevGateConfig({ JEV_VETO_PASS_PROBABILITY: '0' }).passThreshold).toBe(DEFAULT_JEV_VETO_PASS_PROBABILITY);
    expect(readJevGateConfig({ JEV_VETO_PASS_PROBABILITY: 'abc' }).passThreshold).toBe(DEFAULT_JEV_VETO_PASS_PROBABILITY);
    expect(readJevGateConfig({ JEV_VETO_PASS_PROBABILITY: '0.75' }).passThreshold).toBe(0.75);
  });
});

describe('Jev entry gate', () => {
  it('only ever removes candidates: vetoes a PASS, allows a TAKE, records ledger and shadow', async () => {
    const { deps, store } = setup();
    deps.evaluate.mockResolvedValueOnce(respond('SUPPORTED', 0.8)).mockResolvedValueOnce(respond('SUPPORTED', 0.2));
    const result = await runJevEntryGate(deps);
    expect(result.status).toBe('COMPLETE');
    expect(result.verdicts.get('AAA')).toMatchObject({ action: 'VETO', reviewed: true });
    expect(result.verdicts.get('BBB')).toMatchObject({ action: 'ALLOW', reviewed: true });
    expect([...result.verdicts.keys()].sort()).toEqual(['AAA', 'BBB']);
    const ledger = store.read();
    expect(ledger.attempts).toHaveLength(2);
    expect(Object.values(ledger.reviews).every(review => review.status === 'COMPLETE')).toBe(true);
    expect(fs.readFileSync(store.shadowPath, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(fs.existsSync(path.join(store.directory, 'worker.lock'))).toBe(false);
  });

  it('reuses an earlier answer for the same scan without paying again', async () => {
    const { deps } = setup(['AAA']);
    deps.evaluate.mockResolvedValue(respond('SUPPORTED', 0.9));
    await runJevEntryGate(deps);
    const second = await runJevEntryGate(deps);
    expect(deps.evaluate).toHaveBeenCalledTimes(1);
    expect(second.verdicts.get('AAA')).toMatchObject({ action: 'VETO', reviewed: true });
  });

  it.each([
    ['disabled', (d: JevGateDeps) => { d.config = { ...d.config, enabled: false }; }, 'DISABLED'],
    ['missing key', (d: JevGateDeps) => { d.config = { ...d.config, hasKey: false }; }, 'MISSING_KEY'],
    ['no saved scan', (d: JevGateDeps) => { d.scanId = null; }, 'NO_SCAN'],
    ['scan owned by someone else', (d: JevGateDeps) => { d.load = () => ({ id: 'x', ownerId: 'other', scanTime, candidates: [] }); }, 'SCAN_NOT_FOUND'],
    ['source throws', (d: JevGateDeps) => { d.load = () => { throw new Error('db'); }; }, 'SCAN_NOT_FOUND'],
  ])('fails open without a request when %s', async (_label, mutate, status) => {
    const { deps } = setup();
    mutate(deps);
    const result = await runJevEntryGate(deps);
    expect(result.status).toBe(status);
    expect(deps.evaluate).not.toHaveBeenCalled();
    expect([...result.verdicts.values()].every(verdict => verdict.action === 'ALLOW' && !verdict.reviewed)).toBe(true);
  });

  it('fails open when the worker holds the lock', async () => {
    const { deps, store } = setup();
    store.acquire();
    try {
      const result = await runJevEntryGate(deps);
      expect(result.status).toBe('LOCK_BUSY');
      expect(deps.evaluate).not.toHaveBeenCalled();
      expect([...result.verdicts.values()].every(verdict => verdict.action === 'ALLOW')).toBe(true);
    } finally { store.release(); }
  });

  it('fails open on provider error, charges quota and starts cooldown on 429', async () => {
    const { deps, store } = setup();
    deps.evaluate.mockRejectedValue(new TypesafeReviewError('PROVIDER_UNAVAILABLE', 429, null));
    const result = await runJevEntryGate(deps);
    expect(result.status).toBe('PROVIDER_UNAVAILABLE');
    expect(deps.evaluate).toHaveBeenCalledTimes(1);
    expect([...result.verdicts.values()].every(verdict => verdict.action === 'ALLOW')).toBe(true);
    expect(store.read().cooldownUntil).toBeGreaterThan(now.getTime());
    expect((await runJevEntryGate(deps)).status).toBe('PROVIDER_COOLDOWN');
    expect(deps.evaluate).toHaveBeenCalledTimes(1);
  });

  it('allows without a request when evidence is incomplete', async () => {
    const { deps, snapshot } = setup(['AAA']);
    snapshot.candidates[0].evidence.provenanceMatches = false;
    const result = await runJevEntryGate(deps);
    expect(deps.evaluate).not.toHaveBeenCalled();
    expect(result.verdicts.get('AAA')).toMatchObject({ action: 'ALLOW', reviewed: false });
  });

  it('respects the shared daily budget and fails open once it is used', async () => {
    const { deps, store } = setup(['AAA']);
    store.acquire();
    const ledger = store.read();
    for (let i = 0; i < 20; i++) ledger.attempts.push({ key: `k${i}`, day: '2026-09-23', reservedAt: now.toISOString() });
    store.save(ledger);
    store.release();
    const result = await runJevEntryGate(deps);
    expect(result.status).toBe('BUDGET_EXHAUSTED');
    expect(deps.evaluate).not.toHaveBeenCalled();
    expect(result.verdicts.get('AAA')?.action).toBe('ALLOW');
  });

  it(`reviews at most ${JEV_GATE_MAX_REVIEWS} candidates and allows the rest unreviewed`, async () => {
    const tickers = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];
    const { deps } = setup(tickers);
    const result = await runJevEntryGate(deps);
    expect(deps.evaluate).toHaveBeenCalledTimes(JEV_GATE_MAX_REVIEWS);
    expect(result.verdicts.get('A6')).toMatchObject({ action: 'ALLOW', reviewed: false });
    expect(result.verdicts.size).toBe(tickers.length);
  });
});
