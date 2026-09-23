/**
 * DEPENDENCIES
 * Consumed by: auto-trade-task.bat, Windows Task Scheduler
 * Consumes: scan-engine.ts, position-sizer.ts, risk-gates.ts, stop-manager.ts,
 *           trading212.ts, telegram.ts, market-data.ts, prisma.ts, safety-controls.ts
 * Risk-sensitive: YES — places real buy and stop orders on Trading 212
 * Last modified: 2026-04-25
 * Notes: Standalone cron — runs WITHOUT the dashboard. Must be robust to failures.
 *        Every trade is logged, gated, and Telegram-notified.
 *        ENABLE_AUTO_TRADING=true required or script exits immediately.
 */
/**
 * HybridTurtle Auto-Trade — Standalone Scheduled Execution
 *
 * Scans for READY candidates, validates risk gates, executes buy orders,
 * places protective stops, and sends Telegram updates — all without the
 * Next.js dashboard running.
 *
 * Sessions (UK timezone):
 *   --session=uk       08:20 — UK/EU market entries (open)
 *   --session=uk-mid   10:30 — UK/EU market entries (mid-morning)
 *   --session=us       14:45 — US market entries (open)
 *   --session=us-mid   17:00 — US market entries (midday)
 *   --session=us-close  20:30 — US market entries (near close)
 *   --session=scan     20:00 — Evening scan only (no trades)
 *
 * Safety:
 *   - ENABLE_AUTO_TRADING env var must be "true" (master gate)
 *   - Phase 10 kill switch checked before every trade
 *   - All 6 risk gates must pass per candidate
 *   - Regime must be BULLISH
 *   - Health must not be RED
 *   - Max 2 trades per session (configurable)
 *   - Optional Jev veto (JEV_AUTO_TRADE_GATE=veto): can block, never add, a buy; fails open
 *   - Every execution logged to ExecutionLog audit trail
 *   - Immediate Telegram notification per trade
 *
 * Usage:
 *   npx tsx src/cron/auto-trade.ts --session=uk
 *   npx tsx src/cron/auto-trade.ts --session=uk-mid
 *   npx tsx src/cron/auto-trade.ts --session=us
 *   npx tsx src/cron/auto-trade.ts --session=us-mid
 *   npx tsx src/cron/auto-trade.ts --session=us-close
 *   npx tsx src/cron/auto-trade.ts --session=scan
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import prisma from '@/lib/prisma';
import { runFullScan, runTechnicalFilters } from '@/lib/scan-engine';
import { persistScanSnapshot } from '@/lib/persist-scan-snapshot';
import { linkTradeToOutcome } from '@/lib/candidate-outcome';
import { calculatePositionSize } from '@/lib/position-sizer';
import { validateRiskGates } from '@/lib/risk-gates';
import { Trading212Client, Trading212Error, type T212PendingOrder } from '@/lib/trading212';
import type { T212AccountType } from '@/lib/trading212-dual';
import { sendTelegramMessage, sendThrottledTelegramAlert } from '@/lib/telegram';
import { sendAlert } from '@/lib/alert-service';
import { assertSubmissionAllowed, SafetyControlError, isAutoTradingEnabled } from '../../packages/workflow/src';
import { getBatchPrices, getTechnicalData, normalizeBatchPricesToGBP, getFXRate, getMarketRegime } from '@/lib/market-data';
import { fetchT212LivePrices } from '@/lib/position-sync';
import { classifyCandidate, DEFAULT_GRADE_THRESHOLDS, type GradingContext, type CandidateGrade, type GradeThresholds } from '@/lib/candidate-grade';
import { getLatestScoresByTicker } from '@/lib/score-lookup';
import { NO_CHASE_ATR_BOUND } from '@/lib/entry-quality-engine';
import { RISK_PROFILES, type RiskProfileType, type Sleeve, type MarketRegime, type TechnicalData, OPERATING_MODES, type OperatingMode } from '@/types';
import { decryptField } from '@/lib/crypto';
import { isTodayMarketHoliday, isEarlyCloseDay } from '@/lib/market-holidays';
import { createCronLogger } from '@/lib/cron-logger';
import { getUKDayOfWeek, getUKTimeString } from '@/lib/uk-time';
import { groupSkipsByCategory } from '@/lib/skip-reason-category';
import { acquireAutoTradeLock, releaseAutoTradeLock, AutoTradeLockContentionError, type LockHolder } from '@/lib/auto-trade-lock';
import { getHistoricalFill, recoverTimedOutBuy } from '@/lib/buy-timeout-recovery';
import { readJevGateConfig, runJevGateForAutoTrade } from '@/lib/jev-entry-gate';

// ── Configuration ────────────────────────────────────────────

const MAX_TRADES_PER_SESSION = parseInt(process.env.AUTO_TRADE_MAX_PER_SESSION || '2', 10);
const SCAN_MAX_AGE_HOURS = 18;
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 20;

// ── Stop-loss retry strategy (audit 2026-05-16 H4) ────────────
// On stop-placement failure, retry up to 3 times with progressively wider
// stops. Index 0 = original price, 1.33× = ~33% wider, 1.67× = ~67% wider.
// Each step trades protection for placement probability. After all attempts
// fail, the existing UNPROTECTED_POSITION alert path runs unchanged.
export const STOP_RETRY_WIDEN_FACTORS = [1.0, 1.33, 1.67] as const;
export const STOP_RETRY_DELAY_MS = 500;
// 401/403 won't be fixed by widening — abort retries on these.
export const STOP_TERMINAL_STATUS_CODES = [401, 403] as const;

// M-4 fix (2026-05-17): extended retry tier after the immediate widen loop.
// Many T212 stop-rejection failures are transient (price-too-close after
// momentum bar, brief 5xx surge, ticker-not-tradeable for ~30s after IPO/halt
// resume). Before declaring UNPROTECTED_POSITION, retry at the widest factor
// with progressively longer back-off. Skip this tier for terminal (401/403)
// errors and DB-side failures.
export const STOP_EXTENDED_RETRY_DELAYS_MS = [15_000, 45_000, 90_000] as const;
export const STOP_EXTENDED_RETRY_FACTOR = 1.67;

/** Compute a widened stop price by a given gap multiplier.
 *  widenStop(100, 95, 1.0)  -> 95   (original)
 *  widenStop(100, 95, 1.33) -> 93.35
 *  widenStop(100, 95, 1.67) -> 91.65
 *  Floor at 0.01 to avoid negative or zero stops on extreme inputs. */
export function widenStop(filledPrice: number, originalStop: number, factor: number): number {
  const gap = filledPrice - originalStop;
  return Math.max(0.01, filledPrice - gap * factor);
}

/** H-3: preserve PLANNED per-share risk on gap-up fills.
 *  When the buy fills above planned entry, raising the stop by the gap amount
 *  keeps realised risk per share equal to planned risk per share. When the
 *  fill is at or below planned entry, the planned stop is returned unchanged.
 *  Returns 0-or-negative inputs unchanged (degenerate cases handled by caller).
 *  Examples:
 *    effectiveStopForFill(100, 100, 95) -> 95     (no gap)
 *    effectiveStopForFill(100, 108, 95) -> 103    (gap-up: stop raised by $8)
 *    effectiveStopForFill(100,  98, 95) -> 95     (gap-down: stop unchanged)
 */
export function effectiveStopForFill(entryPrice: number, filledPrice: number, plannedStop: number): number {
  const plannedRiskPerShare = entryPrice - plannedStop;
  const fillGapUp = Math.max(0, filledPrice - entryPrice);
  if (plannedRiskPerShare <= 0 || fillGapUp <= 0) return plannedStop;
  return plannedStop + fillGapUp;
}

/** Live-price revalidation (audit 2026-05-28): the scan that graded a
 *  candidate A_GRADE_BUY can be hours old by the time the cron actually
 *  tries to execute. This re-checks the current live price against the
 *  entry trigger and decides whether the candidate is still tradeable.
 *
 *  Defensive on missing data: a missing / NaN / non-positive live price
 *  returns SKIP rather than KEEP, so we never trade on stale scan-price
 *  alone when the broker fetch fails.
 *
 *  Anti-chase ceiling (audit 2026-05-29): the scan-time anti-chase guard
 *  (candidate-grade BLOCKED_CHASE) only sees the scan-time price. If the
 *  live price has run above the no-chase ceiling (entryTrigger +
 *  NO_CHASE_ATR_BOUND × ATR) since the scan, the breakout is now extended
 *  and a market fill here would be chasing. Re-enforce the same ceiling
 *  the entry-quality-engine defines, using live price + scan-time ATR.
 *  ATR is optional: when missing / non-finite / non-positive the ceiling
 *  cannot be computed, so the check is skipped (floor still applies) rather
 *  than blocking — a broken ATR pipeline must not silently halt all trades.
 *
 *  Pure — unit-testable without broker/network.
 */
export type LiveRevalidationDecision =
  | { action: 'KEEP' }
  | { action: 'SKIP'; reason: string };

export function revalidateLivePrice(
  scanPrice: number,
  entryTrigger: number,
  livePrice: number | undefined,
  atr?: number,
): LiveRevalidationDecision {
  if (livePrice === undefined || !Number.isFinite(livePrice) || livePrice <= 0) {
    return {
      action: 'SKIP',
      reason: `Live price unavailable (scan price ${scanPrice.toFixed(2)}, trigger ${entryTrigger.toFixed(2)})`,
    };
  }
  if (livePrice < entryTrigger) {
    return {
      action: 'SKIP',
      reason: `Price fell back below trigger since scan (live ${livePrice.toFixed(2)} < trigger ${entryTrigger.toFixed(2)})`,
    };
  }
  if (atr !== undefined && Number.isFinite(atr) && atr > 0) {
    const noChasePrice = entryTrigger + NO_CHASE_ATR_BOUND * atr;
    if (livePrice > noChasePrice) {
      return {
        action: 'SKIP',
        reason: `Price ran above no-chase ceiling since scan (live ${livePrice.toFixed(2)} > ceiling ${noChasePrice.toFixed(2)} = trigger ${entryTrigger.toFixed(2)} + ${NO_CHASE_ATR_BOUND}×ATR ${atr.toFixed(2)})`,
      };
    }
  }
  return { action: 'KEEP' };
}

export function revalidateExecutionTechnicals(
  livePrice: number,
  technicals: TechnicalData | null,
  sleeve: Sleeve,
  minVolumeRatio: number,
): LiveRevalidationDecision {
  if (!technicals) {
    return { action: 'SKIP', reason: 'Fresh technical data unavailable' };
  }

  const filters = runTechnicalFilters(livePrice, technicals, sleeve);
  const failed: string[] = [];
  if (!filters.priceAboveMa200) failed.push('price below MA200');
  if (!filters.adxAbove20) failed.push('ADX below 20');
  if (!filters.plusDIAboveMinusDI) failed.push('+DI not above -DI');
  if (!filters.atrPercentBelow8) failed.push('ATR% above sleeve cap');
  if (!filters.dataQuality) failed.push('technical data quality failed');
  if (technicals.volumeRatio < minVolumeRatio) {
    failed.push(`volume ratio ${technicals.volumeRatio.toFixed(2)} below ${minVolumeRatio.toFixed(2)}`);
  }

  return failed.length > 0
    ? { action: 'SKIP', reason: `Execution-time technical revalidation failed: ${failed.join(', ')}` }
    : { action: 'KEEP' };
}

/** M-3 (2026-05-17): realised gate footprint for a just-filled trade.
 *  After Phase D succeeds, the second candidate in the session must be gated
 *  against the position's REALISED footprint (filled price × filled shares),
 *  not the planned (entryTrigger × planned shares). Otherwise a gap-up fill
 *  silently leaves headroom under sleeve/cluster caps that doesn't exist.
 *
 *  All output values are GBP-normalised (caller passes fxToGbp).
 *  Falls back to planned values when the result is missing fields (e.g. when
 *  the DB write succeeded but order-poll returned no filledPrice).
 */
export function realisedGateFootprint(
  result: { filledPrice?: number; shares?: number; stopPrice?: number },
  planned: { entryTrigger: number; stopPrice: number; shares: number },
  fxToGbp: number,
): { valueGbp: number; riskGbp: number; entryGbp: number; stopGbp: number; shares: number } {
  const filledPrice = result.filledPrice ?? planned.entryTrigger;
  const shares = result.shares ?? planned.shares;
  const stop = result.stopPrice ?? planned.stopPrice;
  const entryGbp = filledPrice * fxToGbp;
  const stopGbp = stop * fxToGbp;
  return {
    valueGbp: entryGbp * shares,
    riskGbp: Math.max(0, (entryGbp - stopGbp) * shares),
    entryGbp,
    stopGbp,
    shares,
  };
}

/** R2 (audit 2026-05-29): health gate must FAIL CLOSED.
 *  The previous gate blocked new entries only when health was explicitly RED;
 *  a missing health record (none ever written) or a stale one (nightly didn't
 *  run) defaulted to permissive and allowed trading under unknown conditions.
 *  This evaluates the gate so that absent OR stale OR RED all block, while a
 *  fresh GREEN/AMBER allows. AMBER still trades (unchanged) — only RED blocks
 *  among recorded states. Health is written by the nightly pipeline, so a
 *  record older than HEALTH_STALE_HOURS means the latest nightly is missing.
 *
 *  Pure — unit-testable without prisma/network.
 */
export const HEALTH_STALE_HOURS = 30;

export function evaluateHealthGate(
  health: { overall: string | null; runDate: Date } | null | undefined,
  nowMs: number,
  staleHours: number = HEALTH_STALE_HOURS,
): { block: boolean; reason: string } {
  if (!health) {
    return { block: true, reason: 'Health: no health check on record — fail-closed (no entries)' };
  }
  const ageHours = (nowMs - health.runDate.getTime()) / (1000 * 60 * 60);
  if (!Number.isFinite(ageHours) || ageHours > staleHours) {
    return {
      block: true,
      reason: `Health: stale (${Number.isFinite(ageHours) ? Math.round(ageHours) : '∞'}h old > ${staleHours}h) — fail-closed (no entries)`,
    };
  }
  if (String(health.overall ?? '').toUpperCase() === 'RED') {
    return { block: true, reason: 'Health: RED' };
  }
  return { block: false, reason: '' };
}

/**
 * Reason pushed when a candidate passes every risk gate but no connected T212
 * account will route it (stock not isaEligible and no Invest account, or the
 * routed account is disconnected). Shared by the skip-emit site and the
 * routing-leak detector so the two can never drift apart.
 */
export const NO_ACCOUNT_SKIP_REASON =
  'No suitable T212 account (tag stock isaEligible=true to allow ISA routing, or connect Invest account)';

/**
 * Detects a silent routing leak: candidates passed every gate but the session
 * executed nothing because no T212 account would accept them. This is the
 * failure mode that ran undetected (the isaEligible universe was untagged, so
 * every buy was routed to nowhere while heartbeats still reported OK).
 *
 * Targeted by design — returns true ONLY when at least one candidate was
 * blocked on routing AND zero trades executed. A partial gap where some trades
 * still flow is not a leak (it already surfaces in skipReasons) and must not
 * fire, to avoid an over-eager alert.
 */
export function detectRoutingLeak(
  skipped: ReadonlyArray<{ reason: string }>,
  successCount: number,
): boolean {
  if (successCount > 0) return false;
  return skipped.some(s => s.reason === NO_ACCOUNT_SKIP_REASON);
}


type Session = 'uk' | 'uk-mid' | 'us' | 'us-mid' | 'us-close' | 'scan';

interface SessionConfig {
  name: string;
  sleeves: Sleeve[];
  description: string;
  /** Volume ratio threshold for this session (overrides DEFAULT_GRADE_THRESHOLDS.minVolumeRatio) */
  minVolumeRatio: number;
}

const SESSION_CONFIGS: Record<Session, SessionConfig> = {
  uk:        { name: 'UK/EU Morning',    sleeves: ['CORE', 'ETF'],                    description: 'UK/EU entries (08:20)',        minVolumeRatio: 0.15 },
  'uk-mid':  { name: 'UK/EU Mid-Morning',sleeves: ['CORE', 'ETF'],                    description: 'UK/EU entries (10:30)',        minVolumeRatio: 0.5  },
  us:        { name: 'US Afternoon',      sleeves: ['CORE', 'HIGH_RISK', 'ETF'],       description: 'US entries (14:45)',           minVolumeRatio: 0.15 },
  'us-mid':  { name: 'US Midday',         sleeves: ['CORE', 'HIGH_RISK', 'ETF'],       description: 'US entries (17:00)',           minVolumeRatio: 0.6  },
  'us-close':{ name: 'US Near-Close',     sleeves: ['CORE', 'HIGH_RISK', 'ETF'],       description: 'US near-close entries (20:30)',minVolumeRatio: 0.4  },
  scan:      { name: 'Evening Scan',      sleeves: [],                                 description: 'Scan only — no trades',       minVolumeRatio: 0.8  },
};

// ── Helpers ──────────────────────────────────────────────────

function isStockForSession(ticker: string, sleeve: string, session: Session): boolean {
  if (session === 'scan') return false; // Scan session never trades
  const config = SESSION_CONFIGS[session];
  if (!config.sleeves.includes(sleeve as Sleeve)) return false;

  // UK sessions: only .L suffix stocks (LSE)
  if (session === 'uk' || session === 'uk-mid') return ticker.endsWith('.L');
  // US sessions: non-.L stocks
  return !ticker.endsWith('.L');
}

// ── Execution Log (audit trail) ──────────────────────────────

async function logExecution(data: {
  ticker: string;
  phase: string;
  orderId?: string | null;
  requestBody: string;
  responseStatus?: number | null;
  responseBody?: string | null;
  stopPrice?: number | null;
  quantity?: number | null;
  accountType: string;
  error?: string | null;
}): Promise<void> {
  try {
    await prisma.executionLog.create({
      data: {
        ticker: data.ticker,
        phase: data.phase,
        orderId: data.orderId ?? null,
        requestBody: data.requestBody,
        responseStatus: data.responseStatus ?? null,
        responseBody: data.responseBody ?? null,
        stopPrice: data.stopPrice ?? null,
        quantity: data.quantity ?? null,
        accountType: data.accountType,
        error: data.error ?? null,
      },
    });
  } catch (logErr) {
    console.error('[ExecutionLog] Failed to write log:', logErr);
  }
}

// ── Orphan Reconciliation Record (audit F6, 2026-) ───────────
// When a T212 buy fills but the DB position.create fails, the position
// is LIVE on T212 but invisible to the dashboard, stop manager, and
// hourly status. The pre-existing path only logged to ExecutionLog and
// returned critical=true — but if Prisma itself is the failure mode the
// ExecutionLog write may also fail. This helper writes a durable
// filesystem JSONL record (survives a Prisma outage) AND a Notification
// via sendAlert (best-effort second channel). Recovery: operator inserts
// the missing Position row manually, then marks the notification read.
// We deliberately do NOT attempt to roll back the T212 fill: filled
// orders cannot be cancelled, and an emergency market-sell on a DB-write
// failure introduces worse market risk than the orphan itself.
async function recordOrphanT212Fill(record: {
  ticker: string;
  t212Ticker: string;
  accountType: T212AccountType;
  buyOrderId: string;
  filledQuantity: number;
  filledPrice: number;
  stopOrderId?: string | null;
  stopPrice?: number | null;
  stopPlaced: boolean;
  dbError: string;
}): Promise<void> {
  const payload = {
    timestamp: new Date().toISOString(),
    ukTime: getUKTimeString(),
    ...record,
  };

  // Layer A: durable filesystem record (works even if Prisma is down)
  try {
    const dir = path.join(process.cwd(), 'data', 'incidents');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'orphan-fills.jsonl');
    fs.appendFileSync(file, JSON.stringify(payload) + '\n', 'utf8');
  } catch (fsErr) {
    console.error('[recordOrphanT212Fill] Filesystem write failed:', (fsErr as Error).message);
  }

  // Layer B: in-app notification + Telegram (sendAlert never throws)
  await sendAlert({
    type: 'ORPHAN_T212_FILL',
    title: `🚨 ORPHAN T212 FILL — ${record.ticker}`,
    message: [
      `T212 buy filled (order ${record.buyOrderId}) but DB position.create FAILED.`,
      `Position is LIVE on T212 but invisible to HybridTurtle.`,
      `Account: ${record.accountType} | Qty: ${record.filledQuantity} @ ${record.filledPrice.toFixed(4)}`,
      record.stopPlaced
        ? `Stop placed @ ${record.stopPrice?.toFixed(4) ?? '?'} (order ${record.stopOrderId ?? '?'})`
        : `⚠ STOP NOT PLACED — manual stop required`,
      `DB error: ${record.dbError}`,
      `Reconcile: manually insert Position row, then mark this notification read.`,
    ].join('\n'),
    data: payload,
    priority: 'CRITICAL',
    notificationDedupeKey: `orphan-${record.buyOrderId}`,
    telegramDedupeKey: `orphan-${record.buyOrderId}`,
  });
}

// ── T212 Client Factory (standalone — no HTTP request context) ──

async function getT212Client(userId: string, accountType: T212AccountType): Promise<Trading212Client> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      t212ApiKey: true,
      t212ApiSecret: true,
      t212Environment: true,
      t212Connected: true,
      t212IsaApiKey: true,
      t212IsaApiSecret: true,
      t212IsaConnected: true,
    },
  });

  if (!user) throw new Error('User not found');

  if (accountType === 'isa') {
    if (!user.t212IsaApiKey || !user.t212IsaConnected) {
      throw new Error('Trading 212 ISA account not connected.');
    }
    return new Trading212Client(decryptField(user.t212IsaApiKey), decryptField(user.t212IsaApiSecret ?? ''), user.t212Environment as 'demo' | 'live');
  }

  if (!user.t212ApiKey || !user.t212Connected) {
    throw new Error('Trading 212 Invest account not connected.');
  }
  return new Trading212Client(decryptField(user.t212ApiKey), decryptField(user.t212ApiSecret ?? ''), user.t212Environment as 'demo' | 'live');
}

// ── Determine account type for a stock ───────────────────────
// Returns the account type the stock should route to, or null if
// no connected account can hold the stock (caller skips the candidate
// with a clear reason rather than attempting an order that will throw).
//
// Routing rules — conservative (the inverse rule was attempted on 2026-04-30
// and produced i-s-a-ineligible-instrument rejections from T212; we now require
// explicit isaEligible=true to route to ISA, regardless of which accounts are
// connected). The user must tag stocks isaEligible=true to use ISA.
//
//   1. No accounts connected            → null
//   2. ISA-eligible (isaEligible === true) → ISA if connected, else Invest if connected, else null
//   3. Anything else                    → Invest if connected, else null

async function getAccountTypeForStock(userId: string, stockId: string): Promise<T212AccountType | null> {
  const stock = await prisma.stock.findUnique({ where: { id: stockId }, select: { isaEligible: true, sleeve: true } });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { t212Connected: true, t212IsaConnected: true },
  });

  const investConnected = !!user?.t212Connected;
  const isaConnected = !!user?.t212IsaConnected;

  if (!investConnected && !isaConnected) return null;

  // Only route to ISA if the stock is EXPLICITLY tagged isaEligible=true.
  // null/false → Invest. T212 ISA rejects untagged instruments with
  // i-s-a-ineligible-instrument; let our DB tagging be the source of truth.
  if (stock?.isaEligible === true) {
    if (isaConnected) return 'isa';
    if (investConnected) return 'invest';
    return null;
  }

  if (investConnected) return 'invest';
  return null;
}

// ── Single Trade Execution (buy + stop + DB position) ────────

export interface EntryReferenceEvidence {
  version: 1;
  decisionId: string;
  userId: string;
  scanId: string | null;
  session: string;
  ticker: string;
  source: 'GET_BATCH_PRICES';
  priceBasis: 'UNVERIFIED';
  executableQuote: false;
  providerQuoteTime: null;
  bid: null;
  ask: null;
  fetchStartedAt: string;
  fetchCompletedAt: string;
  fetchError: string | null;
  evaluatedAt: string;
  scanPrice: number;
  entryTrigger: number;
  plannedStop: number;
  referencePrice: number | null;
  action: 'KEEP' | 'SKIP';
  reason: string | null;
}

export async function fetchEntryReferencePrices(tickers: string[]) {
  const fetchStartedAt = new Date().toISOString();
  let prices: Record<string, number> = {};
  let fetchError: string | null = null;
  try {
    prices = await getBatchPrices(tickers, /* forceRefresh */ true);
  } catch (error) {
    fetchError = error instanceof Error ? error.message : String(error);
    console.warn(`    [LIVE REVALIDATION] Batch fetch failed: ${fetchError}`);
  }
  return { prices, fetchStartedAt, fetchCompletedAt: new Date().toISOString(), fetchError };
}

interface TradeResult {
  ticker: string;
  success: boolean;
  shares?: number;
  filledPrice?: number;
  stopPrice?: number;
  stopPlaced: boolean;
  positionId?: string;
  error?: string;
  critical?: boolean;
}

export async function executeTrade(
  userId: string,
  candidate: {
    stockId: string;
    ticker: string;
    t212Ticker: string;
    entryPrice: number;
    stopPrice: number;
    shares: number;
    sleeve: string;
    accountType: T212AccountType;
    rankScore: number;
    atr?: number;
    adx?: number;
    scanId?: string | null;
    entryReference?: EntryReferenceEvidence;
  },
  tradeLog?: ReturnType<typeof createCronLogger>
): Promise<TradeResult> {
  const { ticker, t212Ticker, entryPrice, stopPrice, shares, accountType } = candidate;

  tradeLog?.info('Trade execution starting', { ticker, shares, entryPrice, stopPrice, accountType });
  console.log(`  [TRADE] ${ticker}: ${shares} shares @ ~${entryPrice.toFixed(2)}, stop @ ${stopPrice.toFixed(2)} (${accountType})`);

  // ── Phase A: Place Market Buy ──
  let client: Trading212Client;
  try {
    client = await getT212Client(userId, accountType);
  } catch (err) {
    const msg = (err as Error).message;
    await logExecution({ ticker, phase: 'CLIENT_ERROR', requestBody: JSON.stringify(candidate), accountType, error: msg });
    return { ticker, success: false, stopPlaced: false, error: msg };
  }

  let baselinePosition = { quantity: 0, averagePricePaid: 0 };
  try {
    const positions = await client.getPositions();
    const existing = positions.find(position => position.instrument.ticker === t212Ticker);
    if (existing) {
      baselinePosition = {
        quantity: existing.quantity,
        averagePricePaid: existing.averagePricePaid,
      };
    }
  } catch (err) {
    const msg = `Unable to capture pre-order broker position: ${(err as Error).message}`;
    await logExecution({
      ticker, phase: 'POSITION_SNAPSHOT_FAILED', requestBody: JSON.stringify(candidate), accountType, error: msg,
    });
    return { ticker, success: false, stopPlaced: false, error: msg };
  }

  let buyOrder: T212PendingOrder;
  const submissionStartedAt = new Date().toISOString();
  const buyRequestEvidence = JSON.stringify({ quantity: shares, ticker: t212Ticker,
    userId, scanId: candidate.scanId ?? null, submissionStartedAt,
    entryReference: candidate.entryReference ?? null });
  try {
    buyOrder = await client.placeMarketOrder({ quantity: shares, ticker: t212Ticker });
    await logExecution({
      ticker, phase: 'BUY_PLACED', orderId: String(buyOrder.id),
      requestBody: buyRequestEvidence,
      responseStatus: 200, responseBody: JSON.stringify(buyOrder),
      quantity: shares, accountType,
    });
    console.log(`    ✓ Buy order placed (ID: ${buyOrder.id})`);
  } catch (err) {
    const msg = err instanceof Trading212Error ? `T212 ${err.statusCode}: ${err.message}` : (err as Error).message;
    await logExecution({
      ticker, phase: 'BUY_FAILED', requestBody: buyRequestEvidence,
      responseStatus: err instanceof Trading212Error ? err.statusCode : null, accountType, error: msg,
    });
    return { ticker, success: false, stopPlaced: false, error: msg };
  }

  // ── Phase B: Poll for Fill ──
  let filledQuantity = 0;
  let filledPrice = 0;
  let filled = false;
  let fillPriceSource: 'ORDER_VALUE_OVER_QUANTITY' | 'PLANNED_ENTRY_FALLBACK' | 'HISTORY_HELPER' | 'TIMEOUT_RECOVERY' | null = null;
  let fillObservedAt: string | null = null;

  for (let attempt = 1; attempt <= MAX_POLLS; attempt++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const order = await client.getOrder(buyOrder.id);
      if (order.filledQuantity > 0 && order.filledQuantity >= shares * 0.99) {
        filledQuantity = order.filledQuantity;
        filledPrice = order.filledValue > 0 ? order.filledValue / order.filledQuantity : entryPrice;
        fillPriceSource = order.filledValue > 0 ? 'ORDER_VALUE_OVER_QUANTITY' : 'PLANNED_ENTRY_FALLBACK';
        fillObservedAt = new Date().toISOString();
        filled = true;
        break;
      }
    } catch (err) {
      if (err instanceof Trading212Error && err.statusCode === 404) {
        // Order filled and removed from pending — check positions
        try {
          const history = await client.getOrderHistory(50, { maxPages: 2 });
          const fill = getHistoricalFill(history, buyOrder.id);
          if (fill) {
            filledQuantity = fill.filledQuantity;
            filledPrice = fill.filledPrice;
            fillPriceSource = 'HISTORY_HELPER';
            fillObservedAt = new Date().toISOString();
            filled = true;
            break;
          }
        } catch { /* fall through */ }
      }
    }
  }

  if (!filled) {
    const recovery = await recoverTimedOutBuy(client, buyOrder.id);
    if (recovery.status === 'FILLED') {
      filledQuantity = recovery.filledQuantity;
      filledPrice = recovery.filledPrice;
      fillPriceSource = 'TIMEOUT_RECOVERY';
      fillObservedAt = new Date().toISOString();
      filled = true;
      await logExecution({
        ticker, phase: 'BUY_FILL_RECOVERED', orderId: String(buyOrder.id),
        requestBody: JSON.stringify({ orderId: buyOrder.id, maxPolls: MAX_POLLS }),
        responseStatus: 200,
        responseBody: JSON.stringify(recovery),
        quantity: filledQuantity,
        accountType,
      });
    } else {
      const cancelled = recovery.status === 'CANCELLED';
      const error = cancelled
        ? `Buy order ${buyOrder.id} was not filled after ${(MAX_POLLS * POLL_INTERVAL_MS / 1000).toFixed(0)}s and was cancelled.`
        : `Buy order ${buyOrder.id} remains unresolved after timeout: ${recovery.error}. Check T212 app immediately.`;
      await logExecution({
        ticker, phase: cancelled ? 'BUY_CANCELLED_AFTER_TIMEOUT' : 'BUY_TIMEOUT', orderId: String(buyOrder.id),
        requestBody: JSON.stringify({ orderId: buyOrder.id, maxPolls: MAX_POLLS }),
        accountType,
        error,
      });
      return {
        ticker, success: false, stopPlaced: false,
        error,
        critical: cancelled ? undefined : true,
      };
    }
  }

  console.log(`    ✓ Filled ${filledQuantity} shares @ ${filledPrice.toFixed(4)}`);

  // ── Phase C: Place Stop-Loss with retry-wider strategy (audit 2026-05-16 H4) ──
  // T212 occasionally rejects stop orders (price-too-close, transient 5xx).
  // Previous behaviour: single attempt, leave position UNPROTECTED on failure.
  // New behaviour: up to 3 attempts with progressively wider stops. Skip retry
  // on terminal auth errors (401/403). Track the actual stop placed so the
  // DB row matches what's live at T212.
  //
  // ── H-3 fix (2026-05-17): preserve planned per-share risk on gap-up fills ──
  // When the buy fills materially above planned entry (gap-up / momentum chase),
  // using the planned stop unchanged inflates realised risk per share to
  // (filledPrice - plannedStop), which can be 2-3× the size the position-sizer
  // was designed against. We raise the stop by the gap amount so realised
  // per-share risk equals planned risk per share. Widen-retry then operates
  // FROM this tightened base, so worst-case (all 3 retries) realised risk is
  // ~1.67× planned, not ~2.6× planned.
  let stopPlaced = false;
  let stopFailureWasTerminal = false;
  const plannedRiskPerShare = entryPrice - stopPrice; // positive for long
  const fillGapUp = Math.max(0, filledPrice - entryPrice);
  const effectiveStopPrice = effectiveStopForFill(entryPrice, filledPrice, stopPrice);
  if (effectiveStopPrice !== stopPrice) {
    console.log(`    ℹ Gap-up fill (+${fillGapUp.toFixed(4)}): tightening stop ${stopPrice.toFixed(4)} → ${effectiveStopPrice.toFixed(4)} to preserve planned risk/share (${plannedRiskPerShare.toFixed(4)})`);
    tradeLog?.info('Gap-up fill: stop tightened to preserve planned risk', {
      ticker, entryPrice, filledPrice, plannedStop: stopPrice,
      effectiveStop: effectiveStopPrice, plannedRiskPerShare, fillGapUp,
    });
  }
  let actualStopPrice = effectiveStopPrice;
  const stopQuantity = -Math.abs(filledQuantity);
  const stopAttempts: Array<{ attempt: number; stopPrice: number; orderId?: string; error?: string; statusCode?: number | null }> = [];

  for (let i = 0; i < STOP_RETRY_WIDEN_FACTORS.length; i++) {
    const factor = STOP_RETRY_WIDEN_FACTORS[i];
    const widenedStop = widenStop(filledPrice, effectiveStopPrice, factor);
    const stopRequest = { quantity: stopQuantity, stopPrice: widenedStop, ticker: t212Ticker, timeValidity: 'GOOD_TILL_CANCEL' as const };

    try {
      const stopOrder = await client.placeStopOrder(stopRequest);
      await logExecution({
        ticker, phase: 'STOP_PLACED', orderId: String(stopOrder.id),
        requestBody: JSON.stringify({ ...stopRequest, attempt: i + 1, widenFactor: factor }),
        responseStatus: 200,
        responseBody: JSON.stringify(stopOrder), stopPrice: widenedStop, quantity: stopQuantity, accountType,
      });
      stopPlaced = true;
      actualStopPrice = widenedStop;
      stopAttempts.push({ attempt: i + 1, stopPrice: widenedStop, orderId: String(stopOrder.id) });
      if (i === 0) {
        tradeLog?.info('Stop-loss placed', { ticker, stopPrice: widenedStop, orderId: stopOrder.id });
        console.log(`    ✓ Stop-loss placed @ ${widenedStop.toFixed(4)} (ID: ${stopOrder.id})`);
      } else {
        tradeLog?.warn('Stop-loss placed on retry with wider stop', {
          ticker, attempt: i + 1, widenFactor: factor,
          plannedStop: stopPrice, effectiveStop: effectiveStopPrice, finalStop: widenedStop,
          previousErrors: stopAttempts.slice(0, -1).map(a => a.error),
        });
        console.log(`    ✓ Stop-loss placed on attempt ${i + 1} (widened ${((factor - 1) * 100).toFixed(0)}%) @ ${widenedStop.toFixed(4)} (ID: ${stopOrder.id})`);
      }
      break;
    } catch (err) {
      const statusCode: number | null = err instanceof Trading212Error ? err.statusCode : null;
      const msg = err instanceof Trading212Error ? `T212 ${err.statusCode}: ${err.message}` : (err as Error).message;
      stopAttempts.push({ attempt: i + 1, stopPrice: widenedStop, error: msg, statusCode });
      await logExecution({
        ticker, phase: 'STOP_FAILED',
        requestBody: JSON.stringify({ ...stopRequest, attempt: i + 1, widenFactor: factor }),
        responseStatus: statusCode,
        accountType, error: msg, stopPrice: widenedStop, quantity: stopQuantity,
      });

      // Terminal errors (auth/permission) won't be fixed by widening.
      const isTerminal = statusCode !== null && (STOP_TERMINAL_STATUS_CODES as readonly number[]).includes(statusCode);
      if (isTerminal) {
        console.error(`    ✗ Stop-loss FAILED — terminal error ${statusCode}: ${msg}. No retry.`);
        tradeLog?.error('Stop-loss FAILED — terminal error, no retry', { ticker, statusCode, error: msg });
        stopFailureWasTerminal = true;
        break;
      }

      const isLastAttempt = i === STOP_RETRY_WIDEN_FACTORS.length - 1;
      if (!isLastAttempt) {
        console.warn(`    ⚠ Stop attempt ${i + 1} failed: ${msg}. Retrying with wider stop...`);
        await new Promise(r => setTimeout(r, STOP_RETRY_DELAY_MS));
      } else {
        console.error(`    ✗ CRITICAL: Stop-loss FAILED after ${STOP_RETRY_WIDEN_FACTORS.length} attempts. Final error: ${msg}`);
        tradeLog?.error('CRITICAL: Stop-loss FAILED after all retries', { ticker, attempts: stopAttempts, finalError: msg });
      }
    }
  }

  // ── M-4 fix (2026-05-17): Extended retry tier ──
  // The immediate widen loop above completes in ~2s and catches sub-second
  // T212 hiccups. Many real-world rejections are transient on a 30-90s scale
  // (price-too-close right after a momentum bar, brief 5xx surge, ticker
  // tradability flicker). Before declaring UNPROTECTED_POSITION, try up to
  // 3 more times at the widest factor with longer back-off. Skip for terminal
  // errors — widening + waiting does not fix 401/403.
  if (!stopPlaced && !stopFailureWasTerminal) {
    const widestStop = widenStop(filledPrice, effectiveStopPrice, STOP_EXTENDED_RETRY_FACTOR);
    for (let j = 0; j < STOP_EXTENDED_RETRY_DELAYS_MS.length; j++) {
      const delayMs = STOP_EXTENDED_RETRY_DELAYS_MS[j];
      const attemptNo = STOP_RETRY_WIDEN_FACTORS.length + j + 1;
      console.warn(`    ⏳ Extended retry ${j + 1}/${STOP_EXTENDED_RETRY_DELAYS_MS.length}: waiting ${(delayMs / 1000).toFixed(0)}s before re-attempting stop @ ${widestStop.toFixed(4)}`);
      await new Promise(r => setTimeout(r, delayMs));
      const stopRequest = { quantity: stopQuantity, stopPrice: widestStop, ticker: t212Ticker, timeValidity: 'GOOD_TILL_CANCEL' as const };
      try {
        const stopOrder = await client.placeStopOrder(stopRequest);
        await logExecution({
          ticker, phase: 'STOP_PLACED', orderId: String(stopOrder.id),
          requestBody: JSON.stringify({ ...stopRequest, attempt: attemptNo, extendedRetry: j + 1, delayMs }),
          responseStatus: 200,
          responseBody: JSON.stringify(stopOrder), stopPrice: widestStop, quantity: stopQuantity, accountType,
        });
        stopPlaced = true;
        actualStopPrice = widestStop;
        stopAttempts.push({ attempt: attemptNo, stopPrice: widestStop, orderId: String(stopOrder.id) });
        tradeLog?.warn('Stop-loss placed on extended retry', {
          ticker, extendedAttempt: j + 1, delayMs, finalStop: widestStop,
          previousErrors: stopAttempts.slice(0, -1).map(a => a.error),
        });
        console.log(`    ✓ Stop-loss placed on extended retry ${j + 1} after ${(delayMs / 1000).toFixed(0)}s wait @ ${widestStop.toFixed(4)} (ID: ${stopOrder.id})`);
        break;
      } catch (err) {
        const statusCode: number | null = err instanceof Trading212Error ? err.statusCode : null;
        const msg = err instanceof Trading212Error ? `T212 ${err.statusCode}: ${err.message}` : (err as Error).message;
        stopAttempts.push({ attempt: attemptNo, stopPrice: widestStop, error: msg, statusCode });
        await logExecution({
          ticker, phase: 'STOP_FAILED',
          requestBody: JSON.stringify({ ...stopRequest, attempt: attemptNo, extendedRetry: j + 1, delayMs }),
          responseStatus: statusCode,
          accountType, error: msg, stopPrice: widestStop, quantity: stopQuantity,
        });
        // Terminal error during extended retry — abort the tier (waiting won't help auth)
        const isTerminal = statusCode !== null && (STOP_TERMINAL_STATUS_CODES as readonly number[]).includes(statusCode);
        if (isTerminal) {
          console.error(`    ✗ Extended retry hit terminal error ${statusCode}: ${msg}. Abandoning extended tier.`);
          stopFailureWasTerminal = true;
          break;
        }
        console.warn(`    ⚠ Extended retry ${j + 1} failed: ${msg}`);
      }
    }
    if (!stopPlaced) {
      console.error(`    ✗ CRITICAL: Stop-loss STILL FAILED after extended retry tier. Position will be UNPROTECTED.`);
      tradeLog?.error('CRITICAL: Stop-loss FAILED after extended retry tier', { ticker, totalAttempts: stopAttempts.length });
    }
  }

  // ── Phase D: Create DB Position (direct Prisma — no dashboard needed) ──
  let positionId: string | undefined;
  let entryTradeLogId: string | undefined;
  try {
    const initialRisk = filledPrice - actualStopPrice;
    const regime = await getMarketRegime();

    // FX rate for trade log
    const stock = await prisma.stock.findUnique({ where: { id: candidate.stockId }, select: { currency: true, ticker: true } });
    const rawCurrency = stock?.currency ? stock.currency.trim() : '';
    const currency = (rawCurrency || 'USD').toUpperCase();
    const isUk = ticker.endsWith('.L');
    // Audit fix F7 (2026-): warn on missing currency so the operator notices
    // a Stock row that needs backfilling. We do NOT skip or throw here: the
    // T212 fill is already live, so any failure in this branch would create
    // an orphan (the surrounding try/catch fires recordOrphanT212Fill).
    // Wrong positionSizeGbp in the trade log is far less bad than an orphan.
    if (!rawCurrency && !isUk) {
      console.warn(`    ⚠ ${ticker} has no currency in Stock row — defaulting to USD for trade log (orphan-safe). Backfill Stock.currency to fix.`);
    }
    let fxToGbp = 1;
    if (isUk || currency === 'GBX' || currency === 'GBp') fxToGbp = 0.01;
    else if (currency !== 'GBP') {
      try {
        fxToGbp = await getFXRate(currency, 'GBP');
        if (!isFinite(fxToGbp) || fxToGbp <= 0) {
          console.warn(`    ⚠ FX rate invalid for ${currency} (got ${fxToGbp}) — using 1 for trade log only.`);
          fxToGbp = 1;
        }
      } catch (fxErr) {
        // Never propagate: would orphan a live T212 position over a reporting field.
        console.warn(`    ⚠ FX rate unavailable for ${currency} in trade log: ${(fxErr as Error).message} — using 1.`);
        fxToGbp = 1;
      }
    }

    const position = await prisma.$transaction(async (tx) => {
      const pos = await tx.position.create({
        data: {
          userId,
          stockId: candidate.stockId,
          entryPrice: filledPrice,
          entryDate: new Date(),
          shares: filledQuantity,
          stopLoss: actualStopPrice,
          initialRisk,
          currentStop: actualStopPrice,
          entry_price: filledPrice,
          initial_stop: actualStopPrice,
          initial_R: initialRisk,
          atr_at_entry: candidate.atr ?? null,
          profile_used: 'BALANCED',
          entry_type: 'BREAKOUT',
          protectionLevel: 'INITIAL',
          source: 'auto-trade',
          accountType: accountType,
          // CRITICAL: persist the broker ticker so a follow-up broker sync
          // recognises this position as already tracked. Without this,
          // /api/trading212/sync re-creates the same holding as a 'trading212'
          // row, producing duplicates in the OPEN positions list.
          t212Ticker: t212Ticker,
          entryTrigger: candidate.entryPrice,
          notes: `Auto-trade: T212 order ${buyOrder.id} | Session ${getUKTimeString()} | Decision scan: ${candidate.scanId ?? 'unavailable'}`,
        },
      });

      // Trade log (best-effort inside transaction)
      try {
        const entryTradeLog = await tx.tradeLog.create({
          data: {
            userId,
            positionId: pos.id,
            ticker,
            tradeDate: new Date(),
            tradeType: 'ENTRY',
            decision: 'TAKEN',
            entryPrice: filledPrice,
            initialStop: actualStopPrice,
            initialR: initialRisk,
            shares: filledQuantity,
            positionSizeGbp: filledQuantity * filledPrice * fxToGbp,
            atrAtEntry: candidate.atr ?? null,
            adxAtEntry: candidate.adx ?? null,
            rankScore: candidate.rankScore ?? null,
            regime,
            plannedEntry: candidate.entryPrice,
            actualFill: filledPrice,
            slippagePct: candidate.entryPrice ? ((filledPrice - candidate.entryPrice) / candidate.entryPrice) * 100 : null,
            fillTime: new Date(),
          },
        });
        entryTradeLogId = entryTradeLog.id;
      } catch (logErr) {
        console.warn('TradeLog create failed (non-blocking)', logErr);
      }

      return pos;
    });

    positionId = position.id;
    console.log(`    ✓ Position saved (ID: ${positionId.slice(0, 8)}...)`);

    const linked = candidate.scanId && entryTradeLogId
      ? await linkTradeToOutcome(candidate.scanId, ticker, entryTradeLogId, filledPrice)
      : false;
    if (!linked) {
      await logExecution({ ticker, phase: 'ATTRIBUTION_PENDING', accountType,
        orderId: String(buyOrder.id),
        requestBody: JSON.stringify({ positionId, tradeLogId: entryTradeLogId, scanId: candidate.scanId }),
        error: 'Exact scan-to-entry linkage unavailable; do not infer historical attribution',
      });
    }

    await logExecution({
      ticker, phase: 'COMPLETE', orderId: String(buyOrder.id),
      requestBody: JSON.stringify({ positionId, tradeLogId: entryTradeLogId, scanId: candidate.scanId, candidateLinked: !!linked }), responseStatus: 201,
      responseBody: JSON.stringify({ fillEvidence: {
        version: 1, userId, decisionId: candidate.entryReference?.decisionId ?? null,
        source: fillPriceSource, observedAt: fillObservedAt, brokerExecutionTime: null,
        usedPrice: Number.isFinite(filledPrice) ? filledPrice : null,
        usedQuantity: Number.isFinite(filledQuantity) ? filledQuantity : null,
        priceBasis: 'UNVERIFIED',
      } }),
      quantity: filledQuantity, accountType, stopPrice: actualStopPrice,
    });
  } catch (err) {
    const msg = (err as Error).message;
    await logExecution({
      ticker, phase: 'DB_POSITION_FAILED', orderId: String(buyOrder.id),
      requestBody: JSON.stringify({ filledPrice, filledQuantity }), accountType, error: msg,
    });
    console.error(`    ✗ DB position failed — trade IS live on T212. ${msg}`);

    // Audit fix F6 (2026-): write a durable orphan-fill record so the live
    // T212 position is recoverable even when Prisma is the failure mode.
    // Filesystem JSONL + Notification both fire; sendAlert never throws.
    const lastStopOrderId = stopAttempts
      .filter(a => a.orderId)
      .map(a => a.orderId!)
      .pop() ?? null;
    try {
      await recordOrphanT212Fill({
        ticker,
        t212Ticker,
        accountType,
        buyOrderId: String(buyOrder.id),
        filledQuantity,
        filledPrice,
        stopOrderId: lastStopOrderId,
        stopPrice: stopPlaced ? actualStopPrice : null,
        stopPlaced,
        dbError: msg,
      });
    } catch (orphanErr) {
      // Defensive: recordOrphanT212Fill is best-effort and sendAlert never
      // throws, but the helper's filesystem write could in theory raise
      // (e.g. disk full). Never let recovery itself break the caller.
      console.error(`    ✗ Orphan-record write failed (orphan still live on T212): ${(orphanErr as Error).message}`);
    }

    return {
      ticker, success: true, shares: filledQuantity, filledPrice, stopPrice: actualStopPrice,
      stopPlaced, error: `DB save failed: ${msg}`, critical: true,
    };
  }

  return {
    ticker, success: true, shares: filledQuantity, filledPrice, stopPrice: actualStopPrice,
    stopPlaced, positionId,
    critical: !stopPlaced ? true : undefined,
  };
}

// ── Telegram Notification Helpers ────────────────────────────

async function sendTradeNotification(result: TradeResult, session: string): Promise<void> {
  const statusEmoji = result.success ? (result.stopPlaced ? '✅' : '⚠️') : '❌';
  const stopLine = result.stopPlaced
    ? `Stop: ${result.stopPrice?.toFixed(2)}`
    : '🚨 <b>STOP NOT PLACED — SET MANUALLY</b>';

  const lines = [
    `${statusEmoji} <b>Auto-Trade: ${result.ticker}</b>`,
    `Session: ${session}`,
    '',
  ];

  if (result.success) {
    lines.push(
      `Shares: ${result.shares}`,
      `Fill: ${result.filledPrice?.toFixed(4)}`,
      stopLine,
    );
    if (result.positionId) lines.push(`Position: ${result.positionId.slice(0, 8)}...`);
  } else {
    lines.push(`Error: ${result.error}`);
  }

  if (result.critical) {
    lines.push('', '🚨 <b>ACTION REQUIRED — check T212 app immediately</b>');
  }

  await sendTelegramMessage({ text: lines.join('\n') });

  // Also create in-app alert for critical issues
  if (result.critical) {
    await sendAlert({
      type: result.stopPlaced === false && result.success ? 'UNPROTECTED_POSITION' : 'FAILED_ORDER',
      title: `Auto-Trade: ${result.ticker}`,
      message: result.error || 'Stop-loss failed to place',
      priority: 'CRITICAL',
    });
  }
}

async function sendSessionSummary(
  session: Session,
  scanResults: { regime: string; readyCount: number; totalScanned: number },
  eligible: Array<{ ticker: string; rankScore: number; distancePercent: number; shares?: number; reason?: string }>,
  tradeResults: TradeResult[],
  skipped: Array<{ ticker: string; reason: string }>,
): Promise<void> {
  const config = SESSION_CONFIGS[session];
  const now = getUKTimeString();
  const executed = tradeResults.filter(r => r.success).length;
  const failed = tradeResults.filter(r => !r.success).length;

  const lines = [
    `📊 <b>HybridTurtle Auto-Trade — ${config.name}</b>`,
    `${now}`,
    '',
    `Regime: <b>${scanResults.regime}</b> | Scanned: ${scanResults.totalScanned} | READY: ${scanResults.readyCount}`,
    '',
  ];

  if (session === 'scan') {
    // Scan-only session — report candidates, no trades
    if (eligible.length > 0) {
      lines.push(`<b>📋 Candidates for tomorrow:</b>`);
      for (const c of eligible) {
        lines.push(`  • <b>${c.ticker}</b> — rank ${c.rankScore.toFixed(1)}, ${c.distancePercent.toFixed(1)}% from trigger`);
      }
    } else {
      lines.push('No READY candidates found.');
    }
  } else {
    // Trading session — report executions
    if (tradeResults.length > 0) {
      lines.push(`<b>Trades: ${executed} executed, ${failed} failed</b>`);
      for (const r of tradeResults) {
        const emoji = r.success ? (r.stopPlaced ? '✅' : '⚠️') : '❌';
        if (r.success) {
          lines.push(`  ${emoji} <b>${r.ticker}</b> — ${r.shares} shares @ ${r.filledPrice?.toFixed(2)}, stop ${r.stopPlaced ? r.stopPrice?.toFixed(2) : 'MISSING'}`);
        } else {
          lines.push(`  ${emoji} <b>${r.ticker}</b> — ${r.error}`);
        }
      }
    } else {
      lines.push('No trades executed this session.');
    }

    if (skipped.length > 0) {
      lines.push('', `<b>Skipped (${skipped.length}):</b>`);
      if (skipped.length <= 5) {
        // Few enough to enumerate — operator gets every reason in full.
        for (const s of skipped) {
          lines.push(`  ⏭ ${s.ticker} — ${s.reason}`);
        }
      } else {
        // Group by reason category so the operator sees WHY each cohort was blocked
        // (the user-facing pain: "Telegram says skipped but I can't see the gate").
        const groups = groupSkipsByCategory(skipped);
        for (const g of groups) {
          const examples = g.exampleTickers.join(', ');
          const more = g.count > g.exampleTickers.length ? ` +${g.count - g.exampleTickers.length}` : '';
          lines.push(`  ⏭ <b>${g.label}</b> (${g.count}): ${examples}${more}`);
          for (const reason of g.exampleReasons) {
            lines.push(`     · ${reason}`);
          }
        }
      }
    }
  }

  // Portfolio status
  const openCount = await prisma.position.count({ where: { userId: 'default-user', status: 'OPEN' } });
  lines.push('', `Open positions: ${openCount}`);

  // Weekly earnings calendar (scan session only)
  if (session === 'scan') {
    try {
      const openPositions = await prisma.position.findMany({
        where: { userId: 'default-user', status: 'OPEN' },
        select: { stock: { select: { ticker: true } } },
      });
      const holdingTickers = openPositions.map(p => p.stock.ticker);
      const candidateTickers = eligible.slice(0, 5).map(c => c.ticker);
      const allTickers = [...new Set([...holdingTickers, ...candidateTickers])];
      if (allTickers.length > 0) {
        const { fetchBatchNewsContext } = await import('@/lib/analyst/news-fetcher');
        const results = await fetchBatchNewsContext(allTickers, 0);
        const upcoming = results
          .filter(r => r.earnings.daysUntil != null && r.earnings.daysUntil <= 7)
          .sort((a, b) => (a.earnings.daysUntil ?? 99) - (b.earnings.daysUntil ?? 99));
        if (upcoming.length > 0) {
          lines.push('', `📅 <b>Earnings this week:</b>`);
          for (const u of upcoming) {
            const warn = (u.earnings.daysUntil ?? 99) <= 3 ? '⚠️ ' : '';
            const type = holdingTickers.includes(u.ticker) ? '(held)' : '(candidate)';
            lines.push(`  ${warn}<b>${u.ticker}</b> in ${u.earnings.daysUntil}d ${type}`);
          }
        }
      }
    } catch {
      // Best-effort — don't fail the summary
    }
  }

  await sendTelegramMessage({ text: lines.join('\n') });
}

// ── Main Pipeline ────────────────────────────────────────────

async function runAutoTrade(session: Session) {
  const userId = 'default-user';
  const log = createCronLogger('auto-trade', { session });

  log.info('Auto-trade started', { sessionName: SESSION_CONFIGS[session].name, ukTime: getUKTimeString() });
  console.log('========================================');
  console.log(`[HybridTurtle] Auto-Trade — ${SESSION_CONFIGS[session].name}`);
  console.log(`  Time (UK): ${getUKTimeString()}`);
  console.log('========================================');

  // ── Gate 0: Master enable check (DB setting or env var) ──
  const autoEnabled = await isAutoTradingEnabled();
  if (!autoEnabled) {
    log.info('Gate 0 BLOCKED: auto-trading not enabled');
    console.log('  ✗ Auto-trading is not enabled — exiting.');
    console.log('  Enable via Settings > Safety Controls, or set ENABLE_AUTO_TRADING=true in .env');
    await prisma.$disconnect();
    return;
  }

  // ── Gate 1: Weekend check ──
  const ukDay = getUKDayOfWeek();
  if (ukDay === 0 || ukDay === 6) {
    log.info('Gate 1 BLOCKED: weekend', { ukDay });
    console.log('  Weekend — skipping.');
    await prisma.heartbeat.create({
      data: { kind: 'AUTO_TRADE', status: 'SKIPPED', details: JSON.stringify({ type: 'auto-trade', session, reason: 'weekend' }) },
    });
    await prisma.$disconnect();
    return;
  }

  // ── Gate 1a: Market holiday check ──
  const { isHoliday, holiday } = isTodayMarketHoliday();
  if (isHoliday && session !== 'scan') {
    log.info('Gate 1a BLOCKED: market holiday', { holiday: holiday?.label });
    console.log(`  Market holiday: ${holiday?.label} — skipping trades (scan-only allowed).`);
    await prisma.heartbeat.create({
      data: { kind: 'AUTO_TRADE', status: 'SKIPPED', details: JSON.stringify({ type: 'auto-trade', session, reason: 'market-holiday', holiday: holiday?.label }) },
    });
    await prisma.$disconnect();
    return;
  }

  // ── Gate 1b: Early-close half-day check (US sessions only) ──
  // On early-close days (Black Friday, Christmas Eve) the US market closes at 1pm ET (~6pm UK).
  // The us-close and us-mid sessions would trade after market close on early-close days — skip them.
  const earlyClose = isEarlyCloseDay();
  if (earlyClose && (session === 'us-close' || session === 'us-mid')) {
    log.info('Early-close day — session skipped', { session, closeTime: earlyClose });
    console.log(`  Early-close day (${earlyClose} ET) — ${session} session skipped.`);
    await sendTelegramMessage({ text: `📅 Early-close day today (market closes ${earlyClose} ET). The ${session} session is skipped.` });
    await prisma.heartbeat.create({
      data: { kind: 'AUTO_TRADE', status: 'SKIPPED', details: JSON.stringify({ type: 'auto-trade', session, reason: 'early-close', closeTime: earlyClose }) },
    });
    await prisma.$disconnect();
    return;
  }

  // ── Gate 2: Kill switch check ──
  try {
    await assertSubmissionAllowed({ automated: true });
  } catch (err) {
    const msg = err instanceof SafetyControlError ? err.message : 'Safety control blocked';
    log.info('Gate 2 BLOCKED: kill switch', { message: msg });
    console.log(`  ✗ Kill switch active: ${msg}`);
    const { ALERT_CATEGORY: AC1, buildAlertKey: BK1 } = await import('@/lib/alert-categories');
    await sendThrottledTelegramAlert(
      { text: `🚫 Auto-Trade blocked by kill switch: ${msg}` },
      BK1(AC1.AUTO_TRADE_BLOCKED, `kill-switch:${session}`)
    );
    await prisma.heartbeat.create({
      data: { kind: 'AUTO_TRADE', status: 'SKIPPED', details: JSON.stringify({ type: 'auto-trade', session, reason: 'kill-switch', message: msg }) },
    });
    await prisma.$disconnect();
    return;
  }

  // ── Gate 3: Broker configured check ──
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { riskProfile: true, equity: true, t212Connected: true, t212IsaConnected: true, operatingMode: true, modelLayerEnabled: true },
  });
  if (!user) {
    console.error('  ✗ User not found');
    await prisma.$disconnect();
    return;
  }

  // ── Gate 3a: Operating mode check ──
  const modeKey = (user.operatingMode || 'NORMAL') as OperatingMode;
  const modeConfig = OPERATING_MODES[modeKey];
  if (session !== 'scan' && modeConfig && !modeConfig.canBuy) {
    log.info('Gate 3a BLOCKED: operating mode', { mode: modeKey });
    console.log(`  ✗ Operating mode ${modeKey} does not allow buying — exiting.`);
    const { ALERT_CATEGORY: AC2, buildAlertKey: BK2 } = await import('@/lib/alert-categories');
    await sendThrottledTelegramAlert(
      { text: `🚫 Auto-Trade blocked: operating mode ${modeKey} — ${modeConfig.description}` },
      BK2(AC2.AUTO_TRADE_BLOCKED, `mode:${modeKey}:${session}`)
    );
    await prisma.heartbeat.create({
      data: { kind: 'AUTO_TRADE', status: 'SKIPPED', details: JSON.stringify({ type: 'auto-trade', session, reason: `operating-mode-${modeKey}` }) },
    });
    await prisma.$disconnect();
    return;
  }

  if (!user.t212Connected && !user.t212IsaConnected) {
    log.info('Gate 3 BLOCKED: no T212 accounts connected');
    console.log('  ✗ No Trading 212 accounts connected — exiting.');
    const { ALERT_CATEGORY: AC3, buildAlertKey: BK3 } = await import('@/lib/alert-categories');
    await sendThrottledTelegramAlert(
      { text: '🚫 Auto-Trade: No T212 account connected. Configure in Settings.' },
      BK3(AC3.AUTO_TRADE_BLOCKED, `no-t212:${session}`)
    );
    await prisma.$disconnect();
    return;
  }

  const riskProfile = (user.riskProfile || 'BALANCED') as RiskProfileType;
  const equity = user.equity || 0;

  if (equity <= 0) {
    console.log('  ✗ Account equity is 0 — exiting.');
    await prisma.$disconnect();
    return;
  }

  // ── Step 1: Run fresh scan ──
  console.log('\n  [1/4] Running signal scan...');
  let scanResult: Awaited<ReturnType<typeof runFullScan>>;
  try {
    scanResult = await runFullScan(userId, riskProfile, equity);
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`  ✗ Scan failed: ${msg}`);
    const { ALERT_CATEGORY: AC4, buildAlertKey: BK4 } = await import('@/lib/alert-categories');
    await sendThrottledTelegramAlert(
      { text: `❌ Auto-Trade scan failed: ${msg}` },
      BK4(AC4.AUTO_TRADE_SCAN_FAIL, session)
    );
    await prisma.$disconnect();
    return;
  }

  console.log(`    Regime: ${scanResult.regime} | Scanned: ${scanResult.totalScanned} | READY: ${scanResult.readyCount}`);

  // ── Gate 4: Regime check (scan-only sessions skip this) ──
  if (session !== 'scan' && scanResult.regime !== 'BULLISH') {
    console.log(`  ✗ Regime is ${scanResult.regime} — no new entries allowed.`);
    await sendSessionSummary(session, { regime: scanResult.regime, readyCount: scanResult.readyCount, totalScanned: scanResult.totalScanned }, [], [], [{ ticker: '*', reason: `Regime: ${scanResult.regime}` }]);
    await prisma.heartbeat.create({
      data: { kind: 'AUTO_TRADE', status: 'OK', details: JSON.stringify({ type: 'auto-trade', session, reason: `regime-${scanResult.regime}`, scanned: scanResult.totalScanned }) },
    });
    await prisma.$disconnect();
    return;
  }

  // ── Gate 5: Health check ──
  const latestHealth = await prisma.healthCheck.findFirst({
    where: { userId },
    orderBy: { runDate: 'desc' },
    select: { overall: true, runDate: true },
  });
  const healthGate = evaluateHealthGate(latestHealth, Date.now());
  if (session !== 'scan' && healthGate.block) {
    console.log(`  ✗ ${healthGate.reason} — no new entries.`);
    await sendSessionSummary(session, { regime: scanResult.regime, readyCount: scanResult.readyCount, totalScanned: scanResult.totalScanned }, [], [], [{ ticker: '*', reason: healthGate.reason }]);
    await prisma.$disconnect();
    return;
  }

  // ── Step 2: Filter and grade candidates for this session ──
  console.log('\n  [2/4] Filtering and grading candidates...');

  const existingPositions = await prisma.position.findMany({
    where: { userId, status: 'OPEN' },
    include: { stock: true },
  });
  const openTickers = new Set(existingPositions.map(p => p.stock.ticker));

  // Grade all candidates using the classification module
  const gradingCtx: GradingContext = {
    regime: scanResult.regime,
    healthOverall: latestHealth?.overall ?? 'GREEN',
  };

  // Get candidates that match this session. Execution is later limited to
  // A-grade candidates whose breakout trigger is actually met.
  const sessionCandidates = scanResult.candidates.filter(c =>
    !openTickers.has(c.ticker) &&
    isStockForSession(c.ticker, c.sleeve, session)
  );

  // Per-candidate dual-score lookup. Without this every candidate is graded
  // with NCS=0/FWS=100/BQS=0 (worst case), which means nothing ever reaches
  // A_GRADE_BUY and auto-trade silently produces zero eligible trades.
  const sessionTickers = sessionCandidates.map(c => c.ticker);
  const scoresByTicker = await getLatestScoresByTicker(sessionTickers).catch((err) => {
    console.warn('  [grading] Score lookup failed, falling back to null scores:', (err as Error).message);
    return new Map<string, ReturnType<typeof Map.prototype.get>>() as Map<string, never>;
  });

  // Session-specific volume threshold: each session has a minVolumeRatio tuned
  // for how much daily volume has typically traded by that time of day.
  // Early sessions (uk 08:20, us 14:45) use low thresholds (0.15) since markets
  // just opened. Mid-day sessions use moderate thresholds. Near-close uses 0.4.
  const sessionConfig = SESSION_CONFIGS[session];
  const sessionThresholds: GradeThresholds = { ...DEFAULT_GRADE_THRESHOLDS, minVolumeRatio: sessionConfig.minVolumeRatio };

  // Classify each candidate with its own NCS/FWS/BQS
  const gradedCandidates = sessionCandidates.map(c => {
    const scores = scoresByTicker.get(c.ticker);
    const candidateCtx: GradingContext = scores
      ? { ...gradingCtx, ncs: scores.ncs, fws: scores.fws, bqs: scores.bqs }
      : gradingCtx;
    return {
      ...c,
      classification: classifyCandidate(c, candidateCtx, sessionThresholds),
    };
  });

  // Auto-trade only executes A_GRADE_BUY candidates after confirmed breakout.
  // The explicit price >= entryTrigger check is defense-in-depth so a future
  // grading policy change cannot reintroduce anticipatory entries here.
  const readyCandidates = gradedCandidates.filter(c =>
    c.classification.grade === 'A_GRADE_BUY' && c.price >= c.entryTrigger
  );

  // Sort by rank (highest first)
  readyCandidates.sort((a, b) => b.rankScore - a.rankScore);

  let executionScanId: string | null = null;
  if (session !== 'scan' && readyCandidates.length > 0) {
    try {
      const persisted = await persistScanSnapshot({ userId, scanResult,
        modelLayerEnabled: false, executionCandidates: gradedCandidates,
        executionScoresByTicker: scoresByTicker });
      executionScanId = persisted.scanId;
      if (!executionScanId) console.warn('[Execution attribution] Scan snapshot unavailable');
    } catch (error) {
      console.warn('[Execution attribution] Scan snapshot failed:', error);
    }
  }

  // ── Jev entry gate (veto-only, fail-open) ──
  // Jev can only remove an A-grade candidate; it never adds a buy or changes
  // sizing, stops or risk gates. Any Jev failure leaves the candidate to the
  // existing rules. Runs BEFORE live revalidation so time spent waiting on Jev
  // can never let a stale price reach an order. Off unless JEV_AUTO_TRADE_GATE=veto.
  const jevVetoSkipped: Array<{ ticker: string; reason: string }> = [];
  const jevConfig = readJevGateConfig();
  if (session !== 'scan' && jevConfig.enabled && readyCandidates.length > 0) {
    const jev = await runJevGateForAutoTrade({
      config: jevConfig, ownerId: userId, scanId: executionScanId,
      tickers: readyCandidates.map(c => c.ticker),
    });
    console.log(`    [JEV] ${jev.status}`);
    for (let i = readyCandidates.length - 1; i >= 0; i--) {
      const c = readyCandidates[i];
      const verdict = jev.verdicts.get(c.ticker);
      if (!verdict) continue;
      console.log(`    [JEV] ${c.ticker}: ${verdict.reason}`);
      await logExecution({
        ticker: c.ticker,
        phase: verdict.action === 'VETO' ? 'JEV_VETO' : 'JEV_ALLOW',
        accountType: 'N/A',
        requestBody: JSON.stringify({ scanId: executionScanId, session, gateStatus: jev.status, verdict }),
        error: verdict.action === 'VETO' ? verdict.reason : null,
      });
      if (verdict.action === 'VETO') {
        jevVetoSkipped.push({ ticker: c.ticker, reason: verdict.reason });
        readyCandidates.splice(i, 1);
      }
    }
  }

  // Live-price revalidation (audit 2026-05-28): scans can be hours old by
  // execution time. Re-fetch live prices for the ready slate and drop any
  // candidate whose price has slipped back below entryTrigger since the scan,
  // or whose live price cannot be fetched at all (defensive — never trade on
  // stale scan-price alone). Scan-only sessions are informational and skip
  // this gate. Skips merge into the session `skipped` array below so they
  // surface in both Telegram and the heartbeat skipReasons field.
  // forceRefresh=true (2026-06-08): the quote cache has a 5-min TTL, so an
  // un-forced fetch could re-use a quote up to 5 min old at the moment we
  // pull the trigger. This is the only price that gates a real buy, so we
  // bypass the cache and fetch a guaranteed-fresh quote here. The extra Yahoo
  // calls are bounded by the ready-slate size (typically a handful).
  const liveRevalidationSkipped: Array<{ ticker: string; reason: string }> = [];
  const entryReferences = new Map<string, EntryReferenceEvidence>();
  if (session !== 'scan' && readyCandidates.length > 0) {
    const tickers = readyCandidates.map(c => c.ticker);
    const [referenceBatch, refreshedTechnicals] = await Promise.all([
      fetchEntryReferencePrices(tickers),
      Promise.all(readyCandidates.map(async candidate => [
        candidate.ticker,
        await getTechnicalData(candidate.ticker, true).catch(() => null),
      ] as const)).then(entries => new Map(entries)),
    ]);
    const livePrices = referenceBatch.prices;
    for (let i = readyCandidates.length - 1; i >= 0; i--) {
      const c = readyCandidates[i];
      const refreshed = refreshedTechnicals.get(c.ticker) ?? null;
      const priceDecision = revalidateLivePrice(c.price, c.entryTrigger, livePrices[c.ticker], refreshed?.atr);
      const technicalDecision = priceDecision.action === 'KEEP'
        ? revalidateExecutionTechnicals(
          livePrices[c.ticker],
          refreshed,
          c.sleeve,
          sessionThresholds.minVolumeRatio,
        )
        : priceDecision;
      const decision = priceDecision.action === 'SKIP' ? priceDecision : technicalDecision;
      const entryReference: EntryReferenceEvidence = {
        version: 1, decisionId: randomUUID(), userId, scanId: executionScanId, session, ticker: c.ticker,
        source: 'GET_BATCH_PRICES', priceBasis: 'UNVERIFIED', executableQuote: false,
        providerQuoteTime: null, bid: null, ask: null,
        fetchStartedAt: referenceBatch.fetchStartedAt, fetchCompletedAt: referenceBatch.fetchCompletedAt,
        fetchError: referenceBatch.fetchError, evaluatedAt: new Date().toISOString(),
        scanPrice: c.price, entryTrigger: c.entryTrigger, plannedStop: c.stopPrice,
        referencePrice: Number.isFinite(livePrices[c.ticker]) && livePrices[c.ticker] > 0
          ? livePrices[c.ticker] : null,
        action: decision.action, reason: decision.action === 'SKIP' ? decision.reason : null,
      };
      entryReferences.set(c.ticker, entryReference);
      if (decision.action === 'SKIP') {
        liveRevalidationSkipped.push({ ticker: c.ticker, reason: decision.reason });
        readyCandidates.splice(i, 1);
        // Persist a forensic ExecutionLog row so "why didn't X trade?" is
        // queryable weeks later without grepping session-summary text.
        // Best-effort — never blocks trading. Audit 2026-06-16 (MEDIUM-7).
        await logExecution({
          ticker: c.ticker,
          phase: 'LIVE_REVAL_SKIP',
          requestBody: JSON.stringify({
            scanPrice: c.price,
            entryTrigger: c.entryTrigger,
            livePrice: livePrices[c.ticker] ?? null,
            atr: refreshed?.atr ?? null,
            technicals: refreshed,
            session,
            entryReference,
          }),
          accountType: 'N/A',
          error: decision.reason,
        });
      } else {
        await logExecution({ ticker: c.ticker, phase: 'LIVE_REVAL_KEEP', accountType: 'N/A',
          requestBody: JSON.stringify({ entryReference }) });
      }
    }
    if (liveRevalidationSkipped.length > 0) {
      console.log(`    [LIVE REVALIDATION] ${liveRevalidationSkipped.length} dropped: ${liveRevalidationSkipped.map(s => s.ticker).join(', ')}`);
    }
  }

  // Log B-grade as skipped with reason
  const bGrades = gradedCandidates.filter(c => c.classification.grade === 'B_GRADE_WATCH');
  for (const c of bGrades) {
    console.log(`    [B-GRADE] ${c.ticker}: ${c.classification.reason}`);
  }

  const eligible = readyCandidates.map(c => ({
    ticker: c.ticker,
    rankScore: c.rankScore,
    distancePercent: c.distancePercent,
    shares: c.shares,
    reason: c.classification.reason,
  }));

  console.log(`    A-Grade for ${session}: ${readyCandidates.length} | B-Grade: ${bGrades.length} | Blocked/C: ${gradedCandidates.length - readyCandidates.length - bGrades.length}`);
  for (const c of readyCandidates.slice(0, 5)) {
    console.log(`      ✓ ${c.ticker} — rank ${c.rankScore.toFixed(1)}, ${c.distancePercent.toFixed(1)}% from trigger`);
  }

  // ── Scan-only session: report and exit ──
  if (session === 'scan') {
    // Persist the scan we just computed so the dashboard / today-directive /
    // ready-to-buy / analyst / research dataset stay fresh without a manual
    // "Run Full Scan" click. This session never places orders, and the persist
    // is non-fatal — a DB failure must not break the Telegram report below.
    try {
      const persisted = await persistScanSnapshot({
        userId,
        scanResult,
        modelLayerEnabled: user.modelLayerEnabled ?? false,
      });
      console.log(`    Persisted scan snapshot: ${persisted.scanId ?? 'FAILED'} (${persisted.gradedCandidates.length} candidates)`);
    } catch (persistErr) {
      console.warn(`    [SCAN PERSIST] Failed (non-fatal): ${(persistErr as Error).message}`);
    }

    // Also report all READY candidates regardless of session filter
    const allReady = scanResult.candidates.filter(c => c.passesAllFilters && c.status === 'READY' && !openTickers.has(c.ticker));
    allReady.sort((a, b) => b.rankScore - a.rankScore);
    const allEligible = allReady.map(c => ({ ticker: c.ticker, rankScore: c.rankScore, distancePercent: c.distancePercent }));

    await sendSessionSummary('scan', { regime: scanResult.regime, readyCount: scanResult.readyCount, totalScanned: scanResult.totalScanned }, allEligible, [], []);
    await prisma.heartbeat.create({
      data: { kind: 'AUTO_TRADE', status: 'OK', details: JSON.stringify({ type: 'auto-trade', session: 'scan', scanned: scanResult.totalScanned, ready: allReady.length }) },
    });
    await prisma.$disconnect();
    return;
  }

  // ── Step 3: Size and validate each candidate ──
  console.log('\n  [3/4] Sizing and validating...');

  // ── Earnings proximity check (advisory + optional deferral) ──
  const earningsDeferralDays = parseInt(process.env.EARNINGS_DEFERRAL_DAYS || '0', 10);
  const earningsWarnings: string[] = [];
  const earningsDeferredTickers = new Set<string>();

  try {
    const { fetchBatchNewsContext } = await import('@/lib/analyst/news-fetcher');
    const candidateTickers = readyCandidates.slice(0, 5).map(c => c.ticker);
    if (candidateTickers.length > 0) {
      const newsResults = await fetchBatchNewsContext(candidateTickers, 0); // 0 headlines — only need earnings
      for (const news of newsResults) {
        if (news.earnings.daysUntil !== null && news.earnings.daysUntil <= Math.max(earningsDeferralDays, 5)) {
          const warn = `⚠️ ${news.ticker}: earnings in ${news.earnings.daysUntil} days`;
          earningsWarnings.push(warn);
          console.log(`    [EARNINGS WARNING] ${warn}`);

          // If deferral is enabled and within the deferral window, mark for downgrade
          if (earningsDeferralDays > 0 && news.earnings.daysUntil <= earningsDeferralDays) {
            earningsDeferredTickers.add(news.ticker);
            console.log(`    [EARNINGS DEFERRED] ${news.ticker} downgraded to B-grade (earnings in ${news.earnings.daysUntil}d, deferral window ${earningsDeferralDays}d)`);
          }
        }
      }
      if (earningsWarnings.length > 0) {
        const deferralNote = earningsDeferredTickers.size > 0
          ? `\n\n🚫 Deferred (EARNINGS_DEFERRAL_DAYS=${earningsDeferralDays}): ${[...earningsDeferredTickers].join(', ')}`
          : '\n\n<i>Auto-trade will proceed — manual review recommended.</i>';
        await sendTelegramMessage({
          text: `📅 <b>Earnings Event Risk</b>\n\n${earningsWarnings.join('\n')}${deferralNote}`,
          parseMode: 'HTML',
        }).catch(() => {}); // Best-effort alert
      }
    }
  } catch (err) {
    console.log(`    [EARNINGS CHECK] Skipped: ${(err as Error).message}`);
  }

  // Remove deferred tickers from the ready list (move to skipped)
  const originalReadyCount = readyCandidates.length;
  for (let i = readyCandidates.length - 1; i >= 0; i--) {
    if (earningsDeferredTickers.has(readyCandidates[i].ticker)) {
      readyCandidates.splice(i, 1);
    }
  }
  if (earningsDeferredTickers.size > 0) {
    console.log(`    [EARNINGS DEFERRAL] ${earningsDeferredTickers.size} candidates deferred (${originalReadyCount} → ${readyCandidates.length} remaining)`);
  }

  const tradeResults: TradeResult[] = [];
  const skipped: Array<{ ticker: string; reason: string }> = [...liveRevalidationSkipped, ...jevVetoSkipped];
  // Track ATTEMPTS separately from SUCCESSES. Both are capped at
  // MAX_TRADES_PER_SESSION so a string of failures (insufficient funds, T212
  // rejections, fill-timeouts) cannot let the loop drain the entire candidate
  // list and place dozens of orders. This is the bug that fired on 2026-04-30
  // 21:35 — success-only counter let the loop run unbounded when fills timed
  // out outside market hours.
  let tradesAttempted = 0;
  let tradesExecuted = 0;

  // Errors that mean "no point trying any more candidates this session".
  // First match aborts the loop; subsequent candidates are marked skipped.
  const TERMINAL_ERROR_PATTERNS = [
    /insufficient[- ]free[- ]for[- ]stocks[- ]buy/i,  // T212 cash too low
    /insufficient.*funds/i,
    /insufficient.*cash/i,
    /kill[- ]switch/i,
    /account.{0,15}suspended/i,
  ] as const;
  let sessionAbortReason: string | null = null;

  // Build existing positions for risk gate checks (GBP-normalised)
  const existingTickers = existingPositions.map(p => p.stock.ticker);
  // T212 real-time prices for existing positions, Yahoo fallback
  const t212Prices = existingTickers.length > 0 ? await fetchT212LivePrices(userId).catch(() => ({} as Record<string, number>)) : {};
  const priceMissing = existingTickers.filter(t => !t212Prices[t]);
  const yahooFallback = priceMissing.length > 0 ? await getBatchPrices(priceMissing) : {};
  const existingPrices: Record<string, number> = { ...yahooFallback, ...t212Prices };
  const existingCurrencies: Record<string, string | null> = {};
  for (const p of existingPositions) existingCurrencies[p.stock.ticker] = p.stock.currency;
  const existingGbpPrices = existingTickers.length > 0
    ? await normalizeBatchPricesToGBP(existingPrices, existingCurrencies)
    : {};

  const positionsForGates = existingPositions.map(p => {
    const rawPrice = existingPrices[p.stock.ticker] || p.entryPrice;
    const gbpPrice = existingGbpPrices[p.stock.ticker] ?? rawPrice;
    const fxRatio = rawPrice > 0 ? gbpPrice / rawPrice : 1;
    return {
      id: p.id,
      ticker: p.stock.ticker,
      sleeve: (p.stock.sleeve || 'CORE') as Sleeve,
      sector: p.stock.sector || 'Unknown',
      cluster: p.stock.cluster || 'General',
      // H-4 fix (2026-05-17): concentration uses current MARKET value, not
      // deployed capital at entry. Prevents profitable positions from leaving
      // phantom sleeve/cluster headroom that doesn't exist at market value.
      value: gbpPrice * p.shares,
      riskDollars: Math.max(0, (gbpPrice - p.currentStop * fxRatio) * p.shares),
      shares: p.shares,
      entryPrice: p.entryPrice * fxRatio,
      currentStop: p.currentStop * fxRatio,
      currentPrice: gbpPrice,
    };
  });

  for (const candidate of readyCandidates) {
    // SAFETY CAP — attempt-based, not success-based. See definition above.
    if (tradesAttempted >= MAX_TRADES_PER_SESSION) {
      skipped.push({ ticker: candidate.ticker, reason: `Session attempt cap reached (${MAX_TRADES_PER_SESSION})` });
      continue;
    }

    // SAFETY CAP — hard stop on terminal errors (insufficient funds, kill switch, etc.)
    if (sessionAbortReason) {
      skipped.push({ ticker: candidate.ticker, reason: `Session aborted: ${sessionAbortReason}` });
      continue;
    }

    // Look up stock for T212 ticker mapping and currency
    const stock = await prisma.stock.findFirst({
      where: { ticker: candidate.ticker },
      select: { id: true, t212Ticker: true, currency: true, sleeve: true, sector: true, cluster: true, isaEligible: true },
    });

    if (!stock?.t212Ticker) {
      skipped.push({ ticker: candidate.ticker, reason: 'No T212 ticker mapped' });
      continue;
    }

    // FX conversion for sizing
    const isUk = candidate.ticker.endsWith('.L');
    const rawCurrency = stock.currency ? stock.currency.trim() : '';
    // Audit fix F7 (2026-): refuse to silently default a missing currency to
    // USD for non-.L tickers. A non-GBP candidate sized at the wrong FX is
    // mis-sized by 20–50%. .L tickers are safe because the isUk branch forces
    // GBp→GBP regardless of currency string.
    if (!rawCurrency && !isUk) {
      skipped.push({ ticker: candidate.ticker, reason: 'Currency not set in Stock row — refusing to assume USD' });
      continue;
    }
    const currency = (rawCurrency || 'USD').toUpperCase();
    let fxToGbp = 1;
    if (isUk || currency === 'GBX' || currency === 'GBp') fxToGbp = 0.01;
    else if (currency !== 'GBP') {
      // Audit fix F1 (2026-): never silently fall back to fxToGbp=1 on FX
      // failure. A non-GBP candidate sized at parity is mis-sized by 20–50%
      // (e.g. USD at 1.0 instead of 0.79). Skip the candidate instead so the
      // operator sees the gap and can act.
      try {
        fxToGbp = await getFXRate(currency, 'GBP');
      } catch (fxErr) {
        skipped.push({ ticker: candidate.ticker, reason: `FX rate unavailable for ${currency}: ${(fxErr as Error).message}` });
        continue;
      }
      if (!isFinite(fxToGbp) || fxToGbp <= 0) {
        skipped.push({ ticker: candidate.ticker, reason: `FX rate invalid for ${currency} (got ${fxToGbp})` });
        continue;
      }
    }

    // Position sizing
    let sizing;
    try {
      sizing = calculatePositionSize({
        equity,
        riskProfile,
        entryPrice: candidate.entryTrigger,
        stopPrice: candidate.stopPrice,
        sleeve: candidate.sleeve as Sleeve,
        fxToGbp,
        allowFractional: true, // T212 supports fractional shares
      });
    } catch (err) {
      skipped.push({ ticker: candidate.ticker, reason: `Sizing failed: ${(err as Error).message}` });
      continue;
    }

    if (sizing.shares <= 0) {
      skipped.push({ ticker: candidate.ticker, reason: 'Zero shares after sizing' });
      continue;
    }

    // Risk gate validation
    const newEntryGbp = candidate.entryTrigger * fxToGbp;
    const newStopGbp = candidate.stopPrice * fxToGbp;
    const newValue = newEntryGbp * sizing.shares;
    const newRiskDollars = Math.max(0, (newEntryGbp - newStopGbp) * sizing.shares);

    const gateResults = validateRiskGates(
      {
        sleeve: (stock.sleeve || 'CORE') as Sleeve,
        sector: stock.sector || 'Unknown',
        cluster: stock.cluster || 'General',
        value: newValue,
        riskDollars: newRiskDollars,
      },
      positionsForGates,
      equity,
      riskProfile
    );

    const failedGates = gateResults.filter(g => !g.passed);
    if (failedGates.length > 0) {
      skipped.push({ ticker: candidate.ticker, reason: `Risk gates: ${failedGates.map(g => g.gate).join(', ')}` });
      continue;
    }

    // Determine account type
    const accountType = await getAccountTypeForStock(userId, stock.id);
    if (!accountType) {
      // Routed account not connected, or stock not isaEligible and no Invest account.
      skipped.push({
        ticker: candidate.ticker,
        reason: NO_ACCOUNT_SKIP_REASON,
      });
      continue;
    }

    // ── Step 4: Execute trade ──
    console.log(`\n  [4/4] Executing trade attempt ${tradesAttempted + 1}/${MAX_TRADES_PER_SESSION}...`);
    tradesAttempted++; // Count the attempt BEFORE calling executeTrade. Even if executeTrade
                       // throws or returns failure, the attempt is spent and counts toward the cap.

    const result = await executeTrade(userId, {
      stockId: stock.id,
      scanId: executionScanId,
      entryReference: entryReferences.get(candidate.ticker),
      ticker: candidate.ticker,
      t212Ticker: stock.t212Ticker,
      entryPrice: candidate.entryTrigger,
      stopPrice: candidate.stopPrice,
      shares: sizing.shares,
      sleeve: candidate.sleeve,
      accountType,
      rankScore: candidate.rankScore,
      atr: candidate.technicals?.atr,
      adx: candidate.technicals?.adx,
    }, log);

    tradeResults.push(result);

    // Send immediate Telegram notification for each trade
    await sendTradeNotification(result, SESSION_CONFIGS[session].name);

    if (result.success) {
      tradesExecuted++;

      // M-3 fix (2026-05-17): Update positions for risk gates using REALISED
      // fill state, not planned values. The previous code pushed `newValue`
      // (planned entryTrigger × planned shares) and `newRiskDollars` (planned
      // risk). If the fill came in materially above plan (gap-up), the next
      // candidate's gate would see a SMALLER footprint than the position
      // actually consumes, allowing the second trade through caps it would
      // otherwise breach. realisedGateFootprint() is the locked contract.
      const realised = realisedGateFootprint(
        result,
        { entryTrigger: candidate.entryTrigger, stopPrice: candidate.stopPrice, shares: sizing.shares },
        fxToGbp,
      );

      positionsForGates.push({
        id: result.positionId || 'pending',
        ticker: candidate.ticker,
        sleeve: (stock.sleeve || 'CORE') as Sleeve,
        sector: stock.sector || 'Unknown',
        cluster: stock.cluster || 'General',
        value: realised.valueGbp,
        riskDollars: realised.riskGbp,
        shares: realised.shares,
        entryPrice: realised.entryGbp,
        currentStop: realised.stopGbp,
        currentPrice: realised.entryGbp,
      });
    } else if (result.error) {
      // Detect terminal errors that mean "abort the rest of this session".
      // These are conditions where retrying with another ticker can only make things worse
      // (e.g. insufficient funds — every subsequent buy attempt will fail the same way and
      // generate Telegram noise).
      for (const pattern of TERMINAL_ERROR_PATTERNS) {
        if (pattern.test(result.error)) {
          sessionAbortReason = result.error;
          log.warn('Session aborted due to terminal error', {
            ticker: candidate.ticker,
            error: result.error,
            tradesAttempted,
            tradesExecuted,
          });
          break;
        }
      }
    }

    // Rate limit: wait 3s between attempts (use attempts, not successes, so we still
    // pace correctly when failures dominate).
    if (tradesAttempted < MAX_TRADES_PER_SESSION && !sessionAbortReason && readyCandidates.indexOf(candidate) < readyCandidates.length - 1) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  if (readyCandidates.length === 0) {
    skipped.push({ ticker: '-', reason: 'No triggered A-grade candidates for this session' });
  }

  // ── Session summary ──
  await sendSessionSummary(
    session,
    { regime: scanResult.regime, readyCount: scanResult.readyCount, totalScanned: scanResult.totalScanned },
    eligible,
    tradeResults,
    skipped,
  );

  // ── Heartbeat ──
  const successCount = tradeResults.filter(r => r.success).length;
  const failCount = tradeResults.filter(r => !r.success).length;
  const unprotectedCount = tradeResults.filter(r => r.success && !r.stopPlaced).length;
  // Silent-failure guard: candidates cleared every gate but nothing executed
  // because no T212 account would route them. Escalate to PARTIAL so this can't
  // run silently (it previously did, for weeks, while heartbeats said OK).
  const routingLeak = detectRoutingLeak(skipped, successCount);
  const heartbeatStatus = failCount > 0 || unprotectedCount > 0 || routingLeak ? 'PARTIAL' : 'OK';

  await prisma.heartbeat.create({
    data: {
      kind: 'AUTO_TRADE',
      status: heartbeatStatus,
      details: JSON.stringify({
        type: 'auto-trade',
        session,
        scanned: scanResult.totalScanned,
        ready: scanResult.readyCount,
        eligible: readyCandidates.length,
        executed: successCount,
        failed: failCount,
        unprotected: unprotectedCount,
        routingLeak,
        skipped: skipped.length,
        skipReasons: skipped.map(s => ({ ticker: s.ticker, reason: s.reason })),
        trades: tradeResults.map(r => ({ ticker: r.ticker, success: r.success, stopPlaced: r.stopPlaced })),
      }),
    },
  });

  // Surface the routing leak loudly — throttled so it resurfaces while the leak
  // persists but does not spam every session. Best-effort: never block completion.
  if (routingLeak) {
    const noAccountSkips = skipped.filter(s => s.reason === NO_ACCOUNT_SKIP_REASON).length;
    console.warn(`\n  ⚠ Routing leak: ${noAccountSkips} candidate(s) passed all gates but no T212 account would route them — 0 executed.`);
    try {
      const { ALERT_CATEGORY: AC, buildAlertKey: BK } = await import('@/lib/alert-categories');
      await sendThrottledTelegramAlert(
        { text: `⚠️ <b>Auto-Trade Routing Leak</b>\n\nSession: ${session}\n${noAccountSkips} candidate(s) passed all risk gates but no T212 account would accept them — 0 trades executed.\n\nLikely cause: stocks not tagged isaEligible=true, or no T212 account connected. Buys are silently blocked until this is fixed.`, parseMode: 'HTML' },
        BK(AC.AUTO_TRADE_ROUTING_LEAK, session),
      );
    } catch { /* never block run completion */ }
  }

  console.log(`\n  Done: ${successCount} trades executed, ${failCount} failed, ${skipped.length} skipped`);
  await prisma.$disconnect();
}

// ── Entry point ──────────────────────────────────────────────

const args = process.argv.slice(2);
const sessionArg = args.find(a => a.startsWith('--session='));
const session = (sessionArg?.split('=')[1] || 'scan') as Session;

// Run the CLI only when this file is executed directly, not when imported
// by tests or other modules. Without this gate, importing any named export
// would trigger a full auto-trade run + lock acquire against the real DB.
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const { pathToFileURL } = require('node:url') as typeof import('node:url');
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  if (!SESSION_CONFIGS[session]) {
    console.error(`Unknown session: ${session}. Use: uk, uk-mid, us, us-mid, us-close, scan`);
    process.exit(1);
  }

  (async () => {
  // ── Concurrent-run lock ──
  // Real-money safety: prevent duplicate buy orders if Task Scheduler
  // double-fires or a manual run races with cron. Acquire BEFORE any
  // gate checks or scanning so contention is detected instantly.
  let lockHolder: LockHolder | null = null;
  try {
    const acquireResult = await acquireAutoTradeLock({
      session,
      pid: process.pid,
      host: os.hostname(),
    });
    lockHolder = acquireResult.holder;

    // Stale-lock reclaim is itself a safety signal: a previous run crashed
    // without releasing. Surface it so the operator can investigate even
    // though the current run is allowed to proceed.
    if (acquireResult.reclaimedFrom) {
      const prior = acquireResult.reclaimedFrom;
      const ageStr = acquireResult.reclaimedAgeMinutes?.toFixed(1) ?? '?';
      console.error(`⚠ Reclaimed stale auto-trade lock from prior crashed run (pid=${prior.pid} host=${prior.host} session=${prior.session} age=${ageStr}m).`);
      try {
        await prisma.heartbeat.create({
          data: {
            kind: 'AUTO_TRADE',
            status: 'WARNING',
            details: JSON.stringify({
              type: 'auto-trade',
              session,
              reason: 'lock-reclaim',
              reclaimedFrom: prior,
              reclaimedAgeMinutes: acquireResult.reclaimedAgeMinutes,
            }),
          },
        });
      } catch { /* never block run */ }
      try {
        const { ALERT_CATEGORY: AC, buildAlertKey: BK } = await import('@/lib/alert-categories');
        await sendThrottledTelegramAlert(
          { text: `⚠️ <b>Auto-Trade Lock Reclaimed</b>\n\nSession: ${session}\nReclaimed stale lock from prior run:\npid=${prior.pid} host=${prior.host} session=${prior.session}\nage=${ageStr}m\n\nA previous run crashed without releasing. Current run proceeding — investigate prior session logs.`, parseMode: 'HTML' },
          BK(AC.AUTO_TRADE_BLOCKED, `lock-reclaim:${session}`)
        );
      } catch { /* never block run */ }
    }
  } catch (err) {
    if (err instanceof AutoTradeLockContentionError) {
      const holderInfo = err.holder
        ? `pid=${err.holder.pid} host=${err.holder.host} session=${err.holder.session} age=${err.ageMinutes?.toFixed(1)}m`
        : 'unknown holder';
      console.error(`✗ Auto-trade lock held — another run is in progress (${holderInfo}). Exiting.`);
      try {
        await prisma.heartbeat.create({
          data: {
            kind: 'AUTO_TRADE',
            status: 'SKIPPED',
            details: JSON.stringify({
              type: 'auto-trade',
              session,
              reason: 'lock-contention',
              holder: err.holder,
              ageMinutes: err.ageMinutes,
            }),
          },
        });
      } catch { /* never block exit */ }
      try {
        const { ALERT_CATEGORY: AC, buildAlertKey: BK } = await import('@/lib/alert-categories');
        await sendThrottledTelegramAlert(
          { text: `⚠️ <b>Auto-Trade Lock Contention</b>\n\nSession: ${session}\nAnother run is in progress (${holderInfo}).\n\nThis run was skipped to prevent duplicate orders.`, parseMode: 'HTML' },
          BK(AC.AUTO_TRADE_BLOCKED, `lock-contention:${session}`)
        );
      } catch { /* never block exit */ }
      try { await prisma.$disconnect(); } catch { /* never block exit */ }
      process.exit(2);
    }
    // Lock infrastructure failure (DB down, etc) — surface loudly and exit.
    console.error('Fatal error acquiring auto-trade lock:', err);
    try { await prisma.$disconnect(); } catch { /* never block exit */ }
    process.exit(1);
  }

  try {
    await runAutoTrade(session);
  } catch (err) {
    console.error('Fatal error in auto-trade:', err);
    // Send throttled Telegram alert on fatal crash (suppresses repeated identical crashes)
    try {
      const { sendThrottledTelegramAlert: sendThrottled } = await import('@/lib/telegram');
      const { ALERT_CATEGORY: AC, buildAlertKey: BK } = await import('@/lib/alert-categories');
      await sendThrottled(
        { text: `🔥 <b>Auto-Trade CRASHED</b>\n\nSession: ${session}\nError: ${(err as Error).message}\n\nCheck logs immediately.`, parseMode: 'HTML' },
        BK(AC.AUTO_TRADE_CRASH, session)
      );
    } catch { /* never block exit */ }
    try { await releaseAutoTradeLock({ holder: lockHolder }); } catch { /* never block exit */ }
    process.exit(1);
  }

  // Clean exit path — release lock. (runAutoTrade calls prisma.$disconnect
  // on its exit paths; Prisma auto-reconnects for the release query.)
  try {
    await releaseAutoTradeLock({ holder: lockHolder });
  } catch (err) {
    console.error('Warning: failed to release auto-trade lock:', err);
    // Do not exit non-zero — the trading work itself succeeded. The lock's
    // stale-recovery (STALE_LOCK_MINUTES) will reclaim it on the next run.
  }
  })();
}
