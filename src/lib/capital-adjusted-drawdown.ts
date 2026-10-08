/**
 * DEPENDENCIES
 * Consumed by: nightly.ts, safety-alerts.ts, profit-scoreboard.ts, /api/performance/equity-curve
 * Consumes: prisma.ts (AppSetting 'capital-events.v1', written by scripts/collect-cash-transactions.ts)
 * Risk-sensitive: NO — alerting and reporting only; no trade gate reads it
 * Last modified: 2026-10-08
 * Notes: Drawdown measured on equity alone treats withdrawals as losses. This
 *        measures it on a time-weighted performance index instead: each step's
 *        return is (equity now − cash added since the last snapshot) / equity
 *        before. With no recorded cash movements it equals the raw equity curve.
 *        Limits: cash movements are applied to the snapshot interval they fall in.
 *        NIGHTLY snapshots copy User.equity, which can lag the broker; a movement
 *        recorded before the copy refreshes shifts the step by a day (the product
 *        telescopes, but a spurious peak can persist). Events must be refreshed
 *        after each deposit or withdrawal (scripts/collect-cash-transactions.ts).
 */
import prisma from './prisma';

export const CAPITAL_EVENTS_KEY = 'capital-events.v1';

export interface CapitalEvent {
  /** ISO time of the cash movement */
  at: string;
  /** GBP; positive = money in (deposit), negative = money out (withdrawal) */
  amount: number;
  type: string;
  reference?: string;
}

export interface EquityPoint {
  capturedAt: Date;
  equity: number;
}

export interface DrawdownPoint extends EquityPoint {
  /** Performance index (starts at 100); unaffected by deposits and withdrawals */
  index: number;
  /** Percent below the running index peak (0 or positive) */
  drawdownPct: number;
}

/** Keep GBP deposits, withdrawals and transfers; sign them as money in (+) or out (−). */
export function toCapitalEvents(items: Array<{ type: string; amount: number; currency?: string; dateTime: string; reference?: string }>): CapitalEvent[] {
  return items
    .filter(item => ['DEPOSIT', 'WITHDRAW', 'TRANSFER'].includes(item.type)
      && (item.currency ?? 'GBP') === 'GBP' && Number.isFinite(item.amount) && Number.isFinite(Date.parse(item.dateTime)))
    .map(item => ({
      at: new Date(item.dateTime).toISOString(),
      amount: item.type === 'DEPOSIT' ? Math.abs(item.amount) : item.type === 'WITHDRAW' ? -Math.abs(item.amount) : item.amount,
      type: item.type,
      reference: item.reference,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Time-weighted performance index and its drawdown. Snapshots must be in time order. */
export function computeCapitalAdjustedDrawdown(snapshots: EquityPoint[], events: CapitalEvent[]): {
  series: DrawdownPoint[];
  currentDrawdownPct: number;
  maxDrawdownPct: number;
  /** Return of the latest step in percent (after recorded cash movements), or null */
  lastStepPct: number | null;
} {
  const series: DrawdownPoint[] = [];
  const flows = events.map(event => ({ time: Date.parse(event.at), amount: event.amount }));
  let index = 100;
  let peak = 100;
  let maxDrawdownPct = 0;
  let lastStepPct: number | null = null;
  for (let i = 0; i < snapshots.length; i++) {
    const point = snapshots[i];
    if (i > 0) {
      const previous = snapshots[i - 1];
      const from = previous.capturedAt.getTime();
      const to = point.capturedAt.getTime();
      const flow = flows.filter(f => f.time > from && f.time <= to).reduce((sum, f) => sum + f.amount, 0);
      if (previous.equity > 0 && Number.isFinite(point.equity)) {
        const step = (point.equity - flow) / previous.equity;
        index *= step;
        lastStepPct = (step - 1) * 100;
      }
    }
    peak = Math.max(peak, index);
    const drawdownPct = peak > 0 ? Math.max(0, ((peak - index) / peak) * 100) : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
    series.push({ ...point, index, drawdownPct });
  }
  return { series, currentDrawdownPct: series.at(-1)?.drawdownPct ?? 0, maxDrawdownPct, lastStepPct };
}

/**
 * A one-step fall this large is beyond what a small, stop-protected book usually
 * loses overnight, so it is more likely an unrecorded withdrawal than a loss.
 * Set low on purpose: a false prompt only asks for a refresh, while a missed
 * withdrawal silently inflates the drawdown.
 */
export const UNEXPLAINED_STEP_PCT = -5;

/**
 * Snapshots before the first broker sync can hold the seed-default equity, so
 * drawdown history starts at the first BROKER row (empty if there is none).
 */
export function fromFirstBrokerSnapshot<T extends { source?: string | null }>(rows: T[]): T[] {
  const first = rows.findIndex(row => row.source === 'BROKER');
  return first >= 0 ? rows.slice(first) : [];
}

/** Recorded cash movements, or [] when none have been imported (raw-equity behaviour). */
export async function loadCapitalEvents(): Promise<CapitalEvent[]> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: CAPITAL_EVENTS_KEY }, select: { value: true } });
    const parsed = row ? JSON.parse(row.value) : null;
    return Array.isArray(parsed?.events) ? parsed.events.filter((e: CapitalEvent) =>
      typeof e?.at === 'string' && Number.isFinite(e?.amount)) : [];
  } catch {
    return [];
  }
}
