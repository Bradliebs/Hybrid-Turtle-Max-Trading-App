/**
 * DEPENDENCIES
 * Consumed by: research-refresh-task.bat, manual CLI invocation
 * Consumes: candidate-outcome.ts, candidate-outcome-enrichment.ts,
 *           score-backfill.ts, filter-attribution.ts, score-tracker.ts,
 *           prisma.ts
 * Risk-sensitive: NO — analytics only, no trading actions
 * Last modified: 2026-03-06
 *
 * Research Refresh Job — Standalone
 *
 * Refreshes the research dataset by running all backfill and enrichment
 * steps in sequence. Safe to rerun (all steps are idempotent).
 *
 * Steps:
 *   1. Backfill trade links: CandidateOutcome ← TradeLog (by ticker + date)
 *   2. Backfill scores: CandidateOutcome ← ScoreBreakdown (BQS/FWS/NCS)
 *   3. Enrich forward outcomes: CandidateOutcome ← Yahoo prices (5d/10d/20d)
 *   4. Backfill filter outcomes: FilterAttribution ← TradeLog (R-multiples)
 *   5. Backfill score outcomes: ScoreBreakdown ← TradeLog (R-multiples)
 *
 * Usage:
 *   npx tsx src/cron/research-refresh.ts --run-now
 *   npx tsx src/cron/research-refresh.ts --run-now --quiet
 *
 * Or via batch file:
 *   research-refresh-task.bat
 */

import prisma from '@/lib/prisma';
import { backfillTradeLinks } from '@/lib/candidate-outcome';
import { enrichCandidateOutcomes } from '@/lib/candidate-outcome-enrichment';
import { backfillScoresOnOutcomes } from '@/lib/score-backfill';
import { backfillFilterOutcomes } from '@/lib/filter-attribution';
import { backfillScoreOutcomes } from '@/lib/score-tracker';
import { createCronLogger } from '@/lib/cron-logger';

// ── Configuration ───────────────────────────────────────────────────

/**
 * Candidate outcomes claimed per run. A page holds roughly one row per ticker,
 * and each claimed ticker's other eligible rows are enriched from the same price
 * fetch, so this is effectively tickers per run. ~1.4s per fetch → ~10 minutes,
 * inside the task's 20-minute limit; the ~1,100-ticker universe is swept about
 * every 3 nights.
 */
const ENRICHMENT_BATCH_SIZE = 400;

/** Minimum days old before attempting forward outcome enrichment */
const ENRICHMENT_MIN_DAYS = 8;

// ── CLI flags ───────────────────────────────────────────────────────

const QUIET = process.argv.includes('--quiet');
const RUN_NOW = process.argv.includes('--run-now');

const cronLog = createCronLogger('research-refresh');

function log(msg: string): void {
  if (!QUIET) cronLog.info(msg);
}

function logError(msg: string): void {
  cronLog.error(msg);
}

// ── Step runner ─────────────────────────────────────────────────────

interface StepResult {
  step: string;
  status: 'OK' | 'FAILED' | 'SKIPPED';
  detail: string;
  durationMs: number;
}

async function runStep(
  name: string,
  fn: () => Promise<string>
): Promise<StepResult> {
  const start = Date.now();
  try {
    const detail = await fn();
    const duration = Date.now() - start;
    log(`✓ ${name} (${duration}ms): ${detail}`);
    return { step: name, status: 'OK', detail, durationMs: duration };
  } catch (e) {
    const duration = Date.now() - start;
    const msg = (e as Error).message || String(e);
    logError(`✗ ${name} (${duration}ms): ${msg}`);
    return { step: name, status: 'FAILED', detail: msg, durationMs: duration };
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = Date.now();
  log('Starting research dataset refresh...');

  // Check we have data to work with
  const candidateCount = await prisma.candidateOutcome.count();
  const snapshotCount = await prisma.scoreBreakdown.count();
  log(`Dataset: ${candidateCount} candidate outcomes, ${snapshotCount} score breakdowns`);

  if (candidateCount === 0) {
    log('No candidate outcome records yet. Run a scan first to populate data.');
    log('Finished (nothing to do).');
    return;
  }

  const results: StepResult[] = [];

  // ── Step 1: Link trades to candidate outcomes ─────────────────
  results.push(await runStep(
    '1. Trade Links',
    async () => {
      const linked = await backfillTradeLinks();
      return `${linked} candidate outcomes linked to trades`;
    }
  ));

  // ── Step 2: Backfill BQS/FWS/NCS from ScoreBreakdown ─────────
  results.push(await runStep(
    '2. Score Backfill',
    async () => {
      const { updated, skipped, errors } = await backfillScoresOnOutcomes();
      return `${updated} scored, ${skipped} skipped (no match), ${errors} errors`;
    }
  ));

  // ── Step 3: Enrich forward outcomes (Yahoo price data) ────────
  results.push(await runStep(
    '3. Forward Enrichment',
    async () => {
      const { enriched, skipped, errors } = await enrichCandidateOutcomes(
        ENRICHMENT_MIN_DAYS,
        ENRICHMENT_BATCH_SIZE
      );
      return `${enriched} enriched, ${skipped} skipped (too recent/no data), ${errors} errors`;
    }
  ));

  // ── Step 4: Backfill filter attribution outcomes ──────────────
  results.push(await runStep(
    '4. Filter Outcomes',
    async () => {
      const updated = await backfillFilterOutcomes();
      return `${updated} filter attribution rows updated with R-multiples`;
    }
  ));

  // ── Step 5: Backfill score breakdown outcomes ─────────────────
  results.push(await runStep(
    '5. Score Outcomes',
    async () => {
      const updated = await backfillScoreOutcomes();
      return `${updated} score breakdown rows updated with R-multiples`;
    }
  ));

  // ── Summary ───────────────────────────────────────────────────

  const totalMs = Date.now() - startTime;
  const ok = results.filter((r) => r.status === 'OK').length;
  const failed = results.filter((r) => r.status === 'FAILED').length;

  log('');
  log('═══════════════════════════════════════════════');
  log(`  Research Refresh Complete: ${ok}/${results.length} steps OK`);
  if (failed > 0) {
    log(`  ⚠ ${failed} step(s) failed — see errors above`);
  }
  log(`  Total time: ${(totalMs / 1000).toFixed(1)}s`);
  log('═══════════════════════════════════════════════');

  // Post-refresh dataset stats
  const enrichedCount = await prisma.candidateOutcome.count({
    where: { enrichedAt: { not: null } },
  });
  const scoredCount = await prisma.candidateOutcome.count({
    where: { ncs: { not: null } },
  });
  const tradedCount = await prisma.candidateOutcome.count({
    where: { tradePlaced: true },
  });

  log(`  Dataset: ${candidateCount} total → ${scoredCount} scored, ${enrichedCount} enriched, ${tradedCount} traded`);
  log('');

  await prisma.$disconnect();
}

// ── Entry point ─────────────────────────────────────────────────────

if (RUN_NOW) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      logError(`Fatal error: ${(e as Error).message}`);
      process.exit(1);
    });
} else {
  console.log('Usage: npx tsx src/cron/research-refresh.ts --run-now [--quiet]');
  process.exit(0);
}
