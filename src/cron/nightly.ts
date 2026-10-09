/**
 * DEPENDENCIES
 * Consumed by: nightly-task.bat
 * Consumes: health-check.ts, stop-manager.ts, telegram.ts, market-data.ts, equity-snapshot.ts, snapshot-sync.ts, laggard-detector.ts, modules/*, risk-gates.ts, position-sizer.ts, prisma.ts, @/types
 * Risk-sensitive: YES
 * Last modified: 2026-02-24
 * Notes: Nightly automation should continue on partial failures.
 */
/**
 * HybridTurtle Nightly Cron Job — Standalone
 *
 * Runs the full nightly process directly (no running dashboard needed).
 *
 * 9-Step Nightly Process:
 * 1. Run 16-point health check
 * 2. Fetch live prices for all open positions
 * 3. Generate stop-loss recommendations + trailing ATR stops
 * 4. Detect laggards / dead money
 * 5. Run risk-signal modules (climax, swap, whipsaw, breadth, momentum)
 * 6. Record equity snapshot + check pyramid opportunities
 * 7. Sync snapshot data from Yahoo Finance + query READY candidates
 * 8. Send Telegram summary
 * 9. Write heartbeat
 *
 * Usage:
 *   npx tsx src/cron/nightly.ts --run-now
 */

import prisma from '@/lib/prisma';
import { runHealthCheck } from '@/lib/health-check';
import { generateStopRecommendations, generateTrailingStopRecommendations, updateStopLoss } from '@/lib/stop-manager';
import { ukLineUnitsIssue } from '@/lib/listing-identity';
import { getT212LineCurrency } from '@/lib/t212-instruments-cache';
import { decideStopCommit } from '@/lib/nightly-stop-apply';
import { sendNightlySummary } from '@/lib/telegram';
import { deliverNightlyNotification } from './nightly-notification';
import type { NightlyPositionDetail, NightlyStopChange, NightlyReadyCandidate, NightlyTriggerMetCandidate, NightlyLaggardAlert, NightlyClimaxAlert, NightlySwapAlert, NightlyWhipsawAlert, NightlyBreadthAlert, NightlyMomentumAlert, NightlyPyramidAlert, NightlyGapRiskAlert, NightlyBreakoutFailureAlert, NightlyAcceleratorAlert } from '@/lib/telegram';
import { getBatchQuotes, normalizeBatchPricesToGBP, getDailyPrices, calculateADX, calculateATR, calculateMA, preCacheHistoricalData, getDataFreshness, getMarketRegime } from '@/lib/market-data';
import { fetchWithFallback, toPriceRecord } from '@/lib/data-provider';
import { fetchT212LivePrices } from '@/lib/position-sync';
import type { DataSourceHealth } from '@/lib/data-provider';
import { recordEquitySnapshot } from '@/lib/equity-snapshot';
import { syncClosedPositions } from '@/lib/position-sync';
import type { PositionSyncResult } from '@/lib/position-sync';
import { syncSnapshot } from '@/lib/snapshot-sync';
import { detectLaggards } from '@/lib/laggard-detector';
import { computeCapitalAdjustedDrawdown, fromFirstBrokerSnapshot, loadCapitalEvents, UNEXPLAINED_STEP_PCT } from '@/lib/capital-adjusted-drawdown';
import { rankActions, type AcceleratorContext, type HeldPosition, type ReadyCandidate as AcceleratorCandidate } from '@/lib/profit-accelerator';
import { detectBreakoutFailures } from '@/lib/breakout-failure-detector';
import type { BreakoutFailureResult } from '@/lib/breakout-failure-detector';
import { scanClimaxSignals } from '@/lib/modules/climax-detector';
import { findSwapSuggestions } from '@/lib/modules/heatmap-swap';
import { checkWhipsawBlocks } from '@/lib/modules/whipsaw-guard';
import { calculateBreadth, checkBreadthSafety } from '@/lib/modules/breadth-safety';
import { computeCorrelationMatrix } from '@/lib/correlation-matrix';
import { refreshSectorMomentumCache } from '@/lib/sector-etf-cache';
import { preCacheEarningsBatch } from '@/lib/earnings-calendar';
import { getRiskBudget, canPyramid, calculatePyramidAddSize, validateRiskGates } from '@/lib/risk-gates';
import { calculateRMultiple } from '@/lib/position-sizer';
import { sendAlert } from '@/lib/alert-service';
import { selectStopHitTriggerPrice } from '@/lib/stop-hit-detection';
import { backupDatabase } from '@/lib/db-backup';
import { isAutoTradingEnabled } from '../../packages/workflow/src';
import { Trading212Client, Trading212Error } from '@/lib/trading212';
import type { T212AccountType } from '@/lib/trading212-dual';
import { decryptField } from '@/lib/crypto';
import { isEarlyCloseDay, checkHolidayCoverage } from '@/lib/market-holidays';
import { createCronLogger } from '@/lib/cron-logger';
import { getUKDayOfWeek } from '@/lib/uk-time';
import { saveScoreBreakdowns } from '@/lib/score-tracker';
import { scoreRow, normaliseRow } from '@/lib/dual-score';
import { RISK_PROFILES, EQUITY_REVIEW_THRESHOLDS, type RiskProfileType, type Sleeve } from '@/types';
import { randomUUID } from 'node:crypto';
import { claimExecutionIntent, hashExecutionPayload, hasActiveBrokerSubmissionLease, updateExecutionIntent } from '@/lib/execution-intent';
import { getHistoricalFill, recoverTimedOutBuy } from '@/lib/buy-timeout-recovery';

// Track which (accountType) decrypt failures have already alerted this
// process so we send exactly one CRITICAL alert per account per nightly run,
// not one per call site. See audit 2026-05-16 (H3).
const t212CredentialAlertsSent = new Set<T212AccountType>();

async function getNightlyT212Client(userId: string, accountType: T212AccountType): Promise<Trading212Client | null> {
  let user:
    | {
        t212ApiKey: string | null;
        t212ApiSecret: string | null;
        t212Environment: string;
        t212Connected: boolean;
        t212IsaApiKey: string | null;
        t212IsaApiSecret: string | null;
        t212IsaConnected: boolean;
      }
    | null = null;
  try {
    user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        t212ApiKey: true, t212ApiSecret: true, t212Environment: true, t212Connected: true,
        t212IsaApiKey: true, t212IsaApiSecret: true, t212IsaConnected: true,
      },
    });
  } catch (err) {
    // DB read failed \u2014 distinct from "user not connected". Surface but stay safe.
    console.warn(`[Nightly] T212 ${accountType} credential lookup failed: ${(err as Error).message}`);
    return null;
  }
  if (!user) return null;

  const apiKey = accountType === 'isa' ? user.t212IsaApiKey : user.t212ApiKey;
  const apiSecret = accountType === 'isa' ? user.t212IsaApiSecret : user.t212ApiSecret;
  const connected = accountType === 'isa' ? user.t212IsaConnected : user.t212Connected;

  // Not configured \u2014 silently skip (legitimate state for ISA-only / Invest-only users).
  if (!apiKey || !connected) return null;

  // Decrypt \u2014 this is where ENCRYPTION_SECRET rotation or DB corruption surfaces.
  // If we silently swallow this (the pre-2026-05-16 behaviour), broker stop sync
  // is disabled for the rest of the process with no signal to the operator.
  let decryptedKey: string;
  let decryptedSecret: string;
  try {
    decryptedKey = decryptField(apiKey);
    decryptedSecret = decryptField(apiSecret ?? '');
  } catch (err) {
    const errMsg = (err as Error).message;
    if (!t212CredentialAlertsSent.has(accountType)) {
      t212CredentialAlertsSent.add(accountType);
      // Fire-and-forget alert; we do not want to block the nightly on telegram.
      sendAlert({
        type: 'SYSTEM',
        title: `T212 ${accountType.toUpperCase()} credential decryption FAILED`,
        message:
          `getNightlyT212Client could not decrypt the T212 ${accountType} credentials. ` +
          `Likely cause: ENCRYPTION_SECRET (or NEXTAUTH_SECRET) was rotated since the credentials were saved, ` +
          `or the encrypted value in the DB is corrupted. ` +
          `Broker stop sync is DISABLED for this account until the credentials are re-entered via /settings. ` +
          `Local stop ladder updates continue, but T212 stops will drift from DB stops. ` +
          `Error: ${errMsg}`,
        priority: 'CRITICAL',
        telegramDedupeKey: `t212-decrypt-fail:${accountType}`,
      }).catch(() => {
        // Alert dispatch itself failed \u2014 nothing more we can do here.
      });
    }
    return null;
  }

  return new Trading212Client(decryptedKey, decryptedSecret, user.t212Environment as 'demo' | 'live');
}

async function runNightlyProcess() {
  const userId = 'default-user';
  let hadFailure = false;
  // Step-level tracking for PARTIAL heartbeat status
  interface StepResult {
    step: string;
    name: string;
    status: 'OK' | 'FAILED' | 'SKIPPED';
    error?: string;
    durationMs: number;
  }
  const stepResults: StepResult[] = [];
  let currentStepStart = 0;
  let currentStepHadFailure = false;
  let currentStepError: string | undefined;
  function startStep(step: string, name: string): void {
    // Auto-close the previous step when a new one starts
    if (stepResults.length > 0) {
      const prev = stepResults[stepResults.length - 1];
      prev.durationMs = Date.now() - currentStepStart;
      if (currentStepHadFailure) {
        prev.status = 'FAILED';
        if (currentStepError) prev.error = currentStepError;
      }
    }
    currentStepStart = Date.now();
    currentStepHadFailure = false;
    currentStepError = undefined;
    stepResults.push({ step, name, status: 'OK', durationMs: 0 });
  }
  function markStepFailed(error: string): void {
    currentStepHadFailure = true;
    currentStepError = error;
  }
  function finalizeSteps(): void {
    // Close the last open step
    if (stepResults.length > 0) {
      const last = stepResults[stepResults.length - 1];
      last.durationMs = Date.now() - currentStepStart;
      if (currentStepHadFailure) {
        last.status = 'FAILED';
        if (currentStepError) last.error = currentStepError;
      }
    }
  }
  // Track data source health across the pipeline
  let dataSourceHealth: DataSourceHealth = 'LIVE';
  let dataSourceStaleTickers: string[] = [];
  let dataSourceMaxStalenessHours = 0;
  let dataSourceSummary = '';

  const log = createCronLogger('nightly');
  log.info('Nightly process started');
  console.log('========================================');
  console.log(`[HybridTurtle] Nightly process started at ${new Date().toISOString()}`);
  console.log('========================================');

  try {
    // Write RUNNING heartbeat so the dashboard knows we're active
    await prisma.heartbeat.create({
      data: { kind: 'NIGHTLY', status: 'RUNNING', details: JSON.stringify({ startedAt: new Date().toISOString() }) },
    });
    console.log('  [---] RUNNING heartbeat written');

    // Check for tomorrow's early-close or holiday so the nightly summary can note it
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    const tomorrowEarlyClose = isEarlyCloseDay(tomorrowStr);
    if (tomorrowEarlyClose) {
      log.info('Tomorrow is an early-close day', { date: tomorrowStr, closeTime: tomorrowEarlyClose });
    }

    // Holiday calendar coverage check — warn in January if next year is missing
    const currentMonth = new Date().getMonth(); // 0 = January
    if (currentMonth === 0) {
      const nextYear = new Date().getFullYear() + 1;
      const coverageWarning = checkHolidayCoverage(nextYear);
      if (coverageWarning) {
        log.warn('Holiday calendar gap detected', { year: nextYear });
        console.warn(`  [!!!] ${coverageWarning}`);
      }
    }

    // Step 0: Pre-cache historical data for all active tickers
    console.log('  [0/9] Pre-caching historical data for all active tickers...');
    startStep('0', 'Pre-cache historical data');
    log.info('Step 0: Pre-cache historical data');
    try {
      const preCacheResult = await preCacheHistoricalData();
      console.log(`        ${preCacheResult.success}/${preCacheResult.total} tickers cached in ${(preCacheResult.durationMs / 1000).toFixed(1)}s`);
      if (preCacheResult.failed.length > 0) {
        console.warn(`        Failed: ${preCacheResult.failed.join(', ')}`);
      }
    } catch (error) {
      hadFailure = true;
      log.error('Step 0 failed', { error: (error as Error).message });
      console.error('  [0] Pre-cache failed:', (error as Error).message);
    }

    // Step 0a: Credential decrypt smoke-test
    // Detects the silent-rotation cascade where rotating NEXTAUTH_SECRET (or
    // a botched ENCRYPTION_SECRET migration) leaves stored T212/Telegram
    // credentials undecryptable. Without this, the failure surfaces only as
    // a generic "broker not connected" at the next session, with no pointer
    // to root cause. Audit 2026-06-16 (HIGH-2).
    console.log('  [0a] Credential decrypt smoke-test...');
    try {
      const u = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          t212ApiKey: true,
          t212IsaApiKey: true,
          telegramBotToken: true,
          telegramChatId: true,
        },
      });
      const fields: Array<[string, string | null | undefined]> = u ? [
        ['t212ApiKey', u.t212ApiKey],
        ['t212IsaApiKey', u.t212IsaApiKey],
        ['telegramBotToken', u.telegramBotToken],
        ['telegramChatId', u.telegramChatId],
      ] : [];
      const broken: string[] = [];
      for (const [name, value] of fields) {
        if (!value || !value.startsWith('enc:')) continue;
        try {
          decryptField(value);
        } catch (err) {
          broken.push(`${name}: ${(err as Error).message}`);
        }
      }
      if (broken.length > 0) {
        console.error(`  [0a] CREDENTIAL DECRYPT FAILED for ${broken.length} field(s)`);
        await sendAlert({
          type: 'SYSTEM',
          title: 'Credential decrypt failed — broker may be unreachable',
          message:
            `Stored credentials cannot be decrypted: ${broken.join('; ')}.\n\n` +
            `Likely cause: NEXTAUTH_SECRET was rotated without setting ` +
            `ENCRYPTION_SECRET first. Restore the previous secret value or ` +
            `re-encrypt credentials before the next trading session.`,
          priority: 'CRITICAL',
          telegramDedupeKey: 'credential-decrypt-failed',
          notificationDedupeKey: 'credential-decrypt-failed',
        });
        hadFailure = true;
      } else {
        console.log('        Credential decrypt OK');
      }
    } catch (err) {
      console.error('  [0a] Credential smoke-test threw:', (err as Error).message);
      // Do not block — the test is diagnostic, not a gate.
    }

    // Step 0b: Database backup
    console.log('  [0b] Database backup...');
    try {
      const backupResult = await backupDatabase();
      if (backupResult.success) {
        console.log(`        Backup created: ${backupResult.filename} (${backupResult.sizeBytes} bytes)`);
      } else {
        console.warn(`        Backup failed: ${backupResult.error}`);
        hadFailure = true;
        // Do NOT abort — backup failure should not stop the rest of the pipeline.
        // BUT: a 48h-stale backup hard-blocks all auto-trade sessions
        // (pre-execution-dry-run.ts), so a silent backup failure on Sunday
        // night blocks Monday trading with no clear in-app pointer to the
        // root cause. Fire a CRITICAL alert at the moment of failure.
        // Audit 2026-06-16 (HIGH-4).
        await sendAlert({
          type: 'SYSTEM',
          title: 'Nightly DB backup failed — trading may be blocked',
          message:
            `Backup failed: ${backupResult.error ?? 'unknown error'}.\n\n` +
            `If the most recent successful backup is older than 48h, all ` +
            `auto-trade sessions will be hard-blocked until a fresh backup ` +
            `succeeds. Resolve disk space, permissions, or restore from a ` +
            `known-good backup before the next session.`,
          priority: 'CRITICAL',
          telegramDedupeKey: 'nightly-backup-failed',
          notificationDedupeKey: 'nightly-backup-failed',
        }).catch((alertErr) => {
          console.error('  [0b] Backup-failure alert dispatch failed:', (alertErr as Error).message);
        });
      }
    } catch (err) {
      console.error('  [0b] Backup step threw unexpectedly:', err);
      hadFailure = true;
      await sendAlert({
        type: 'SYSTEM',
        title: 'Nightly DB backup threw — trading may be blocked',
        message:
          `Backup step threw an unexpected error: ${(err as Error).message}.\n\n` +
          `If the most recent successful backup is older than 48h, all ` +
          `auto-trade sessions will be hard-blocked until a fresh backup succeeds.`,
        priority: 'CRITICAL',
        telegramDedupeKey: 'nightly-backup-threw',
        notificationDedupeKey: 'nightly-backup-threw',
      }).catch((alertErr) => {
        console.error('  [0b] Backup-throw alert dispatch failed:', (alertErr as Error).message);
      });
    }

    // Step 1: Run health check (isolated — failure doesn't block other steps)
    console.log('  [1/9] Running health check...');
    startStep('1', 'Health check');
    log.info('Step 1: Health check');
    let healthReport: { overall: string; checks: Record<string, string>; results: unknown[]; timestamp: Date } = {
      overall: 'YELLOW', checks: {}, results: [], timestamp: new Date(),
    };
    try {
      healthReport = await runHealthCheck(userId);
      console.log(`        Health: ${healthReport.overall}`);
    } catch (error) {
      hadFailure = true;
      console.error('  [1] Health check failed:', (error as Error).message);
    }

    // Step 2: Get open positions + fetch live prices
    // Collect alert summary strings for the Telegram nightly report.
    // Declared early so data source alerts (Step 2) and stop-hit detection (Step 3d) can push to it.
    const alerts: string[] = [];
    // Surface tomorrow's early-close as an alert in the nightly summary
    if (tomorrowEarlyClose) {
      alerts.push(`📅 Tomorrow is an early-close day — US market closes at ${tomorrowEarlyClose} ET. The us-close auto-trade session will be skipped.`);
    }
    console.log('  [2/9] Fetching positions and live prices...');
    startStep('2', 'Live prices');
    let positions: Awaited<ReturnType<typeof prisma.position.findMany<{ include: { stock: true } }>>> = [];
    try {
      positions = await prisma.position.findMany({
        where: { userId, status: 'OPEN' },
        include: { stock: true },
      });
    } catch (error) {
      hadFailure = true;
      console.error('  [2] Position fetch failed:', (error as Error).message);
    }
    log.info('Step 2: Live prices', { positionCount: positions.length });

    const openTickers = positions.map((p) => p.stock.ticker);
    let livePrices: Record<string, number> = {};
    try {
      if (openTickers.length > 0) {
        // Use resilient fallback chain: Yahoo → AV → EODHD → DB cache
        const fetchResult = await fetchWithFallback(openTickers, 'nightly');
        livePrices = toPriceRecord(fetchResult);
        dataSourceHealth = fetchResult.health;
        dataSourceStaleTickers = fetchResult.staleTickers;
        dataSourceMaxStalenessHours = fetchResult.maxStalenessHours;
        dataSourceSummary = fetchResult.summary;

        // Surface data source degradation as an alert
        if (fetchResult.health === 'DEGRADED') {
          console.warn(`  [2] DATA DEGRADED — using cached data from ${fetchResult.maxStalenessHours.toFixed(1)}h ago`);
          alerts.push(`⚠ Yahoo Finance unavailable — using cached data from ${fetchResult.maxStalenessHours.toFixed(1)}h ago. Scan results may be slightly outdated.`);
        } else if (fetchResult.health === 'PARTIAL') {
          console.warn(`  [2] PARTIAL DATA — ${fetchResult.staleTickers.length} tickers using cache`);
          alerts.push(`⚠ Yahoo partial failure — ${fetchResult.staleTickers.length} ticker(s) using cached data`);
        }
      }
    } catch (error) {
      hadFailure = true;
      console.error('  [2] Live price fetch failed:', (error as Error).message);
    }

    // Overlay T212 real-time prices for held positions (more accurate than Yahoo)
    if (openTickers.length > 0) {
      try {
        const t212Prices = await fetchT212LivePrices(userId);
        const t212Count = Object.keys(t212Prices).length;
        if (t212Count > 0) {
          Object.assign(livePrices, t212Prices);
          console.log(`        T212 overlay: ${t212Count} tickers upgraded to real-time`);
        }
      } catch {
        console.warn('  [2] T212 price overlay failed — using Yahoo/cache prices');
      }
    }

    const stockCurrencies: Record<string, string | null> = {};
    for (const p of positions) {
      stockCurrencies[p.stock.ticker] = p.stock.currency;
    }
    let gbpPrices: Record<string, number> = {};
    try {
      gbpPrices = openTickers.length > 0
        ? await normalizeBatchPricesToGBP(livePrices, stockCurrencies)
        : {};
    } catch (error) {
      hadFailure = true;
      // Fall back to raw prices so downstream steps can still run
      gbpPrices = { ...livePrices };
      console.error('  [2] FX normalisation failed, using raw prices as fallback:', (error as Error).message);
    }
    console.log(`        ${positions.length} positions, ${Object.keys(livePrices).length} prices fetched`);

    // Check market data freshness — warn if stale
    const freshness = getDataFreshness();
    if (freshness.source === 'STALE_CACHE' || freshness.ageMinutes > 60) {
      alerts.push(`⚠️ Market data is ${freshness.ageMinutes}m old (source: ${freshness.source})`);
      console.warn(`  [2] Data freshness warning: ${freshness.source}, ${freshness.ageMinutes}m old`);
    }

    // Step 2b: Position sync — detect T212 closures before downstream steps
    console.log('  [2b] Syncing positions against Trading 212...');
    let positionSyncResult: PositionSyncResult = { checked: 0, closed: 0, skipped: 0, updated: 0, errors: [] };
    try {
      positionSyncResult = await syncClosedPositions(userId);
      console.log(`        Position sync: ${positionSyncResult.checked} checked, ${positionSyncResult.closed} closed, ${positionSyncResult.skipped} skipped`);
      if (positionSyncResult.errors.length > 0) {
        for (const err of positionSyncResult.errors) {
          console.warn(`        Sync: ${err}`);
        }
      }
      if (positionSyncResult.closed > 0) {
        alerts.push(`${positionSyncResult.closed} position(s) auto-closed via T212 sync`);
        // Re-fetch open positions so downstream steps work with accurate status
        positions = await prisma.position.findMany({
          where: { userId, status: 'OPEN' },
          include: { stock: true },
        });
      }
      if (positionSyncResult.errors.length > 0 && positionSyncResult.closed === 0) {
        alerts.push(`T212 position sync: ${positionSyncResult.errors[0]}`);
      }
    } catch (error) {
      // Position sync failure is non-blocking — nightly continues
      console.error('  [2b] Position sync failed:', (error as Error).message);
      alerts.push('T212 position sync failed — positions not updated. Check manually.');
    }

    // Step 3: Generate stop recommendations (isolated)
    console.log('  [3/9] Generating stop recommendations...');
    startStep('3', 'Stop management');
    log.info('Step 3: Stop management', { openPositions: positions.length });
    const livePriceMap = new Map(Object.entries(livePrices));
    const stopChanges: NightlyStopChange[] = [];
    const atrMap = new Map<string, number>();
    let stopRecs: Awaited<ReturnType<typeof generateStopRecommendations>> = [];
    try {
      // Fetch daily bars in parallel batches — use 'full' so trailing stop (step 3b) gets cache hits
      const PRICE_BATCH = 10;
      for (let i = 0; i < openTickers.length; i += PRICE_BATCH) {
        const batch = openTickers.slice(i, i + PRICE_BATCH);
        await Promise.allSettled(
          batch.map(async (ticker) => {
            const bars = await getDailyPrices(ticker, 'full');
            if (bars.length >= 15) {
              atrMap.set(ticker, calculateATR(bars, 14));
            }
          })
        );
        if (i + PRICE_BATCH < openTickers.length) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      // Compute only — DB commit happens in Step 3-apply below, gated on broker confirmation.
      stopRecs = await generateStopRecommendations(userId, livePriceMap, atrMap);
    } catch (error) {
      hadFailure = true;
      console.error('  [3] R-based stop recommendations failed:', (error as Error).message);
    }

    // Step 3b: Trailing ATR stops (compute only — committed in Step 3-apply below)
    const trailingStopChanges: NightlyStopChange[] = [];
    let trailingRecs: Awaited<ReturnType<typeof generateTrailingStopRecommendations>> = [];
    try {
      trailingRecs = await generateTrailingStopRecommendations(userId);
    } catch (error) {
      hadFailure = true;
      console.warn('  [3b] Trailing stop calculation failed:', (error as Error).message);
    }

    // Step 3-apply: Broker-confirmation-first stop commit.
    // ROBUSTNESS INVARIANT (real money): the DB stop record must never claim a
    // tighter stop than the broker actually holds. So when auto-trading is on and
    // a position has a broker ticker, we PUSH the intended stop to T212 FIRST and
    // commit the DB raise ONLY for positions the broker confirms. Withheld raises
    // leave the DB at its prior (lower-or-equal) stop, so the DB can only ever
    // understate broker protection — never overstate it (the ELV-class divergence).
    const autoTradingEnabled = await isAutoTradingEnabled();
    let stopsPushedToT212 = 0;
    let stopsPushFailed = 0;
    let orphanStopsPlaced = 0;
    const orphanTickersPlaced: string[] = [];
    const unprotectedOrphanTickers: string[] = [];
    const withheldRaiseTickers: string[] = [];
    // positionId -> setStopLossBatch action for tonight's raises (absent = not confirmed).
    const brokerActionByPositionId = new Map<string, string>();

    // Highest intended stop per position (R-based vs trailing). The broker only
    // needs the tightest of the two; the DB writes below reproduce both records
    // for faithful Telegram reporting via the monotonic updateStopLoss guard.
    const intendedStopByPosition = new Map<string, number>();
    for (const rec of stopRecs) {
      const prev = intendedStopByPosition.get(rec.positionId) ?? 0;
      if (rec.newStop > prev) intendedStopByPosition.set(rec.positionId, rec.newStop);
    }
    for (const rec of trailingRecs) {
      const prev = intendedStopByPosition.get(rec.positionId) ?? 0;
      if (rec.trailingStop > prev) intendedStopByPosition.set(rec.positionId, rec.trailingStop);
    }

    if (autoTradingEnabled && intendedStopByPosition.size > 0) {
      console.log('  [3-apply] Pushing intended stops to Trading 212 before DB commit...');
      try {
        // Group open positions by account for per-account broker calls + orphan detection.
        const positionsByAccount = new Map<T212AccountType, typeof positions>();
        for (const p of positions) {
          const acctType: T212AccountType = p.accountType === 'isa' ? 'isa' : 'invest';
          const group = positionsByAccount.get(acctType) ?? [];
          group.push(p);
          positionsByAccount.set(acctType, group);
        }

        for (const [acctType, acctPositions] of Array.from(positionsByAccount.entries())) {
          const client = await getNightlyT212Client(userId, acctType);
          if (!client) {
            console.warn(`  [3-apply] T212 ${acctType} client unavailable — withholding DB commit for its raises`);
            continue;
          }

          // Detect orphans: open positions whose broker ticker has no STOP/SELL order.
          const orphanT212Tickers = new Set<string>();
          try {
            const pending = await client.getPendingOrders();
            const brokerStopTickers = new Set(
              pending.filter(o => o.type === 'STOP' && o.side === 'SELL').map(o => o.ticker)
            );
            for (const p of acctPositions) {
              const t = p.t212Ticker || p.stock.t212Ticker;
              if (t && !brokerStopTickers.has(t) && p.currentStop > 0) {
                orphanT212Tickers.add(t);
              }
            }
          } catch (err) {
            console.warn(`  [3-apply] Orphan detection failed for ${acctType}: ${(err as Error).message}`);
          }

          // Build push batch: tonight's raises ∪ orphans. Raises push the intended
          // (tightest) stop; orphans push their existing currentStop.
          const t212ToPosition = new Map<string, { positionId: string; isRaise: boolean; isOrphan: boolean }>();
          const batchInput: Array<{ t212Ticker: string; shares: number; stopPrice: number }> = [];
          for (const p of acctPositions) {
            const t212Ticker = p.t212Ticker || p.stock.t212Ticker;
            if (!t212Ticker) continue;
            const intended = intendedStopByPosition.get(p.id);
            const isRaise = intended !== undefined && intended > 0;
            const isOrphan = orphanT212Tickers.has(t212Ticker) && p.currentStop > 0;
            const stopPrice = isRaise ? intended! : (isOrphan ? p.currentStop : undefined);
            if (stopPrice === undefined || stopPrice <= 0) continue;
            batchInput.push({ t212Ticker, shares: p.shares, stopPrice });
            t212ToPosition.set(t212Ticker, { positionId: p.id, isRaise, isOrphan });
          }

          if (batchInput.length === 0) continue;

          try {
            const results = await client.setStopLossBatch(batchInput);
            for (const r of results) {
              const mapped = t212ToPosition.get(r.t212Ticker);
              if (mapped?.isRaise) brokerActionByPositionId.set(mapped.positionId, r.action);
              if (r.action === 'PLACED' || r.action === 'UPDATED') {
                stopsPushedToT212++;
                if (mapped?.isOrphan && !mapped.isRaise) {
                  orphanStopsPlaced++;
                  orphanTickersPlaced.push(r.t212Ticker);
                  console.warn(`  [3-apply] Orphan stop placed for ${r.t212Ticker} @ ${r.stopPrice} — position had no broker stop`);
                }
              } else if (r.action === 'SKIPPED_SAME') {
                // Broker already holds this stop — confirmed, no-op.
              } else {
                stopsPushFailed++;
                if (mapped?.isOrphan && !mapped.isRaise) unprotectedOrphanTickers.push(r.t212Ticker);
                console.warn(`  [3-apply] Stop push ${r.action} for ${r.t212Ticker}: ${r.error || ''}`);
              }
            }
          } catch (err) {
            console.warn(`  [3-apply] Batch stop push failed for ${acctType}: ${(err as Error).message}`);
            stopsPushFailed += batchInput.length;
            // Raises: brokerActionByPositionId stays unset → decideStopCommit WITHHOLDs.
            // Orphans: still unprotected at the broker — surface explicitly.
            for (const [t212, mapped] of Array.from(t212ToPosition.entries())) {
              if (mapped.isOrphan && !mapped.isRaise) unprotectedOrphanTickers.push(t212);
            }
          }
        }
      } catch (error) {
        console.warn('  [3-apply] Auto-push stops failed:', (error as Error).message);
        alerts.push('⚠ Auto stop-push to T212 failed — stop raises withheld from DB, check manually');
      }
    }

    // Commit DB stop raises — only those the broker confirmed (or advisory / no broker ticker).
    for (const rec of stopRecs) {
      const pos = positions.find((p) => p.id === rec.positionId);
      const hasBrokerTicker = !!(pos?.t212Ticker || pos?.stock.t212Ticker);
      const decision = decideStopCommit({
        autoTradingEnabled,
        hasBrokerTicker,
        brokerAction: brokerActionByPositionId.get(rec.positionId),
      });
      if (decision === 'WITHHOLD') {
        if (!withheldRaiseTickers.includes(rec.ticker)) withheldRaiseTickers.push(rec.ticker);
        continue;
      }
      const isUK = rec.ticker.endsWith('.L') || /^[A-Z]{2,5}l$/.test(rec.ticker);
      const cur = isUK ? 'GBX' : (pos?.stock.currency || 'USD').toUpperCase();
      try {
        await updateStopLoss(rec.positionId, rec.newStop, rec.reason, rec.newLevel);
        stopChanges.push({
          ticker: rec.ticker,
          oldStop: rec.currentStop,
          newStop: rec.newStop,
          level: rec.newLevel,
          reason: rec.reason,
          currency: cur,
        });
      } catch (err) {
        console.warn(`  [nightly] Stop update skipped due to error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const rec of trailingRecs) {
      const pos = positions.find((p) => p.id === rec.positionId);
      const hasBrokerTicker = !!(pos?.t212Ticker || pos?.stock.t212Ticker);
      const decision = decideStopCommit({
        autoTradingEnabled,
        hasBrokerTicker,
        brokerAction: brokerActionByPositionId.get(rec.positionId),
      });
      if (decision === 'WITHHOLD') {
        if (!withheldRaiseTickers.includes(rec.ticker)) withheldRaiseTickers.push(rec.ticker);
        continue;
      }
      try {
        // F-3: use rec.recommendedLevel so trailing updates do not silently
        // downgrade higher-tier labels (LOCK_08R / LOCK_1R_TRAIL) to TRAILING_ATR.
        await updateStopLoss(rec.positionId, rec.trailingStop, rec.reason, rec.recommendedLevel);
        trailingStopChanges.push({
          ticker: rec.ticker,
          oldStop: rec.currentStop,
          newStop: rec.trailingStop,
          level: rec.recommendedLevel,
          reason: rec.reason,
          currency: rec.priceCurrency,
        });
      } catch (err) {
        console.warn(`  [nightly] Trailing stop update skipped due to error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (stopsPushedToT212 > 0) {
      alerts.push(`✅ ${stopsPushedToT212} stop(s) auto-pushed to T212`);
    }
    if (orphanStopsPlaced > 0) {
      alerts.push(`⚠ Orphan stop(s) placed for ${orphanTickersPlaced.join(', ')} — position(s) had no broker stop (initial Phase C likely skipped)`);
    }
    if (unprotectedOrphanTickers.length > 0) {
      alerts.push(`🚨 ${unprotectedOrphanTickers.length} position(s) UNPROTECTED at broker (${unprotectedOrphanTickers.join(', ')}) — stop placement FAILED. Act now.`);
    }
    if (withheldRaiseTickers.length > 0) {
      alerts.push(`⚠ ${withheldRaiseTickers.length} stop raise(s) NOT confirmed by T212 (${withheldRaiseTickers.join(', ')}) — DB kept at prior stop; broker still holds previous protection. Check manually.`);
    }
    console.log(`        ${stopRecs.length} R-based, ${trailingStopChanges.length} trailing ATR committed; T212 push: ${stopsPushedToT212} pushed (${orphanStopsPlaced} orphans), ${stopsPushFailed} failed, ${withheldRaiseTickers.length} withheld`);

    // Re-fetch positions from DB so all downstream code (stop-hit detection,
    // near-stop alerts, position details, Telegram) uses the committed stop values.
    if (stopChanges.length > 0 || trailingStopChanges.length > 0) {
      try {
        positions = await prisma.position.findMany({
          where: { userId, status: 'OPEN' },
          include: { stock: true },
        });
      } catch (err) {
        console.warn('  [3] Position re-fetch after stop updates failed:', (err as Error).message);
      }
    }

    // Clear near-stop alert flag for positions whose stop just moved
    // (so the alert can fire again if price approaches the new, higher stop)
    const movedPositionIds = [
      ...stopChanges.map((sc) => positions.find((p) => p.stock.ticker === sc.ticker)?.id),
      ...trailingStopChanges.map((sc) => positions.find((p) => p.stock.ticker === sc.ticker)?.id),
    ].filter((id): id is string => !!id);
    if (movedPositionIds.length > 0) {
      try {
        // Clear via raw SQL — Prisma client may not have the field type yet if generate hasn't run
        for (const pid of movedPositionIds) {
          await prisma.$executeRawUnsafe(
            'UPDATE "Position" SET "nearStopAlertSentAt" = NULL WHERE "id" = ? AND "nearStopAlertSentAt" IS NOT NULL',
            pid
          );
        }
      } catch (err) {
        console.warn('  [3] Near-stop flag clear failed:', (err as Error).message);
      }
    }

    // Step 3c: Gap Risk detection for HIGH_RISK positions (advisory only)
    const gapRiskAlerts: NightlyGapRiskAlert[] = [];
    try {
      const highRiskPositions = positions.filter((p) => p.stock.sleeve === 'HIGH_RISK');
      if (highRiskPositions.length > 0) {
        const hrTickers = highRiskPositions.map((p) => p.stock.ticker);
        // getBatchQuotes hits Yahoo quote cache populated by step 2's fetchWithFallback
        const quotes = await getBatchQuotes(hrTickers);
        for (const pos of highRiskPositions) {
          const quote = quotes.get(pos.stock.ticker);
          const atr = atrMap.get(pos.stock.ticker);
          if (!quote || !atr || quote.previousClose <= 0) continue;
          const gapPercent = ((quote.open - quote.previousClose) / quote.previousClose) * 100;
          const atrPercent = (atr / quote.previousClose) * 100;
          const threshold = atrPercent * 2;
          // Flag if absolute gap exceeds 2× ATR%
          if (Math.abs(gapPercent) > threshold) {
            const isUK = pos.stock.ticker.endsWith('.L') || /^[A-Z]{2,5}l$/.test(pos.stock.ticker);
            const currency = isUK ? 'GBX' : (pos.stock.currency || 'USD').toUpperCase();
            gapRiskAlerts.push({ ticker: pos.stock.ticker, gapPercent, atrPercent, threshold, currency });
          }
        }
      }
    } catch (error) {
      console.warn('  [3c] Gap risk detection failed:', (error as Error).message);
    }
    console.log(`        Gap risk: ${gapRiskAlerts.length} flagged`);

    // Step 3d: Stop-hit detection — alert when today's intra-day low <= currentStop.
    // Snapshot price (livePrices) is close-of-day Yahoo + T212 real-time quote —
    // both miss the case where a stop was hit intra-day and price recovered before
    // snapshot time. T212 may have already filled the stop in that window; without
    // checking today's bar.low we never alert. Fall back to snapshot only when
    // today's bar is unavailable (weekend, holiday, data outage). Dedupe per
    // ticker per UTC day so a stuck-below-stop position reminds once daily, not
    // every nightly run.
    const stopHitPositions: Array<{ ticker: string; name: string; currentStop: number; triggerPrice: number; triggerSource: 'INTRA_DAY_LOW' | 'SNAPSHOT'; currency: string }> = [];
    const stopHitTodayStr = new Date().toISOString().split('T')[0];
    try {
      for (const p of positions) {
        // Fetch today's bar from cached daily history (compact = ~100 days).
        // getDailyPrices is memoised, so this also warms the cache for the
        // trailing-ATR step later in this run. Fire-and-forget on failure —
        // fall back to the snapshot path inside the helper.
        let todayBar: { date: string; low: number } | null = null;
        try {
          const bars = await getDailyPrices(p.stock.ticker, 'compact');
          if (bars.length > 0 && bars[0].low != null) {
            todayBar = { date: bars[0].date, low: bars[0].low };
          }
        } catch (err) {
          console.warn(`  [3d] intra-day bar fetch failed for ${p.stock.ticker}: ${(err as Error).message}`);
        }

        const trigger = selectStopHitTriggerPrice(
          todayBar,
          livePrices[p.stock.ticker],
          stopHitTodayStr
        );
        if (!trigger) continue;

        if (trigger.price <= p.currentStop) {
          const isUK = p.stock.ticker.endsWith('.L') || /^[A-Z]{2,5}l$/.test(p.stock.ticker);
          const currency = isUK ? 'GBX' : (p.stock.currency || 'USD').toUpperCase();
          stopHitPositions.push({
            ticker: p.stock.ticker,
            name: p.stock.name || p.stock.ticker,
            currentStop: p.currentStop,
            triggerPrice: trigger.price,
            triggerSource: trigger.source,
            currency,
          });
        }
      }
      // Send stop-hit alerts (any day of the week). Dedupe key prevents
      // duplicate DB rows + Telegram messages when the same position is still
      // below its stop on subsequent nightly runs within the same UTC day.
      for (const hit of stopHitPositions) {
        const currSymbol = hit.currency === 'GBP' || hit.currency === 'GBX' ? '£' : hit.currency === 'EUR' ? '€' : '$';
        const sourceLabel = hit.triggerSource === 'INTRA_DAY_LOW' ? 'intra-day low' : 'latest price';
        const dedupeKey = `stop-hit:${hit.ticker}:${stopHitTodayStr}`;
        await sendAlert({
          type: 'STOP_HIT',
          title: `⚠ Action needed — ${hit.ticker} may have hit its stop`,
          message: `${hit.name} (${hit.ticker}) has fallen to or below your stop-loss level.\n\nStop price: ${currSymbol}${hit.currentStop.toFixed(2)}\n${sourceLabel === 'intra-day low' ? 'Today\'s low' : 'Current price'}: ${currSymbol}${hit.triggerPrice.toFixed(2)} (${sourceLabel})\n\nCheck Trading 212 and confirm whether the position has been closed. If not, close it manually now.`,
          data: {
            ticker: hit.ticker,
            currentStop: hit.currentStop,
            triggerPrice: hit.triggerPrice,
            triggerSource: hit.triggerSource,
          },
          priority: 'WARNING',
          notificationDedupeKey: dedupeKey,
          telegramDedupeKey: dedupeKey,
        });
      }
      if (stopHitPositions.length > 0) {
        alerts.push(`🔴 ${stopHitPositions.length} position(s) hit stop-loss — check Trading 212`);
      }
    } catch (error) {
      console.warn('  [3d] Stop-hit detection failed:', (error as Error).message);
    }
    console.log(`        Stop hits: ${stopHitPositions.length} detected`);

    // Step 3e: Breakout failure detection — price closed back below entry trigger within 5 days
    let breakoutFailureAlerts: NightlyBreakoutFailureAlert[] = [];
    try {
      const bfInput = positions.map((p) => {
        const currentPrice = livePrices[p.stock.ticker];
        const isUK = p.stock.ticker.endsWith('.L') || /^[A-Z]{2,5}l$/.test(p.stock.ticker);
        const currency = isUK ? 'GBX' : (p.stock.currency || 'USD').toUpperCase();
        return {
          id: p.id,
          ticker: p.stock.ticker,
          entryPrice: p.entryPrice,
          entryDate: p.entryDate,
          entryTrigger: p.entryTrigger,
          initialRisk: p.initialRisk,
          // No live price → 0, which the detector skips (never flag on the entry price).
          currentPrice: currentPrice || 0,
          shares: p.shares,
          currency,
          alreadyFlagged: !!p.breakoutFailureDetectedAt,
        };
      });
      const failures = detectBreakoutFailures(bfInput);

      // Persist the detection timestamp on newly-flagged positions
      for (const f of failures) {
        try {
          await prisma.position.update({
            where: { id: f.positionId },
            data: { breakoutFailureDetectedAt: new Date() },
          });
        } catch (err) {
          console.warn(`  [nightly] Breakout failure flag skipped due to error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      breakoutFailureAlerts = failures.map((f) => {
        const currSymbol = f.currency === 'GBP' || f.currency === 'GBX' ? '£' : f.currency === 'EUR' ? '€' : '$';
        return {
          ticker: f.ticker,
          daysHeld: f.daysHeld,
          rMultiple: f.rMultiple,
          entryTrigger: f.entryTrigger,
          currentPrice: f.currentPrice,
          estimatedLoss: f.estimatedLoss,
          currency: f.currency,
          reason: f.reason,
        };
      });

      // Send in-app + Telegram alerts for each breakout failure
      for (const bf of breakoutFailureAlerts) {
        const currSymbol = bf.currency === 'GBP' || bf.currency === 'GBX' ? '£' : bf.currency === 'EUR' ? '€' : '$';
        await sendAlert({
          type: 'BREAKOUT_FAILURE',
          title: `⚠ Breakout failure — ${bf.ticker}`,
          message: `${bf.ticker} has closed back below its entry trigger after ${bf.daysHeld} day${bf.daysHeld !== 1 ? 's' : ''}. Consider exiting.\n\nEntry trigger: ${currSymbol}${bf.entryTrigger.toFixed(2)}\nCurrent price: ${currSymbol}${bf.currentPrice.toFixed(2)}\nExpected loss: -${currSymbol}${Math.abs(bf.estimatedLoss).toFixed(2)}\n\nRecommendation: Exit this position in Trading 212. This breakout has failed.`,
          data: { ticker: bf.ticker, daysHeld: bf.daysHeld, rMultiple: bf.rMultiple, entryTrigger: bf.entryTrigger, currentPrice: bf.currentPrice, estimatedLoss: bf.estimatedLoss },
          priority: 'WARNING',
        });
      }
      if (breakoutFailureAlerts.length > 0) {
        alerts.push(`⚠️ ${breakoutFailureAlerts.length} breakout failure(s) — consider exiting`);
      }
    } catch (error) {
      console.warn('  [3e] Breakout failure detection failed:', (error as Error).message);
    }
    console.log(`        Breakout failures: ${breakoutFailureAlerts.length} detected`);

    // Step 3f: Near-stop alert — warn when price is within 3% of stop-loss
    // Only fires once per position (until stop is moved). HEDGE positions excluded.
    let nearStopCount = 0;
    try {
      const NEAR_STOP_THRESHOLD = 0.03; // 3%

      // Fetch nearStopAlertSentAt for open positions (may not be in Prisma types yet)
      const alertFlags = await prisma.$queryRawUnsafe<Array<{ id: string; nearStopAlertSentAt: string | null }>>(
        'SELECT "id", "nearStopAlertSentAt" FROM "Position" WHERE "status" = \'OPEN\''
      );
      const alertFlagMap = new Map(alertFlags.map((r) => [r.id, r.nearStopAlertSentAt]));

      for (const p of positions) {
        // Skip HEDGE positions — excluded from risk alerts per CLAUDE.md
        if ((p.stock as { sleeve?: string }).sleeve === 'HEDGE') continue;

        const currentPrice = livePrices[p.stock.ticker];
        if (!currentPrice || currentPrice <= 0 || p.currentStop <= 0) continue;

        // Already hit stop (handled by step 3d) or stop above price — skip
        if (currentPrice <= p.currentStop) continue;

        const distanceToStop = (currentPrice - p.currentStop) / currentPrice;
        if (distanceToStop > NEAR_STOP_THRESHOLD) continue;

        // Already alerted for this stop level — skip until stop moves
        if (alertFlagMap.get(p.id)) continue;

        // Price is within 3% of stop — fire alert
        const isUK = p.stock.ticker.endsWith('.L') || /^[A-Z]{2,5}l$/.test(p.stock.ticker);
        const currency = isUK ? 'GBX' : (p.stock.currency || 'USD').toUpperCase();
        const currSymbol = currency === 'GBP' || currency === 'GBX' ? '\u00a3' : currency === 'EUR' ? '\u20ac' : '$';
        const distPct = (distanceToStop * 100).toFixed(1);

        await sendAlert({
          type: 'NEAR_STOP',
          title: `\u26a0 Near stop \u2014 ${p.stock.ticker} is ${distPct}% from stop`,
          message: `${p.stock.name || p.stock.ticker} is approaching its stop-loss.\n\nCurrent price: ${currSymbol}${currentPrice.toFixed(2)}\nStop-loss: ${currSymbol}${p.currentStop.toFixed(2)}\nDistance: ${distPct}%\n\nConsider reviewing this position. The stop will execute automatically if the price drops further.`,
          data: { ticker: p.stock.ticker, currentPrice, currentStop: p.currentStop, distancePct: parseFloat(distPct) },
          priority: 'WARNING',
        });

        // Mark as alerted — prevents duplicate alerts until stop moves
        await prisma.$executeRawUnsafe(
          'UPDATE "Position" SET "nearStopAlertSentAt" = ? WHERE "id" = ?',
          new Date().toISOString(),
          p.id
        );

        nearStopCount++;
      }
      if (nearStopCount > 0) {
        alerts.push(`\u26a0\ufe0f ${nearStopCount} position(s) within 3% of stop-loss`);
      }
    } catch (error) {
      console.warn('  [3f] Near-stop alert failed:', (error as Error).message);
    }
    console.log(`        Near-stop alerts: ${nearStopCount} sent`);

    // Stop pushes to T212 now happen in Step 3-apply (above), BEFORE the DB
    // commit, so the DB never overstates broker protection. Steps 3c–3f run on
    // the broker-confirmed committed stops.

    // Step 3h: Stop–Broker sync check — compare DB stops vs T212 pending orders
    if (process.env.BROKER_ADAPTER === 'trading212') {
      try {
        const { checkStopBrokerSync } = await import('@/lib/stop-broker-sync-check');
        const t212Clients: { type: string; client: typeof import('@/lib/trading212').Trading212Client.prototype }[] = [];
        for (const acctType of ['invest', 'isa'] as T212AccountType[]) {
          const c = await getNightlyT212Client(userId, acctType);
          if (c) t212Clients.push({ type: acctType, client: c });
        }
        if (t212Clients.length > 0) {
          // M-1 fix (2026-05-17): drift auto-correct is OFF by default. The
          // previous behaviour silently re-wrote DB stops down to match the
          // broker, bypassing the monotonic-stop invariant. Operators must
          // explicitly opt in via ENABLE_DRIFT_AUTOCORRECT=true. When OFF,
          // drift mismatches are reported and alerted but the DB is not
          // mutated — operator decides whether to push DB→T212 or accept
          // the broker's value via dashboard action.
          const autoCorrectEnabled = process.env.ENABLE_DRIFT_AUTOCORRECT === 'true';
          const driftReport = await checkStopBrokerSync(t212Clients, autoCorrectEnabled);
          if (driftReport.mismatches.length > 0) {
            for (const m of driftReport.mismatches) {
              const dir = m.driftDirection === 'NO_BROKER_STOP'
                ? 'NO T212 STOP'
                : `DB:$${m.dbStop.toFixed(2)} vs T212:$${m.brokerStop?.toFixed(2)} (${m.driftPct.toFixed(1)}%)${m.corrected ? ' → AUTO-CORRECTED' : ''}`;
              console.warn(`        ⚠ Stop drift: ${m.ticker} — ${dir}`);
            }
            const uncorrected = driftReport.mismatches.filter(m => !m.corrected);
            // M-1: DB_HIGHER without auto-correct is a real risk — DB believes
            // the stop is tighter than broker, which means: (a) stop-hit alerts
            // may fire when no broker stop was hit, AND (b) the real per-trade
            // risk is wider than the DB reports. Escalate these explicitly.
            const dbHigherUncorrected = uncorrected.filter(m => m.driftDirection === 'DB_HIGHER');
            if (dbHigherUncorrected.length > 0) {
              const detail = dbHigherUncorrected
                .map(m => `${m.ticker} (DB:$${m.dbStop.toFixed(2)} > T212:$${m.brokerStop?.toFixed(2)}, ${m.driftPct.toFixed(1)}%)`)
                .join('; ');
              alerts.push(`🚨 ${dbHigherUncorrected.length} stop(s) DB > T212 — broker is LOOSER than DB. Push DB→T212 via dashboard, or set ENABLE_DRIFT_AUTOCORRECT=true. [${detail}]`);
              await sendAlert({
                type: 'STOP_MISMATCH',
                title: `🚨 Stop drift: DB tighter than T212 (${dbHigherUncorrected.length})`,
                message: `These positions show DB stop ABOVE T212 stop. Realised risk is wider than DB reports. Push DB→T212 from dashboard, OR set ENABLE_DRIFT_AUTOCORRECT=true to accept the broker value. Affected: ${detail}`,
                data: { mismatches: dbHigherUncorrected },
                priority: 'CRITICAL',
                telegramDedupeKey: `nightly:stop-drift-db-higher`,
                telegramThrottleMs: 12 * 60 * 60 * 1000,
              });
            }
            const otherUncorrected = uncorrected.filter(m => m.driftDirection !== 'DB_HIGHER');
            if (otherUncorrected.length > 0) {
              alerts.push(`⚠ ${otherUncorrected.length} stop(s) drifted from T212 — check manually`);
            }
            if (driftReport.corrected > 0) {
              alerts.push(`✅ ${driftReport.corrected} stop(s) auto-corrected to match T212 (ENABLE_DRIFT_AUTOCORRECT=true)`);
            }
          } else {
            console.log(`        Stop-broker sync: ${driftReport.checked} checked, all matched`);
          }
        }
      } catch (error) {
        console.warn('  [3h] Stop-broker sync check failed:', (error as Error).message);
      }
    }

    // Step 4: Detect laggards + collect alerts
    console.log('  [4/9] Detecting laggards...');
    startStep('4', 'Laggard detection');
    log.info('Step 4: Laggard detection');

    // Audit fix F4 (2026-): refresh User.equity from T212 combined totalValue
    // BEFORE reading it for the rest of nightly (Step 6 snapshot, drawdown
    // alert, openRiskPercent, pyramid gating). Without this, nightly sizing
    // and snapshots used whatever value was last written by the dashboard
    // sync — which could be stale by days. Failure is non-fatal.
    try {
      const { refreshUserEquityFromBroker } = await import('@/lib/equity-refresh');
      const eq = await refreshUserEquityFromBroker(userId);
      if (eq.written) {
        console.log(`        Equity refreshed from broker: £${eq.combinedTotalValueGbp.toFixed(2)}`);
      } else {
        console.warn('        Equity refresh skipped — using last-known User.equity.');
      }
    } catch (eqErr) {
      console.warn(`        Equity refresh failed: ${(eqErr as Error).message}`);
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    const equity = user?.equity || 0;

    if (healthReport.overall === 'RED') alerts.push('Health check is RED — review issues before trading');
    if (healthReport.overall === 'YELLOW') alerts.push('Health check has warnings');
    if (stopChanges.length > 0) alerts.push(`${stopChanges.length} R-based stop-loss updates auto-applied`);
    if (trailingStopChanges.length > 0) alerts.push(`${trailingStopChanges.length} trailing ATR stops auto-applied`);
    if (gapRiskAlerts.length > 0) alerts.push(`${gapRiskAlerts.length} HIGH_RISK position(s) with overnight gap > 2× ATR%`);

    let laggardAlerts: NightlyLaggardAlert[] = [];
    // Hoisted for reuse by accelerator engine (step 6c)
    const laggardExtrasCache = new Map<string, { ma20: number; adxToday: number; adxYesterday: number }>();
    try {
      // Pre-compute MA20 + ADX (today vs yesterday) from cached daily bars
      // getDailyPrices hits cache here — bars were fetched in Step 3
      const laggardExtras = laggardExtrasCache;
      for (const p of positions) {
        try {
          const bars = await getDailyPrices(p.stock.ticker, 'full');
          if (bars.length >= 29) {
            // MA20 from newest-first close prices
            const closes = bars.map(b => b.close);
            const ma20 = calculateMA(closes, 20);
            // ADX today (full bars) vs yesterday (exclude today's bar)
            const adxToday = calculateADX(bars, 14).adx;
            const adxYesterday = calculateADX(bars.slice(1), 14).adx;
            laggardExtras.set(p.stock.ticker, { ma20, adxToday, adxYesterday });
          }
        } catch (err) {
          console.warn(`  [nightly] Laggard extra data skipped due to error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const laggardInput = positions.map((p) => {
        const currentPrice = livePrices[p.stock.ticker] || p.entryPrice;
        const isUK = p.stock.ticker.endsWith('.L') || /^[A-Z]{2,5}l$/.test(p.stock.ticker);
        const currency = isUK ? 'GBX' : (p.stock.currency || 'USD').toUpperCase();
        const extras = laggardExtras.get(p.stock.ticker);
        return {
          id: p.id,
          ticker: p.stock.ticker,
          entryPrice: p.entryPrice,
          entryDate: p.entryDate,
          currentStop: p.currentStop,
          shares: p.shares,
          initialRisk: p.initialRisk,
          currentPrice,
          currency,
          sleeve: p.stock.sleeve,
          // Recovery exemption fields — computed from cached daily bars
          ...(extras ? { ma20: extras.ma20, adxToday: extras.adxToday, adxYesterday: extras.adxYesterday } : {}),
        };
      });
      const laggards = detectLaggards(laggardInput);
      laggardAlerts = laggards.map((l) => ({
        ticker: l.ticker,
        daysHeld: l.daysHeld,
        rMultiple: l.rMultiple,
        lossPct: l.lossPct,
        flag: l.flag,
        reason: l.reason,
        currency: l.currency,
      }));
      if (laggardAlerts.length > 0) {
        const trimCount = laggardAlerts.filter((l) => l.flag === 'TRIM_LAGGARD').length;
        const deadCount = laggardAlerts.filter((l) => l.flag === 'DEAD_MONEY').length;
        const parts: string[] = [];
        if (trimCount > 0) parts.push(`${trimCount} laggard(s)`);
        if (deadCount > 0) parts.push(`${deadCount} dead-money`);
        alerts.push(`${parts.join(' + ')} flagged for review`);
      }
    } catch (error) {
      hadFailure = true;
      console.warn('  [4] Laggard detection failed:', (error as Error).message);
    }
    console.log(`        ${laggardAlerts.length} laggards flagged`);

    // Step 5: Risk-signal modules
    console.log('  [5/9] Running risk-signal modules...');
    startStep('5', 'Risk modules');
    log.info('Step 5: Risk modules');
    let climaxAlerts: NightlyClimaxAlert[] = [];
    let swapAlerts: NightlySwapAlert[] = [];
    let whipsawAlerts: NightlyWhipsawAlert[] = [];
    let breadthAlert: NightlyBreadthAlert | undefined;
    let momentumAlert: NightlyMomentumAlert | undefined;

    try {
      const climaxSignals = await scanClimaxSignals(
        positions.map((p) => ({ id: p.id, ticker: p.stock.ticker }))
      );
      climaxAlerts = climaxSignals.map((c) => ({
        ticker: c.ticker,
        priceAboveMa20Pct: c.priceAboveMa20Pct,
        volumeRatio: c.volumeRatio,
        action: c.action,
        reason: c.reason,
      }));
      if (climaxAlerts.length > 0) {
        alerts.push(`${climaxAlerts.length} climax top signal(s) — consider trimming`);
      }
    } catch (error) {
      console.warn('  [5] Climax detection failed:', (error as Error).message);
    }

    // Shared data for risk modules — computed once, used by swap/whipsaw/breadth/momentum
    const riskProfile = (user?.riskProfile || 'BALANCED') as RiskProfileType;
    const enrichedForSwap = positions.map((p) => {
      const rawPrice = livePrices[p.stock.ticker] || p.entryPrice;
      const gbpPrice = gbpPrices[p.stock.ticker] ?? rawPrice;
      const rMultiple = calculateRMultiple(rawPrice, p.entryPrice, p.initialRisk);
      return {
        id: p.id,
        ticker: p.stock.ticker,
        cluster: p.stock.cluster || 'General',
        sleeve: p.stock.sleeve as Sleeve,
        value: gbpPrice * p.shares,
        rMultiple,
      };
    });
    const totalPortfolioValue = enrichedForSwap.reduce((s, p) => s + p.value, 0);

    // Swap suggestions (isolated)
    try {
      const latestScan = await prisma.scan.findFirst({
        where: { userId },
        orderBy: { runDate: 'desc' },
        include: { results: { include: { stock: true } } },
      });
      const scanCandidates = (latestScan?.results || [])
        .filter((r) => r.status === 'READY')
        .map((r) => ({
          ticker: r.stock.ticker,
          cluster: r.stock.cluster || 'General',
          rankScore: r.rankScore,
          status: r.status,
        }));

      const swaps = findSwapSuggestions(enrichedForSwap, scanCandidates, totalPortfolioValue, riskProfile);
      swapAlerts = swaps.map((s) => ({
        cluster: s.cluster,
        weakTicker: s.weakTicker,
        weakRMultiple: s.weakRMultiple,
        strongTicker: s.strongTicker,
        reason: s.reason,
      }));
      if (swapAlerts.length > 0) {
        alerts.push(`${swapAlerts.length} swap suggestion(s) — stronger candidates available`);
      }
    } catch (error) {
      hadFailure = true;
      console.warn('  [5] Swap suggestions failed:', (error as Error).message);
    }

    // Whipsaw kill switch (isolated)
    try {
      const closedPositions = await prisma.position.findMany({
        where: { userId, status: 'CLOSED' },
        include: { stock: true },
        orderBy: { exitDate: 'desc' },
        take: 50,
      });
      const blocks = checkWhipsawBlocks(
        closedPositions.map((p) => ({
          ticker: p.stock.ticker,
          exitDate: p.exitDate || new Date(),
          exitReason: p.exitReason,
          whipsawCount: p.whipsawCount ?? 0,
        }))
      );
      whipsawAlerts = blocks.map((w) => ({
        ticker: w.ticker,
        stopsInLast30Days: w.stopsInLast30Days,
        reason: w.reason,
      }));
      if (whipsawAlerts.length > 0) {
        alerts.push(`${whipsawAlerts.length} ticker(s) blocked by whipsaw kill switch`);
      }
    } catch (error) {
      hadFailure = true;
      console.warn('  [5] Whipsaw check failed:', (error as Error).message);
    }

    // Breadth safety (isolated)
    try {
      const stocks = await prisma.stock.findMany({ where: { active: true }, select: { ticker: true } });
      const universeTickers = stocks.map((s) => s.ticker);
      // Sample up to 30 tickers for breadth — avoids 266 sequential Yahoo calls
      const sampleSize = Math.min(30, universeTickers.length);
      const shuffled = [...universeTickers].sort(() => Math.random() - 0.5);
      const breadthSample = shuffled.slice(0, sampleSize);
      console.log(`        Breadth sample: ${breadthSample.length} of ${universeTickers.length} tickers`);
      const breadthPct = breadthSample.length > 0 ? await calculateBreadth(breadthSample) : 100;

      const { maxPositions } = getRiskBudget(
        enrichedForSwap.map((p) => ({
          id: p.id,
          ticker: p.ticker,
          sleeve: p.sleeve,
          sector: 'Unknown',
          cluster: p.cluster,
          value: p.value,
          riskDollars: 0,
          shares: 0,
          entryPrice: 0,
          currentStop: 0,
          currentPrice: 0,
        })),
        equity,
        riskProfile
      );
      const breadthResult = checkBreadthSafety(breadthPct, maxPositions);
      breadthAlert = {
        breadthPct: breadthResult.breadthPct,
        isRestricted: breadthResult.isRestricted,
        maxPositionsOverride: breadthResult.maxPositionsOverride,
        reason: breadthResult.reason,
      };
      if (breadthResult.isRestricted) {
        alerts.push(`Breadth ${breadthPct.toFixed(0)}% < 40% — max positions reduced to ${breadthResult.maxPositionsOverride}`);
      }
    } catch (error) {
      hadFailure = true;
      console.warn('  [5] Breadth safety failed:', (error as Error).message);
    }

    // Correlation matrix (isolated — advisory only, no hard blocks)
    let correlationPairCount = 0;
    try {
      const corrResult = await computeCorrelationMatrix();
      correlationPairCount = corrResult.pairs.length;
      if (corrResult.pairs.length > 0) {
        alerts.push(`${corrResult.pairs.length} HIGH_CORR pair(s) detected (r > 0.75)`);
      }
      if (corrResult.tickersFailed.length > 0) {
        console.warn(`        Correlation: ${corrResult.tickersFailed.length} tickers failed data fetch`);
      }
    } catch (error) {
      // Non-critical — log and continue
      console.warn('  [5] Correlation matrix failed:', (error as Error).message);
    }
    console.log(`        Climax: ${climaxAlerts.length}, Swap: ${swapAlerts.length}, Whipsaw: ${whipsawAlerts.length}, Corr pairs: ${correlationPairCount}`);

    // Sector ETF momentum cache refresh (non-blocking — BPS factor 4 data)
    try {
      const sectorResult = await refreshSectorMomentumCache();
      console.log(`        Sector ETF cache: ${sectorResult.cached} sectors cached, ${sectorResult.failed.length} failed`);
    } catch (error) {
      // Non-critical — BPS sector factor returns 0 on cache miss
      console.warn('  [5] Sector ETF cache refresh failed:', (error as Error).message);
    }

    // Step 6: Record equity snapshot + check pyramids
    console.log('  [6/9] Recording equity snapshot...');
    startStep('6', 'Equity snapshot');
    log.info('Step 6: Equity snapshot');
    let openRiskPercent = 0;
    try {
      const openRisk = positions
        .filter((p) => p.stock.sleeve !== 'HEDGE')
        .reduce((sum, p) => {
          const rawPrice = livePrices[p.stock.ticker] || p.entryPrice;
          const gbpPrice = gbpPrices[p.stock.ticker] ?? rawPrice;
          const fxRatio = rawPrice > 0 ? gbpPrice / rawPrice : 1;
          const currentStopGbp = p.currentStop * fxRatio;
          const risk = Math.max(0, (gbpPrice - currentStopGbp) * p.shares);
          return sum + risk;
        }, 0);
      openRiskPercent = equity > 0 ? (openRisk / equity) * 100 : 0;
      // NIGHTLY-sourced: derived from User.equity. Recorded so the weekly
      // risk-efficiency calc has an openRiskPercent series. Equity here
      // may be stale; user-facing chart filters this source out.
      await recordEquitySnapshot(userId, equity, openRiskPercent, 'NIGHTLY');

      // Equity drawdown alert: warn if trading performance is >5% below its peak.
      // Measured on a capital-adjusted index so deposits/withdrawals are not losses.
      try {
        const [history, capitalEvents] = await Promise.all([
          prisma.equitySnapshot.findMany({
            where: { userId },
            orderBy: { capturedAt: 'asc' },
            select: { equity: true, capturedAt: true, source: true },
          }),
          loadCapitalEvents(),
        ]);
        const { currentDrawdownPct: drawdownPct, lastStepPct } = computeCapitalAdjustedDrawdown(fromFirstBrokerSnapshot(history), capitalEvents);
        if (lastStepPct != null && lastStepPct <= UNEXPLAINED_STEP_PCT) {
          alerts.push(`⚠️ Equity fell ${Math.abs(lastStepPct).toFixed(1)}% since the last snapshot with no recorded deposit or withdrawal. If money was withdrawn, refresh capital events (scripts/collect-cash-transactions.ts) or drawdown figures will treat it as a loss.`);
        }
        if (drawdownPct >= 5) {
          alerts.push(`⚠️ Trading drawdown: ${drawdownPct.toFixed(1)}% below the performance peak (deposits and withdrawals excluded). Current equity: £${equity.toFixed(2)}. Consider CAPITAL_PRESERVATION mode.`);
          log.warn('Equity drawdown alert', { drawdownPct: drawdownPct.toFixed(1), current: equity, capitalEvents: capitalEvents.length });
        }
      } catch (err) {
        console.warn('  [6] Equity drawdown check failed:', (err as Error).message);
      }
    } catch {
      hadFailure = true;
      await recordEquitySnapshot(userId, equity, undefined, 'NIGHTLY');
    }

    let pyramidAlerts: NightlyPyramidAlert[] = [];
    // Hoisted for reuse by accelerator engine (step 6c)
    const addsMap = new Map<string, number>();
    try {
      // Count existing pyramid adds per position from TradeLog
      const addCounts = await prisma.tradeLog.groupBy({
        by: ['positionId'],
        where: { userId, tradeType: 'ADD', positionId: { not: null } },
        _count: { id: true },
      });
      for (const row of addCounts) {
        if (row.positionId) addsMap.set(row.positionId, row._count.id);
      }

      // Open risk ratio for pyramid gating (0–1 scale)
      const maxOpenRiskPct = RISK_PROFILES[riskProfile].maxOpenRisk;
      const openRiskRatio = maxOpenRiskPct > 0 ? openRiskPercent / maxOpenRiskPct : 1;

      for (const p of positions) {
        if (p.stock.sleeve === 'HEDGE') continue;
        const currentPrice = livePrices[p.stock.ticker] || p.entryPrice;
        if (currentPrice <= p.entryPrice) continue;

        let atr: number | null = null;
        try {
          const bars = await getDailyPrices(p.stock.ticker, 'compact');
          if (bars.length >= 15) {
            atr = calculateATR(bars, 14);
          }
        } catch (err) { console.warn(`  [nightly] Pyramid ATR fetch skipped: ${err instanceof Error ? err.message : String(err)}`); }

        const pyramidCheck = canPyramid(
          currentPrice,
          p.entryPrice,
          p.initialRisk,
          atr ?? undefined,
          addsMap.get(p.id) ?? 0,
          openRiskRatio
        );

        if (pyramidCheck.allowed) {
          const isUK = p.stock.ticker.endsWith('.L') || /^[A-Z]{2,5}l$/.test(p.stock.ticker);
          const currency = isUK ? 'GBX' : (p.stock.currency || 'USD').toUpperCase();

          // Compute scaled add sizing
          const rawPrice = livePrices[p.stock.ticker] || p.entryPrice;
          const gbpPrice = gbpPrices[p.stock.ticker] ?? rawPrice;
          const fxRatio = rawPrice > 0 ? gbpPrice / rawPrice : 1;
          const addSizing = calculatePyramidAddSize({
            equity,
            riskProfile,
            addNumber: pyramidCheck.addNumber,
            currentPrice,
            currentStop: p.currentStop,
            sleeve: p.stock.sleeve as Sleeve,
            fxToGbp: fxRatio,
            allowFractional: true, // Trading 212
          });

          pyramidAlerts.push({
            ticker: p.stock.ticker,
            entryPrice: p.entryPrice,
            currentPrice,
            rMultiple: pyramidCheck.rMultiple,
            addNumber: pyramidCheck.addNumber,
            triggerPrice: pyramidCheck.triggerPrice,
            message: pyramidCheck.message,
            currency,
            riskScalar: pyramidCheck.riskScalar,
            addShares: addSizing.shares,
            addRiskAmount: addSizing.riskDollars,
            scaledRiskPercent: addSizing.scaledRiskPercent,
          });
        }
      }
      if (pyramidAlerts.length > 0) {
        alerts.push(`${pyramidAlerts.length} position(s) eligible for pyramid add`);
      }

      // Send pyramid add alerts via notification centre (Friday only — matches execution day)
      const dayOfWeekPyramid = getUKDayOfWeek(); // 0=Sun, 5=Fri — UK timezone
      if (dayOfWeekPyramid === 5 && pyramidAlerts.length > 0) {
        for (const pa of pyramidAlerts) {
          const currSymbol = pa.currency === 'GBP' || pa.currency === 'GBX' ? '£' : pa.currency === 'EUR' ? '€' : '$';
          const sizingLine = pa.addShares > 0
            ? `Add #${pa.addNumber}: ${pa.addShares.toFixed(2)} shares (risk ${currSymbol}${pa.addRiskAmount.toFixed(2)} — ${(pa.riskScalar * 100).toFixed(0)}% of base)`
            : `Add number: #${pa.addNumber}`;
          await sendAlert({
            type: 'PYRAMID_ADD',
            title: `${pa.ticker} is ready for a pyramid add`,
            message: `Your position in ${pa.ticker} has moved up enough to add more shares.\n\nR-multiple: ${pa.rMultiple.toFixed(1)}R\n${sizingLine}\n${pa.triggerPrice ? `Trigger price: ${currSymbol}${pa.triggerPrice.toFixed(2)}` : ''}\n${pa.message}\n\nPyramid adds auto-execute on Friday nightly if regime is BULLISH.`,
            data: { ticker: pa.ticker, rMultiple: pa.rMultiple, addNumber: pa.addNumber, addShares: pa.addShares, addRiskAmount: pa.addRiskAmount, riskScalar: pa.riskScalar },
            priority: 'INFO',
            telegramDedupeKey: `nightly:pyramid-ready:${pa.ticker}:${pa.addNumber}`,
            telegramThrottleMs: 6 * 24 * 60 * 60 * 1000,
          });
        }
      }
    } catch (error) {
      hadFailure = true;
      console.warn('  [6] Pyramid check failed:', (error as Error).message);
    }
    console.log(`        Equity: ${equity.toFixed(2)}, Risk: ${openRiskPercent.toFixed(1)}%, Pyramids: ${pyramidAlerts.length}`);

    // Step 6-auto: Auto-execute pyramid adds (requires ENABLE_AUTO_TRADING + regime BULLISH)
    let pyramidsExecuted = 0;
    let pyramidsFailed = 0;
    if (autoTradingEnabled && pyramidAlerts.length > 0) {
      const regime = await getMarketRegime().catch(() => 'UNKNOWN');
      const dayOfWeek = getUKDayOfWeek();

      // Only pyramid on Fridays in BULLISH regime (end-of-week confirmation)
      if (regime === 'BULLISH' && dayOfWeek === 5) {
        console.log('  [6-auto] Auto-executing pyramid adds...');

        // ── H-1 fix ──────────────────────────────────────────────
        // Build a GBP-normalised snapshot of open positions once, so the per-candidate
        // risk-gate check sees the same denominators that scan-engine / auto-trade use.
        // Treat each pyramid candidate as a NEW position equal to the POST-ADD total
        // (existing shares + new shares) at current price, with the existing position
        // filtered out of the comparison set — this lets sleeve / cluster / sector /
        // position-size gates evaluate the realised post-add state, not the increment.
        // Risk is recomputed from (currentPrice - currentStop) × postAddShares in GBP.
        const pyramidGatePositions = positions.map((p) => {
          const rawPrice = livePrices[p.stock.ticker] || p.entryPrice;
          const gbpPrice = gbpPrices[p.stock.ticker] ?? rawPrice;
          const fxRatio = rawPrice > 0 ? gbpPrice / rawPrice : 1;
          const currentStopGbp = p.currentStop * fxRatio;
          const entryPriceGbp = p.entryPrice * fxRatio;
          return {
            id: p.id,
            ticker: p.stock.ticker,
            sleeve: (p.stock.sleeve || 'CORE') as Sleeve,
            sector: p.stock.sector || 'Unknown',
            cluster: p.stock.cluster || 'General',
            // H-4: market value, not entry value
            value: gbpPrice * p.shares,
            riskDollars: Math.max(0, (gbpPrice - currentStopGbp) * p.shares),
            shares: p.shares,
            entryPrice: entryPriceGbp,
            currentStop: currentStopGbp,
            currentPrice: gbpPrice,
          };
        });

        try {
          for (const pa of pyramidAlerts) {
            if (pa.addShares <= 0) continue;

            // Find the position and its stock
            const pos = positions.find(p => p.stock.ticker === pa.ticker);
            if (!pos) continue;

            const t212Ticker = pos.t212Ticker || pos.stock.t212Ticker;
            if (!t212Ticker) {
              console.warn(`  [6-auto] ${pa.ticker}: no T212 ticker — skipping`);
              pyramidsFailed++;
              continue;
            }
            const isUkAdd = pa.ticker.endsWith('.L') || /^[A-Z]{2,5}l$/.test(pa.ticker);
            const ukUnits = ukLineUnitsIssue(isUkAdd, t212Ticker, isUkAdd ? getT212LineCurrency(t212Ticker) : null);
            if (ukUnits) {
              console.warn(`  [6-auto] ${pa.ticker}: ${ukUnits}`);
              pyramidsFailed++;
              continue;
            }

            // ── H-1 fix ──────────────────────────────────────────
            // Concentration / size caps MUST hold for the post-add state.
            // `canPyramid` only enforces the open-risk budget (≤70%) and the
            // R/ATR triggers — it does not check sleeve / cluster / sector /
            // position-size. Re-run the 6 gates here with the existing position
            // removed and the candidate treated as the post-add total.
            try {
              const rawPrice = livePrices[pa.ticker] || pos.entryPrice;
              const gbpPrice = gbpPrices[pa.ticker] ?? rawPrice;
              const fxRatio = rawPrice > 0 ? gbpPrice / rawPrice : 1;
              const currentStopGbp = pos.currentStop * fxRatio;
              const postAddShares = pos.shares + pa.addShares;
              const postAddValueGbp = gbpPrice * postAddShares;
              const postAddRiskGbp = Math.max(0, (gbpPrice - currentStopGbp) * postAddShares);

              const otherPositions = pyramidGatePositions.filter(gp => gp.id !== pos.id);
              const gateResults = validateRiskGates(
                {
                  sleeve: (pos.stock.sleeve || 'CORE') as Sleeve,
                  sector: pos.stock.sector || 'Unknown',
                  cluster: pos.stock.cluster || 'General',
                  value: postAddValueGbp,
                  riskDollars: postAddRiskGbp,
                },
                otherPositions,
                equity,
                riskProfile,
              );
              const failed = gateResults.filter(g => !g.passed);
              if (failed.length > 0) {
                const reasons = failed.map(g => g.gate).join(', ');
                console.warn(`  [6-auto] ${pa.ticker}: pyramid blocked by risk gates: ${reasons}`);
                alerts.push(`⚠ Pyramid ${pa.ticker} blocked: ${reasons}`);
                await sendAlert({
                  type: 'PYRAMID_ADD',
                  title: `🚫 Pyramid ${pa.ticker} blocked by risk gates`,
                  message: `Add #${pa.addNumber} would breach: ${reasons}. Existing position retained; no add placed.`,
                  data: {
                    ticker: pa.ticker,
                    addNumber: pa.addNumber,
                    failedGates: failed.map(g => ({ gate: g.gate, current: g.current, limit: g.limit })),
                  },
                  priority: 'WARNING',
                  telegramDedupeKey: `nightly:pyramid-gate-block:${pa.ticker}:${pa.addNumber}`,
                  telegramThrottleMs: 7 * 24 * 60 * 60 * 1000,
                });
                pyramidsFailed++;
                continue;
              }
            } catch (gateErr) {
              // Fail closed: if the gate check itself errored, do NOT execute the add.
              console.warn(`  [6-auto] ${pa.ticker}: pyramid gate check errored — ${(gateErr as Error).message}`);
              alerts.push(`⚠ Pyramid ${pa.ticker} skipped: gate check failed`);
              pyramidsFailed++;
              continue;
            }

            const acctType: T212AccountType = pos.accountType === 'isa' ? 'isa' : 'invest';
            const client = await getNightlyT212Client(userId, acctType);
            if (!client) {
              console.warn(`  [6-auto] ${pa.ticker}: T212 ${acctType} client unavailable`);
              pyramidsFailed++;
              continue;
            }

            // Cash check: verify sufficient funds before placing order
            try {
              const summary = await client.getAccountSummary();
              const availableCash = summary.cash.availableToTrade;
              const estimatedCost = pa.addShares * pa.currentPrice;

              if (availableCash < estimatedCost) {
                console.warn(`  [6-auto] ${pa.ticker}: insufficient cash (need ${estimatedCost.toFixed(2)}, have ${availableCash.toFixed(2)})`);
                alerts.push(`⚠ Pyramid ${pa.ticker}: insufficient cash (need ${estimatedCost.toFixed(2)}, have ${availableCash.toFixed(2)})`);
                pyramidsFailed++;
                continue;
              }
            } catch (err) {
              console.warn(`  [6-auto] ${pa.ticker}: cash check failed — ${(err as Error).message}`);
              pyramidsFailed++;
              continue;
            }

            // Claim durable intent before any broker mutation. The payload-level
            // uniqueness prevents a second process from submitting the same add.
            try {
              const payloadHash = hashExecutionPayload({
                type: 'PYRAMID_ADD',
                userId,
                positionId: pos.id,
                stockId: pos.stockId,
                addNumber: pa.addNumber,
                quantity: pa.addShares,
                stopPrice: pos.currentStop,
                accountType: acctType,
              });
              const activePayloadHash = hashExecutionPayload({
                type: 'PYRAMID_ADD',
                userId,
                positionId: pos.id,
                accountType: acctType,
              });
              const requestedOperationId = randomUUID();
              const intentClaim = await claimExecutionIntent({
                operationId: requestedOperationId,
                userId,
                payloadHash,
                activePayloadHash,
                stockId: pos.stockId,
                ticker: t212Ticker,
                accountType: acctType,
                requestedQuantity: pa.addShares,
                stopPrice: pos.currentStop,
              });
              const operationId = intentClaim.claimed ? requestedOperationId : intentClaim.operationId;
              let buyOrderId: number;
              let pyramidFilledQty = 0;
              let pyramidFilledPrice = 0;
              let pyramidFilled = false;

              if (intentClaim.claimed) {
                await updateExecutionIntent(operationId, {
                  status: 'PYRAMID_BROKER_SUBMITTING',
                  positionId: pos.id,
                  baselineQuantity: pos.shares,
                  markBrokerSubmitted: true,
                });
                try {
                  const buyOrder = await client.placeMarketOrder({ quantity: pa.addShares, ticker: t212Ticker });
                  buyOrderId = buyOrder.id;
                  await updateExecutionIntent(operationId, {
                    status: 'PYRAMID_BROKER_SUBMITTED',
                    orderId: String(buyOrderId),
                  });
                  console.log(`  [6-auto] ${pa.ticker}: pyramid add placed (order ${buyOrderId}, ${pa.addShares} shares)`);
                } catch (submitError) {
                  const definiteRejection = submitError instanceof Trading212Error
                    && submitError.statusCode >= 400
                    && submitError.statusCode < 500
                    && submitError.statusCode !== 408;
                  await updateExecutionIntent(operationId, {
                    status: definiteRejection ? 'PYRAMID_FAILED_PRE_SUBMISSION' : 'PYRAMID_BROKER_OUTCOME_UNKNOWN',
                    error: (submitError as Error).message,
                    release: definiteRejection,
                  });
                  throw submitError;
                }
              } else {
                if (hasActiveBrokerSubmissionLease(intentClaim.status, intentClaim.brokerSubmittedAt)) {
                  console.warn(`  [6-auto] ${pa.ticker}: pyramid intent ${operationId} is still owned by an active submitter; retained without cancellation`);
                  pyramidsFailed++;
                  continue;
                }
                if (!intentClaim.orderId) {
                  console.warn(`  [6-auto] ${pa.ticker}: existing pyramid intent ${operationId} has no exact broker order ID; retained for review`);
                  pyramidsFailed++;
                  continue;
                }
                buyOrderId = Number(intentClaim.orderId);
                const recovery = await recoverTimedOutBuy(client, buyOrderId);
                if (recovery.status === 'CANCELLED') {
                  await updateExecutionIntent(operationId, {
                    status: 'PYRAMID_CANCELLED',
                    error: 'Exact broker history confirmed terminal cancellation with zero fill',
                    release: true,
                  });
                  pyramidsFailed++;
                  continue;
                }
                if (recovery.status === 'UNRESOLVED') {
                  await updateExecutionIntent(operationId, {
                    status: 'PYRAMID_RECONCILIATION_REQUIRED',
                    error: recovery.error,
                  });
                  console.warn(`  [6-auto] ${pa.ticker}: retained pyramid order ${buyOrderId}: ${recovery.error}`);
                  pyramidsFailed++;
                  continue;
                }
                pyramidFilledQty = recovery.filledQuantity;
                pyramidFilledPrice = recovery.filledPrice;
                pyramidFilled = true;
              }

              // ── H-2 fix (2026-05-17) ─────────────────────────────
              // Poll for fill before mutating DB / placing oversized stop.
              // Nightly runs at 22:00 UK, AFTER both UK and US market close,
              // so on a Friday the market buy will NOT fill until Monday open.
              // Previously this code updated DB.shares + setStopLoss IMMEDIATELY
              // after placing the order, leaving a 48-64h window where DB shares
              // > broker shares and the stop covered an unfilled quantity.
              // We now poll for fill; if not filled within the window, cancel
              // the order (best-effort) and skip the DB update. The pyramid
              // will be re-evaluated on the next nightly during market hours.
              const PYRAMID_POLL_MAX = 12;       // 12 × 5s = 60s — bounded
              const PYRAMID_POLL_INTERVAL = 5000;
              for (let attempt = 1; !pyramidFilled && attempt <= PYRAMID_POLL_MAX; attempt++) {
                await new Promise(r => setTimeout(r, PYRAMID_POLL_INTERVAL));
                try {
                  const order = await client.getOrder(buyOrderId);
                  if (order.filledQuantity > 0 && order.filledQuantity >= pa.addShares * 0.99) {
                    pyramidFilledQty = order.filledQuantity;
                    pyramidFilledPrice = order.filledValue > 0 ? order.filledValue / order.filledQuantity : pa.currentPrice;
                    pyramidFilled = true;
                    break;
                  }
                } catch (pollErr) {
                  // 404 means the order left the pending collection. Attribute a
                  // fill only from exact order history, never ticker-level growth.
                  const isNotFound = pollErr instanceof Error && /404/.test(pollErr.message);
                  if (isNotFound) {
                    try {
                      const history = await client.getOrderHistory(50, { maxPages: 2 });
                      const fill = getHistoricalFill(history, buyOrderId);
                      if (fill && fill.filledQuantity >= pa.addShares * 0.99) {
                        pyramidFilledQty = fill.filledQuantity;
                        pyramidFilledPrice = fill.filledPrice;
                        pyramidFilled = true;
                        break;
                      }
                    } catch { /* fall through */ }
                  }
                }
              }

              if (!pyramidFilled) {
                const recovery = await recoverTimedOutBuy(client, buyOrderId);
                if (recovery.status === 'FILLED') {
                  pyramidFilledQty = recovery.filledQuantity;
                  pyramidFilledPrice = recovery.filledPrice;
                  pyramidFilled = true;
                } else {
                  const released = recovery.status === 'CANCELLED';
                  const recoveryMessage = released
                    ? 'Exact broker history confirmed terminal cancellation with zero fill'
                    : recovery.error;
                  await updateExecutionIntent(operationId, {
                    status: released ? 'PYRAMID_CANCELLED' : 'PYRAMID_RECONCILIATION_REQUIRED',
                    error: recoveryMessage,
                    release: released,
                  });
                  console.warn(`  [6-auto] ${pa.ticker}: pyramid buy not filled within ${(PYRAMID_POLL_MAX * PYRAMID_POLL_INTERVAL / 1000).toFixed(0)}s — ${recoveryMessage}; DB not updated`);
                  alerts.push(`⚠ Pyramid ${pa.ticker} queued — ${recoveryMessage}.`);
                await prisma.executionLog.create({
                  data: {
                    ticker: pa.ticker,
                    phase: 'PYRAMID_BUY_QUEUED',
                      orderId: String(buyOrderId),
                      requestBody: JSON.stringify({ shares: pa.addShares, t212Ticker, addNumber: pa.addNumber, polled: PYRAMID_POLL_MAX, recovery: recovery.status }),
                    responseStatus: null,
                    quantity: pa.addShares,
                    accountType: acctType,
                      error: recoveryMessage,
                  },
                });
                await sendAlert({
                  type: 'PYRAMID_ADD',
                    title: `⚠ Pyramid ${pa.ticker} did not confirm`,
                    message: `Buy order ${buyOrderId} did not confirm within ${(PYRAMID_POLL_MAX * PYRAMID_POLL_INTERVAL / 1000).toFixed(0)}s. ${recoveryMessage}. No DB change.`,
                    data: { ticker: pa.ticker, addNumber: pa.addNumber, orderId: String(buyOrderId), recovery: recovery.status },
                  priority: 'WARNING',
                  telegramDedupeKey: `nightly:pyramid-queued:${pa.ticker}:${pa.addNumber}`,
                  telegramThrottleMs: 24 * 60 * 60 * 1000,
                });
                pyramidsFailed++;
                continue;
                }
              }

              // Note: entryPrice now uses actual filledPrice (post H-2). Slippage on
              // the add is small relative to R and the position already has a stop.

              // Fix 4: Update position shares in DB so next nightly uses correct count
              const finalization = await prisma.$transaction(async (tx) => {
                const existingAdd = await tx.tradeLog.findUnique({
                  where: { t212OrderId: String(buyOrderId) },
                });
                if (existingAdd) {
                  const currentPosition = await tx.position.findUniqueOrThrow({ where: { id: pos.id } });
                  return { newTotalShares: currentPosition.shares, alreadyFinalized: true };
                }
                const updatedPosition = await tx.position.update({
                  where: { id: pos.id },
                  data: { shares: { increment: pyramidFilledQty } },
                });
                await tx.tradeLog.create({
                  data: {
                    userId,
                    positionId: pos.id,
                    ticker: pa.ticker,
                    tradeDate: new Date(),
                    tradeType: 'ADD',
                    entryPrice: pyramidFilledPrice,
                    shares: pyramidFilledQty,
                    decision: 'AUTO_PYRAMID',
                    decisionReason: `Auto pyramid add #${pa.addNumber} at ${pa.rMultiple.toFixed(1)}R`,
                    t212OrderId: String(buyOrderId),
                    t212Ticker,
                    fillPrice: pyramidFilledPrice,
                  },
                });
                return { newTotalShares: updatedPosition.shares, alreadyFinalized: false };
              });
              const newTotalShares = finalization.newTotalShares;

              // Fix 2: Place protective stop for the full position (original + added shares)
              // This ensures the added shares are covered by the existing stop on T212.
              let pyramidStopCovered = true;
              let pyramidStopOrderId: string | undefined;
              let pyramidStopError: string | undefined;
              try {
                const stopOrder = await client.setStopLoss(t212Ticker, newTotalShares, pos.currentStop);
                pyramidStopOrderId = stopOrder ? String(stopOrder.id) : undefined;
                console.log(`  [6-auto] ${pa.ticker}: stop updated for ${newTotalShares.toFixed(2)} total shares`);
              } catch (stopErr) {
                pyramidStopCovered = false;
                pyramidStopError = (stopErr as Error).message;
                console.warn(`  [6-auto] ${pa.ticker}: stop update after pyramid failed — ${(stopErr as Error).message}`);
                alerts.push(`⚠ ${pa.ticker}: pyramid bought but stop may not cover new shares — check T212`);
              }

              // Log to execution audit
              await prisma.executionLog.create({
                data: {
                  ticker: pa.ticker,
                  phase: 'PYRAMID_ADD',
                  orderId: String(buyOrderId),
                  requestBody: JSON.stringify({ shares: pyramidFilledQty, requested: pa.addShares, t212Ticker, addNumber: pa.addNumber, newTotalShares, filledPrice: pyramidFilledPrice }),
                  responseStatus: 200,
                  quantity: pyramidFilledQty,
                  accountType: acctType,
                },
              });

              await updateExecutionIntent(operationId, {
                status: pyramidStopCovered ? 'PYRAMID_COMPLETED' : 'PYRAMID_RECONCILIATION_REQUIRED',
                positionId: pos.id,
                orderId: String(buyOrderId),
                stopOrderId: pyramidStopOrderId,
                error: pyramidStopError,
                release: pyramidStopCovered,
              });

              if (pyramidStopCovered) {
                await sendAlert({
                  type: 'PYRAMID_ADD',
                  title: `✅ Auto pyramid: ${pa.ticker} add #${pa.addNumber}`,
                  message: `Bought ${pyramidFilledQty.toFixed(2)} shares @ ${pyramidFilledPrice.toFixed(2)} (${pa.rMultiple.toFixed(1)}R). Total: ${newTotalShares.toFixed(2)} shares. Stop covers full position.`,
                  priority: 'INFO',
                });
              } else {
                await sendAlert({
                  type: 'PYRAMID_ADD',
                  title: `🚨 ${pa.ticker} pyramid filled — stop unconfirmed`,
                  message: `Bought ${pyramidFilledQty.toFixed(2)} shares @ ${pyramidFilledPrice.toFixed(2)}, but full-position stop protection was not confirmed. Check T212 immediately.`,
                  data: { ticker: pa.ticker, addNumber: pa.addNumber, orderId: String(buyOrderId), error: pyramidStopError },
                  priority: 'CRITICAL',
                });
              }

              pyramidsExecuted++;
              alerts.push(pyramidStopCovered
                ? `✅ Pyramid ${pa.ticker}: ${pyramidFilledQty.toFixed(2)} shares @ ${pyramidFilledPrice.toFixed(2)} (${pa.rMultiple.toFixed(1)}R)`
                : `🚨 Pyramid ${pa.ticker} filled but stop protection is unconfirmed`);
            } catch (err) {
              console.error(`  [6-auto] ${pa.ticker}: pyramid buy failed — ${(err as Error).message}`);
              alerts.push(`⚠ Pyramid ${pa.ticker} FAILED: ${(err as Error).message}`);
              pyramidsFailed++;
            }
          }
        } catch (error) {
          console.warn('  [6-auto] Auto pyramid execution failed:', (error as Error).message);
        }
      } else {
        console.log(`  [6-auto] Pyramid auto-exec skipped (regime=${regime}, day=${dayOfWeek})`);
      }
    }
    if (pyramidsExecuted > 0 || pyramidsFailed > 0) {
      console.log(`        Auto pyramids: ${pyramidsExecuted} executed, ${pyramidsFailed} failed`);
    }

    // Step 6b: Equity milestone check (advisory only — never auto-changes risk profile)
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      const dismissed: number[] = user?.dismissedEquityThresholds
        ? JSON.parse(user.dismissedEquityThresholds) as number[]
        : [];
      for (const threshold of EQUITY_REVIEW_THRESHOLDS) {
        if (equity >= threshold.equity && !dismissed.includes(threshold.equity)) {
          alerts.push(`💰 ${threshold.message}`);
          await sendAlert({
            type: 'EQUITY_MILESTONE',
            title: `Equity milestone: £${threshold.equity.toLocaleString()}`,
            message: threshold.message,
            data: { threshold: threshold.equity, equity },
            priority: 'INFO',
          });
          console.log(`        Equity milestone: £${threshold.equity}`);
        }
      }
    } catch (error) {
      // Non-critical — don't fail the pipeline for an advisory check
      console.warn('  [6b] Equity milestone check failed:', (error as Error).message);
    }

    // Step 6c: Profit Acceleration — Capital Priority Engine (advisory only)
    let acceleratorAlerts: NightlyAcceleratorAlert[] = [];
    try {
      // Build HeldPosition data for the accelerator
      const accelPositions: HeldPosition[] = positions.map((p) => {
        const rawPrice = livePrices[p.stock.ticker] || p.entryPrice;
        const rMult = calculateRMultiple(rawPrice, p.entryPrice, p.initialRisk);
        const extras = laggardExtrasCache?.get(p.stock.ticker);
        return {
          id: p.id,
          ticker: p.stock.ticker,
          sleeve: p.stock.sleeve as Sleeve,
          sector: p.stock.sector || 'Unknown',
          cluster: p.stock.cluster || 'General',
          entryPrice: p.entryPrice,
          currentPrice: rawPrice,
          currentStop: p.currentStop,
          shares: p.shares,
          initialRisk: p.initialRisk,
          entryDate: p.entryDate,
          daysHeld: Math.floor((Date.now() - p.entryDate.getTime()) / 86400000),
          rMultiple: rMult,
          atr: p.atr_at_entry || 0,
          currency: p.stock.currency || 'USD',
          pyramidAdds: addsMap.get(p.id) ?? 0,
          ma20: extras?.ma20,
          adxToday: extras?.adxToday,
          adxYesterday: extras?.adxYesterday,
        };
      });

      // Build candidate data from latest scan (CandidateOutcome has NCS/FWS)
      const accelCandidates: AcceleratorCandidate[] = [];
      try {
        const recentCandidates = await prisma.candidateOutcome.findMany({
          where: {
            status: 'READY',
            scanDate: { gte: new Date(Date.now() - 48 * 60 * 60 * 1000) },
          },
          orderBy: { ncs: 'desc' },
          take: 30,
        });
        const heldTickers = new Set(positions.map((p) => p.stock.ticker));
        for (const r of recentCandidates) {
          if (heldTickers.has(r.ticker)) continue;
          accelCandidates.push({
            ticker: r.ticker,
            sleeve: (r.sleeve || 'CORE') as Sleeve,
            sector: r.sector || 'Unknown',
            cluster: r.cluster || 'General',
            ncs: r.ncs ?? 0,
            fws: r.fws ?? 0,
            actionNote: r.dualScoreAction ?? '',
            entryTrigger: r.entryTrigger ?? 0,
            stopPrice: r.stopPrice ?? 0,
            riskDollars: r.suggestedRiskGbp ?? 0,
            totalCost: r.suggestedCostGbp ?? 0,
          });
        }
      } catch {
        // Non-critical — accelerator runs with empty candidates
      }

      const accelCtx: AcceleratorContext = {
        positions: accelPositions,
        candidates: accelCandidates,
        equity,
        riskProfile,
        regime: (await getMarketRegime()) as AcceleratorContext['regime'],
        openRiskPercent,
      };

      const recommendations = rankActions(accelCtx);
      const actionable = recommendations.filter(
        (r) => r.action !== 'HOLD' && r.action !== 'NO_ACTION'
      );

      acceleratorAlerts = actionable.map((r) => ({
        action: r.action,
        ticker: r.ticker,
        replacementTicker: r.replacementTicker,
        urgency: r.urgency,
        reason: r.reason,
        expectedBenefit: r.expectedBenefit,
        riskImpact: r.riskImpact,
      }));

      if (acceleratorAlerts.length > 0) {
        alerts.push(`⚡ ${acceleratorAlerts.length} capital priority action(s) — review in plan page`);
      }
      console.log(`        Accelerator: ${acceleratorAlerts.length} actionable recommendations`);
    } catch (error) {
      // Non-critical — accelerator is advisory-only
      console.warn('  [6c] Profit accelerator failed:', (error as Error).message);
    }

    // Step 7: Sync snapshot + query READY candidates
    console.log('  [7/9] Syncing snapshot data...');
    startStep('7', 'Snapshot sync');
    log.info('Step 7: Snapshot sync');
    const positionDetails: NightlyPositionDetail[] = positions.map((p) => {
      const currentPrice = livePrices[p.stock.ticker] || p.entryPrice;
      const gbpPrice = gbpPrices[p.stock.ticker] ?? currentPrice;
      const fxRatio = currentPrice > 0 ? gbpPrice / currentPrice : 1;
      // Use GBP-normalised prices for cross-currency PnL aggregation
      const pnlValue = (gbpPrice - p.entryPrice * fxRatio) * p.shares;
      const pnlPercent = p.entryPrice > 0 ? ((currentPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
      const rMultiple = p.initialRisk > 0 ? (currentPrice - p.entryPrice) / p.initialRisk : 0;
      const isUK = p.stock.ticker.endsWith('.L') || /^[A-Z]{2,5}l$/.test(p.stock.ticker);
      const currency = isUK ? 'GBX' : (p.stock.currency || 'USD').toUpperCase();
      return {
        ticker: p.stock.ticker,
        sleeve: p.stock.sleeve,
        shares: p.shares,
        entryPrice: p.entryPrice,
        currentPrice,
        currentStop: p.currentStop,
        protectionLevel: p.protectionLevel,
        rMultiple,
        pnl: pnlValue,
        pnlPercent,
        currency,
      };
    });

    let snapshotSync = { synced: false, rowCount: 0, failed: [] as string[], snapshotId: '', failureReasons: new Map<string, string>() };
    try {
      const result = await syncSnapshot();
      snapshotSync = { synced: true, rowCount: result.rowCount, failed: result.failed, snapshotId: result.snapshotId, failureReasons: result.failureReasons };
      if (result.failed.length > 0) {
        alerts.push(`Snapshot sync: ${result.rowCount} tickers synced, ${result.failed.length} failed`);
      }
    } catch (error) {
      hadFailure = true;
      console.warn('  [7] Snapshot sync failed:', (error as Error).message);
      alerts.push('Snapshot sync failed — scores may be stale');
    }
    console.log(`        Snapshot: ${snapshotSync.rowCount} synced, ${snapshotSync.failed.length} failed`);

    // ── Auto-deactivate chronically dead tickers ──
    if (snapshotSync.synced && snapshotSync.failureReasons.size > 0) {
      try {
        const { updateStaleTracking } = await import('@/lib/stale-ticker-tracker');
        const activeStocksForTracking = await prisma.stock.findMany({ where: { active: true }, select: { ticker: true } });
        const allActive = new Set(activeStocksForTracking.map(s => s.ticker));
        const staleResult = await updateStaleTracking(snapshotSync.failureReasons, allActive);
        if (staleResult.deactivated.length > 0) {
          alerts.push(`Auto-deactivated ${staleResult.deactivated.length} dead tickers: ${staleResult.deactivated.join(', ')}`);
          console.log(`        Auto-deactivated: ${staleResult.deactivated.join(', ')}`);
        }
        if (staleResult.tracked > 0) {
          console.log(`        Stale tracking: ${staleResult.tracked} tickers being monitored`);
        }
      } catch (error) {
        console.warn('  [7] Stale ticker tracking failed:', (error as Error).message);
      }
    }

    // ── Score Breakdown: record BQS/FWS/NCS component decomposition for analytics ──
    if (snapshotSync.snapshotId && snapshotSync.synced) {
      try {
        const allSnapshotRows = await prisma.snapshotTicker.findMany({
          where: { snapshotId: snapshotSync.snapshotId },
        });
        const scoredTickers = allSnapshotRows.map((st) => {
          const row = normaliseRow({
            ticker: st.ticker, name: st.name || st.ticker, sleeve: st.sleeve || 'CORE',
            status: st.status || 'FAR', close: st.close, atr_14: st.atr14,
            atr_pct: st.atrPct, adx_14: st.adx14, plus_di: st.plusDi,
            minus_di: st.minusDi, vol_ratio: st.volRatio,
            market_regime: st.marketRegime, market_regime_stable: st.marketRegimeStable,
            distance_to_20d_high_pct: st.distanceTo20dHighPct,
            entry_trigger: st.entryTrigger, stop_level: st.stopLevel,
            chasing_20_last5: st.chasing20Last5, chasing_55_last5: st.chasing55Last5,
            atr_spiking: st.atrSpiking, atr_collapsing: st.atrCollapsing,
            rs_vs_benchmark_pct: st.rsVsBenchmarkPct,
            days_to_earnings: st.daysToEarnings, earnings_in_next_5d: st.earningsInNext5d,
            cluster_name: st.clusterName, super_cluster_name: st.superClusterName,
            cluster_exposure_pct: st.clusterExposurePct,
            super_cluster_exposure_pct: st.superClusterExposurePct,
            max_cluster_pct: st.maxClusterPct, max_super_cluster_pct: st.maxSuperClusterPct,
            weekly_adx: st.weeklyAdx, vol_regime: st.volRegime,
            dual_regime_aligned: st.dualRegimeAligned, bis_score: st.bisScore,
            currency: st.currency,
          });
          return scoreRow(row);
        });
        const sbResult = await saveScoreBreakdowns(
          scoredTickers,
          snapshotSync.snapshotId,
          allSnapshotRows[0]?.marketRegime || 'NEUTRAL'
        );
        console.log(`        ScoreBreakdown: ${sbResult.saved} saved, ${sbResult.errors} errors`);
      } catch (sbError) {
        console.warn('  [7] ScoreBreakdown save failed:', (sbError as Error).message);
        // Non-fatal — analytics data loss, not pipeline failure
      }
    }

    let readyToBuy: NightlyReadyCandidate[] = [];
    let triggerMetCandidates: NightlyTriggerMetCandidate[] = [];
    if (snapshotSync.snapshotId) {
      try {
        const heldTickers = new Set(positions.map((p) => p.stock.ticker));
        const readyRows = await prisma.snapshotTicker.findMany({
          where: { snapshotId: snapshotSync.snapshotId, status: 'READY' },
          orderBy: { distanceTo20dHighPct: 'asc' },
          take: 15,
        });
        readyToBuy = readyRows
          .filter((r) => !heldTickers.has(r.ticker) && r.adx14 >= 20)
          .map((r) => ({
            ticker: r.ticker,
            name: r.name || r.ticker,
            sleeve: r.sleeve || 'CORE',
            close: r.close,
            entryTrigger: r.entryTrigger,
            stopLevel: r.stopLevel,
            // Distance to entry trigger (not raw 20d high) — matches classifyCandidate
            distancePct: r.close > 0 && r.entryTrigger > 0
              ? ((r.entryTrigger - r.close) / r.close) * 100
              : r.distanceTo20dHighPct,
            atr14: r.atr14,
            adx14: r.adx14,
            currency: r.currency || 'USD',
          }));

        // Detect trigger-met candidates: close >= entryTrigger and not already held
        const allTriggeredRows = await prisma.snapshotTicker.findMany({
          where: {
            snapshotId: snapshotSync.snapshotId,
            status: { in: ['READY', 'WATCH'] },
          },
          orderBy: { distanceTo20dHighPct: 'asc' },
        });
        triggerMetCandidates = allTriggeredRows
          .filter((r) => !heldTickers.has(r.ticker) && r.close >= r.entryTrigger && r.entryTrigger > 0 && r.adx14 >= 20)
          .map((r) => ({
            ticker: r.ticker,
            name: r.name || r.ticker,
            sleeve: r.sleeve || 'CORE',
            close: r.close,
            entryTrigger: r.entryTrigger,
            stopLevel: r.stopLevel,
            distancePct: ((r.close - r.entryTrigger) / r.entryTrigger) * 100,
            atr14: r.atr14,
            adx14: r.adx14,
            currency: r.currency || 'USD',
          }));
        if (triggerMetCandidates.length > 0) {
          alerts.push(`🚨 ${triggerMetCandidates.length} trigger(s) met — review for immediate entry`);
        }
      } catch (error) {
        hadFailure = true;
        console.warn('  [7b] Failed to query READY tickers:', (error as Error).message);
      }
    }

    // ── Step 7c: Pre-cache earnings dates for READY/WATCH candidates ──
    // Fetches from Yahoo quoteSummary(calendarEvents) and writes to EarningsCache table.
    // This means Tuesday morning's scan reads from cache — no additional Yahoo calls needed.
    console.log('  [7c] Pre-caching earnings dates...');
    try {
      // Gather unique tickers from ready-to-buy + trigger-met candidates + all READY/WATCH from snapshot
      const earningsTickers = new Set<string>();
      for (const r of readyToBuy) earningsTickers.add(r.ticker);
      for (const t of triggerMetCandidates) earningsTickers.add(t.ticker);

      // Also include all READY/WATCH from latest snapshot for broader coverage
      if (snapshotSync.snapshotId) {
        const watchRows = await prisma.snapshotTicker.findMany({
          where: {
            snapshotId: snapshotSync.snapshotId,
            status: { in: ['READY', 'WATCH'] },
          },
          select: { ticker: true },
        });
        for (const r of watchRows) earningsTickers.add(r.ticker);
      }

      const tickerList = Array.from(earningsTickers);
      if (tickerList.length > 0) {
        const earningsResult = await preCacheEarningsBatch(tickerList);
        console.log(`        Earnings cached: ${earningsResult.success} success, ${earningsResult.failed} failed of ${tickerList.length}`);
        if (earningsResult.failed > 0) {
          alerts.push(`Earnings cache: ${earningsResult.failed}/${tickerList.length} tickers failed`);
        }
      } else {
        console.log('        No READY/WATCH candidates — earnings cache skipped');
      }
    } catch (error) {
      // Non-critical — scan will fall through to UNKNOWN confidence (no penalty)
      console.warn('  [7c] Earnings pre-cache failed:', (error as Error).message);
    }

    // ── Alert Generation — In-app notifications via alert-service ────
    const dayOfWeek = getUKDayOfWeek(); // 0=Sunday, 2=Tuesday — UK timezone

    // ALERT 1: Trade triggers (Tuesday only, max 3)
    if (dayOfWeek === 2 && triggerMetCandidates.length > 0) {
      try {
        // Take top 3 by closest distance (already sorted by distanceTo20dHighPct asc)
        const topTriggers = triggerMetCandidates.slice(0, 3);
        const extraCount = triggerMetCandidates.length - topTriggers.length;

        for (const t of topTriggers) {
          const currSymbol = t.currency === 'GBP' || t.currency === 'GBX' ? '£' : t.currency === 'EUR' ? '€' : '$';
          const riskPerShare = t.entryTrigger > 0 && t.stopLevel > 0 ? t.entryTrigger - t.stopLevel : 0;
          await sendAlert({
            type: 'TRADE_TRIGGER',
            title: `${t.ticker} is ready to buy`,
            message: `The system found a trade for Tuesday.\n${t.name} (${t.ticker})\nBuy price: ${currSymbol}${t.entryTrigger.toFixed(2)}\nStop-loss: ${currSymbol}${t.stopLevel.toFixed(2)}${riskPerShare > 0 ? `\nRisk per share: ${currSymbol}${riskPerShare.toFixed(2)}` : ''}\n\nOpen the Plan page to review.${extraCount > 0 ? `\n\nand ${extraCount} more in the app.` : ''}`,
            data: { ticker: t.ticker, entryTrigger: t.entryTrigger, stopLevel: t.stopLevel, close: t.close },
            priority: 'INFO',
          });
        }
        console.log(`        Trade trigger alerts: ${topTriggers.length} sent${extraCount > 0 ? ` (+${extraCount} more in app)` : ''}`);
      } catch (error) {
        console.warn('  [7c] Trade trigger alerts failed:', (error as Error).message);
      }
    }

    // ALERT 2: Weekly summary (Sunday only)
    if (dayOfWeek === 0) {
      try {
        // Determine market mood from regime
        const latestRegime = await prisma.regimeHistory.findFirst({ orderBy: { date: 'desc' } });
        const mood = latestRegime?.regime === 'BULLISH' ? 'Positive ✓'
          : latestRegime?.regime === 'BEARISH' ? 'Negative ✗'
          : 'Neutral —';

        // Position tickers as comma-separated
        const positionTickers = positions.map((p) => p.stock.ticker).join(', ') || 'None';

        // Portfolio value in GBP
        const portfolioValue = positions.reduce((sum, p) => {
          const rawPrice = livePrices[p.stock.ticker] || p.entryPrice;
          const gbpPrice = gbpPrices[p.stock.ticker] ?? rawPrice;
          return sum + gbpPrice * p.shares;
        }, 0);

        // Closest to triggering (top 3 from readyToBuy)
        const closest = readyToBuy.slice(0, 3);
        const closestLines = closest.length > 0
          ? closest.map((c) => `· ${c.ticker} — ${c.distancePct.toFixed(2)}% away`).join('\n')
          : 'None close to triggering';

        const watchCount = readyToBuy.length;

        await sendAlert({
          type: 'WEEKLY_SUMMARY',
          title: 'Weekly Summary',
          message: `Market mood: ${mood}\nOpen positions: ${positions.length} (${positionTickers})\nPortfolio value: £${portfolioValue.toFixed(0)}\nCandidates watching: ${watchCount}\n\nClosest to triggering:\n${closestLines}\n\nYour trading window is Tuesday.`,
          data: { mood, positionCount: positions.length, portfolioValue, watchCount },
          priority: 'INFO',
          // Sunday nightly report (sendNightlySummary) already sends a comprehensive
          // Telegram message — suppress Telegram here to avoid a confusing double-message.
          // The in-app notification still saves to DB for the notifications page.
          skipTelegram: true,
        });
        console.log('        Weekly summary alert sent');
      } catch (error) {
        console.warn('  [7d] Weekly summary alert failed:', (error as Error).message);
      }
    }

    // Step 8: Send Telegram summary (isolated — failure doesn't block heartbeat)
    console.log('  [8/9] Sending Telegram summary...');
    startStep('8', 'Telegram alert');
    log.info('Step 8: Telegram summary');

    // Fetch today's price accuracy stats (T212 vs Yahoo)
    let priceAccuracy: { avgDiffPercent: number; maxDiffPercent: number; snapshotCount: number } | null = null;
    try {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const snapshots = await prisma.priceSnapshot.findMany({
        where: { capturedAt: { gte: dayAgo }, diffPercent: { not: null } },
        select: { diffPercent: true },
      });
      if (snapshots.length > 0) {
        const diffs = snapshots.map(s => s.diffPercent!);
        priceAccuracy = {
          avgDiffPercent: Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length * 100) / 100,
          maxDiffPercent: Math.round(Math.max(...diffs) * 100) / 100,
          snapshotCount: snapshots.length,
        };
      }
    } catch { /* advisory — don't block telegram */ }

    const telegramSent = await deliverNightlyNotification(() => sendNightlySummary({
      date: new Date().toISOString().split('T')[0],
      healthStatus: healthReport.overall,
      regime: snapshotSync.synced ? 'SYNCED' : 'UNKNOWN',
      openPositions: positions.length,
      stopsUpdated: stopChanges.length + trailingStopChanges.length,
      readyCandidates: readyToBuy.length,
      alerts,
      // Portfolio value in GBP for multi-currency consistency
      portfolioValue: positions.reduce((sum, p) => {
        const rawPrice = livePrices[p.stock.ticker] || p.entryPrice;
        const gbpPrice = gbpPrices[p.stock.ticker] ?? rawPrice;
        return sum + gbpPrice * p.shares;
      }, 0),
      dailyChange: 0,
      dailyChangePercent: 0,
      equity,
      openRiskPercent,
      positions: positionDetails,
      stopChanges,
      trailingStopChanges,
      snapshotSynced: snapshotSync.rowCount,
      snapshotFailed: snapshotSync.failed.length,
      readyToBuy,
      triggerMet: triggerMetCandidates,
      pyramidAlerts,
      laggards: laggardAlerts,
      climaxAlerts,
      swapAlerts,
      whipsawAlerts,
      breadthAlert,
      momentumAlert,
      gapRiskAlerts,
      breakoutFailures: breakoutFailureAlerts,
      acceleratorAlerts,
      priceAccuracy,
    }), (message) => {
      markStepFailed(message);
      log.error(message);
    });
    console.log(`        Telegram: ${telegramSent ? 'SENT' : 'NOT SENT (check delivery logs)'}`);

    // Step 9: Write heartbeat
    console.log('  [9/9] Writing heartbeat...');
    finalizeSteps();
    // Derive status: SUCCESS (no failures), PARTIAL (some steps failed, pipeline completed), FAILED (critical)
    const failedSteps = stepResults.filter(s => s.status === 'FAILED');
    const heartbeatStatus = !hadFailure ? 'SUCCESS' : failedSteps.length < stepResults.length ? 'PARTIAL' : 'FAILED';
    if (heartbeatStatus === 'PARTIAL') {
      const degradedNames = failedSteps.map(s => `Step ${s.step} (${s.name})`).join(', ');
      alerts.push(`⚠️ Degraded steps: ${degradedNames}`);
    }
    await prisma.heartbeat.create({
      data: {
        kind: 'NIGHTLY',
        status: heartbeatStatus,
        details: JSON.stringify({
          healthStatus: healthReport.overall,
          positionsChecked: positions.length,
          stopsRecommended: stopRecs.length,
          trailingStopsApplied: trailingStopChanges.length,
          alertsCount: alerts.length,
          telegramSent,
          hadFailure,
          stepResults,
          snapshotSync,
          positionSync: {
            checked: positionSyncResult.checked,
            closed: positionSyncResult.closed,
            skipped: positionSyncResult.skipped,
            errors: positionSyncResult.errors,
          },
          // Data source fallback chain health
          dataSource: {
            health: dataSourceHealth,
            staleTickers: dataSourceStaleTickers,
            maxStalenessHours: dataSourceMaxStalenessHours,
            summary: dataSourceSummary,
          },
        }),
      },
    });

    console.log('========================================');
    console.log('[HybridTurtle] Nightly process completed successfully');

    // Step self-test: warn if any step took >5 minutes (300s)
    finalizeSteps();
    const STEP_SLOW_THRESHOLD_MS = 5 * 60 * 1000;
    const slowSteps = stepResults.filter(s => s.durationMs > STEP_SLOW_THRESHOLD_MS);
    if (slowSteps.length > 0) {
      const slowList = slowSteps.map(s => `${s.name}: ${(s.durationMs / 1000).toFixed(0)}s`).join(', ');
      log.warn('Slow steps detected', { slowSteps: slowList, thresholdMs: STEP_SLOW_THRESHOLD_MS });
      alerts.push(`⏱ ${slowSteps.length} step(s) took >5 min: ${slowList}`);
    }
    const failedStepsFinal = stepResults.filter(s => s.status === 'FAILED');
    if (failedStepsFinal.length > 0) {
      const failList = failedStepsFinal.map(s => `${s.name}: ${s.error ?? 'unknown'}`).join('; ');
      log.warn('Failed steps in nightly', { failedSteps: failList });
    }

    log.info('Nightly process completed', {
      status: hadFailure ? 'PARTIAL' : 'SUCCESS',
      health: healthReport.overall,
      positions: positions.length,
      alerts: alerts.length,
      telegramSent,
      steps: stepResults.map(s => ({ step: s.step, name: s.name, status: s.status, durationMs: s.durationMs })),
    });
    console.log(`  Health: ${healthReport.overall}`);
    console.log(`  Positions: ${positions.length}`);
    console.log(`  Alerts: ${alerts.length}`);
    console.log(`  Telegram: ${telegramSent ? 'Sent' : 'Not sent'}`);
    console.log('========================================');
  } catch (error) {
    console.error('[HybridTurtle] Nightly process error:', error);
    process.exitCode = 1;

    // Still write heartbeat on failure
    try {
      await prisma.heartbeat.create({
        data: {
          kind: 'NIGHTLY',
          status: 'FAILED',
          details: JSON.stringify({ error: (error as Error).message }),
        },
      });
    } catch (err) { console.warn(`  [nightly] Heartbeat write skipped: ${err instanceof Error ? err.message : String(err)}`); }
  } finally {
    // Safety net: if latest heartbeat is still RUNNING, mark as FAILED
    try {
      const latest = await prisma.heartbeat.findFirst({
        where: { kind: 'NIGHTLY' },
        orderBy: { timestamp: 'desc' },
      });
      if (latest?.status === 'RUNNING') {
        await prisma.heartbeat.create({
          data: {
            kind: 'NIGHTLY',
            status: 'FAILED',
            details: JSON.stringify({ error: 'Pipeline exited with RUNNING status — forced to FAILED' }),
          },
        });
        console.warn('  [!!!] RUNNING heartbeat found in finally — forced to FAILED');
      }
    } catch (err) { console.warn(`  [nightly] Safety-net heartbeat skipped: ${err instanceof Error ? err.message : String(err)}`); }
    await prisma.$disconnect();
  }
}

// If running directly via tsx / node
const args = process.argv.slice(2);

if (args.includes('--run-now')) {
  console.log('[HybridTurtle] Running nightly process immediately (--run-now)');
  runNightlyProcess().then(() => process.exit(process.exitCode ?? 0));
}
