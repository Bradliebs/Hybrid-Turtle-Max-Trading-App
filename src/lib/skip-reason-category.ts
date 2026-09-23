/**
 * DEPENDENCIES
 * Consumed by: src/cron/auto-trade.ts (sendSessionSummary)
 * Consumes: none — pure string classifier
 * Risk-sensitive: NO (display only — no trading logic)
 * Notes: Categorises auto-trade skip reasons into stable groups so the
 *        Telegram session summary can show counts + example tickers
 *        instead of one line per ticker. Prefix-matched against the
 *        actual reason strings emitted across auto-trade.ts, candidate-
 *        grade.ts, position-sizer.ts, and risk-gates.ts. UNKNOWN is the
 *        safe fallback; new reason strings render as "Other" rather than
 *        being silently dropped.
 */

export type SkipCategory =
  | 'MARKET_GATE'
  | 'LIVE_PRICE'
  | 'RISK_GATES'
  | 'SIZING'
  | 'FX_CURRENCY'
  | 'BROKER_MAPPING'
  | 'GRADE'
  | 'EARNINGS'
  | 'JEV_VETO'
  | 'SESSION_CAP'
  | 'SESSION_ABORT'
  | 'UNKNOWN';

const CATEGORY_LABEL: Record<SkipCategory, string> = {
  MARKET_GATE: 'Market gate',
  LIVE_PRICE: 'Live-price revalidation',
  RISK_GATES: 'Risk gates',
  SIZING: 'Position sizing',
  FX_CURRENCY: 'FX / currency',
  BROKER_MAPPING: 'Broker mapping',
  GRADE: 'Entry grade',
  EARNINGS: 'Earnings deferral',
  JEV_VETO: 'Jev veto',
  SESSION_CAP: 'Session cap',
  SESSION_ABORT: 'Session aborted',
  UNKNOWN: 'Other',
};

export function categorySkipLabel(category: SkipCategory): string {
  return CATEGORY_LABEL[category];
}

export function categorizeSkipReason(reason: string): SkipCategory {
  const r = (reason || '').toLowerCase();

  if (r.startsWith('jev veto:')) return 'JEV_VETO';

  if (
    r.startsWith('regime:') ||
    r.startsWith('health') ||
    r.includes('market holiday') ||
    r.includes('early-close') ||
    r.includes('kill switch') ||
    r.includes('auto-trading')
  ) return 'MARKET_GATE';

  if (
    r.includes('price fell back') ||
    r.includes('no-chase ceiling') ||
    r.includes('live price unavailable')
  ) return 'LIVE_PRICE';

  if (r.startsWith('risk gates:')) return 'RISK_GATES';

  if (
    r.startsWith('sizing failed') ||
    r.startsWith('zero shares')
  ) return 'SIZING';

  if (
    r.startsWith('fx rate') ||
    r.includes('currency not set') ||
    r.includes('refusing to assume')
  ) return 'FX_CURRENCY';

  if (
    r.includes('no t212 ticker') ||
    r.includes('no suitable t212 account')
  ) return 'BROKER_MAPPING';

  if (
    r.includes('earnings') && (r.includes('deferral') || r.includes('within'))
  ) return 'EARNINGS';

  if (r.includes('session attempt cap')) return 'SESSION_CAP';

  if (
    r.includes('insufficient-free-for-stocks-buy') ||
    r.includes('account suspended') ||
    r.includes('terminal error')
  ) return 'SESSION_ABORT';

  if (
    r.startsWith('blocked_') ||
    r.startsWith('b-grade') ||
    r.startsWith('c-grade') ||
    r.includes('anti-chase guard') ||
    r.includes('cooldown') ||
    r.includes('market regime is') ||
    r.includes('system health is red') ||
    r.includes('blocked: earnings within') ||
    r.includes('insufficient price data') ||
    r.includes('within 2% of trigger') ||
    r.includes('filter') && r.includes('failed')
  ) return 'GRADE';

  return 'UNKNOWN';
}

export interface SkipGroup {
  category: SkipCategory;
  label: string;
  count: number;
  exampleTickers: string[];
  /** Distinct reason strings in this group, capped (for diagnostic detail). */
  exampleReasons: string[];
}

/**
 * Group skip entries by category. Each group exposes its count, up to 3
 * example tickers, and up to 2 distinct reason strings. Stable category
 * ordering matches the Telegram presentation order (most operational
 * first, ambiguous last).
 */
export function groupSkipsByCategory(
  skipped: ReadonlyArray<{ ticker: string; reason: string }>,
): SkipGroup[] {
  const order: SkipCategory[] = [
    'MARKET_GATE',
    'SESSION_ABORT',
    'BROKER_MAPPING',
    'FX_CURRENCY',
    'SIZING',
    'RISK_GATES',
    'LIVE_PRICE',
    'EARNINGS',
    'JEV_VETO',
    'GRADE',
    'SESSION_CAP',
    'UNKNOWN',
  ];
  const buckets = new Map<SkipCategory, { tickers: string[]; reasons: Set<string> }>();
  for (const s of skipped) {
    const cat = categorizeSkipReason(s.reason);
    const bucket = buckets.get(cat) ?? { tickers: [], reasons: new Set<string>() };
    bucket.tickers.push(s.ticker);
    bucket.reasons.add(s.reason);
    buckets.set(cat, bucket);
  }
  const groups: SkipGroup[] = [];
  for (const cat of order) {
    const bucket = buckets.get(cat);
    if (!bucket || bucket.tickers.length === 0) continue;
    groups.push({
      category: cat,
      label: CATEGORY_LABEL[cat],
      count: bucket.tickers.length,
      exampleTickers: bucket.tickers.slice(0, 3),
      exampleReasons: Array.from(bucket.reasons).slice(0, 2),
    });
  }
  return groups;
}
