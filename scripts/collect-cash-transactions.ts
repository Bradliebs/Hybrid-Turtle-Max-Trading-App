// Read-only collector for Trading 212 cash movements (deposits and withdrawals).
//
// Why: equity snapshots fall when money is withdrawn, so drawdown alerts measured
// on raw equity treat withdrawals as trading losses. This records the real cash
// movements so drawdown can be measured on trading performance alone
// (src/lib/capital-adjusted-drawdown.ts).
//
// Safety: only GET /equity/account/summary and GET /equity/history/transactions
// on the configured live ISA account, with a request budget and an account
// identity check. No orders, no other endpoints.
//
// Usage:
//   npx tsx scripts/collect-cash-transactions.ts --fetch prisma/dev.db prisma/backups/cash-transactions-YYYY-MM-DD.json
//   npx tsx scripts/collect-cash-transactions.ts --store prisma/dev.db prisma/backups/cash-transactions-YYYY-MM-DD.json
// --fetch writes raw evidence under prisma/backups (git-ignored). --store saves the
// deposits and withdrawals from that evidence file into AppSetting 'capital-events.v1'.
import 'dotenv/config';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { decryptField } from '../src/lib/crypto';
import { Trading212Client, Trading212Error, type T212CashTransaction } from '../src/lib/trading212';
import { CAPITAL_EVENTS_KEY, toCapitalEvents } from '../src/lib/capital-adjusted-drawdown';

const ALLOWED_PATHS = ['/api/v0/equity/account/summary', '/api/v0/equity/history/transactions'];
const MAX_PAGES = 12;
const configSchema = z.object({
  t212Environment: z.literal('live'), t212IsaConnected: z.literal(1),
  t212IsaApiKey: z.string().min(1), t212IsaApiSecret: z.string().nullable(),
  t212IsaAccountId: z.string().min(1),
});

export function makeReadOnlyCashFetch(transport: typeof fetch, requestBudget = 15) {
  let requests = 0;
  const guarded: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (url.origin !== 'https://live.trading212.com' || url.username || url.password
      || !ALLOWED_PATHS.includes(url.pathname) || method !== 'GET' || init?.body != null) {
      throw new Error('READ_ONLY_ENDPOINT_REQUIRED');
    }
    if (requests >= requestBudget) throw new Error('REQUEST_BUDGET_EXHAUSTED');
    requests++;
    return transport(input, { ...init, method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000) });
  };
  return { fetch: guarded, get requests() { return requests; } };
}

function requireBackupPath(destination: string) {
  const relative = path.relative(path.resolve('prisma/backups'), path.resolve(destination));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('OUTPUT_MUST_BE_UNDER_PRISMA_BACKUPS');
}

async function fetchEvidence(sourcePath: string, destination: string) {
  requireBackupPath(destination);
  if (existsSync(destination)) throw new Error('OUTPUT_ALREADY_EXISTS');
  const database = new Database(sourcePath, { readonly: true, fileMustExist: true });
  let config: z.infer<typeof configSchema>;
  try {
    database.pragma('query_only = ON');
    config = configSchema.parse(database.prepare(`SELECT t212Environment,t212IsaConnected,
      t212IsaApiKey,t212IsaApiSecret,t212IsaAccountId FROM User WHERE id=?`).get('default-user'));
  } finally {
    database.close();
  }
  const client = new Trading212Client(decryptField(config.t212IsaApiKey),
    decryptField(config.t212IsaApiSecret ?? ''), config.t212Environment);
  const originalFetch = globalThis.fetch;
  const guard = makeReadOnlyCashFetch(originalFetch);
  let accountMatches = false;
  let items: T212CashTransaction[] = [];
  let failure: { errorType: string; statusCode: number | null } | null = null;
  globalThis.fetch = guard.fetch;
  try {
    const summary = await client.getAccountSummary();
    accountMatches = String(summary.id) === config.t212IsaAccountId && summary.currency === 'GBP';
    if (!accountMatches) throw new Error('ACCOUNT_IDENTITY_MISMATCH');
    items = await client.getCashTransactions(50, { maxPages: MAX_PAGES });
  } catch (error) {
    failure = { errorType: error instanceof Error ? error.message : 'UnknownError',
      statusCode: error instanceof Trading212Error ? error.statusCode : null };
  } finally {
    globalThis.fetch = originalFetch;
  }
  const evidence = {
    fetchedAt: new Date().toISOString(), kind: 'READ_ONLY_CASH_TRANSACTIONS', accountType: 'isa',
    accountIdHash: createHash('sha256').update(config.t212IsaAccountId).digest('hex'),
    // Fewer items than the page budget means pagination ran out, i.e. full history.
    accountMatches, complete: failure == null && items.length < 50 * MAX_PAGES,
    requests: guard.requests, failure, items,
  };
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  const counts = items.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.type]: (acc[item.type] ?? 0) + 1 }), {});
  console.log(JSON.stringify({ accountMatches, requests: guard.requests, items: items.length, counts, failure, destination }));
  if (failure) process.exitCode = 1;
}

function storeEvents(databasePath: string, evidencePath: string) {
  requireBackupPath(evidencePath);
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  if (evidence.kind !== 'READ_ONLY_CASH_TRANSACTIONS' || !evidence.accountMatches || evidence.failure) {
    throw new Error('EVIDENCE_NOT_USABLE');
  }
  // Evidence from before the completeness flag existed (34 items) is complete by the same rule.
  const complete = evidence.complete ?? evidence.items.length < 50 * MAX_PAGES;
  if (!complete) throw new Error('HISTORY_INCOMPLETE');
  const events = toCapitalEvents(evidence.items);
  const database = new Database(databasePath, { fileMustExist: true });
  try {
    database.prepare(`INSERT INTO AppSetting (id, key, value, updatedAt) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`)
      .run(randomUUID(), CAPITAL_EVENTS_KEY,
        JSON.stringify({ source: path.basename(evidencePath), fetchedAt: evidence.fetchedAt, events }), Date.now());
  } finally {
    database.close();
  }
  const net = events.reduce((sum, event) => sum + event.amount, 0);
  console.log(JSON.stringify({ stored: events.length, netCashFlowGbp: Math.round(net * 100) / 100, key: CAPITAL_EVENTS_KEY }));
}

const [mode, sourcePath, filePath] = process.argv.slice(2);
if (mode === '--fetch' && sourcePath && filePath) {
  fetchEvidence(sourcePath, filePath).catch(error => {
    console.error(JSON.stringify({ blocked: true, error: error instanceof Error ? error.message : 'UnknownError' }));
    process.exitCode = 1;
  });
} else if (mode === '--store' && sourcePath && filePath) {
  storeEvents(sourcePath, filePath);
} else if (process.argv[1]?.endsWith('collect-cash-transactions.ts')) {
  console.error('Usage: --fetch <db> <prisma/backups/file.json> | --store <db> <prisma/backups/file.json>');
  process.exitCode = 1;
}
