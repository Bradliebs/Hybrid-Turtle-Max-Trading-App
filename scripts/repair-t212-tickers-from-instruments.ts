/**
 * Repair invalid `Stock.t212Ticker` rows using a fetched snapshot of
 * Trading 212's instruments universe.
 *
 * Background — 11 May 2026 incident
 * ────────────────────────────────
 * `scripts/fix-invalid-t212-tickers.ts` covered the case where an OPEN
 * position carried the correct `_EQ`-suffixed value and we could copy
 * it back to the canonical Stock row. That repaired 1 of 86 rows.
 *
 * The remaining 85 rows are bare values for stocks the user has never
 * opened a position on. To repair them we need to ask T212 directly
 * which instrument identifier matches each Stock.
 *
 * Strategy
 * ────────
 * 1. Load the cached T212 instruments snapshot. Refresh from the live
 *    API when missing/stale or when `--refresh-cache` is passed.
 *    The endpoint is rate-limited 1 req/50s — only call it deliberately.
 * 2. For each Stock with an invalid `t212Ticker`, look up candidate T212
 *    instruments via `stripT212Suffix(t212.ticker) === bareTicker`.
 * 3. Disambiguate by exchange when the Stock ticker carries an exchange
 *    hint (e.g. `LLOY.L` → only LSE listings; `RBOT` with `currency=GBP`
 *    → prefer LSE over US ADR).
 * 4. Print recommendations. Default mode is dry-run; `--apply` writes.
 *
 * Usage
 * ─────
 *   npx tsx scripts/repair-t212-tickers-from-instruments.ts
 *   npx tsx scripts/repair-t212-tickers-from-instruments.ts --refresh-cache
 *   npx tsx scripts/repair-t212-tickers-from-instruments.ts --apply
 *   npx tsx scripts/repair-t212-tickers-from-instruments.ts --include-unknown
 *
 * `--include-unknown` also repairs well-formed tickers that are absent from
 * the snapshot (e.g. RTX_US_EQ where T212 still lists UTX_US_EQ). In every
 * mode a stock priced from a US listing may only map to a `_US_EQ`
 * instrument and a non-US one never does, matching the buy-time
 * listing guard (src/lib/listing-identity.ts).
 *
 * Environment
 * ───────────
 *   SANITY_USER_ID    — user whose T212 credentials are used to fetch
 *                       (defaults to `default-user`)
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Trading212Client, type T212Instrument } from '../src/lib/trading212';
import { decryptField } from '../src/lib/crypto';
import {
  isInvalidT212TickerFormat,
  looksLikeValidT212Ticker,
  stripT212Suffix,
} from '../src/lib/t212-ticker-validator';
import {
  DEFAULT_CACHE_PATH,
  indexInstruments,
  loadT212InstrumentsCache,
  writeT212InstrumentsCache,
  type T212InstrumentsLookup,
} from '../src/lib/t212-instruments-cache';
import { isUsBrokerListing, isUsPriceListing } from '../src/lib/listing-identity';
import { toYahooTicker } from '../src/lib/ticker-maps';

const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const REFRESH = process.argv.includes('--refresh-cache');
const INCLUDE_UNKNOWN = process.argv.includes('--include-unknown');
const USER_ID = process.env.SANITY_USER_ID || 'default-user';

interface InvalidRow {
  id: string;
  ticker: string;
  t212Ticker: string;
  currency: string | null;
  region: string | null;
}

interface Recommendation {
  row: InvalidRow;
  /** Replacement t212Ticker value, or null when no match found / ambiguous. */
  replacement: string | null;
  reason: string;
}

// ── Currency disambiguation ─────────────────────────────────────────
//
// T212's `/equity/metadata/instruments` does NOT actually return an
// `exchange` field (the documented field is missing in practice).
// Instead each instrument has `currencyCode` (the listing currency) and
// `shortName` (the canonical bare ticker — same across listings of the
// same instrument).
//
// We disambiguate listings by matching `currencyCode` to a currency
// inferred from the Stock row. Conservative: only commit when the match
// is unambiguous; flag otherwise.

/** Currency codes the instrument's listing currencyCode could be reported as
 *  for a Stock with a given declared currency or exchange suffix. */
function expectedCurrencyCodes(row: InvalidRow): Set<string> | null {
  // Suffix-based hints win because they are the strongest declaration.
  if (row.ticker.endsWith('.L')) return new Set(['GBX', 'GBP', 'GBp']);
  if (row.ticker.endsWith('.DE')) return new Set(['EUR']);
  if (row.ticker.endsWith('.PA')) return new Set(['EUR']);
  if (row.ticker.endsWith('.MI')) return new Set(['EUR']);
  if (row.ticker.endsWith('.MC')) return new Set(['EUR']);
  if (row.ticker.endsWith('.AS')) return new Set(['EUR']);
  if (row.ticker.endsWith('.CO')) return new Set(['DKK']);
  if (row.ticker.endsWith('.ST')) return new Set(['SEK']);
  if (row.ticker.endsWith('.HE')) return new Set(['EUR']);
  if (row.ticker.endsWith('.SW')) return new Set(['CHF']);
  // Currency-only signals — only useful when the Stock row carries one.
  if (!row.currency) return null;
  const c = row.currency.toUpperCase();
  if (c === 'GBP' || c === 'GBX' || c === 'GBP.') return new Set(['GBX', 'GBP', 'GBp']);
  if (c === 'USD') return new Set(['USD']);
  return new Set([c]);
}

function recommendFor(
  row: InvalidRow,
  lookup: T212InstrumentsLookup,
): Recommendation {
  // shortName is the strongest match key — T212 sets it to the canonical
  // bare ticker on every listing of a given instrument. The Stock row's
  // ticker may carry a Yahoo-style exchange suffix (e.g. `LLOY.L`) that
  // T212 does not include in shortName, so we strip a known set of
  // suffixes before lookup.
  const STRIPPABLE_SUFFIXES = ['.L', '.DE', '.PA', '.MI', '.MC', '.AS', '.CO', '.ST', '.HE', '.SW'];
  const stripped = STRIPPABLE_SUFFIXES.reduce(
    (t, s) => (t.endsWith(s) ? t.slice(0, -s.length) : t),
    row.ticker,
  );
  const lookupKeys = [row.ticker, stripped].map((k) => k.toUpperCase());
  const priceUs = isUsPriceListing(toYahooTicker(row.ticker));

  const fromShortName: T212Instrument[] = [];
  for (const key of lookupKeys) {
    fromShortName.push(...(lookup.byShortName.get(key) ?? []));
  }
  // Bare-stripped fallback for the rare instrument missing shortName.
  const fromBare = [
    ...(lookup.byBareTicker.get(row.ticker) ?? []),
    ...(lookup.byBareTicker.get(stripped) ?? []),
  ];
  // Combine and de-duplicate by full ticker.
  const seen = new Set<string>();
  const candidates: T212Instrument[] = [];
  for (const list of [fromShortName, fromBare]) {
    for (const inst of list) {
      if (seen.has(inst.ticker)) continue;
      seen.add(inst.ticker);
      // Same market as the price listing, or auto-trade would refuse it anyway.
      if (isUsBrokerListing(inst.ticker) !== priceUs) continue;
      candidates.push(inst);
    }
  }

  if (candidates.length === 0) {
    return {
      row,
      replacement: null,
      reason: `No T212 instrument has shortName/bare ticker '${row.ticker}'`,
    };
  }

  // Currency-aware filtering. When the Stock row carries a clear currency
  // signal (exchange suffix or explicit currency), enforce it on EVERY
  // match — including the "single candidate" path. Without this, false
  // matches slip through for tickers that collide with unrelated US ADRs
  // or other-region instruments (e.g. EVO.ST is Evolution AB but T212
  // also has EVTCY_US_EQ "Evotec" with shortName='EVO'; DSV.CO is the
  // Danish logistics firm but T212 has DSV_CA_EQ "Discovery Silver"
  // with shortName='DSV'). The user can manually map these later.
  const expected = expectedCurrencyCodes(row);
  if (expected) {
    const currencyMatched = candidates.filter((c) => expected.has(c.currencyCode));
    if (currencyMatched.length === 0) {
      return {
        row,
        replacement: null,
        reason: `${candidates.length} listings of '${row.ticker}' [${candidates.map((c) => `${c.ticker}/${c.currencyCode}`).join(', ')}] but none match expected currency [${[...expected].join('/')}] — likely a different instrument with the same ticker, needs manual mapping`,
      };
    }
    if (currencyMatched.length === 1) {
      return {
        row,
        replacement: currencyMatched[0].ticker,
        reason:
          candidates.length === 1
            ? `Single T212 instrument matches '${row.ticker}' (${currencyMatched[0].currencyCode})`
            : `${candidates.length} listings of '${row.ticker}'; chose ${currencyMatched[0].ticker} (${currencyMatched[0].currencyCode}) on currency match`,
      };
    }
    return {
      row,
      replacement: null,
      reason: `${candidates.length} listings of '${row.ticker}'; ${currencyMatched.length} match expected currency [${[...expected].join('/')}] — ambiguous (${currencyMatched.map((m) => m.ticker).join(', ')})`,
    };
  }

  // No currency signal available on the Stock row — accept the single
  // match unconditionally; flag multiples as ambiguous.
  if (candidates.length === 1) {
    return {
      row,
      replacement: candidates[0].ticker,
      reason: `Single T212 instrument matches '${row.ticker}' (${candidates[0].currencyCode}) — no currency hint on Stock row`,
    };
  }

  return {
    row,
    replacement: null,
    reason: `Ambiguous: ${candidates.length} listings of '${row.ticker}' [${candidates.map((c) => `${c.ticker}/${c.currencyCode}`).join(', ')}] — manual disambiguation needed`,
  };
}

// ── Cache fetch ─────────────────────────────────────────────────────

async function fetchAndCacheInstruments(): Promise<T212InstrumentsLookup> {
  console.log('  Fetching live T212 instruments (rate-limited, may take ~50s if recently called)...');
  const user = await prisma.user.findUnique({
    where: { id: USER_ID },
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

  // The instruments endpoint returns the same universe regardless of which
  // account type the API key belongs to. Prefer Invest, fall back to ISA so
  // ISA-only users (like the live default-user) can run this script.
  let apiKey: string | null = null;
  let apiSecret: string | null = null;
  let source = '';
  if (user?.t212ApiKey && user.t212Connected) {
    apiKey = user.t212ApiKey;
    apiSecret = user.t212ApiSecret ?? '';
    source = 'invest';
  } else if (user?.t212IsaApiKey && user.t212IsaConnected) {
    apiKey = user.t212IsaApiKey;
    apiSecret = user.t212IsaApiSecret ?? '';
    source = 'isa';
  }

  if (!apiKey) {
    throw new Error(
      `User '${USER_ID}' has no connected Trading 212 account (neither Invest nor ISA) — ` +
        'cannot fetch instruments. Connect an account or set SANITY_USER_ID to a user that has one.',
    );
  }

  console.log(`  Using ${source.toUpperCase()} account credentials.`);
  const client = new Trading212Client(
    decryptField(apiKey),
    decryptField(apiSecret ?? ''),
    user!.t212Environment as 'demo' | 'live',
  );
  const instruments = await client.getInstruments();
  console.log(`  Fetched ${instruments.length} instruments.`);
  writeT212InstrumentsCache(instruments);
  console.log(`  Wrote cache to ${DEFAULT_CACHE_PATH}`);
  return indexInstruments(instruments, new Date());
}

async function getLookup(): Promise<T212InstrumentsLookup> {
  if (!REFRESH) {
    const cached = loadT212InstrumentsCache();
    if (cached) {
      console.log(
        `  Using cached instruments (${cached.count} entries, fetched ${cached.fetchedAt.toISOString()}).`,
      );
      return cached;
    }
    console.log('  No fresh cache found — fetching live.');
  } else {
    console.log('  --refresh-cache requested.');
  }
  return fetchAndCacheInstruments();
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const mode = APPLY ? 'APPLY' : 'AUDIT';
  console.log(`[repair-t212-tickers-from-instruments] mode=${mode}\n`);

  const lookup = await getLookup();

  const allWithT212 = await prisma.stock.findMany({
    where: { t212Ticker: { not: null } },
    select: {
      id: true,
      ticker: true,
      t212Ticker: true,
      currency: true,
      region: true,
    },
  });

  const invalid: InvalidRow[] = allWithT212
    .filter((s) => isInvalidT212TickerFormat(s.t212Ticker)
      || (INCLUDE_UNKNOWN && !lookup.byT212Ticker.has(s.t212Ticker as string)))
    .map((s) => ({
      id: s.id,
      ticker: s.ticker,
      t212Ticker: s.t212Ticker as string,
      currency: s.currency,
      region: s.region,
    }));

  console.log(`\nStock rows with ${INCLUDE_UNKNOWN ? 'invalid or unknown' : 'INVALID-shaped'} t212Ticker: ${invalid.length}`);
  if (invalid.length === 0) {
    console.log('Nothing to repair.');
    await prisma.$disconnect();
    return;
  }

  const recommendations = invalid.map((row) => recommendFor(row, lookup));

  console.log('\n--- Recommendations ---');
  for (const rec of recommendations) {
    if (rec.replacement) {
      console.log(`  ${rec.row.ticker.padEnd(12)} '${rec.row.t212Ticker}' → '${rec.replacement}'  [${lookup.byT212Ticker.get(rec.replacement)?.name ?? '?'}]  (${rec.reason})`);
    } else {
      console.log(`  ${rec.row.ticker.padEnd(12)} '${rec.row.t212Ticker}' → ??           (${rec.reason})`);
    }
  }

  const repairable = recommendations.filter((r) => r.replacement !== null);
  const manual = recommendations.filter((r) => r.replacement === null);

  console.log(`\nAutomatically repairable: ${repairable.length}`);
  console.log(`Needs manual mapping:     ${manual.length}`);

  if (!APPLY) {
    console.log('\nDry run — no changes written. Re-run with `--apply` to perform repairs.');
    await prisma.$disconnect();
    return;
  }

  console.log('\n--- Applying repairs ---');
  let updated = 0;
  for (const rec of repairable) {
    if (!rec.replacement) continue;
    // Belt-and-braces: don't write a value the validator would also reject.
    if (!looksLikeValidT212Ticker(rec.replacement)) {
      console.warn(`  SKIP ${rec.row.ticker}: recommended '${rec.replacement}' is not a valid _EQ form`);
      continue;
    }
    await prisma.stock.update({
      where: { id: rec.row.id },
      data: { t212Ticker: rec.replacement },
    });
    updated++;
    console.log(`  UPDATED ${rec.row.ticker} → ${rec.replacement}`);
  }

  console.log(`\nDone. ${updated} row(s) updated. ${manual.length} still need manual mapping.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[repair-t212-tickers-from-instruments] failed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
