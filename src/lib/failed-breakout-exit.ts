/**
 * DEPENDENCIES
 * Consumed by: src/cron/auto-trade.ts (start of each trading session)
 * Consumes: listing-identity.ts, telegram.ts (escapeHtml); broker access is injected
 * Risk-sensitive: YES — places live market sells
 * Last modified: 2026-10-08
 * Notes: Acts on the nightly failed-breakout flag (breakout-failure-detector.ts):
 *        an auto-trade position that closed back below its entry trigger within
 *        5 days, with under +0.5R profit, is sold at the first session after the
 *        flag. Tested once on untouched Aug–Sep 2026 data: +0.13R per trade
 *        (reports/holdout-test-2026-10-08.md). Only sells the position's own
 *        shares, only during regular market hours, never buys, sizes or raises a
 *        stop. Turn off with FAILED_BREAKOUT_AUTO_EXIT=off.
 */
import { isUsPriceListing } from './listing-identity';
import { escapeHtml } from './telegram';

/**
 * The tested rule sells at the next open; a flag older than this is stale. Covers
 * a weekend plus a one-day holiday; a flag before a four-day weekend (e.g. Easter)
 * expires unsold, which fails safe (the stop still protects the position).
 */
export const MAX_FLAG_AGE_MS = 4 * 24 * 60 * 60 * 1000;

type Market = 'US' | 'UK';
const HOURS: Record<Market, { timeZone: string; open: number; close: number }> = {
  US: { timeZone: 'America/New_York', open: 9 * 60 + 30, close: 16 * 60 },
  UK: { timeZone: 'Europe/London', open: 8 * 60, close: 16 * 60 + 30 },
};
/** Stay clear of the open and close auctions. */
const EDGE_MINUTES = 5;

export interface ExitCandidatePosition {
  id: string;
  ticker: string;
  t212Ticker: string | null;
  accountType: string | null;
  source: string;
  shares: number;
  breakoutFailureDetectedAt: Date | null;
}

export type ExitSession = 'uk' | 'uk-mid' | 'us' | 'us-mid' | 'us-close';

export function exitAutoEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.FAILED_BREAKOUT_AUTO_EXIT ?? 'on').trim().toLowerCase() !== 'off';
}

function market(ticker: string): Market | null {
  if (ticker.endsWith('.L')) return 'UK';
  return isUsPriceListing(ticker) ? 'US' : null;
}

function localClock(where: Market, at: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: HOURS[where].timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map(part => [part.type, part.value]));
  return { weekend: parts.weekday === 'Sat' || parts.weekday === 'Sun', minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** True when the flag was recorded after that market's regular close (the nightly run), not mid-session. */
export function flaggedAfterClose(ticker: string, flaggedAt: Date): boolean {
  const where = market(ticker);
  if (!where) return false;
  const clock = localClock(where, flaggedAt);
  return clock.weekend || clock.minutes >= HOURS[where].close;
}

/** True during the market's regular session (weekday, clear of the auctions). Holidays are gated by auto-trade. */
export function inRegularHours(ticker: string, now: Date): boolean {
  const where = market(ticker);
  if (!where) return false;
  const clock = localClock(where, now);
  return !clock.weekend && clock.minutes >= HOURS[where].open + EDGE_MINUTES
    && clock.minutes <= HOURS[where].close - EDGE_MINUTES;
}

/** Positions this session should sell. */
export function selectFailedBreakoutExits(
  positions: ExitCandidatePosition[],
  session: ExitSession,
  now: Date,
  alreadyAttempted: ReadonlySet<string>,
): ExitCandidatePosition[] {
  const sessionMarket: Market = session.startsWith('uk') ? 'UK' : 'US';
  return positions.filter(position => {
    const flaggedAt = position.breakoutFailureDetectedAt;
    if (position.source !== 'auto-trade' || !flaggedAt || !position.t212Ticker || !(position.shares > 0)) return false;
    if (alreadyAttempted.has(position.id)) return false;
    if (market(position.ticker) !== sessionMarket || !inRegularHours(position.ticker, now)) return false;
    const age = now.getTime() - flaggedAt.getTime();
    if (age < 0 || age > MAX_FLAG_AGE_MS) return false;
    return flaggedAfterClose(position.ticker, flaggedAt);
  });
}

export const EXIT_PHASES = {
  intent: 'FAILED_BREAKOUT_EXIT_INTENT',
  sold: 'FAILED_BREAKOUT_EXIT',
  notHeld: 'FAILED_BREAKOUT_EXIT_NOT_HELD',
  shared: 'FAILED_BREAKOUT_EXIT_SKIPPED_SHARED',
  error: 'FAILED_BREAKOUT_EXIT_ERROR',
  critical: 'FAILED_BREAKOUT_EXIT_CRITICAL',
} as const;
const MAX_ERROR_ATTEMPTS = 2;

/**
 * Positions that must not be tried again: sold, not held, shared, critical,
 * failed twice, or an intent with no recorded outcome (a crash mid-sell; never
 * risk a second sell).
 */
export function terminalAttempts(logs: Array<{ positionId: string; phase: string }>): Set<string> {
  const byPosition = new Map<string, string[]>();
  for (const log of logs) byPosition.set(log.positionId, [...(byPosition.get(log.positionId) ?? []), log.phase]);
  const terminal = new Set<string>();
  for (const [id, phases] of byPosition) {
    const count = (phase: string) => phases.filter(p => p === phase).length;
    const resolved = count(EXIT_PHASES.sold) + count(EXIT_PHASES.error) + count(EXIT_PHASES.critical);
    if (count(EXIT_PHASES.sold) || count(EXIT_PHASES.notHeld) || count(EXIT_PHASES.shared) || count(EXIT_PHASES.critical)
      || count(EXIT_PHASES.error) >= MAX_ERROR_ATTEMPTS || count(EXIT_PHASES.intent) > resolved) {
      terminal.add(id);
    }
  }
  return terminal;
}

export interface FailedBreakoutExitDeps {
  /** Every OPEN position (flagged or not), so shared tickers can be detected. */
  positions: () => Promise<ExitCandidatePosition[]>;
  attemptedPositionIds: () => Promise<Set<string>>;
  /** Broker quantity held for the ticker on that account (0 if not held). */
  brokerQuantity: (position: ExitCandidatePosition) => Promise<number>;
  /** Must confirm the holding fell; throws if not (with protection restored, or CRITICAL). */
  sell: (position: ExitCandidatePosition, quantity: number) => Promise<{ orderId: number | null; sold: number; remaining: number }>;
  record: (position: ExitCandidatePosition, outcome: { phase: string; quantity?: number; orderId?: number | null; error?: string }) => Promise<void>;
  notify: (text: string) => Promise<void>;
}

export interface FailedBreakoutExitResult {
  ticker: string;
  status: 'SOLD' | 'NOT_HELD' | 'SKIPPED' | 'FAILED';
  detail: string;
}

/** Sells every qualifying position. Never throws: each failure is recorded and reported. */
export async function runFailedBreakoutExits(
  session: ExitSession,
  deps: FailedBreakoutExitDeps,
  now: Date = new Date(),
): Promise<FailedBreakoutExitResult[]> {
  const results: FailedBreakoutExitResult[] = [];
  let all: ExitCandidatePosition[];
  let selected: ExitCandidatePosition[];
  try {
    all = await deps.positions();
    selected = selectFailedBreakoutExits(all, session, now, await deps.attemptedPositionIds());
  } catch (error) {
    await deps.notify(`⚠️ Failed-breakout exit check could not run: ${escapeHtml((error as Error).message)}`).catch(() => {});
    return results;
  }
  for (const position of selected) {
    try {
      const shared = all.some(other => other.id !== position.id && other.t212Ticker === position.t212Ticker
        && (other.accountType ?? 'invest') === (position.accountType ?? 'invest'));
      if (shared) {
        await deps.record(position, { phase: EXIT_PHASES.shared });
        results.push({ ticker: position.ticker, status: 'SKIPPED', detail: 'another open position holds the same shares; sell by hand if needed' });
        continue;
      }
      const held = await deps.brokerQuantity(position);
      const quantity = Math.min(held, position.shares);
      if (!(quantity > 0)) {
        await deps.record(position, { phase: EXIT_PHASES.notHeld });
        results.push({ ticker: position.ticker, status: 'NOT_HELD', detail: 'not held at the broker; nothing to sell' });
        continue;
      }
      await deps.record(position, { phase: EXIT_PHASES.intent, quantity });
      const { orderId, sold, remaining } = await deps.sell(position, quantity);
      await deps.record(position, { phase: EXIT_PHASES.sold, quantity: sold, orderId });
      results.push({ ticker: position.ticker, status: 'SOLD',
        detail: `sold ${sold}${remaining > 0 ? `; ${remaining} other shares kept with their stop` : ''}. Run a sync if this was your only holding.` });
    } catch (error) {
      const message = (error as Error).message;
      const critical = message.includes('CRITICAL');
      await deps.record(position, { phase: critical ? EXIT_PHASES.critical : EXIT_PHASES.error, error: message }).catch(() => {});
      results.push({ ticker: position.ticker, status: 'FAILED', detail: message });
    }
  }
  if (results.length > 0) {
    const icon = { SOLD: '✅', NOT_HELD: 'ℹ️', SKIPPED: '⚠️', FAILED: '🚨' } as const;
    const critical = results.some(r => r.status === 'FAILED' && r.detail.includes('CRITICAL'));
    await deps.notify([
      '📉 <b>Failed-breakout exit</b> (closed back below its trigger within 5 days)',
      ...results.map(r => `${icon[r.status]} <b>${escapeHtml(r.ticker)}</b>: ${escapeHtml(r.detail)}`),
      ...(critical ? ['', '🚨 <b>ACTION REQUIRED — check T212 stops immediately</b>'] : []),
    ].join('\n')).catch(() => {});
  }
  return results;
}
