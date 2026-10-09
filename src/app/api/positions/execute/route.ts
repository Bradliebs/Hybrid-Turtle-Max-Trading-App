/**
 * DEPENDENCIES
 * Consumed by: BuyConfirmationModal.tsx (frontend)
 * Consumes: trading212.ts, trading212-dual.ts, positions/route.ts (POST), prisma (ExecutionLog),
 *           place-stop-with-retry.ts, alert-service.ts
 * Risk-sensitive: YES — places real orders on Trading 212
 * Last modified: 2026-06-02 (F1: stop-placement parity — widen-retry + durable alert)
 * Notes: 4-phase execution: buy → poll → stop → DB position.
 *        Every T212 API call is logged to ExecutionLog for audit trail.
 *        Uses SSE (Server-Sent Events) to stream progress to the modal.
 */

export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import prisma from '@/lib/prisma';
import { Trading212Client, Trading212Error, type T212PendingOrder } from '@/lib/trading212';
import type { T212AccountType } from '@/lib/trading212-dual';
import { ensureDefaultUser } from '@/lib/default-user';
import { z } from 'zod';
import { assertSubmissionAllowed, SafetyControlError } from '../../../../../packages/workflow/src';
import { runPreExecutionDryRun } from '@/lib/pre-execution-dry-run';
import { getFXRate, getMarketRegime } from '@/lib/market-data';
import { decryptField } from '@/lib/crypto';
import { placeStopWithRetry } from '@/lib/place-stop-with-retry';
import { sendAlert } from '@/lib/alert-service';
import { getHistoricalFill, recoverTimedOutBuy } from '@/lib/buy-timeout-recovery';
import { validatePreOrderRiskGates } from '@/lib/pre-order-risk-gates';
import {
  claimExecutionIntent,
  hashExecutionPayload,
  updateExecutionIntent,
} from '@/lib/execution-intent';
import { reconcileExecutionIntent } from '@/lib/execution-reconciliation';
import { calculatePositionSize } from '@/lib/position-sizer';
import { brokerListingMismatch, ukLineUnitsIssue } from '@/lib/listing-identity';
import { getT212LineCurrency } from '@/lib/t212-instruments-cache';
import { toYahooTicker } from '@/lib/ticker-maps';
import { RISK_PROFILES, type RiskProfileType, type Sleeve } from '@/types';

// ── Types ────────────────────────────────────────────────────

interface ExecutionPhase {
  phase: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  message?: string;
  orderId?: number;
  filledQuantity?: number;
  filledPrice?: number;
}

// ── Zod Schema ───────────────────────────────────────────────

const executeSchema = z.object({
  operationId: z.string().uuid(),
  userId: z.string().trim().min(1),
  stockId: z.string().trim().min(1),
  ticker: z.string().trim().min(1),           // Yahoo format
  t212Ticker: z.string().trim().min(1),       // T212 format: AAPL_US_EQ
  quantity: z.coerce.number().positive(),      // Shares to buy (positive)
  stopPrice: z.coerce.number().positive(),     // Pre-computed stop-loss price
  entryPrice: z.coerce.number().positive(),    // Expected entry price (for logging)
  currentPrice: z.coerce.number().positive().optional(),  // Current price for trigger confirmation
  entryTrigger: z.coerce.number().positive().optional(),  // Breakout trigger for trigger confirmation
  accountType: z.enum(['invest', 'isa']),
  // Additional metadata for DB position creation
  atrAtEntry: z.coerce.number().positive().optional(),
  adxAtEntry: z.coerce.number().positive().optional(),
  scanStatus: z.string().optional(),
  bqsScore: z.coerce.number().optional(),
  fwsScore: z.coerce.number().optional(),
  ncsScore: z.coerce.number().optional(),
  dualScoreAction: z.string().optional(),
  rankScore: z.coerce.number().optional(),
  entryType: z.string().optional(),
  notes: z.string().optional(),
});

// ── Execution Log Helper ─────────────────────────────────────

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
    // Never let logging failures abort execution
    console.error('[ExecutionLog] Failed to write log:', logErr);
  }
}

// ── T212 Client Factory ──────────────────────────────────────

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
      throw new Error('Trading 212 ISA account not connected. Go to Settings to add your ISA API credentials.');
    }
    return new Trading212Client(
      decryptField(user.t212IsaApiKey),
      decryptField(user.t212IsaApiSecret ?? ''),
      user.t212Environment as 'demo' | 'live'
    );
  }

  if (!user.t212ApiKey || !user.t212Connected) {
    throw new Error('Trading 212 Invest account not connected. Go to Settings to add your API credentials.');
  }
  return new Trading212Client(
    decryptField(user.t212ApiKey),
    decryptField(user.t212ApiSecret ?? ''),
    user.t212Environment as 'demo' | 'live'
  );
}

// ── Safety Assertions ────────────────────────────────────────

async function validateSafetyAssertions(
  stockId: string,
  t212Ticker: string,
  stopPrice: number,
  quantity: number,
  accountType: T212AccountType
): Promise<{
  ok: boolean;
  error?: string;
  resolvedT212Ticker?: string;
  resolvedStockId?: string;
  stockTicker?: string;
  stockSleeve?: string;
  stockCurrency?: string | null;
}> {
  // 1. stopPrice > 0
  if (stopPrice <= 0) {
    return { ok: false, error: 'ABORT: stopPrice must be > 0' };
  }

  // 2. quantity > 0 (buy side)
  if (quantity <= 0) {
    return { ok: false, error: 'ABORT: quantity must be > 0' };
  }

  // 3. t212Ticker exists on Stock record
  // Support both Prisma cuid (from auto-trade) and ticker string (from BuyConfirmationModal)
  let stock = await prisma.stock.findUnique({
    where: { id: stockId },
    select: { id: true, t212Ticker: true, isaEligible: true, ticker: true, sleeve: true, currency: true },
  });
  if (!stock) {
    // Fallback: try looking up by ticker (frontend sends candidate.ticker as stockId)
    stock = await prisma.stock.findUnique({
      where: { ticker: stockId },
      select: { id: true, t212Ticker: true, isaEligible: true, ticker: true, sleeve: true, currency: true },
    });
  }

  if (!stock) {
    return { ok: false, error: 'ABORT: Stock not found in database' };
  }

  if (!stock.t212Ticker) {
    return { ok: false, error: `ABORT: No T212 ticker mapped for ${stock.ticker}. Set it in the database first.` };
  }

  // Use the DB's authoritative t212Ticker — the frontend may send the Yahoo ticker
  // as t212Ticker which would mismatch. The DB is the source of truth.

  // 3b. Price data and broker instrument must be the same listing, otherwise the
  // stop is placed in the wrong units (e.g. pence on a USD share).
  const listingMismatch = brokerListingMismatch(toYahooTicker(stock.ticker), stock.t212Ticker);
  if (listingMismatch) {
    return { ok: false, error: `ABORT: ${listingMismatch}` };
  }
  // Sizing below handles every UK instrument in pence; block lines T212 quotes in GBP or USD.
  const isUkInstrument = stock.ticker.endsWith('.L') || /^[A-Z]{2,5}l$/.test(stock.ticker);
  const ukUnits = ukLineUnitsIssue(isUkInstrument, stock.t212Ticker, isUkInstrument ? getT212LineCurrency(stock.t212Ticker) : null);
  if (ukUnits) {
    return { ok: false, error: `ABORT: ${ukUnits}` };
  }

  // 4. ISA eligibility check — abort if explicitly ineligible
  if (accountType === 'isa' && stock.isaEligible === false) {
    return { ok: false, error: `ABORT: ${stock.ticker} is not ISA eligible — cannot buy on ISA account` };
  }

  return {
    ok: true,
    resolvedT212Ticker: stock.t212Ticker,
    resolvedStockId: stock.id,
    stockTicker: stock.ticker,
    stockSleeve: stock.sleeve,
    stockCurrency: stock.currency,
  };
}

// ── SSE Helpers ──────────────────────────────────────────────

function sseMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── Main Execution Handler (SSE) ─────────────────────────────

/**
 * POST /api/positions/execute
 *
 * Executes a buy order on Trading 212 with full audit logging.
 * Returns Server-Sent Events for real-time progress:
 *   event: phase    — phase status updates
 *   event: complete — final result with position data
 *   event: error    — abort with error details
 */
export async function POST(request: NextRequest) {
  // Parse and validate request body
  let body: z.infer<typeof executeSchema>;
  try {
    const rawBody = await request.json();
    body = executeSchema.parse(rawBody);
  } catch (err) {
    const msg = err instanceof z.ZodError
      ? err.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
      : 'Invalid request body';
    return new Response(JSON.stringify({ error: msg }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const {
    operationId, userId, stockId, ticker, t212Ticker, quantity, stopPrice,
    entryPrice, currentPrice, entryTrigger, accountType, atrAtEntry, adxAtEntry, scanStatus,
    bqsScore, fwsScore, ncsScore, dualScoreAction, rankScore,
    entryType, notes,
  } = body;

  // Ensure user exists
  const resolvedUserId = userId || await ensureDefaultUser();

  // ── Create SSE stream ──

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(sseMessage(event, data)));
        } catch {
          // Stream may be closed
        }
      };

      const phases: ExecutionPhase[] = [
        { phase: 'BUY_PLACED', status: 'pending', message: 'Placing buy order...' },
        { phase: 'BUY_POLLING', status: 'pending', message: 'Waiting for fill...' },
        { phase: 'STOP_PLACED', status: 'pending', message: 'Setting stop-loss...' },
        { phase: 'DB_POSITION', status: 'pending', message: 'Saving position...' },
      ];

      const updatePhase = (idx: number, update: Partial<ExecutionPhase>) => {
        phases[idx] = { ...phases[idx], ...update };
        send('phase', { phases, currentPhase: idx });
      };

      try {
        try {
          await assertSubmissionAllowed({ automated: false });
        } catch (error) {
          const message = error instanceof SafetyControlError ? error.message : 'Submission blocked by safety controls.';
          await logExecution({
            ticker,
            phase: 'KILL_SWITCH_BLOCK',
            requestBody: JSON.stringify(body),
            accountType,
            error: message,
          });
          send('error', { error: message, phase: 'KILL_SWITCH_BLOCK' });
          controller.close();
          return;
        }

        // ── SAFETY ASSERTIONS ──
        const safety = await validateSafetyAssertions(stockId, t212Ticker, stopPrice, quantity, accountType);
        if (!safety.ok) {
          await logExecution({
            ticker, phase: 'SAFETY_ABORT', requestBody: JSON.stringify(body),
            accountType, error: safety.error,
          });
          send('error', { error: safety.error, phase: 'SAFETY_ABORT' });
          controller.close();
          return;
        }

        // Use DB-resolved values — the frontend may send ticker as stockId/t212Ticker
        const resolvedT212Ticker = safety.resolvedT212Ticker || t212Ticker;
        const resolvedStockId = safety.resolvedStockId || stockId;

        // ── SERVER-AUTHORITATIVE QUANTITY CAP ──
        try {
          const sizingUser = await prisma.user.findUnique({
            where: { id: resolvedUserId },
            select: { equity: true, riskProfile: true },
          });
          if (!sizingUser || sizingUser.equity <= 0) {
            throw new Error('Account equity is unavailable');
          }
          if (!(sizingUser.riskProfile in RISK_PROFILES)) {
            throw new Error(`Unknown risk profile: ${sizingUser.riskProfile}`);
          }

          const currency = (safety.stockCurrency || 'USD').toUpperCase();
          const stockTicker = safety.stockTicker || ticker;
          const isUkInstrument = stockTicker.endsWith('.L') || /^[A-Z]{2,5}l$/.test(stockTicker);
          const fxToGbp = isUkInstrument || currency === 'GBX'
            ? 0.01
            : currency === 'GBP'
              ? 1
              : await getFXRate(currency, 'GBP');
          const serverSizing = calculatePositionSize({
            equity: sizingUser.equity,
            riskProfile: sizingUser.riskProfile as RiskProfileType,
            entryPrice,
            stopPrice,
            sleeve: (safety.stockSleeve || 'CORE') as Sleeve,
            fxToGbp,
            allowFractional: true,
          });

          if (serverSizing.shares <= 0 || quantity > serverSizing.shares + 0.000_001) {
            const failureMsg = serverSizing.shares <= 0
              ? 'Server sizing permits no shares for this trade.'
              : `Requested quantity ${quantity} exceeds the server maximum ${serverSizing.shares}.`;
            await logExecution({
              ticker,
              phase: 'SIZING_CAP_EXCEEDED',
              requestBody: JSON.stringify(body),
              accountType,
              error: failureMsg,
            });
            send('error', { error: failureMsg, phase: 'SIZING_CAP_EXCEEDED' });
            controller.close();
            return;
          }
        } catch (error) {
          const failureMsg = `Server sizing could not be evaluated: ${(error as Error).message}`;
          await logExecution({
            ticker,
            phase: 'SIZING_UNAVAILABLE',
            requestBody: JSON.stringify(body),
            accountType,
            error: failureMsg,
          });
          send('error', { error: failureMsg, phase: 'SIZING_UNAVAILABLE' });
          controller.close();
          return;
        }

        // ── PRE-EXECUTION DRY RUN ──
        const regime = await getMarketRegime().catch(() => undefined);
        const dryRun = await runPreExecutionDryRun({
          userId: resolvedUserId,
          ticker,
          entryPrice,
          currentPrice,
          entryTrigger,
          stopPrice,
          quantity,
          accountType,
          regime,
          ncsScore,
          fwsScore,
          dualScoreAction,
        });

        if (!dryRun.passed) {
          const failureMsg = dryRun.summary;
          await logExecution({
            ticker, phase: 'DRY_RUN_FAIL', requestBody: JSON.stringify(body),
            accountType, error: failureMsg,
          });
          send('error', {
            error: failureMsg,
            phase: 'DRY_RUN_FAIL',
            dryRunChecks: dryRun.checks,
            hardFailures: dryRun.hardFailures,
          });
          controller.close();
          return;
        }

        try {
          const portfolioGates = await validatePreOrderRiskGates({
            userId: resolvedUserId,
            stockId: resolvedStockId,
            entryPrice,
            stopPrice,
            shares: quantity,
          });
          if (!portfolioGates.passed) {
            const failureMsg = portfolioGates.failedGates
              .map((gate) => `${gate.gate}: ${gate.message}`)
              .join('; ');
            await logExecution({
              ticker,
              phase: 'RISK_GATES_FAILED',
              requestBody: JSON.stringify(body),
              accountType,
              error: failureMsg,
            });
            send('error', {
              error: `Position blocked by portfolio risk gates: ${failureMsg}`,
              phase: 'RISK_GATES_FAILED',
            });
            controller.close();
            return;
          }
        } catch (error) {
          const failureMsg = (error as Error).message;
          await logExecution({
            ticker,
            phase: 'RISK_GATES_UNAVAILABLE',
            requestBody: JSON.stringify(body),
            accountType,
            error: failureMsg,
          });
          send('error', {
            error: `Portfolio risk gates could not be evaluated: ${failureMsg}`,
            phase: 'RISK_GATES_UNAVAILABLE',
          });
          controller.close();
          return;
        }

        const canonicalPayloadHash = hashExecutionPayload({
          userId: resolvedUserId,
          stockId: resolvedStockId,
          t212Ticker: resolvedT212Ticker,
          quantity,
          stopPrice,
          accountType,
        });
        let intentClaim: Awaited<ReturnType<typeof claimExecutionIntent>>;
        try {
          intentClaim = await claimExecutionIntent({
            operationId,
            userId: resolvedUserId,
            payloadHash: canonicalPayloadHash,
            stockId: resolvedStockId,
            ticker: resolvedT212Ticker,
            accountType,
            requestedQuantity: quantity,
            stopPrice,
          });
        } catch (error) {
          send('error', {
            error: `Execution safety ledger unavailable: ${(error as Error).message}`,
            phase: 'IDEMPOTENCY_UNAVAILABLE',
          });
          controller.close();
          return;
        }

        if (!intentClaim.claimed) {
          let completed = intentClaim.sameOperation
            && !intentClaim.payloadMismatch
            && (intentClaim.status === 'COMPLETED'
              || intentClaim.status === 'COMPLETED_WITH_WARNING'
              || intentClaim.status === 'COMPLETED_RECONCILED');
          let conflictStatus = intentClaim.status;
          let conflictMessage: string | null = null;
          let reconciledPositionId = intentClaim.positionId;
          let reconciledOrderId = intentClaim.orderId;

          const retainedUncertain = intentClaim.sameOperation
            && !intentClaim.payloadMismatch
            && (intentClaim.status === 'BROKER_OUTCOME_UNKNOWN'
              || intentClaim.status === 'RECONCILIATION_REQUIRED');
          if (retainedUncertain) {
            try {
              const reconciliationClient = await getT212Client(resolvedUserId, accountType);
              const reconciliation = await reconcileExecutionIntent(
                intentClaim.operationId,
                reconciliationClient,
              );
              conflictStatus = reconciliation.status;
              conflictMessage = reconciliation.message;
              if (reconciliation.status === 'COMPLETED_RECONCILED') {
                completed = true;
                reconciledPositionId = reconciliation.positionId;
                reconciledOrderId = reconciliation.orderId;
              } else if (reconciliation.released) {
                send('error', {
                  error: `${reconciliation.message} No broker side effect remains; submit again to start a new trade attempt.`,
                  phase: 'EXECUTION_RECONCILED_NO_EFFECT',
                  operationId: intentClaim.operationId,
                  retainOperationId: false,
                  status: reconciliation.status,
                  critical: false,
                });
                controller.close();
                return;
              }
            } catch (error) {
              conflictMessage = `Reconciliation could not complete: ${(error as Error).message}`;
            }
          }

          send(completed ? 'complete' : 'error', {
            error: conflictMessage ?? (intentClaim.payloadMismatch
              ? 'Operation ID was already used with different trade details.'
              : intentClaim.sameOperation
                ? `This trade attempt was already accepted (${conflictStatus}). No second order was submitted.`
                : `An equivalent trade is already active (${conflictStatus}). Reconcile it before retrying.`),
            phase: 'IDEMPOTENCY_CONFLICT',
            operationId: intentClaim.operationId,
            retainOperationId: !completed && !intentClaim.payloadMismatch,
            status: conflictStatus,
            position: completed ? {
              id: reconciledPositionId,
              ticker,
              t212Ticker: resolvedT212Ticker,
              orderId: reconciledOrderId ? Number(reconciledOrderId) : undefined,
              accountType,
            } : undefined,
            stopFailed: conflictStatus === 'COMPLETED_WITH_WARNING',
            critical: !completed && !intentClaim.payloadMismatch,
          });
          controller.close();
          return;
        }

        // ── Get T212 Client ──
        let client: Trading212Client;
        try {
          client = await getT212Client(resolvedUserId, accountType);
        } catch (err) {
          const msg = (err as Error).message;
          await logExecution({
            ticker, phase: 'CLIENT_ERROR', requestBody: JSON.stringify(body),
            accountType, error: msg,
          });
          await updateExecutionIntent(operationId, {
            status: 'FAILED_PRE_SUBMISSION',
            error: msg,
            release: true,
          }).catch(() => undefined);
          send('error', { error: msg, phase: 'CLIENT_ERROR' });
          controller.close();
          return;
        }

        // ════════════════════════════════════════════════════
        //  PHASE A: Place Market Buy Order
        // ════════════════════════════════════════════════════

        updatePhase(0, { status: 'running' });

        let baselinePosition = { quantity: 0, averagePricePaid: 0 };
        try {
          const positions = await client.getPositions();
          const existing = positions.find(position => position.instrument.ticker === resolvedT212Ticker);
          if (existing) {
            baselinePosition = {
              quantity: existing.quantity,
              averagePricePaid: existing.averagePricePaid,
            };
          }
        } catch (err) {
          const msg = `Unable to capture pre-order broker position: ${(err as Error).message}`;
          await logExecution({
            ticker, phase: 'POSITION_SNAPSHOT_FAILED', requestBody: JSON.stringify(body),
            accountType, error: msg,
          });
          updatePhase(0, { status: 'failed', message: msg });
          await updateExecutionIntent(operationId, {
            status: 'FAILED_PRE_SUBMISSION',
            error: msg,
            release: true,
          }).catch(() => undefined);
          send('error', { error: msg, phase: 'POSITION_SNAPSHOT_FAILED', critical: false });
          controller.close();
          return;
        }

        let buyOrder: T212PendingOrder;
        const buyRequest = { quantity, ticker: resolvedT212Ticker };

        try {
          await updateExecutionIntent(operationId, {
            status: 'BROKER_SUBMITTING',
            baselineQuantity: baselinePosition.quantity,
            baselineAveragePrice: baselinePosition.averagePricePaid,
            markBrokerSubmitted: true,
          });
          buyOrder = await client.placeMarketOrder(buyRequest);

          await updateExecutionIntent(operationId, {
            status: 'BROKER_SUBMITTED',
            orderId: String(buyOrder.id),
          }).catch((error) => {
            console.error('[ExecutionIntent] Failed to record submitted order:', error);
          });

          await logExecution({
            ticker, phase: 'BUY_PLACED',
            orderId: String(buyOrder.id),
            requestBody: JSON.stringify(buyRequest),
            responseStatus: 200,
            responseBody: JSON.stringify(buyOrder),
            quantity,
            accountType,
          });

          updatePhase(0, {
            status: 'success',
            message: `Buy order placed (ID: ${buyOrder.id})`,
            orderId: buyOrder.id,
          });
        } catch (err) {
          const msg = err instanceof Trading212Error
            ? `T212 API error ${err.statusCode}: ${err.message}`
            : (err as Error).message;

          await logExecution({
            ticker, phase: 'BUY_FAILED',
            requestBody: JSON.stringify(buyRequest),
            responseStatus: err instanceof Trading212Error ? err.statusCode : null,
            accountType, error: msg,
          });

          const definiteRejection = err instanceof Trading212Error
            && err.statusCode >= 400
            && err.statusCode < 500
            && err.statusCode !== 408;
          const outcomeUnknown = !definiteRejection;
          await updateExecutionIntent(operationId, {
            status: outcomeUnknown ? 'BROKER_OUTCOME_UNKNOWN' : 'FAILED_PRE_SUBMISSION',
            error: msg,
            release: !outcomeUnknown,
          }).catch(() => undefined);

          updatePhase(0, { status: 'failed', message: msg });
          send('error', {
            error: outcomeUnknown
              ? `${msg}. Broker acceptance is unknown; reconcile T212 before retrying.`
              : msg,
            phase: outcomeUnknown ? 'BROKER_OUTCOME_UNKNOWN' : 'BUY_FAILED',
            critical: outcomeUnknown,
          });
          controller.close();
          return;
        }

        // ════════════════════════════════════════════════════
        //  PHASE B: Poll for Fill (every 3s, max 20 attempts)
        // ════════════════════════════════════════════════════

        updatePhase(1, { status: 'running' });

        let filledOrder: T212PendingOrder | null = null;
        let filledQuantity = 0;
        let filledPrice = 0;
        const MAX_POLLS = 20;
        const POLL_INTERVAL_MS = 3000;

        for (let attempt = 1; attempt <= MAX_POLLS; attempt++) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

          try {
            const order = await client.getOrder(buyOrder.id);

            await logExecution({
              ticker, phase: 'BUY_POLLING',
              orderId: String(buyOrder.id),
              requestBody: JSON.stringify({ orderId: buyOrder.id, attempt }),
              responseStatus: 200,
              responseBody: JSON.stringify(order),
              quantity,
              accountType,
            });

            // Check if filled — T212 returns filledQuantity > 0 when (partially) filled
            if (order.filledQuantity > 0 && order.filledQuantity >= quantity * 0.99) {
              filledOrder = order;
              filledQuantity = order.filledQuantity;
              // Approximate fill price from filledValue / filledQuantity
              filledPrice = order.filledValue > 0 && order.filledQuantity > 0
                ? order.filledValue / order.filledQuantity
                : entryPrice;
              break;
            }

            updatePhase(1, {
              status: 'running',
              message: `Waiting for fill... (${attempt}/${MAX_POLLS})`,
            });
          } catch (err) {
            // 404 on getOrder often means the order was already filled and removed from pending
            if (err instanceof Trading212Error && err.statusCode === 404) {
              // Order left the pending endpoint — require exact order history for attribution.
              try {
                const history = await client.getOrderHistory(50, { maxPages: 2 });
                const fill = getHistoricalFill(history, buyOrder.id);
                if (fill) {
                  filledQuantity = fill.filledQuantity;
                  filledPrice = fill.filledPrice;
                  filledOrder = buyOrder; // Use the original order reference
                  break;
                }
              } catch {
                // Fall through to timeout
              }
            }
            // Log but don't abort — keep polling
            console.warn(`[Execute] Poll attempt ${attempt} error:`, (err as Error).message);
          }
        }

        if (!filledOrder || filledQuantity === 0) {
          const recovery = await recoverTimedOutBuy(
            client,
            buyOrder.id,
          );

          if (recovery.status === 'FILLED') {
            filledOrder = buyOrder;
            filledQuantity = recovery.filledQuantity;
            filledPrice = recovery.filledPrice;
          } else {
            const unresolved = recovery.status === 'UNRESOLVED';
            const recoveryMessage = unresolved
              ? ` Exposure is unresolved: ${recovery.error}`
              : ' The pending order was cancelled and no broker position was found.';

            await updateExecutionIntent(operationId, {
              status: unresolved ? 'RECONCILIATION_REQUIRED' : 'CANCELLED',
              orderId: String(buyOrder.id),
              error: unresolved ? recovery.error : undefined,
              release: !unresolved,
            }).catch(() => undefined);

          await logExecution({
            ticker, phase: 'BUY_TIMEOUT',
            orderId: String(buyOrder.id),
            requestBody: JSON.stringify({ orderId: buyOrder.id, maxPolls: MAX_POLLS }),
            accountType,
              error: `Fill not confirmed after ${MAX_POLLS} polls (${MAX_POLLS * POLL_INTERVAL_MS / 1000}s).${recoveryMessage}`,
          });

          updatePhase(1, {
            status: 'failed',
              message: unresolved
                ? `Fill not confirmed and exposure unresolved — check T212 immediately`
                : `Fill not confirmed — order cancelled with no position found`,
          });
          updatePhase(2, { status: 'skipped', message: 'Skipped — fill not confirmed' });
          updatePhase(3, { status: 'skipped', message: 'Skipped — fill not confirmed' });

          send('error', {
              error: unresolved
                ? `Buy order ${buyOrder.id} timed out and could not be reconciled. Check T212 immediately before taking any further action. ${recovery.error}`
                : `Buy order ${buyOrder.id} timed out, was cancelled, and no broker position was found.`,
            phase: 'BUY_TIMEOUT',
              critical: unresolved,
            orderId: buyOrder.id,
          });
          controller.close();
          return;
          }
        }

        updatePhase(1, {
          status: 'success',
          message: `Filled ${filledQuantity} shares @ ${filledPrice.toFixed(4)}`,
          filledQuantity,
          filledPrice,
        });

        // ════════════════════════════════════════════════════
        //  PHASE C: Place Stop-Loss (NEGATIVE quantity)
        // ════════════════════════════════════════════════════

        updatePhase(2, { status: 'running' });

        // Track the stop actually live at T212 so the DB row matches reality.
        // Defaults to the intended stop: on failure the DB still records the
        // intended stop so the nightly orphan detector (which keys off
        // currentStop > 0 with no broker stop) re-places it.
        let stopPlacedOk = false;
        let protectiveStopOrderId: string | null = null;
        let actualStopPrice = stopPrice;

        // Safety: stop quantity MUST be negative
        const stopQuantity = -Math.abs(filledQuantity);
        if (stopQuantity >= 0) {
          // This should never happen but we check anyway
          const errMsg = `CRITICAL: stopQuantity is not negative (${stopQuantity}). Aborting stop placement.`;
          await logExecution({
            ticker, phase: 'STOP_FAILED',
            requestBody: JSON.stringify({ stopQuantity, stopPrice }),
            accountType, error: errMsg, stopPrice,
          });
          updatePhase(2, { status: 'failed', message: errMsg });
          // Still create DB position but flag the stop issue
          send('phase', { phases, currentPhase: 2, warning: errMsg });
        } else {
          // F1 (audit 2026): immediate widen-retry tier — parity with the
          // automated path. Up to 3 attempts (~1.5s) with progressively wider
          // stops; terminal auth errors abort early. Replaces the previous
          // single attempt that left positions unprotected on transient 4xx/5xx.
          const stopResult = await placeStopWithRetry({
            client,
            t212Ticker: resolvedT212Ticker,
            filledPrice,
            filledQuantity,
            baseStopPrice: stopPrice,
          });

          // Audit-log every attempt (ExecutionLog trail parity with cron).
          for (const a of stopResult.attempts) {
            await logExecution({
              ticker,
              phase: a.orderId ? 'STOP_PLACED' : 'STOP_FAILED',
              orderId: a.orderId,
              requestBody: JSON.stringify({
                quantity: stopQuantity,
                stopPrice: a.stopPrice,
                ticker: resolvedT212Ticker,
                attempt: a.attempt,
              }),
              responseStatus: a.orderId ? 200 : (a.statusCode ?? null),
              accountType,
              error: a.error,
              stopPrice: a.stopPrice,
              quantity: stopQuantity,
            });
          }

          if (stopResult.placed) {
            stopPlacedOk = true;
            protectiveStopOrderId = stopResult.orderId ?? null;
            actualStopPrice = stopResult.stopPrice;
            await updateExecutionIntent(operationId, {
              status: 'STOP_PLACED',
              stopOrderId: protectiveStopOrderId ?? undefined,
            }).catch((error) => {
              console.error('[ExecutionIntent] Failed to record protective stop:', error);
            });
            const retryNote = stopResult.attempts.length > 1
              ? ` (after ${stopResult.attempts.length} attempts)`
              : '';
            updatePhase(2, {
              status: 'success',
              message: `Stop-loss set @ ${actualStopPrice.toFixed(4)}${retryNote} (ID: ${stopResult.orderId})`,
              orderId: stopResult.orderId ? Number(stopResult.orderId) : undefined,
            });
          } else {
            const lastErr = stopResult.attempts.at(-1)?.error ?? 'unknown error';

            // CRITICAL: Stop failed after all retries but shares are bought.
            updatePhase(2, { status: 'failed', message: `CRITICAL: ${lastErr}` });

            // Durable alert — survives the modal closing (fixes the prior
            // ephemeral-SSE-only gap). Saved in-app + Telegram (CRITICAL).
            await sendAlert({
              type: 'UNPROTECTED_POSITION',
              title: `Unprotected position: ${ticker}`,
              message: `Manual buy of ${filledQuantity} ${ticker} @ ${filledPrice.toFixed(4)} filled, but the stop-loss failed to place after ${stopResult.attempts.length} attempt(s)${stopResult.terminal ? ' (terminal auth/permission error)' : ''}. Set a stop @ ~${stopPrice.toFixed(4)} in the T212 app NOW.`,
              priority: 'CRITICAL',
              data: {
                ticker,
                filledPrice,
                filledQuantity,
                intendedStop: stopPrice,
                accountType,
                attempts: stopResult.attempts.length,
                terminal: stopResult.terminal,
                source: 'manual-execute',
              },
            });

            // Don't abort — still create DB position so the orphan detector can
            // recover it; send the critical SSE warning for the live modal too.
            send('phase', {
              phases,
              currentPhase: 2,
              critical: true,
              warning: `CRITICAL: Stop-loss failed after ${stopResult.attempts.length} attempt(s). A durable alert was sent. Set a stop-loss manually at ${stopPrice.toFixed(4)} immediately. Error: ${lastErr}`,
            });
          }
        }

        // ════════════════════════════════════════════════════
        //  PHASE D: Create DB Position (reuse existing POST logic)
        // ════════════════════════════════════════════════════

        // Durable alert for a LIVE fill that could not be recorded in the DB.
        // The buy (and possibly the stop) are already live on T212, so a failure
        // here leaves a position recorded nowhere. Routed as ORPHAN_T212_FILL so
        // hourly-status re-surfaces it until the operator reconciles; deduped by
        // buy order id to match the cron orphan-recovery path. sendAlert never throws.
        const alertUnrecordedFill = (dbError: string) =>
          sendAlert({
            type: 'ORPHAN_T212_FILL',
            title: `Live fill not recorded: ${ticker}`,
            message: `Manual buy of ${filledQuantity} ${ticker} @ ${filledPrice.toFixed(4)} (${accountType}) filled on T212, but the position could not be saved to the database. Create it manually. Stop ${stopPlacedOk ? `is live @ ${actualStopPrice.toFixed(4)}` : `is NOT live — set one @ ~${stopPrice.toFixed(4)} too`}.`,
            priority: 'CRITICAL',
            notificationDedupeKey: `orphan-${buyOrder.id}`,
            telegramDedupeKey: `orphan-${buyOrder.id}`,
            data: {
              source: 'manual-execute',
              orderId: buyOrder.id,
              ticker,
              t212Ticker,
              filledPrice,
              filledQuantity,
              stopPlaced: stopPlacedOk,
              stopPrice: stopPlacedOk ? actualStopPrice : stopPrice,
              accountType,
              dbError,
            },
          });

        updatePhase(3, { status: 'running' });

        try {
          // Call the existing position creation endpoint internally
          const cookie = request.headers.get('cookie');
          const positionResponse = await fetch(new URL('/api/positions', request.url), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(cookie ? { Cookie: cookie } : {}),
            },
            body: JSON.stringify({
              userId: resolvedUserId,
              stockId: resolvedStockId,
              entryPrice: filledPrice,
              shares: filledQuantity,
              stopLoss: actualStopPrice,
              atrAtEntry,
              adxAtEntry,
              scanStatus,
              bqsScore,
              fwsScore,
              ncsScore,
              dualScoreAction,
              rankScore,
              entryType: entryType || 'BREAKOUT',
              plannedEntry: entryPrice,
              accountType,
              notes: notes || `T212 auto-execute: Order ${buyOrder.id}`,
            }),
          });

          const positionData = await positionResponse.json();

          if (!positionResponse.ok) {
            const errMsg = positionData.message || positionData.error || 'Failed to create DB position';

            await logExecution({
              ticker, phase: 'DB_POSITION_FAILED',
              orderId: String(buyOrder.id),
              requestBody: JSON.stringify({ filledPrice, filledQuantity, stopPrice }),
              responseStatus: positionResponse.status,
              responseBody: JSON.stringify(positionData),
              accountType, error: errMsg,
            });

            await alertUnrecordedFill(errMsg);
            await updateExecutionIntent(operationId, {
              status: 'RECONCILIATION_REQUIRED',
              orderId: String(buyOrder.id),
              error: errMsg,
            }).catch(() => undefined);

            updatePhase(3, { status: 'failed', message: errMsg });
            send('error', {
              error: `Position record failed to save. The trade IS live on T212. Create manually: ${filledQuantity} shares @ ${filledPrice.toFixed(4)}, stop @ ${stopPrice.toFixed(4)}`,
              phase: 'DB_POSITION_FAILED',
              critical: true,
              orderId: buyOrder.id,
            });
            controller.close();
            return;
          }

          await logExecution({
            ticker, phase: 'COMPLETE',
            orderId: String(buyOrder.id),
            requestBody: JSON.stringify({ positionId: positionData.id }),
            responseStatus: 201,
            responseBody: JSON.stringify(positionData),
            stopPrice: actualStopPrice,
            quantity: filledQuantity,
            accountType,
          });

          try {
            if (!stopPlacedOk || !protectiveStopOrderId) {
              const protectionError = 'Position saved, but no protective broker stop was verified.';
              await updateExecutionIntent(operationId, {
                status: 'RECONCILIATION_REQUIRED',
                orderId: String(buyOrder.id),
                positionId: positionData.id,
                error: protectionError,
              });
              send('error', {
                error: `${protectionError} Set and verify the stop in T212 before retrying this trade.`,
                phase: 'UNPROTECTED_POSITION',
                critical: true,
                retainOperationId: true,
                operationId,
                orderId: buyOrder.id,
                positionId: positionData.id,
              });
              controller.close();
              return;
            }

            await updateExecutionIntent(operationId, {
              status: 'COMPLETED',
              orderId: String(buyOrder.id),
              stopOrderId: protectiveStopOrderId,
              positionId: positionData.id,
              release: true,
            });
          } catch (error) {
            const ledgerError = `Position saved, but execution ledger completion failed: ${(error as Error).message}`;
            await sendAlert({
              type: 'ORPHAN_T212_FILL',
              title: `Execution ledger incomplete: ${ticker}`,
              message: `${ledgerError}. Order ${buyOrder.id}, position ${positionData.id}. Reconcile before retrying this trade.`,
              priority: 'CRITICAL',
              notificationDedupeKey: `ledger-${operationId}`,
              telegramDedupeKey: `ledger-${operationId}`,
              data: { operationId, orderId: buyOrder.id, positionId: positionData.id, ticker },
            });
            send('error', {
              error: ledgerError,
              phase: 'EXECUTION_LEDGER_INCOMPLETE',
              critical: true,
              retainOperationId: true,
              operationId,
              orderId: buyOrder.id,
              positionId: positionData.id,
            });
            controller.close();
            return;
          }

          updatePhase(3, {
            status: 'success',
            message: `Position saved (ID: ${positionData.id?.slice(0, 8)}...)`,
          });

          // ── SUCCESS ──
          send('complete', {
            phases,
            position: {
              id: positionData.id,
              ticker,
              t212Ticker,
              filledQuantity,
              filledPrice,
              stopPrice: actualStopPrice,
              orderId: buyOrder.id,
              accountType,
            },
            // Flag if stop placement failed (no broker stop is live)
            stopFailed: !stopPlacedOk,
          });

        } catch (err) {
          const msg = (err as Error).message;
          await logExecution({
            ticker, phase: 'DB_POSITION_FAILED',
            requestBody: JSON.stringify({ filledPrice, filledQuantity }),
            accountType, error: msg,
          });

          await alertUnrecordedFill(msg);
          await updateExecutionIntent(operationId, {
            status: 'RECONCILIATION_REQUIRED',
            orderId: String(buyOrder.id),
            error: msg,
          }).catch(() => undefined);

          updatePhase(3, { status: 'failed', message: msg });
          send('error', {
            error: `Position record failed. Trade IS live on T212: ${filledQuantity} shares @ ${filledPrice.toFixed(4)}. Create position manually.`,
            phase: 'DB_POSITION_FAILED',
            critical: true,
          });
        }

      } catch (err) {
        // Unexpected top-level error
        const msg = (err as Error).message || 'Unexpected execution error';
        await logExecution({
          ticker, phase: 'UNEXPECTED_ERROR',
          requestBody: JSON.stringify(body),
          accountType, error: msg,
        });
        send('error', { error: msg, phase: 'UNEXPECTED_ERROR', critical: true });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
