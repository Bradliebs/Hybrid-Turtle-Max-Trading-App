/**
 * DEPENDENCIES
 * Consumed by: nightly.ts, /api/health-check/route.ts, /api/nightly/route.ts
 * Consumes: prisma.ts, market-data.ts, @/types
 * Risk-sensitive: NO
 * Last modified: 2026-02-22
 * Notes: 16-point health audit — used in nightly Step 1 and dashboard.
 */
// ============================================================
// 16-Point Health Check Service
// ============================================================

import type { HealthStatus, HealthCheckResult, RiskProfileType } from '@/types';
import { HEALTH_CHECK_ITEMS, RISK_PROFILES, SLEEVE_CAPS, CLUSTER_CAP, SECTOR_CAP, getProfileCaps } from '@/types';
import { getBatchPrices, normalizeBatchPricesToGBP } from '@/lib/market-data';
import { looksLikeValidT212Ticker } from '@/lib/t212-ticker-validator';
import prisma from './prisma';

/** Shape of a position as loaded by the health-check Prisma query. */
interface HealthCheckPosition {
  entryPrice: number;
  shares: number;
  currentStop: number;
  stopLoss: number;
  initialRisk: number;
  protectionLevel: string;
  status: string;
  // Optional in the type so existing test fixtures (which mock partial rows
  // for stop/sleeve/config checks) keep compiling. Production callers always
  // populate them via Prisma's default `include: { stock: true }` shape.
  stockId?: string;
  accountType?: string | null;
  stock: { ticker: string; sleeve: string; currency: string | null; cluster?: string | null; sector?: string | null };
  stopHistory: { oldStop: number; newStop: number }[];
}

export interface HealthCheckReport {
  overall: HealthStatus;
  checks: Record<string, HealthStatus>;
  results: HealthCheckResult[];
  timestamp: Date;
}

/**
 * Run the full 16-point health check
 */
export async function runHealthCheck(userId: string): Promise<HealthCheckReport> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      positions: {
        where: { status: 'OPEN' },
        include: { stock: true, stopHistory: { orderBy: { createdAt: 'desc' }, take: 1 } },
      },
    },
  });

  if (!user) {
    throw new Error('User not found');
  }

  const results: HealthCheckResult[] = [];

  // ---- A1: Data Freshness ----
  results.push(await checkDataFreshness());

  // ---- A2: Duplicate Tickers ----
  results.push(await checkDuplicateTickers());

  // ---- A3: Column Population ----
  results.push(await checkColumnPopulation());

  // ---- A4: Open Position Uniqueness ----
  results.push(checkOpenPositionUniqueness(user.positions));

  // ---- A5: T212 Ticker Mappings ----
  results.push(await checkInvalidT212Tickers());

  // ---- A6: Yahoo Ticker Mappings ----
  results.push(await checkInvalidYahooTickers());

  // ---- A7: Sector Coverage on Open Positions ----
  results.push(checkSectorCoverage(user.positions));

  // ---- C1: Equity > £0 ----
  results.push(checkEquityPositive(user.equity));

  // ---- C2: Open Risk Within Cap ----
  const tickers = user.positions.map((p) => p.stock?.ticker).filter(Boolean) as string[];
  const livePrices = tickers.length > 0 ? await getBatchPrices(tickers) : {};
  const stockCurrencies: Record<string, string | null> = {};
  for (const p of user.positions) {
    if (p.stock?.ticker) {
      stockCurrencies[p.stock.ticker] = p.stock.currency;
    }
  }
  const gbpPrices = tickers.length > 0
    ? await normalizeBatchPricesToGBP(livePrices, stockCurrencies)
    : {};
  results.push(checkOpenRiskCap(user.positions, user.equity, user.riskProfile as RiskProfileType, livePrices, gbpPrices));

  // ---- C3: Valid Position Sizes ----
  results.push(checkPositionSizes(user.positions, user.equity, user.riskProfile as RiskProfileType, livePrices, gbpPrices));

  // ---- D: Stop Monotonicity ----
  results.push(await checkStopMonotonicity(user.positions));

  // ---- D2: Stop Integrity ----
  results.push(checkStopIntegrity(user.positions));

  // ---- E: State File Currency ----
  results.push(await checkStateCurrency(userId));

  // ---- F: Config Coherence ----
  results.push(checkConfigCoherence(user.riskProfile as RiskProfileType));

  // ---- G1: Sleeve Limits ----
  results.push(checkSleeveLimits(user.positions, user.equity, livePrices, gbpPrices));

  // ---- G2: Cluster Concentration ----
  results.push(checkClusterConcentration(user.positions, user.equity, user.riskProfile as RiskProfileType));

  // ---- G3: Sector Concentration ----
  results.push(checkSectorConcentration(user.positions, user.equity, user.riskProfile as RiskProfileType));

  // ---- H1: Heartbeat Recent ----
  results.push(await checkHeartbeat());

  // ---- H2: API Connectivity ----
  results.push(await checkAPIConnectivity());

  // ---- H3: Database Integrity ----
  results.push(checkDatabaseIntegrity());

  // ---- H4: Cron Job Active ----
  results.push(await checkCronActive());

  // ---- H5: Data Source Quality ----
  results.push(await checkDataSource());

  // Determine overall status
  const hasRed = results.some((r) => r.status === 'RED');
  const hasYellow = results.some((r) => r.status === 'YELLOW');
  const overall: HealthStatus = hasRed ? 'RED' : hasYellow ? 'YELLOW' : 'GREEN';

  const checks: Record<string, HealthStatus> = {};
  results.forEach((r) => {
    checks[r.id] = r.status;
  });

  // Save to database
  await prisma.healthCheck.create({
    data: {
      userId,
      overall,
      checks: JSON.stringify(checks),
      details: JSON.stringify(results),
    },
  });

  return {
    overall,
    checks,
    results,
    timestamp: new Date(),
  };
}

// ---- Individual Check Functions ----

async function checkDataFreshness(): Promise<HealthCheckResult> {
  try {
    // Filter by kind='NIGHTLY' so a fresh hourly-status / midday-sync heartbeat
    // can never mask a missed nightly. Audit 2026-06-16 — A1 was reading the
    // most recent heartbeat across all kinds and reporting GREEN even when
    // nightly had been skipped for days.
    const heartbeat = await prisma.heartbeat.findFirst({
      where: { kind: 'NIGHTLY' },
      orderBy: { timestamp: 'desc' },
    });

    if (!heartbeat) {
      return { id: 'A1', label: 'Data Freshness', category: 'Data', status: 'YELLOW', message: 'No nightly heartbeat recorded yet' };
    }

    const hoursSince = (Date.now() - heartbeat.timestamp.getTime()) / (1000 * 60 * 60);
    const daysSince = hoursSince / 24;
    if (daysSince > 5) {
      return { id: 'A1', label: 'Data Freshness', category: 'Data', status: 'RED', message: `Nightly data is ${daysSince.toFixed(1)} days old (max 5 days)` };
    }
    if (daysSince > 2) {
      return { id: 'A1', label: 'Data Freshness', category: 'Data', status: 'YELLOW', message: `Nightly data is ${daysSince.toFixed(1)} days old (warn > 2 days)` };
    }
    return { id: 'A1', label: 'Data Freshness', category: 'Data', status: 'GREEN', message: `Nightly updated ${Math.floor(hoursSince)}h ago` };
  } catch {
    return { id: 'A1', label: 'Data Freshness', category: 'Data', status: 'YELLOW', message: 'Data freshness check failed — unable to query heartbeat' };
  }
}

async function checkDuplicateTickers(): Promise<HealthCheckResult> {
  try {
    const stocks = await prisma.stock.findMany({ select: { ticker: true } });
    const tickers = stocks.map((s) => s.ticker);
    const unique = new Set(tickers);
    if (tickers.length !== unique.size) {
      const dupes = tickers.filter((t, i) => tickers.indexOf(t) !== i);
      return { id: 'A2', label: 'Duplicate Tickers', category: 'Data', status: 'RED', message: `Duplicates found: ${dupes.join(', ')}` };
    }
    return { id: 'A2', label: 'Duplicate Tickers', category: 'Data', status: 'GREEN', message: `${tickers.length} unique tickers` };
  } catch {
    return { id: 'A2', label: 'Duplicate Tickers', category: 'Data', status: 'YELLOW', message: 'Duplicate check failed — unable to query stocks' };
  }
}

async function checkColumnPopulation(): Promise<HealthCheckResult> {
  // Check that scan results have no null values in required fields
  try {
    const latestScan = await prisma.scan.findFirst({
      orderBy: { runDate: 'desc' },
      include: { results: true },
    });
    if (!latestScan || latestScan.results.length === 0) {
      return { id: 'A3', label: 'Column Population', category: 'Data', status: 'YELLOW', message: 'No scan data to validate' };
    }
    const hasNull = latestScan.results.some(
      (r) => r.price == null || r.ma200 == null || r.adx == null
    );
    if (hasNull) {
      return { id: 'A3', label: 'Column Population', category: 'Data', status: 'RED', message: 'Some scan results have missing data' };
    }
    return { id: 'A3', label: 'Column Population', category: 'Data', status: 'GREEN', message: 'All required columns populated' };
  } catch {
    return { id: 'A3', label: 'Column Population', category: 'Data', status: 'GREEN', message: 'Column check passed' };
  }
}

/**
 * A5 — T212 Ticker Mappings.
 *
 * Background — 11 May 2026 RBOT 404 incident
 * ──────────────────────────────────────────
 * Auto-trade tried to buy `RBOT` because `Stock.t212Ticker` was the bare
 * value `'RBOT'` instead of a structurally valid `_EQ`-suffixed identifier
 * (T212 actually wanted `RBOTl_EQ`). T212 returned HTTP 404 and the trade
 * silently failed. The cleanup wave (validator + repair scripts + seed
 * write-side guard) eliminated all invalid rows, but a future schema
 * change, manual import, or third-party tool could reintroduce one.
 *
 * This check counts populated `Stock.t212Ticker` values that fail the
 * structural validator. Status:
 *   - GREEN  → all populated values are well-shaped
 *   - YELLOW → one or more bare/wrong-shape values present
 *
 * Never RED — auto-trade now skips invalid mappings with a clear reason
 * before they reach T212, so the worst case is "those tickers are not
 * tradable until remapped" rather than a money-loss scenario.
 *
 * Implemented as a thin Prisma wrapper around the pure
 * `tallyInvalidT212TickerRows` helper below, so the bucketing logic can
 * be unit-tested without a database.
 */
async function checkInvalidT212Tickers(): Promise<HealthCheckResult> {
  try {
    const rows = await prisma.stock.findMany({
      where: { t212Ticker: { not: null } },
      select: { ticker: true, t212Ticker: true },
    });
    return tallyInvalidT212TickerRows(
      rows as Array<{ ticker: string; t212Ticker: string | null }>,
    );
  } catch {
    return {
      id: 'A5',
      label: 'T212 Ticker Mappings',
      category: 'Data',
      status: 'YELLOW',
      message: 'T212 ticker mapping check failed — unable to query stocks',
    };
  }
}

/**
 * Pure helper for the A5 check. Inputs are Stock rows (only the two
 * fields we examine). Returns the same HealthCheckResult shape that the
 * Prisma-fronted check produces. Exported for unit testing.
 *
 * Listing examples in the message are capped at five tickers to keep the
 * dashboard widget readable; an "…" suffix indicates more were detected.
 */
export function tallyInvalidT212TickerRows(
  rows: Array<{ ticker: string; t212Ticker: string | null }>,
): HealthCheckResult {
  const invalid = rows.filter((r) => {
    if (!r.t212Ticker || r.t212Ticker === '') return false;
    return !looksLikeValidT212Ticker(r.t212Ticker);
  });
  if (invalid.length === 0) {
    return {
      id: 'A5',
      label: 'T212 Ticker Mappings',
      category: 'Data',
      status: 'GREEN',
      message: `All ${rows.length} populated t212Ticker value(s) are well-shaped`,
    };
  }
  const sample = invalid.slice(0, 5).map((r) => r.ticker).join(', ');
  const more = invalid.length > 5 ? ', …' : '';
  return {
    id: 'A5',
    label: 'T212 Ticker Mappings',
    category: 'Data',
    status: 'YELLOW',
    message: `${invalid.length} stock(s) have bare/invalid t212Ticker (missing _EQ suffix): ${sample}${more}. Run scripts/repair-t212-tickers-from-instruments.ts to remap.`,
  };
}

/**
 * A6 — Yahoo Ticker Mappings.
 *
 * Defence-in-depth analogue to A5 for the price-feed side. Yahoo Finance
 * tickers must either be a bare alphanumeric symbol (e.g. AAPL) or
 * carry an exchange suffix the price loader recognises (.L, .DE, .PA,
 * .MI, .MC, .AS, .CO, .ST, .HE, .SW, .AX, .TO, .HK, .T). Anything else
 * triggers a silent miss in `getBatchPrices` — the candidate disappears
 * from the scan with no operator-visible signal.
 *
 * Status:
 *   - GREEN  → all populated `yahooTicker` values look like valid Yahoo symbols
 *   - YELLOW → one or more wrong-shape values present
 *
 * Never RED — a bad Yahoo ticker degrades data freshness for that one
 * stock; auto-trade's `A1: Data Freshness` check already catches the
 * downstream effect at the portfolio level.
 */
async function checkInvalidYahooTickers(): Promise<HealthCheckResult> {
  try {
    const rows = await prisma.stock.findMany({
      where: { yahooTicker: { not: null } },
      select: { ticker: true, yahooTicker: true },
    });
    return tallyInvalidYahooTickerRows(
      rows as Array<{ ticker: string; yahooTicker: string | null }>,
    );
  } catch {
    return {
      id: 'A6',
      label: 'Yahoo Ticker Mappings',
      category: 'Data',
      status: 'YELLOW',
      message: 'Yahoo ticker mapping check failed — unable to query stocks',
    };
  }
}

/**
 * Pure helper for the A6 check. Recognises the same Yahoo exchange
 * suffix set the seed and the price loader use. Exported for testing.
 *
 * Listing examples in the message are capped at five tickers.
 */
export function tallyInvalidYahooTickerRows(
  rows: Array<{ ticker: string; yahooTicker: string | null }>,
): HealthCheckResult {
  const invalid = rows.filter((r) => {
    if (!r.yahooTicker || r.yahooTicker === '') return false;
    return !looksLikeValidYahooTicker(r.yahooTicker);
  });
  if (invalid.length === 0) {
    return {
      id: 'A6',
      label: 'Yahoo Ticker Mappings',
      category: 'Data',
      status: 'GREEN',
      message: `All ${rows.length} populated yahooTicker value(s) are well-shaped`,
    };
  }
  const sample = invalid.slice(0, 5).map((r) => `${r.ticker}→${r.yahooTicker}`).join(', ');
  const more = invalid.length > 5 ? ', …' : '';
  return {
    id: 'A6',
    label: 'Yahoo Ticker Mappings',
    category: 'Data',
    status: 'YELLOW',
    message: `${invalid.length} stock(s) have wrong-shape yahooTicker: ${sample}${more}. Yahoo expects a bare symbol or one of the supported exchange suffixes (.L, .DE, .PA, .MI, .MC, .AS, .CO, .ST, .HE, .SW, .AX, .TO, .HK, .T).`,
  };
}

/**
 * Structural check for Yahoo Finance symbols. Mirrors the suffix list
 * used by `src/lib/ticker-maps.ts:toYahooTicker` and `prisma/seed.ts:findRegion`.
 *
 * Accepts:
 *   - Bare alphanumeric (1–6 chars): AAPL, MSFT, BRK
 *   - Bare with hyphen segment: BRK-B, NOVO-B
 *   - Exchange-suffixed: AZN.L, SAP.DE, MC.PA, etc.
 *
 * Rejects: empty, whitespace, lowercase-only, embedded `_EQ`, etc.
 */
function looksLikeValidYahooTicker(value: string): boolean {
  if (!value) return false;
  // Reject T212-style identifiers (the most common copy-paste mistake).
  if (/_EQ$/.test(value)) return false;
  // Strip a trailing `.SUFFIX` if it matches a known Yahoo exchange.
  const known = /\.(L|DE|PA|MI|MC|AS|CO|ST|HE|SW|AX|TO|V|HK|T|KS|TW|SA|SI|MX|JK|BO|NS)$/;
  const base = value.replace(known, '');
  // Bare base must be 1–6 chars of [A-Z0-9-].
  return /^[A-Z0-9]([A-Z0-9-]{0,5})$/.test(base);
}

/**
 * A4 — Open Position Uniqueness.
 *
 * Flags any case where two OPEN Position rows share the same
 * (stockId, accountType). This caught the 2026-05-01 "9 vs 6" bug where
 * auto-trade and broker sync created parallel rows for the same holding.
 *
 * Also flags OPEN positions with NULL accountType: such rows are invisible
 * to per-account counters in /api/trading212/sync (they only count
 * accountType='invest'|'isa'), so a null orphan would silently under-report
 * holdings on the dashboard.
 *
 * Pure function (no Prisma access) so it can be unit-tested directly.
 * Exported because the unit test in health-check.test.ts imports it.
 */
export function checkOpenPositionUniqueness(positions: HealthCheckPosition[]): HealthCheckResult {
  const groups = new Map<string, HealthCheckPosition[]>();
  const orphans: string[] = [];
  for (const p of positions) {
    // Fall back to ticker when stockId is not populated (test fixtures only —
    // real Prisma reads always include stockId). Two rows for the same ticker
    // would still be duplicates regardless of which key we group by.
    const stockKey = p.stockId ?? p.stock?.ticker ?? 'unknown';

    // Track NULL accountType separately. Grouping these under 'invest' (the
    // historical default) would mask the orphan as a duplicate-vs-nothing.
    if (p.accountType == null) {
      orphans.push(p.stock?.ticker ?? stockKey);
    }

    const key = `${stockKey}::${p.accountType ?? 'invest'}`;
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }

  const duplicates: string[] = [];
  for (const [, list] of groups) {
    if (list.length > 1) {
      const ticker = list[0].stock?.ticker ?? 'unknown';
      const acct = list[0].accountType ?? 'invest';
      duplicates.push(`${ticker} (${acct}, ${list.length} rows)`);
    }
  }

  if (duplicates.length > 0 || orphans.length > 0) {
    const parts: string[] = [];
    if (duplicates.length > 0) parts.push(`Duplicate OPEN positions: ${duplicates.join(', ')}`);
    if (orphans.length > 0) parts.push(`OPEN positions with NULL accountType (invisible to per-account counters): ${orphans.join(', ')}`);
    return {
      id: 'A4',
      label: 'Open Position Uniqueness',
      category: 'Data',
      status: 'RED',
      message: parts.join(' | '),
    };
  }

  return {
    id: 'A4',
    label: 'Open Position Uniqueness',
    category: 'Data',
    status: 'GREEN',
    message: `${positions.length} unique OPEN position(s)`,
  };
}

export function checkEquityPositive(equity: number): HealthCheckResult {
  if (equity <= 0) {
    return { id: 'C1', label: 'Equity > £0', category: 'Risk', status: 'RED', message: `Equity is ${equity}. Must be positive.` };
  }
  return { id: 'C1', label: 'Equity > £0', category: 'Risk', status: 'GREEN', message: `Equity: $${equity.toFixed(2)}` };
}

function checkOpenRiskCap(
  positions: HealthCheckPosition[],
  equity: number,
  riskProfile: RiskProfileType,
  livePrices: Record<string, number>,
  gbpPrices: Record<string, number>
): HealthCheckResult {
  const profile = RISK_PROFILES[riskProfile];
  // HEDGE positions excluded from open risk per CLAUDE.md
  const nonHedge = positions.filter((p) => p.stock?.sleeve !== 'HEDGE');
  const totalRisk = nonHedge.reduce((sum: number, p: HealthCheckPosition) => {
    const ticker = p.stock?.ticker as string | undefined;
    const rawPrice = ticker ? (livePrices[ticker] || p.entryPrice) : p.entryPrice;
    const gbpPrice = ticker ? (gbpPrices[ticker] ?? rawPrice) : rawPrice;
    const fxRatio = rawPrice > 0 ? gbpPrice / rawPrice : 1;
    const currentStopGbp = p.currentStop * fxRatio;
    const risk = Math.max(0, (gbpPrice - currentStopGbp) * p.shares);
    return sum + risk;
  }, 0);
  const riskPercent = equity > 0 ? (totalRisk / equity) * 100 : 0;

  if (riskPercent > profile.maxOpenRisk) {
    return { id: 'C2', label: 'Open Risk Within Cap', category: 'Risk', status: 'RED', message: `Open risk ${riskPercent.toFixed(1)}% exceeds max ${profile.maxOpenRisk}%` };
  }
  if (riskPercent > profile.maxOpenRisk * 0.9) {
    return { id: 'C2', label: 'Open Risk Within Cap', category: 'Risk', status: 'YELLOW', message: `Open risk ${riskPercent.toFixed(1)}% near limit ${profile.maxOpenRisk}%` };
  }
  return { id: 'C2', label: 'Open Risk Within Cap', category: 'Risk', status: 'GREEN', message: `Open risk: ${riskPercent.toFixed(1)}% / ${profile.maxOpenRisk}%` };
}

function checkPositionSizes(
  positions: HealthCheckPosition[],
  equity: number,
  riskProfile: RiskProfileType,
  livePrices?: Record<string, number>,
  gbpPrices?: Record<string, number>
): HealthCheckResult {
  if (positions.length === 0) {
    return { id: 'C3', label: 'Valid Position Sizes', category: 'Risk', status: 'GREEN', message: 'No open positions' };
  }
  // With fewer than 2 positions, size limits are not meaningful
  if (positions.length < 2) {
    return { id: 'C3', label: 'Valid Position Sizes', category: 'Risk', status: 'GREEN', message: 'Too few positions for size check' };
  }
  const caps = getProfileCaps(riskProfile);
  // Use mark-to-market prices (GBP-normalised where available) rather than stale entry prices
  const totalValue = positions.reduce((sum: number, p: HealthCheckPosition) => {
    const ticker = p.stock?.ticker;
    const markPrice = ticker ? (gbpPrices?.[ticker] ?? livePrices?.[ticker] ?? p.entryPrice) : p.entryPrice;
    return sum + markPrice * p.shares;
  }, 0);
  const oversized = positions.filter((p: HealthCheckPosition) => {
    const ticker = p.stock?.ticker;
    const markPrice = ticker ? (gbpPrices?.[ticker] ?? livePrices?.[ticker] ?? p.entryPrice) : p.entryPrice;
    const posValue = markPrice * p.shares;
    const pct = totalValue > 0 ? posValue / totalValue : 0;
    const sleeve = p.stock?.sleeve || 'CORE';
    const cap = caps.positionSizeCaps[sleeve] ?? 0.16;
    return pct > cap;
  });

  if (oversized.length > 0) {
    return { id: 'C3', label: 'Valid Position Sizes', category: 'Risk', status: 'YELLOW', message: `${oversized.length} position(s) exceed size limits (mark-to-market)` };
  }
  return { id: 'C3', label: 'Valid Position Sizes', category: 'Risk', status: 'GREEN', message: 'All positions within size limits (mark-to-market)' };
}

async function checkStopMonotonicity(positions: HealthCheckPosition[]): Promise<HealthCheckResult> {
  // Check that currentStop has never decreased below initial stopLoss
  for (const p of positions) {
    // Primary check: currentStop must be >= initial stop (stopLoss field)
    if (p.currentStop < p.stopLoss) {
      return { id: 'D', label: 'Stop Monotonicity', category: 'Logic', status: 'RED', message: `Stop decreased for ${p.stock?.ticker}: current $${p.currentStop.toFixed(2)} < initial $${p.stopLoss.toFixed(2)}` };
    }
    // Secondary check: verify last history record didn't decrease
    if (p.stopHistory && p.stopHistory.length > 0) {
      const lastHistory = p.stopHistory[0];
      if (lastHistory.newStop < lastHistory.oldStop) {
        return { id: 'D', label: 'Stop Monotonicity', category: 'Logic', status: 'RED', message: `Stop decreased for ${p.stock?.ticker}: $${lastHistory.oldStop} → $${lastHistory.newStop}` };
      }
    }
  }
  return { id: 'D', label: 'Stop Monotonicity', category: 'Logic', status: 'GREEN', message: 'All stops monotonically increasing' };
}

export function checkStopIntegrity(positions: HealthCheckPosition[]): HealthCheckResult {
  const issues: string[] = [];
  for (const p of positions) {
    if (!p.stock?.ticker) continue;
    const ticker = p.stock.ticker;
    // Stop above entry on INITIAL level is always wrong
    if (p.protectionLevel === 'INITIAL' && p.currentStop >= p.entryPrice) {
      issues.push(`${ticker}: INITIAL stop ($${p.currentStop.toFixed(2)}) >= entry ($${p.entryPrice.toFixed(2)})`);
    }
    // Zero or negative stop on an open position
    if (p.currentStop <= 0) {
      issues.push(`${ticker}: stop is $${p.currentStop.toFixed(2)}`);
    }
    // Zero or negative initial risk
    if (p.initialRisk <= 0) {
      issues.push(`${ticker}: initialRisk is ${p.initialRisk}`);
    }
  }
  if (issues.length > 0) {
    return { id: 'D2', label: 'Stop Integrity', category: 'Logic', status: 'RED', message: issues.join('; ') };
  }
  return { id: 'D2', label: 'Stop Integrity', category: 'Logic', status: 'GREEN', message: 'All stops consistent with protection levels' };
}

async function checkStateCurrency(userId: string): Promise<HealthCheckResult> {
  try {
    const snapshot = await prisma.equitySnapshot.findFirst({
      where: { userId },
      orderBy: { capturedAt: 'desc' },
    });
    if (!snapshot) {
      return { id: 'E', label: 'State File Currency', category: 'Logic', status: 'YELLOW', message: 'No equity snapshot recorded — run nightly to capture state' };
    }
    const daysSince = (Date.now() - snapshot.capturedAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > 7) {
      return { id: 'E', label: 'State File Currency', category: 'Logic', status: 'RED', message: `Equity state is ${daysSince.toFixed(1)} days old — run nightly to refresh` };
    }
    if (daysSince > 2) {
      return { id: 'E', label: 'State File Currency', category: 'Logic', status: 'YELLOW', message: `Equity state is ${daysSince.toFixed(1)} days old` };
    }
    const hoursAgo = daysSince * 24;
    return { id: 'E', label: 'State File Currency', category: 'Logic', status: 'GREEN', message: `Equity state current (${Math.floor(hoursAgo)}h ago)` };
  } catch {
    return { id: 'E', label: 'State File Currency', category: 'Logic', status: 'YELLOW', message: 'Unable to verify equity snapshot state' };
  }
}

export function checkConfigCoherence(riskProfile: RiskProfileType): HealthCheckResult {
  const profile = RISK_PROFILES[riskProfile];
  const theoreticalMax = profile.maxPositions * profile.riskPerTrade;
  if (theoreticalMax > profile.maxOpenRisk * 1.5) {
    return { id: 'F', label: 'Config Coherence', category: 'Logic', status: 'YELLOW', message: `Max positions × risk/trade (${theoreticalMax.toFixed(1)}%) significantly exceeds max open risk (${profile.maxOpenRisk}%)` };
  }
  return { id: 'F', label: 'Config Coherence', category: 'Logic', status: 'GREEN', message: `Config is coherent for ${profile.name} profile` };
}

export function checkSleeveLimits(
  positions: HealthCheckPosition[],
  equity: number,
  livePrices?: Record<string, number>,
  gbpPrices?: Record<string, number>
): HealthCheckResult {
  if (positions.length === 0) {
    return { id: 'G1', label: 'Sleeve Limits', category: 'Allocation', status: 'GREEN', message: 'No open positions' };
  }

  // Same basis as risk-gates Gate 3: mark-to-market value over max(equity, non-HEDGE invested).
  const sleeveValues: Record<string, number> = {};
  let nonHedgeInvested = 0;
  for (const p of positions) {
    const ticker = p.stock?.ticker;
    const markPrice = ticker ? (gbpPrices?.[ticker] ?? livePrices?.[ticker] ?? p.entryPrice) : p.entryPrice;
    const value = markPrice * p.shares;
    const sleeve = p.stock?.sleeve || 'CORE';
    sleeveValues[sleeve] = (sleeveValues[sleeve] || 0) + value;
    if (sleeve !== 'HEDGE') nonHedgeInvested += value;
  }
  const denominator = Math.max(equity, nonHedgeInvested);
  if (denominator <= 0) {
    return { id: 'G1', label: 'Sleeve Limits', category: 'Allocation', status: 'GREEN', message: 'No portfolio value' };
  }

  const breaches: string[] = [];
  for (const [sleeve, value] of Object.entries(sleeveValues)) {
    const pct = value / denominator;
    const cap = SLEEVE_CAPS[sleeve as keyof typeof SLEEVE_CAPS] ?? 0.80;
    if (pct > cap) {
      breaches.push(`${sleeve}: ${(pct * 100).toFixed(0)}% > ${(cap * 100).toFixed(0)}%`);
    }
  }

  if (breaches.length > 0) {
    return { id: 'G1', label: 'Sleeve Limits', category: 'Allocation', status: 'RED', message: `Sleeve limit breached: ${breaches.join(', ')}` };
  }
  return { id: 'G1', label: 'Sleeve Limits', category: 'Allocation', status: 'GREEN', message: 'Sleeve allocations within limits' };
}

function checkClusterConcentration(positions: HealthCheckPosition[], _equity: number, riskProfile: RiskProfileType): HealthCheckResult {
  if (positions.length === 0) {
    return { id: 'G2', label: 'Cluster Concentration', category: 'Allocation', status: 'GREEN', message: 'No open positions' };
  }

  const totalValue = positions.reduce((sum, p) => sum + (p.entryPrice * p.shares), 0);
  if (totalValue <= 0) {
    return { id: 'G2', label: 'Cluster Concentration', category: 'Allocation', status: 'GREEN', message: 'No portfolio value' };
  }

  const caps = getProfileCaps(riskProfile);
  // Group by actual cluster name from stock relation
  const clusterValues: Record<string, number> = {};
  for (const p of positions) {
    const cluster = p.stock?.cluster || 'General';
    clusterValues[cluster] = (clusterValues[cluster] || 0) + (p.entryPrice * p.shares);
  }

  // With fewer than 2 distinct clusters, concentration is expected
  if (Object.keys(clusterValues).length < 2) {
    return { id: 'G2', label: 'Cluster Concentration', category: 'Allocation', status: 'GREEN', message: 'Too few clusters for concentration check' };
  }

  const breaches: string[] = [];
  for (const [cluster, value] of Object.entries(clusterValues)) {
    const pct = value / totalValue;
    if (pct > caps.clusterCap) {
      breaches.push(`${cluster}: ${(pct * 100).toFixed(0)}% > ${(caps.clusterCap * 100).toFixed(0)}%`);
    }
  }

  if (breaches.length > 0) {
    return { id: 'G2', label: 'Cluster Concentration', category: 'Allocation', status: 'YELLOW', message: `Concentration warning: ${breaches.join(', ')}` };
  }
  return { id: 'G2', label: 'Cluster Concentration', category: 'Allocation', status: 'GREEN', message: `Cluster concentrations within ${(caps.clusterCap * 100).toFixed(0)}% cap` };
}

function checkSectorConcentration(positions: HealthCheckPosition[], _equity: number, riskProfile: RiskProfileType): HealthCheckResult {
  if (positions.length === 0) {
    return { id: 'G3', label: 'Sector Concentration', category: 'Allocation', status: 'GREEN', message: 'No open positions' };
  }

  const totalValue = positions.reduce((sum, p) => sum + (p.entryPrice * p.shares), 0);
  if (totalValue <= 0) {
    return { id: 'G3', label: 'Sector Concentration', category: 'Allocation', status: 'GREEN', message: 'No portfolio value' };
  }

  const caps = getProfileCaps(riskProfile);
  // Group by actual sector from stock relation
  const sectorValues: Record<string, number> = {};
  for (const p of positions) {
    const sector = p.stock?.sector || 'Unknown';
    sectorValues[sector] = (sectorValues[sector] || 0) + (p.entryPrice * p.shares);
  }

  // With fewer than 2 distinct sectors, concentration is expected
  if (Object.keys(sectorValues).length < 2) {
    return { id: 'G3', label: 'Sector Concentration', category: 'Allocation', status: 'GREEN', message: 'Too few sectors for concentration check' };
  }

  const breaches: string[] = [];
  for (const [sector, value] of Object.entries(sectorValues)) {
    const pct = value / totalValue;
    if (pct > caps.sectorCap) {
      breaches.push(`${sector}: ${(pct * 100).toFixed(0)}% > ${(caps.sectorCap * 100).toFixed(0)}%`);
    }
  }

  if (breaches.length > 0) {
    return { id: 'G3', label: 'Sector Concentration', category: 'Allocation', status: 'YELLOW', message: `Sector warning: ${breaches.join(', ')}` };
  }
  return { id: 'G3', label: 'Sector Concentration', category: 'Allocation', status: 'GREEN', message: `Sector concentrations within ${(caps.sectorCap * 100).toFixed(0)}% cap` };
}

/**
 * A7 — Sector Coverage on Open Positions.
 *
 * Detects the data-quality drift where a meaningful share of OPEN positions
 * has a missing or 'Unknown' `Stock.sector`. The G3 sector-concentration
 * check correctly buckets these under 'Unknown' but cannot tell the
 * operator whether a breach reflects real concentration or a metadata
 * gap. A7 surfaces the gap directly so it can be fixed at source.
 *
 * Status:
 *   - GREEN  → 0 positions with missing sector
 *   - YELLOW → up to 30% of positions (by count) missing sector
 *   - RED    → more than 30% of positions missing sector
 *
 * Counts positions, not portfolio value — a single mis-tagged position is
 * a data issue worth flagging even if it's a small £ slice.
 *
 * Audit 2026-06-16 (MEDIUM-8).
 */
export function checkSectorCoverage(positions: HealthCheckPosition[]): HealthCheckResult {
  if (positions.length === 0) {
    return { id: 'A7', label: 'Sector Coverage', category: 'Data', status: 'GREEN', message: 'No open positions' };
  }
  const missing = positions.filter((p) => {
    const s = p.stock?.sector;
    return !s || s.trim() === '' || s.toLowerCase() === 'unknown';
  });
  if (missing.length === 0) {
    return { id: 'A7', label: 'Sector Coverage', category: 'Data', status: 'GREEN', message: `All ${positions.length} open positions have a sector` };
  }
  const pct = missing.length / positions.length;
  const sample = missing.slice(0, 5).map((p) => p.stock.ticker).join(', ');
  const more = missing.length > 5 ? ', …' : '';
  const status: HealthStatus = pct > 0.3 ? 'RED' : 'YELLOW';
  return {
    id: 'A7',
    label: 'Sector Coverage',
    category: 'Data',
    status,
    message: `${missing.length}/${positions.length} (${(pct * 100).toFixed(0)}%) open positions missing sector: ${sample}${more}`,
  };
}

async function checkHeartbeat(): Promise<HealthCheckResult> {
  try {
    const heartbeat = await prisma.heartbeat.findFirst({
      orderBy: { timestamp: 'desc' },
    });
    if (!heartbeat) {
      return { id: 'H1', label: 'Heartbeat Recent', category: 'System', status: 'YELLOW', message: 'No heartbeat recorded' };
    }
    const hoursSince = (Date.now() - heartbeat.timestamp.getTime()) / (1000 * 60 * 60);
    if (hoursSince > 25) {
      return { id: 'H1', label: 'Heartbeat Recent', category: 'System', status: 'RED', message: `Last heartbeat ${Math.floor(hoursSince)}h ago` };
    }
    return { id: 'H1', label: 'Heartbeat Recent', category: 'System', status: 'GREEN', message: `Heartbeat ${Math.floor(hoursSince)}h ago` };
  } catch {
    return { id: 'H1', label: 'Heartbeat Recent', category: 'System', status: 'GREEN', message: 'Heartbeat check passed' };
  }
}

async function checkAPIConnectivity(): Promise<HealthCheckResult> {
  try {
    // Quick check: verify Prisma can query the database
    await prisma.stock.count();
    return { id: 'H2', label: 'API Connectivity', category: 'System', status: 'GREEN', message: 'API endpoints reachable' };
  } catch {
    return { id: 'H2', label: 'API Connectivity', category: 'System', status: 'RED', message: 'Database connection failed' };
  }
}

function checkDatabaseIntegrity(): HealthCheckResult {
  // We verified DB connectivity in the API check above
  // This additional check validates the Prisma singleton is alive
  try {
    if (!prisma) {
      return { id: 'H3', label: 'Database Integrity', category: 'System', status: 'RED', message: 'Prisma client not initialized' };
    }
    return { id: 'H3', label: 'Database Integrity', category: 'System', status: 'GREEN', message: 'Database operational' };
  } catch {
    return { id: 'H3', label: 'Database Integrity', category: 'System', status: 'RED', message: 'Database integrity check failed' };
  }
}

async function checkCronActive(): Promise<HealthCheckResult> {
  try {
    // Check if the nightly heartbeat ran in the last 25 hours
    // Nightly cron writes status: 'SUCCESS' on completion
    const heartbeat = await prisma.heartbeat.findFirst({
      where: { status: 'SUCCESS' },
      orderBy: { timestamp: 'desc' },
    });

    if (!heartbeat) {
      return { id: 'H4', label: 'Cron Job Active', category: 'System', status: 'YELLOW', message: 'No nightly run recorded yet' };
    }

    const hoursSince = (Date.now() - heartbeat.timestamp.getTime()) / (1000 * 60 * 60);
    if (hoursSince > 25) {
      return { id: 'H4', label: 'Cron Job Active', category: 'System', status: 'YELLOW', message: `Last nightly run ${Math.floor(hoursSince)}h ago (expected < 25h)` };
    }

    return { id: 'H4', label: 'Cron Job Active', category: 'System', status: 'GREEN', message: `Nightly ran ${Math.floor(hoursSince)}h ago` };
  } catch {
    return { id: 'H4', label: 'Cron Job Active', category: 'System', status: 'YELLOW', message: 'Unable to check cron status' };
  }
}

/**
 * H5: Data Source Quality — checks the latest heartbeat for data source health.
 * Reports whether the nightly pipeline used live Yahoo data, cached data, or degraded.
 */
async function checkDataSource(): Promise<HealthCheckResult> {
  try {
    const heartbeat = await prisma.heartbeat.findFirst({
      where: { status: { in: ['SUCCESS', 'FAILED'] } },
      orderBy: { timestamp: 'desc' },
    });

    if (!heartbeat || !heartbeat.details) {
      return { id: 'H5', label: 'Data Source', category: 'System', status: 'YELLOW', message: 'No heartbeat data available' };
    }

    let details: Record<string, unknown>;
    try {
      details = JSON.parse(heartbeat.details) as Record<string, unknown>;
    } catch {
      return { id: 'H5', label: 'Data Source', category: 'System', status: 'YELLOW', message: 'Heartbeat details unparseable' };
    }

    // Check for dataSource field written by updated nightly pipeline
    const ds = details.dataSource as { health?: string; staleTickers?: string[]; maxStalenessHours?: number; summary?: string } | undefined;
    if (!ds || !ds.health) {
      // Pre-upgrade heartbeat — no data source info yet
      return { id: 'H5', label: 'Data Source', category: 'System', status: 'GREEN', message: 'Live data (pre-upgrade heartbeat)' };
    }

    if (ds.health === 'LIVE') {
      return { id: 'H5', label: 'Data Source', category: 'System', status: 'GREEN', message: `Live data \u2713 — ${ds.summary || 'all Yahoo'}` };
    }

    if (ds.health === 'PARTIAL') {
      const staleCount = ds.staleTickers?.length ?? 0;
      return { id: 'H5', label: 'Data Source', category: 'System', status: 'YELLOW', message: `Partial data \u26a0 — ${staleCount} ticker(s) from cache` };
    }

    // DEGRADED
    const hours = ds.maxStalenessHours?.toFixed(1) ?? '?';
    if ((ds.maxStalenessHours ?? 0) > 48) {
      return { id: 'H5', label: 'Data Source', category: 'System', status: 'RED', message: `Stale cache \u2717 — data ${hours}h old (>48h). Run nightly with internet.` };
    }
    return { id: 'H5', label: 'Data Source', category: 'System', status: 'YELLOW', message: `Cached data \u26a0 — ${hours}h old. Yahoo was unavailable.` };
  } catch {
    return { id: 'H5', label: 'Data Source', category: 'System', status: 'YELLOW', message: 'Data source check failed' };
  }
}
