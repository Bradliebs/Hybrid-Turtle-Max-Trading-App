/**
 * DEPENDENCIES
 * Consumed by: src/app/api/scan/route.ts (dashboard Run Full Scan),
 *              src/cron/auto-trade.ts (scheduled 20:00 scan-only session)
 * Consumes: scan-engine.ts (type only), packages/model, candidate-grade.ts,
 *           score-lookup.ts, filter-attribution.ts, candidate-outcome.ts,
 *           market-data.ts, prisma.ts
 * Risk-sensitive: NO — persistence + grading only; never executes trades.
 *
 * Single source of truth for turning a raw `runFullScan` result into a
 * persisted Scan snapshot (Scan + ScanResult + FilterAttribution +
 * CandidateOutcome). Previously this pipeline lived inline in the dashboard
 * scan route, which meant the persisted snapshot only advanced when a human
 * clicked "Run Full Scan". The scheduled evening scan recomputed the same data
 * but discarded it, so `scanAgeHours` (today-directive, ready-to-buy, analyst,
 * briefings) and the CandidateOutcome research dataset went stale between
 * manual scans. Extracting this lets the cron persist the scan it already runs.
 */
import prisma from '@/lib/prisma';
import { runFullScan } from '@/lib/scan-engine';
import { applyModelLayerToCandidates, type ModelVersionManifest } from '../../packages/model/src';
import { classifyCandidates, type GradingContext } from '@/lib/candidate-grade';
import { getLatestScoresByTicker, isScoreStale } from '@/lib/score-lookup';
import { saveFilterAttributions } from '@/lib/filter-attribution';
import { saveCandidateOutcomes } from '@/lib/candidate-outcome';
import { getDataFreshness, getTickerDataFreshness } from '@/lib/market-data';
import type { ScanCandidate } from '@/types';

type ScanRunResult = Awaited<ReturnType<typeof runFullScan>>;

export interface PersistScanSnapshotResult {
  /** Created Scan row id, or null if DB persistence failed (non-fatal). */
  scanId: string | null;
  /** All candidates with model overlay applied and A/B/C grades attached. */
  gradedCandidates: Array<ScanCandidate & { classification: { grade: string; reason: string } }>;
  /** Model-layer metadata for the API response. */
  modelLayer: { enabled: boolean; versions: ModelVersionManifest };
}

/**
 * Apply the model layer + grading to a raw scan result and persist the full
 * snapshot. Grading is always computed and returned even if the database write
 * fails, preserving the dashboard's guarantee that graded results are returned
 * to the client regardless of persistence success.
 */
export async function persistScanSnapshot(params: {
  userId: string;
  scanResult: ScanRunResult;
  modelLayerEnabled: boolean;
  executionCandidates?: PersistScanSnapshotResult['gradedCandidates'];
  executionScoresByTicker?: Awaited<ReturnType<typeof getLatestScoresByTicker>>;
}): Promise<PersistScanSnapshotResult> {
  const { userId, scanResult, modelLayerEnabled } = params;

  const modelLayer = applyModelLayerToCandidates(
    scanResult.candidates,
    { enabled: modelLayerEnabled },
    scanResult.regime,
  );

  // Latest health for the grading context (GREEN fallback matches the route).
  const latestHealth = await prisma.healthCheck
    .findFirst({
      where: { userId },
      orderBy: { runDate: 'desc' },
      select: { overall: true },
    })
    .catch(() => null);

  // Per-candidate NCS/FWS/BQS so grading uses the same scores nightly wrote.
  // Without this the grader receives null scores and treats every candidate as
  // worst-case, so nothing ever reaches A_GRADE_BUY.
  const candidateTickers = modelLayer.candidates.map((c) => c.ticker);
  const scoresByTicker = await getLatestScoresByTicker(candidateTickers).catch((err) => {
    console.warn('[persistScanSnapshot] getLatestScoresByTicker failed, falling back to null scores:', (err as Error).message);
    const emptyScores: Awaited<ReturnType<typeof getLatestScoresByTicker>> = new Map();
    return emptyScores;
  });
  if (params.executionScoresByTicker) {
    for (const candidate of params.executionCandidates ?? []) {
      const scores = params.executionScoresByTicker.get(candidate.ticker);
      if (scores) scoresByTicker.set(candidate.ticker, scores);
      else scoresByTicker.delete(candidate.ticker);
    }
  }

  const baseGradingContext: GradingContext = {
    regime: scanResult.regime,
    healthOverall: (latestHealth?.overall as string) ?? 'GREEN',
  };

  const executionCandidates = new Map(params.executionCandidates?.map(candidate => [candidate.ticker, candidate]));
  const gradedCandidates = classifyCandidates(modelLayer.candidates, (candidate) => {
    const scores = scoresByTicker.get(candidate.ticker);
    return scores
      ? { ...baseGradingContext, ncs: scores.ncs, fws: scores.fws, bqs: scores.bqs, scoresStale: isScoreStale(scores) }
      : baseGradingContext;
  }).map(candidate => executionCandidates.get(candidate.ticker) ?? candidate);

  // ── Persist to database (non-fatal — grading is still returned on failure) ──
  let scanId: string | null = null;
  try {
    const allStocks = await prisma.stock.findMany({
      where: { active: true },
      select: { id: true, ticker: true },
    });
    const stockMap = new Map(allStocks.map((s) => [s.ticker, s.id]));

    const scan = await prisma.scan.create({
      data: {
        userId,
        regime: scanResult.regime,
        results: {
          create: gradedCandidates
            .filter((c) => stockMap.has(c.ticker)) // only known tickers
            .map((c) => ({
              stockId: stockMap.get(c.ticker)!,
              price: c.price,
              ma200: c.technicals?.ma200 ?? 0,
              adx: c.technicals?.adx ?? 0,
              plusDI: c.technicals?.plusDI ?? 0,
              minusDI: c.technicals?.minusDI ?? 0,
              atrPercent: c.technicals?.atrPercent ?? 0,
              efficiency: c.technicals?.efficiency ?? 0,
              twentyDayHigh: c.technicals?.twentyDayHigh ?? 0,
              entryTrigger: c.entryTrigger,
              stopPrice: c.stopPrice,
              distancePercent: c.distancePercent,
              status: c.status,
              entryMode: c.pullbackSignal?.triggered ? 'PULLBACK_CONTINUATION' : 'BREAKOUT',
              stage6Reason: c.pullbackSignal?.reason ?? c.antiChaseResult?.reason ?? null,
              passesRiskGates: c.passesRiskGates ?? null,
              passesAntiChase: c.passesAntiChase ?? null,
              rankScore: c.rankScore,
              passesAllFilters: c.passesAllFilters,
              shares: c.shares ?? null,
              riskDollars: c.riskDollars ?? null,
              grade: c.classification?.grade ?? null,
              gradeReason: c.classification?.reason ?? null,
              ncs: scoresByTicker.get(c.ticker)?.ncs ?? null,
              fws: scoresByTicker.get(c.ticker)?.fws ?? null,
              bqs: scoresByTicker.get(c.ticker)?.bqs ?? null,
            })),
        },
      },
    });
    scanId = scan.id;
    console.log(`[persistScanSnapshot] Saved scan ${scan.id} with ${gradedCandidates.length} candidates to DB`);

    // ── Filter Attribution: per-candidate filter decisions for analytics ──
    try {
      const attrResult = await saveFilterAttributions(gradedCandidates, scan.id, scanResult.regime);
      console.log(`[FilterAttribution] Saved ${attrResult.saved}, errors: ${attrResult.errors}`);
    } catch (attrError) {
      console.warn('[FilterAttribution] Failed:', (attrError as Error).message);
    }

    // ── Candidate Outcome: research-grade dataset for every candidate ──
    try {
      const freshness = getDataFreshness();
      const provenanceByTicker = new Map(
        gradedCandidates.map(candidate => [candidate.ticker, getTickerDataFreshness(candidate.ticker)]),
      );
      const coResult = await saveCandidateOutcomes(
        gradedCandidates,
        scan.id,
        scanResult.regime,
        freshness.source,
        provenanceByTicker,
      );
      console.log(`[CandidateOutcome] Saved ${coResult.saved}, errors: ${coResult.errors}`);
    } catch (coError) {
      console.warn('[CandidateOutcome] Failed:', (coError as Error).message);
    }
  } catch (dbError) {
    console.warn('[persistScanSnapshot] Failed to persist scan to DB:', (dbError as Error).message);
    // Non-fatal — caller still receives graded candidates.
  }

  return {
    scanId,
    gradedCandidates,
    modelLayer: { enabled: modelLayer.settings.enabled, versions: modelLayer.versions },
  };
}
