import { describe, expect, it, vi } from 'vitest';
import {
  EXIT_PHASES, exitAutoEnabled, flaggedAfterClose, inRegularHours, runFailedBreakoutExits,
  selectFailedBreakoutExits, terminalAttempts, type ExitCandidatePosition,
} from './failed-breakout-exit';

// Thursday 2026-10-08, 20:05 UTC = 16:05 New York (after the 16:00 close)
const nightly = new Date('2026-10-08T20:05:00Z');
// Friday 2026-10-09, 13:45 UTC = 09:45 New York
const nextUsSession = new Date('2026-10-09T13:45:00Z');
const position = (overrides: Partial<ExitCandidatePosition> = {}): ExitCandidatePosition => ({
  id: 'p1', ticker: 'NTAP', t212Ticker: 'NTAP_US_EQ', accountType: 'isa', source: 'auto-trade',
  shares: 0.24, breakoutFailureDetectedAt: nightly, ...overrides,
});

describe('selectFailedBreakoutExits', () => {
  it('sells a freshly flagged auto-trade US position in the next US session', () => {
    expect(selectFailedBreakoutExits([position()], 'us', nextUsSession, new Set())).toHaveLength(1);
  });

  it('ignores manual positions, other markets, attempted, unflagged and stale flags', () => {
    expect(selectFailedBreakoutExits([position({ source: 'trading212' })], 'us', nextUsSession, new Set())).toEqual([]);
    expect(selectFailedBreakoutExits([position()], 'uk', nextUsSession, new Set())).toEqual([]);
    expect(selectFailedBreakoutExits([position()], 'us', nextUsSession, new Set(['p1']))).toEqual([]);
    expect(selectFailedBreakoutExits([position({ breakoutFailureDetectedAt: null })], 'us', nextUsSession, new Set())).toEqual([]);
    // PLTR case: flagged ten days ago and still held — the tested rule no longer applies.
    expect(selectFailedBreakoutExits([position({ breakoutFailureDetectedAt: new Date('2026-09-28T20:05:00Z') })],
      'us', nextUsSession, new Set())).toEqual([]);
    expect(selectFailedBreakoutExits([position({ ticker: 'SAP.DE' })], 'us', nextUsSession, new Set())).toEqual([]);
  });

  it('never sells outside regular market hours (e.g. a late-running session)', () => {
    expect(selectFailedBreakoutExits([position()], 'us-close', new Date('2026-10-09T21:30:00Z'), new Set())).toEqual([]);
    expect(selectFailedBreakoutExits([position()], 'us', new Date('2026-10-09T13:31:00Z'), new Set())).toEqual([]); // 09:31 NY
    expect(inRegularHours('GSK.L', new Date('2026-10-09T07:20:00Z'))).toBe(true); // 08:20 London
    expect(inRegularHours('GSK.L', new Date('2026-10-09T06:50:00Z'))).toBe(false);
    // UK/US clock-change gap (US already on standard time): 14:45 London = 09:45 New York
    expect(inRegularHours('NTAP', new Date('2026-11-02T14:45:00Z'))).toBe(true);
  });

  it('covers a Friday flag sold on Monday, but not a flag recorded mid-session', () => {
    const friday = new Date('2026-10-09T20:05:00Z');
    expect(selectFailedBreakoutExits([position({ breakoutFailureDetectedAt: friday })], 'us',
      new Date('2026-10-12T13:45:00Z'), new Set())).toHaveLength(1);
    expect(flaggedAfterClose('NTAP', new Date('2026-10-08T16:12:00Z'))).toBe(false); // 12:12 New York
    expect(flaggedAfterClose('GSK.L', new Date('2026-10-08T20:05:00Z'))).toBe(true);
    expect(flaggedAfterClose('GSK.L', new Date('2026-10-08T10:00:00Z'))).toBe(false);
  });

  it('can be switched off', () => {
    expect(exitAutoEnabled({})).toBe(true);
    expect(exitAutoEnabled({ FAILED_BREAKOUT_AUTO_EXIT: 'off' })).toBe(false);
  });
});

describe('terminalAttempts', () => {
  const log = (phase: string, positionId = 'p1') => ({ positionId, phase });
  it('stops after a sale, not-held, shared, critical, two errors or an unresolved intent', () => {
    expect(terminalAttempts([log(EXIT_PHASES.intent), log(EXIT_PHASES.sold)]).has('p1')).toBe(true);
    expect(terminalAttempts([log(EXIT_PHASES.notHeld)]).has('p1')).toBe(true);
    expect(terminalAttempts([log(EXIT_PHASES.shared)]).has('p1')).toBe(true);
    expect(terminalAttempts([log(EXIT_PHASES.intent), log(EXIT_PHASES.critical)]).has('p1')).toBe(true);
    expect(terminalAttempts([log(EXIT_PHASES.intent), log(EXIT_PHASES.error), log(EXIT_PHASES.intent), log(EXIT_PHASES.error)]).has('p1')).toBe(true);
    expect(terminalAttempts([log(EXIT_PHASES.intent)]).has('p1')).toBe(true);
  });
  it('allows one retry after a single ordinary error', () => {
    expect(terminalAttempts([log(EXIT_PHASES.intent), log(EXIT_PHASES.error)]).has('p1')).toBe(false);
  });
});

describe('runFailedBreakoutExits', () => {
  const deps = (overrides: Record<string, unknown> = {}) => ({
    positions: vi.fn(async () => [position()]),
    attemptedPositionIds: vi.fn(async () => new Set<string>()),
    brokerQuantity: vi.fn(async () => 0.24),
    sell: vi.fn(async (_p: ExitCandidatePosition, quantity: number) => ({ orderId: 42, sold: quantity, remaining: 0 })),
    record: vi.fn(async () => {}),
    notify: vi.fn(async (_text: string) => {}),
    ...overrides,
  });

  it('records intent, sells the position quantity, records the sale and reports it', async () => {
    const d = deps();
    const results = await runFailedBreakoutExits('us', d, nextUsSession);
    expect(results[0].status).toBe('SOLD');
    expect(d.sell).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), 0.24);
    expect(d.record.mock.calls.map(call => (call as unknown[])[1])).toEqual([
      { phase: EXIT_PHASES.intent, quantity: 0.24 },
      { phase: EXIT_PHASES.sold, quantity: 0.24, orderId: 42 },
    ]);
    expect(d.notify).toHaveBeenCalledTimes(1);
  });

  it('sells only the position shares when the broker holds more', async () => {
    const d = deps({ brokerQuantity: vi.fn(async () => 1.5) });
    await runFailedBreakoutExits('us', d, nextUsSession);
    expect(d.sell).toHaveBeenCalledWith(expect.anything(), 0.24);
  });

  it('skips a ticker that another open position also holds', async () => {
    const d = deps({ positions: vi.fn(async () => [position(), position({ id: 'p2', source: 'trading212', breakoutFailureDetectedAt: null })]) });
    expect((await runFailedBreakoutExits('us', d, nextUsSession))[0].status).toBe('SKIPPED');
    expect(d.sell).not.toHaveBeenCalled();
  });

  it('does not sell what the broker does not hold', async () => {
    const d = deps({ brokerQuantity: vi.fn(async () => 0) });
    expect((await runFailedBreakoutExits('us', d, nextUsSession))[0].status).toBe('NOT_HELD');
    expect(d.sell).not.toHaveBeenCalled();
  });

  it('records a failed sell without throwing, escapes broker text and escalates CRITICAL', async () => {
    const d = deps({ sell: vi.fn(async () => { throw new Error('CRITICAL: <stop> could not be restored & more'); }) });
    const results = await runFailedBreakoutExits('us', d, nextUsSession);
    expect(results[0].status).toBe('FAILED');
    expect(d.record).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ phase: EXIT_PHASES.critical }));
    const text = d.notify.mock.calls[0][0];
    expect(text).toContain('ACTION REQUIRED');
    expect(text).toContain('&lt;stop&gt;');
  });

  it('does nothing and stays quiet when no position qualifies', async () => {
    const d = deps({ positions: vi.fn(async () => []) });
    expect(await runFailedBreakoutExits('us', d, nextUsSession)).toEqual([]);
    expect(d.notify).not.toHaveBeenCalled();
  });
});
