---
title: Sacred File Change Log
description: Audit history for changes to risk-sensitive trading code.
---

Per `CLAUDE.md`, edits to risk-sensitive files must be logged here for cross-session audit.

**Sacred files** (any modification requires an entry below):

- `src/lib/stop-manager.ts` (or `packages/stops/`)
- `src/lib/position-sizer.ts` (or `packages/portfolio/`)
- `src/lib/risk-gates.ts` (or `packages/risk/`)
- `src/lib/regime-detector.ts` (or `packages/data/`)
- `src/lib/dual-score.ts` (or `packages/signals/`)
- `src/lib/scan-engine.ts` (or `packages/signals/`)
- `src/cron/auto-trade.ts`
- Any file inside `packages/risk/`, `packages/stops/`, `packages/portfolio/`, `packages/signals/`

## Entry format

Each entry uses this shape (newest at top of the History section):

```
### YYYY-MM-DD — <commit short SHA> — <one-line summary>

- File(s): <relative paths>
- Why: <reason for the change>
- Behaviour preserved: <what must NOT change>
- Tests: <which tests were added/run>
- Author: <agent or person>
```

## History

### 2026-09-23 - pending - auto-trade.ts: add fail-open Jev veto gate

- File(s): `src/cron/auto-trade.ts` (new gate block, import, header line); logic in new `src/lib/jev-entry-gate.ts`
- Why: The user explicitly asked for Jev (Typesafe `jev-1.13.0`) to take part in automated buys within the existing guides, overriding the advisory-only default before a 30-signal-day track record exists.
- Behaviour preserved: Off unless `JEV_AUTO_TRADE_GATE=veto` and `TYPESAFE_REVIEW_ENABLED=true`. Jev can only remove an A-grade candidate (CONTRADICTED/MIXED evidence, or PASS probability at least 0.6, floor 0.5). It cannot add buys or change grades, ranking, sizing, stops, risk gates, live-price revalidation or the attempt cap. Any error, lock contention, budget use, cooldown or incomplete evidence allows the candidate. The gate runs before live-price revalidation so its latency cannot let a stale price reach an order.
- Tests: `jev-entry-gate.test.ts` (18 new), ordering test in `auto-trade.test.ts`, `forScan` case in `typesafe-review-source.test.ts`. Full suite 2284 passed, 2 skipped; `tsc --noEmit` and eslint clean. Real-database smoke run sent no paid request and released the lock.
- Author: Copilot CLI agent

### 2026-09-12 - pending - Capture exact entry attribution and execution evidence

- File(s): `src/cron/auto-trade.ts`; supporting scan persistence, candidate linkage, execution analytics and watchdog tests.
- Why: Persist the actual decision scan and committed entry identity, and distinguish observed fill-price sources from planned-entry fallbacks. Record reference-price request timing without presenting it as exchange timing or an executable quote.
- Behaviour preserved: Regime confirmation, weekday gating, technical filters, fresh-price anti-chase, all six risk gates, floor sizing, account routing, broker payloads, fill acceptance and recovery, stop thresholds and retries remain unchanged. Attribution/logging failures do not undo fills or prevent protection. The additional awaited evidence writes can add latency; no performance improvement is claimed.
- Tests: Automated attribution, live revalidation and stop-retry suites passed within the 283-test operational run on September 12. Exact recovery and connected SQLite evidence tests also passed; strict types and scoped lint passed. No live order was placed during verification.
- Author: GitHub Copilot, under the user's implementation and commit/push authorization. See the [work log](WORK_LOG.md) and [simulation report](../reports/trading-simulation-2026-09-12.md) for scope and remaining evidence requirements.

### 2026-08-06 - pending - Canonicalize historical OHLC and instrument currency data

- File(s):
  - `packages/data/src/normalizers.ts` and `packages/data/src/normalizers.test.ts`: Preserved daily OHLC fields during historical bar normalization and added regression coverage.
  - `packages/data/src/repository.ts` and `packages/data/src/repository.test.ts`: Persisted canonical Instrument metadata and DailyBars, including Yahoo currency instruments mapped to the Prisma FOREX type.
  - `packages/data/src/service.ts` and `packages/data/src/types.ts`: Carried OHLC and instrument currency data through the shared historical-data service contracts.
- Why: Advisory backtests require canonical OHLC bars for stop simulation and authoritative instrument currency metadata for fail-closed GBP funding. The previous close-only and snapshot-derived paths could not model these outcomes reliably.
- Behaviour preserved: Live scanning, regime detection, ranking, risk gates, position sizing, order execution, broker synchronization, and stop management are unchanged. The data changes extend persisted historical fields and metadata for read-only replay without bypassing missing-data or FX safety checks.
- Tests: Full suite passed 1,948/1,948 tests across 136 files. TypeScript typecheck, ESLint, complexity and simplification audits, scheduler audit, four-check application smoke test, focused data and backtest tests, and independent adversarial review passed.
- Author: GitHub Copilot (agent), on user instruction to complete and publish the simplification and backtest hardening batch.

### 2026-08-05 — pending — Revalidate entries and make stop updates atomic

- File(s):
  - `src/cron/auto-trade.ts`: Added forced-fresh technical revalidation before live execution using the scanner-owned MA200, ADX, DI, ATR percentage, data-quality, and session-volume filters. Candidates fail closed when fresh technical data is unavailable or no longer passes.
  - `src/lib/stop-manager.ts`: Moved stop read, monotonic comparison, update, and history creation into one transaction. The update uses compare-and-swap against the observed prior stop so a stale concurrent writer cannot lower protection.
- Why: Execution could rely on stale scan technicals, and concurrent stop writers could both pass an out-of-transaction comparison before the lower update committed. Both paths affect real-money entry and protection decisions.
- Behaviour preserved: Scanner thresholds, ranking, regime gates, position-sizing formulas, stop formulas, protection thresholds, stop-level inference, and the rule that stops never move downward are unchanged. The changes only refresh existing entry filters and enforce the existing monotonic stop invariant atomically.
- Tests: Added technical revalidation and atomic stop concurrency coverage. Full suite passed 1,906/1,906 tests across 134 files. Full ESLint, strict TypeScript, production build, Prisma migration status, schema verification, and SQLite `quick_check` passed. Live health and readiness returned GREEN and READY.
- Author: GitHub Copilot (agent), on user instruction following the whole-system audit and hardening cycle.

### 2026-07-10 — pending — Reconcile timed-out broker buys before returning

- File(s):
  - `src/cron/auto-trade.ts`: Replaced the unresolved buy-timeout return with cancellation and immediate broker-position reconciliation. A fill that races with cancellation continues through the existing stop-placement and persistence path. Confirmed cancellation returns without claiming live exposure, while an unverifiable outcome remains critical.
  - `src/lib/buy-timeout-recovery.ts`: Added the isolated cancellation and position-reconciliation helper.
  - `src/lib/buy-timeout-recovery.test.ts`: Added cancellation, fill-race, cancellation-failure, and position-check-failure coverage.
  - `src/lib/position-sync.ts` and `src/lib/position-sync.test.ts`: Added account-aware broker-only holding detection and durable orphan alerts as a secondary recovery layer.
  - `auto-trade-task.bat`: Preserved the child process exit code through the logging pipeline so Task Scheduler receives failures.
- Why: A live ALV buy timed out locally, filled later at Trading 212, and remained absent from the local database without a protective stop. The prior timeout branch neither cancelled nor reconciled the broker order, and scheduled sync only compared local positions against broker holdings.
- Behaviour preserved: Candidate selection, market regime, health and risk gates, position sizing, account routing, order construction, fill polling, protective-stop calculation and retries, persistence, and maximum-trade limits are unchanged. The new branch activates only after existing fill polling times out and is fail-closed when broker state cannot be verified.
- Tests: `npm run typecheck` passed. Focused auto-trade and recovery tests passed 88/88. Position-sync tests passed 10/10. Full suite passed 1825/1825 across 126 files. The batch pipeline probe returned the child exit code 7 while retaining logged output.
- Author: GitHub Copilot (agent), on user instruction following the whole-system audit.

### 2026-06-30 — pending — Silent routing-leak guard (advisory-only) alongside ISA-eligibility tagging

- File(s):
  - `src/cron/auto-trade.ts`:
    - Added exported `NO_ACCOUNT_SKIP_REASON` constant, shared between the skip-emit site (the `if (!accountType)` branch) and the new detector so the two cannot drift apart. The emit site now references the constant instead of an inline literal (same string value).
    - Added exported pure helper `detectRoutingLeak(skipped, successCount)` near `evaluateHealthGate`. Returns `true` ONLY when `successCount === 0` AND at least one skip reason equals `NO_ACCOUNT_SKIP_REASON`. Deliberately targeted: a partial gap where some trades still flow does NOT fire.
    - In the end-of-`runAutoTrade` heartbeat block: compute `routingLeak = detectRoutingLeak(skipped, successCount)`, fold it into `heartbeatStatus` (now `PARTIAL` when `failCount > 0 || unprotectedCount > 0 || routingLeak`), add `routingLeak` to the heartbeat `details` JSON, and when `routingLeak` is true emit a throttled Telegram alert via the new `ALERT_CATEGORY.AUTO_TRADE_ROUTING_LEAK` (wrapped in try/catch — never blocks completion).
  - `src/lib/alert-categories.ts`: new `AUTO_TRADE_ROUTING_LEAK: 'auto-trade:routing-leak'` category.
  - `src/cron/auto-trade.test.ts`: +6 unit tests for `detectRoutingLeak` (fires on routing-block + 0 executed; does NOT fire on partial gap, benign-skip no-trade days, or empty skip list).
  - New scripts (non-sacred, supporting the data fix): `scripts/tag-isa-eligible-shares.ts` (dry-run default, `--apply` to commit, idempotent — tags the tradable universe `isaEligible=true`, excluding only US-listed non-UCITS ETFs), `scripts/analyze-isa-eligibility.ts` and `scripts/diagnose-buy-activity.ts` (read-only diagnostics).
- Why: The buy pipeline was a closed valve — 0 of 1363 stocks had `isaEligible=true`, so `getAccountTypeForStock` returned `null` for every candidate and every buy was skipped with "No suitable T212 account" while heartbeats still reported `OK`. This ran silently. The real fix is DATA (tag the eligible universe; applied 2026-06-30, 996 rows). This guard ensures the same silent valve-closed condition can never recur undetected: it escalates the heartbeat to `PARTIAL` and alerts.
- Behaviour preserved: The guard is ADVISORY/observability-only. It does NOT change which trades execute, gate, size, or block anything — it only reads `skipped`/`successCount` already in scope, escalates the heartbeat status string, adds one detail field, and sends one best-effort alert. Order placement, fill detection, stop placement, regime gate, attempt cap, terminal abort, account routing, sizing, FX, and all TradeLog/heartbeat writes are unchanged. The skip-emit edit is a literal→constant swap with identical value. Sacred-file siblings untouched.
- Tests: `npx vitest run src/cron/auto-trade.test.ts` — 59/59 pass (53 existing + 6 new). `get_errors` clean on `auto-trade.ts`, `auto-trade.test.ts`, `alert-categories.ts`.
- Author: GitHub Copilot (agent), on user instruction (approved option 2: add the silent-failure guard).



- File(s):
  - `src/cron/auto-trade.ts`:
    - **Top of file**: added `import * as os from 'node:os'` and `import { acquireAutoTradeLock, releaseAutoTradeLock, AutoTradeLockContentionError, type LockHolder } from '@/lib/auto-trade-lock'`.
    - **`sendSessionSummary`** (visibility, not trading logic): when more than 5 tickers are skipped, the existing flat ticker list is replaced by a category-grouped view via the new `categorizeSkipReason` helper (e.g. `Risk gates (4): AAPL +1; Live-price (2): GOOG, META`). Pure presentation change inside the Telegram summary string — the underlying `skippedTickers` array, decision logic, and order placement are untouched.
    - **Bottom-of-file IIFE only** (not the `runAutoTrade` function body): added an `invokedDirectly` gate (`import.meta.url === pathToFileURL(process.argv[1])`) so that test files importing this module no longer trigger DB writes. Inside the IIFE, wrapped the existing `runAutoTrade(session)` call in a `try/finally` that (a) calls `acquireAutoTradeLock` BEFORE any work, (b) on `AutoTradeLockContentionError` writes a WARNING `Heartbeat` row, sends a throttled Telegram via `ALERT_CATEGORY.AUTO_TRADE_BLOCKED`, and exits with code 2, (c) when a stale lock is reclaimed (helper returns `reclaimedFrom` non-null) writes a WARNING heartbeat + Telegram alerting the operator that a prior run crashed, (d) on crash releases the lock + exits with code 1, (e) on clean exit releases the lock (release failures are warn-only because the 15-minute stale recovery is the safety net).
- Why: ORACLE SYSTEM AUDIT identified two real-money risks: (1) Task Scheduler double-fire or a manual run racing with cron could allow two `auto-trade.ts` processes to size and place buy orders against the same ready candidates simultaneously, producing duplicate fills with no DB-side deduplication; (2) operator could not see WHY auto-trade was blocked on a given run — only that it was, with no per-ticker breakdown when 10+ tickers were skipped. The lock closes (1) by serializing entry across the entire process boundary, and the skip-grouping closes (2) by surfacing the specific gate (risk-gates, live-price, stop-distance, etc.) that filtered each batch.
- Behaviour preserved:
  - `runAutoTrade` function body is byte-for-byte unchanged. All gates, sizing, stop tiers, account routing, anti-chase, fresh-quote, revalidation, T212 calls, and persistence are untouched.
  - The lock is acquired in the IIFE BEFORE `runAutoTrade` is invoked. If acquisition fails, `runAutoTrade` never runs — the only effect is exit code 2 + Telegram + heartbeat. This is strictly MORE conservative than the prior behaviour (which could run twice in parallel).
  - The skip-grouping change in `sendSessionSummary` only reformats the existing string; it does not change which tickers are skipped, how many, or in what order, and it does not affect the heartbeat payload or any downstream consumer.
  - The `invokedDirectly` gate adds a falsy branch around the IIFE; when invoked as a script (the production path) the gate is true and behaviour is unchanged. When imported (test path) the IIFE no longer runs, which is the desired safety improvement (no spurious DB writes from test imports).
  - Sacred-file siblings (`stop-manager`, `position-sizer`, `risk-gates`, `regime-detector`, `dual-score`, `scan-engine`) untouched.
- Tests:
  - `npx vitest run src/lib/auto-trade-lock.test.ts` — 14/14 pass (clean acquire, fresh contention, stale reclaim with metadata, threshold boundary, custom staleMinutes, anti-stomp release, e2e acquire-fail-release-acquire).
  - `npx vitest run src/lib/skip-reason-category.test.ts` — 13/13 pass.
  - `npx vitest run src/lib/auto-trade-heartbeat-summary.test.ts` — 9/9 pass.
  - Full suite: 1805/1806 (one pre-existing fetch-retry timeout flake in `src/lib/fetch-retry.test.ts:70`, unrelated, file not modified in this commit).
  - Smoke: `tsx src/cron/auto-trade.ts <bad-session>` exits 1 cleanly (gate works).
  - Smoke: `tsx scripts/smoke-prisma-reconnect.ts` shows clean reconnect after explicit `$disconnect()`.
- Author: GitHub Copilot (agent), on user instruction ("I am relying on you to do the best thing" — judgment grant after audit + remediation cycle).

### 2026-06-16 - pending - Log LIVE_REVAL_SKIP rows for live-revalidation skips

- File(s):
  - `src/cron/auto-trade.ts`:
    - In the live-revalidation skip branch (the `if (!decision.proceed)` block immediately after `revalidateLivePrice`, just inside the existing `liveRevalidationSkipped.push(...)` + `readyCandidates.splice(i, 1)` pair), added a single `await logExecution({ ticker, phase: 'LIVE_REVAL_SKIP', requestBody: JSON.stringify({...}), accountType: 'N/A', error: decision.reason })` call.
- Why: 2026-06-16 ORACLE SYSTEM AUDIT HIGH-7. Live-revalidation skips were previously only counted in the session-summary heartbeat (no per-ticker durable evidence). Without an ExecutionLog row per skip, "why did the bot reject GE on Tuesday's UK session?" was unanswerable post-hoc — the user could see the count but not the candidates, the prices that triggered the skip, or the decision reason. This adds a row per skip with the same shape as other execution-loop diagnostic rows (LIVE_REVAL_PASS, RISK_GATE_SKIP, etc.).
- Behaviour preserved:
  - The revalidation decision logic itself (`revalidateLivePrice` and the four SKIP/KEEP branches) is byte-for-byte unchanged.
  - `logExecution` (the existing helper defined earlier in this file) has an internal `try/catch` and a `console.error` on DB failure — it never throws. So a logging failure cannot break the skip path, cannot prevent the candidate from being removed from `readyCandidates`, and cannot affect any later candidate's sizing or execution.
  - The skip is still applied (the `splice(i, 1)` is still called); only diagnostic visibility is added.
  - All sizing, gate, stop, account-routing, anti-chase, fresh-quote, and execution-path logic untouched.
  - Scan-only sessions never enter this branch.
- Tests:
  - `npm run typecheck` clean.
  - `npx vitest run` — 235/235 pass across 11 cron/lib test files (auto-trade, auto-trade-stop-retry, briefing-format, hourly-status, midday-sync, nightly-steps, watchdog-checks, watchdog-recovery, watchdog-restart-budget, health-check, audit-scheduled-tasks).
- Author: GitHub Copilot (agent), on user instruction ("do what is suggested" - executing the ORACLE SYSTEM AUDIT recommended hardening).

### 2026-06-15 - pending - F1 currency strict, F6 orphan T212 fill recovery, F7 FX warn-only

- File(s):
  - `src/cron/auto-trade.ts`:
    - F1 (currency strict, execution loop): refuses to assume USD when `stock.currency` is null/empty and the ticker is not a `.L` London symbol — the entry is skipped with a diagnostic rather than sized in the wrong currency.
    - F6 (orphan T212 fill recovery, Phase D): the catch around the persist-after-fill path now invokes a `recordOrphanT212Fill` helper that writes a durable JSONL incident to `data/incidents/orphan-fills.jsonl` (full recovery payload: order id, ticker, side, qty, fill price, currency, account, timestamp) AND raises a CRITICAL `ORPHAN_T212_FILL` Notification with `notificationDedupeKey = orphan-<buyOrderId>`. T212 fills are never rolled back — emergency-sell on DB failure is strictly worse than the orphan.
    - F7 (FX warn-only fallback, Phase D): `fxToGbp` fallback is `isFinite`-guarded and warn-only so a transient FX outage cannot orphan a live position; the execution loop's hard currency skip (F1) remains the only entry gate, so this is post-fill bookkeeping only.
  - `src/cron/midday-sync.ts`: matches the F1 currency-strict policy when reconciling broker positions.
  - `src/cron/hourly-status.ts`: surfaces unread `ORPHAN_T212_FILL` notifications in the blockers panel (30-day window, top 5) so an orphan cannot go unseen until the user next opens the dashboard.
  - `src/lib/alert-service.ts` (non-sacred): `NotificationType` union gained `ORPHAN_T212_FILL`.
- Why: 2026-05/06 ORACLE SYSTEM AUDIT findings F1 (MED — silent currency assumption), F6 (HIGH — a T212 fill landing while DB persist failed produced a live position with no DB row, no stop, and no alert), and F7 (MED — FX call failure could orphan a position via the wrong execution path). Each was verified in its own prior phase; this commit groups them so they ship together rather than lingering uncommitted.
- Behaviour preserved:
  - All sizing, gate, stop, account-routing, anti-chase, and revalidation logic is byte-for-byte unchanged.
  - F1 makes the loop MORE conservative — it adds skips, never adds entries.
  - F6 changes nothing about the broker call; it only adds a recovery path on the existing catch branch (which previously logged and swallowed). No T212 cancel/sell is ever attempted.
  - F7 fallback is warn-only and only runs when the execution-loop currency gate (F1) has already passed.
  - Scan-only sessions still skip the trading gates entirely.
- Tests:
  - `npm run typecheck` clean.
  - `npx vitest run src/cron/auto-trade.test.ts src/cron/auto-trade-stop-retry.test.ts src/lib/alert-service.test.ts src/lib/stop-hit-detection.test.ts src/lib/nightly-stop-apply.test.ts src/lib/persist-scan-snapshot.test.ts` — 104/104 pass on the combined working tree.
- Author: GitHub Copilot (agent), on user instruction ("do what needs to be done, always remember real money" / "please do what is best to tidy this up").

### 2026-06-11 - pending - Persist scheduled scan snapshot in scan-only session

- File(s):
  - `src/cron/auto-trade.ts`:
    - In the `if (session === 'scan')` branch only, added a `try/catch`-wrapped call to `persistScanSnapshot({ userId, scanResult, modelLayerEnabled })` before the existing session summary / heartbeat / disconnect. The scan-only session places no orders.
    - Added `modelLayerEnabled: true` to the trading-session `user` select so the persist call can honour the model-layer setting.
  - Supporting (non-sacred): new `src/lib/persist-scan-snapshot.ts` helper (extracted from the dashboard scan route) and `src/lib/persist-scan-snapshot.test.ts`; `src/app/api/scan/route.ts` refactored to call the same helper.
- Why: `runFullScan` never persisted, so a `Scan` row was only written when a human clicked "Run Full Scan" in the dashboard. The scheduled evening scan recomputed the same data and discarded it, leaving `scanAgeHours` (today-directive, ready-to-buy, analyst, briefings) and the `CandidateOutcome` research dataset stale between manual scans. Persisting the scan the cron already runs keeps them fresh at zero extra Yahoo load.
- Behaviour preserved:
  - The scan-only branch still places no orders; no gate, sizing, stop, account-routing, anti-chase, or execution logic was touched.
  - Persistence is non-fatal — a DB failure is caught and logged, and never alters the existing Telegram session summary or heartbeat behaviour.
  - All trading-session gates and the `revalidateLivePrice` anti-chase guard are byte-for-byte unchanged.
- Tests:
  - `npx vitest run src/lib/persist-scan-snapshot.test.ts src/cron/auto-trade.test.ts src/cron/auto-trade-stop-retry.test.ts` — 82/82 pass.
  - `npx tsc --noEmit` clean; `eslint` clean on all touched files.
- Author: GitHub Copilot (agent), on user instruction.

### 2026-06-08 - pending - Entry revalidation forces a fresh quote

- File(s):
  - `src/cron/auto-trade.ts`:
    - Changed the execution-time live-revalidation fetch from `getBatchPrices(tickers)` to `getBatchPrices(tickers, /* forceRefresh */ true)`, with an explanatory comment. This is the only price that authorizes a real buy.
- Why: The quote cache has a 5-minute TTL (`QUOTE_TTL`, `src/lib/market-data.ts`), so an entry could fire on a quote up to ~5 minutes stale. `forceRefresh=true` routes all tickers to the uncached path, forcing a live `yf.quote()` so entries are always judged against a guaranteed-fresh price.
- Behaviour preserved:
  - `revalidateLivePrice` decision logic is byte-for-byte unchanged (all four SKIP/KEEP branches, the no-chase ceiling, the floor check, and missing-price defensiveness). Only the freshness of the price input changed.
  - The separate existing-position risk-gate fallback fetch (`getBatchPrices(priceMissing)`) is deliberately left un-forced — Yahoo is a fallback for gate denominators there, not a new-entry trigger. T212 remains primary.
  - All other gates, sizing, stop tiers, account routing, and execution path untouched.
- Tests:
  - `npx vitest run src/cron/auto-trade.test.ts src/cron/auto-trade-stop-retry.test.ts` — 78/78 pass.
  - `npm run typecheck` passes (pre-commit).
- Author: GitHub Copilot (agent), on user instruction.

### 2026-05-29 - pending - Auto-trade health gate fails closed on stale health (R2)

- File(s):
  - `src/cron/auto-trade.ts`:
    - Added `HEALTH_STALE_HOURS = 30` constant and pure exported `evaluateHealthGate(lastHealthCheck, now)` returning `{ action: 'PROCEED' } | { action: 'BLOCK', reason }`. Missing health record or a health check older than 30h returns BLOCK (fail closed); otherwise PROCEED.
    - Wired the helper into the trading-session gate chain as "Gate 5" (after regime, before sizing), blocking the run with a diagnostic reason when health is stale/absent. Scan-only sessions are unaffected.
  - `src/cron/auto-trade.test.ts`:
    - Added an `evaluateHealthGate` describe block: proceed when fresh, block when missing, block when older than 30h, boundary check exactly at 30h.
- Why: 2026-05-29 ORACLE SYSTEM AUDIT finding R2. The auto-trade run consumed the health signal but had no fail-closed path: if the nightly health pipeline silently stopped updating, auto-trade would keep trading on stale health indefinitely. This makes a stale/absent health record halt new entries rather than trading blind.
- Behaviour preserved:
  - All existing gates unchanged; the health gate is additive and placed after the regime gate so regime blocking still takes precedence.
  - The anti-chase guard (`revalidateLivePrice` no-chase ceiling, floor check, missing-price defensiveness) is byte-for-byte unchanged.
  - `evaluateHealthGate` is pure — no DB, broker, or network access (the caller supplies `lastHealthCheck`).
  - Scan-only sessions still skip the trading gates entirely. Sizing, stop tiers, account routing, and execution path untouched.
- Tests:
  - `npx vitest run src/cron/watchdog-checks.test.ts src/cron/auto-trade.test.ts` — 70/70 pass.
  - `npm run typecheck` passes; `npx next build` passes.
- Author: GitHub Copilot (agent), on user instruction.

### 2026-05-29 - pending - Auto-trade anti-chase ceiling re-enforced at execution time

- File(s):
  - `src/lib/entry-quality-engine.ts`:
    - Exported the existing `NO_CHASE_ATR_BOUND = 1.2` constant (was module-private) so the cron reuses the same trusted no-chase bound rather than a duplicated magic number. No value or logic change.
  - `src/cron/auto-trade.ts`:
    - Imported `NO_CHASE_ATR_BOUND` from `@/lib/entry-quality-engine`.
    - Extended `revalidateLivePrice` with an optional 4th param `atr?: number` and a no-chase ceiling check: after the floor check, if `atr` is finite and > 0, SKIP when `livePrice > entryTrigger + NO_CHASE_ATR_BOUND × atr` with a diagnostic reason. Missing / non-finite / non-positive ATR skips the ceiling check (floor still applies) so a broken ATR pipeline cannot silently halt all trades.
    - Call site now passes `c.technicals?.atr` as the 4th argument. No other execution logic changed.
  - `src/cron/auto-trade.test.ts`:
    - Added a `live-price anti-chase ceiling` describe block with 7 contract tests: keep when extended-but-under ceiling, keep exactly at ceiling (strict `>`), skip above ceiling (with reason-text checks), no-enforce when ATR is undefined / 0 / negative, and floor-precedence when below trigger.
- Why: 2026-05-29 audit finding. The anti-chase guard (scan-time `BLOCKED_CHASE` in `candidate-grade.ts`, plus the engine's `noChasePrice` ceiling) only saw the scan-time price. The 2026-05-28 live-price revalidation re-checked the floor (`live >= trigger`) but had no upper bound, so a candidate whose live price ran above the no-chase ceiling between scan and execution would pass revalidation and be bought at market — a chased, extended entry that H-3 then pairs with a very tight stop, raising stop-out probability. This re-enforces the same ceiling the entry-quality-engine already defines, using the live price and scan-time ATR.
- Behaviour preserved:
  - All existing gates unchanged. The floor check (skip below trigger) and missing-price defensiveness (skip on undefined/NaN/<=0) are byte-for-byte unchanged and still take precedence over the new ceiling check.
  - The 4th param is optional; the prior 3-arg call contract and all existing `revalidateLivePrice` tests remain valid.
  - Scan-only sessions still skip the revalidation gate entirely.
  - `revalidateLivePrice` remains pure — no DB, broker, or network access.
  - Market-order execution path, sizing, stop tiers, and H-3 gap-up stop tightening are untouched.
- Tests:
  - `npx vitest run src/cron/auto-trade.test.ts` — 45/45 pass (incl. 7 new ceiling tests + the 10 prior revalidation tests).
  - `npx tsc --noEmit` passes.
- Author: GitHub Copilot (agent), on user instruction.

### 2026-05-28 - pending - Auto-trade live-price revalidation + heartbeat skip-reason logging

- File(s):
  - `src/cron/auto-trade.ts`:
    - Added pure exported `revalidateLivePrice(scanPrice, entryTrigger, livePrice)` helper returning `{ action: 'KEEP' } | { action: 'SKIP', reason }`. Skip-on-missing-price (undefined / NaN / <= 0) is the defensive default; below-trigger live price also returns SKIP with a diagnostic reason. Placed next to the other exported helpers (`widenStop`, `effectiveStopForFill`, `realisedGateFootprint`).
    - Inserted a live-price revalidation block after `readyCandidates.sort(...)`, gated on `session !== 'scan'` and `readyCandidates.length > 0`. Performs a single batched `getBatchPrices(tickers)` (already imported), applies `revalidateLivePrice` per candidate, splices losers out of `readyCandidates` in-place (same pattern as the existing earnings-deferral splice loop), and collects the drops into a `liveRevalidationSkipped` array. Fetch failure logs a warning and falls through to an empty price map — every candidate then skips with "Live price unavailable", keeping the gate defensive.
    - Seeded the existing `skipped` array with `liveRevalidationSkipped` so the new drops surface through the unchanged Telegram session-summary path.
    - Added `skipReasons: skipped.map(s => ({ ticker, reason }))` to the heartbeat `details` JSON. No existing field renamed or removed.
  - `src/cron/auto-trade.test.ts`:
    - Imported `revalidateLivePrice` from `./auto-trade` (same pattern as `auto-trade-stop-retry.test.ts`).
    - Added a `live-price revalidation` describe block with 10 contract tests: keep when live >= trigger, skip when below trigger, skip when undefined / NaN / 0 / negative / Infinity, and reason-text content checks for both diagnostic paths.
    - Added a `heartbeat skip-reason logging` describe block with 4 contract tests covering empty case, populated case, JSON round-trip, and the eligible>0/executed=0 diagnostic-blind-spot case.
- Why: Two motivations from the 2026-05-28 investigation of "markets bullish but zero autobuys":
  1. (Skip-reason logging) Heartbeats stored `skipped: <count>` with no reasons. When `eligible > 0` and `executed = 0` (observed on 2026-05-26 us-close: `eligible:4, executed:0, skipped:4`) the system was silent about WHY. Per-candidate skip reasons were already collected for Telegram; this exposes them to the heartbeat record so post-hoc DB queries can answer the diagnostic question.
  2. (Live revalidation) The auto-trade scan can be 2–22h old at execution time. The 2026-05-27 sacred change made the `price >= entryTrigger` gate strict at scan time, but a candidate that broke out at scan time may have fallen back before the cron fires. The new gate re-checks live price right before sizing, and skips both (a) candidates that have slipped back below trigger and (b) candidates whose live price cannot be fetched (defensive — never trade on stale scan-price alone). Skip-on-fetch-failure is the deliberate choice; the alternative (proceed on scan-price) was rejected because it re-opens the staleness hole the gate is meant to close.
- Behaviour preserved:
  - All existing gates (master enable, weekend, holiday, early-close, kill switch, broker config, operating mode, regime, health, session sleeve filter, A_GRADE_BUY classification, defense-in-depth `price >= entryTrigger` at scan time, earnings deferral, sizing, risk gates, account routing, max-attempt cap, terminal-error session abort, buy placement, fill polling, stop-placement retry tiers, gap-up stop tightening, realised gate footprint, DB position write, Telegram notifications, alert routing) are unchanged.
  - Scan-only session is unchanged — the revalidation gate is explicitly skipped for `session === 'scan'`.
  - Heartbeat `details` keeps every existing field (`type`, `session`, `scanned`, `ready`, `eligible`, `executed`, `failed`, `unprotected`, `skipped`, `trades`); `skipReasons` is purely additive.
  - Telegram session-summary content is unchanged in shape — revalidation drops appear in the existing `Skipped (N)` block with the same `{ticker, reason}` format as every other skip.
  - `revalidateLivePrice` is a pure function with no side effects, no DB access, no broker calls.
- Tests:
  - `npm run test:unit -- src/cron/auto-trade.test.ts src/cron/auto-trade-stop-retry.test.ts` — all existing tests still pass plus 14 new contract tests (10 revalidation + 4 heartbeat).
  - `npm run typecheck` passes.
- Author: GitHub Copilot (2026-05-28)

### 2026-05-27 - pending - Dashboard manual buy breakout confirmation

- File(s):
  - `src/lib/pre-execution-dry-run.ts` - Added a `BREAKOUT_TRIGGER` dry-run check. When an entry trigger is supplied, execution now fails if the current price is below `entryTrigger`.
  - `src/app/api/positions/execute/route.ts` - Accepts optional `currentPrice` and `entryTrigger` fields and passes them into the server-side pre-execution dry run before any live Trading212 order is placed.
  - `src/components/portfolio/BuyConfirmationModal.tsx` - Sends the dashboard candidate's scan price and scan entry trigger with the manual execution request.
  - `src/lib/pre-execution-dry-run.test.ts` - Added trigger-failed and trigger-confirmed regressions, and updated the dry-run check count.
- Why: Dashboard display paths already filtered for trigger-met candidates, but the live manual execution endpoint also needed a server-side confirmation gate so a stale or crafted request cannot buy below the breakout trigger when trigger context is available.
- Behaviour preserved:
  - Existing dry-run checks for stop validity, position sizing, risk gates, anti-chase, spread, cooldown, freshness, and duplicate positions are unchanged.
  - Manual execution still supports callers that do not provide trigger context, but dashboard buys now provide it.
  - Visible dashboard ready-to-buy filtering remains `price >= entryTrigger`.
- Tests: `npm run test:unit -- src/lib/candidate-grade.test.ts src/cron/auto-trade.test.ts src/cron/auto-trade-stop-retry.test.ts src/lib/pre-execution-dry-run.test.ts src/app/api/positions/execute/route.test.ts` passes, 5 files / 129 tests. `npm run typecheck` passes.
- Author: GitHub Copilot (2026-05-27)

### 2026-05-27 - pending - Strict breakout-only auto-buy execution

- File(s):
  - `src/lib/candidate-grade.ts` - Removed the near-trigger A-grade allowance. `A_GRADE_BUY` now requires `price >= entryTrigger`; below-trigger `READY` candidates remain `B_GRADE_WATCH` even with exceptional scores.
  - `src/cron/auto-trade.ts` - Added a defense-in-depth `price >= entryTrigger` filter before execution so future grading changes cannot re-enable anticipatory auto-buys. Updated the no-trade skip reason to say no triggered A-grade candidates were found. Auto-trade heartbeat now reports `PARTIAL` when a buy succeeds but its protective stop is missing.
  - `src/lib/candidate-grade.test.ts` - Replaced the near-trigger promotion regression with a strict breakout regression.
- Why: The near-trigger rule made auto-buy behave like a moving pre-breakout target. The documented system intent is confirmation-based: READY candidates are watchlist-only, and automated buys require the breakout trigger to be met.
- Behaviour preserved:
  - Regime, health, earnings, data-quality, anti-chase, cooldown, risk-gate, session, routing, sizing, broker-order, fill-polling, stop-placement, and max-attempt gates are unchanged.
  - Trigger-met A-grade candidates still execute through the existing auto-trade path.
  - Existing CRITICAL alert behavior for unprotected positions is preserved; heartbeat now also reflects the degraded session state.
- Tests: `npm run test:unit -- src/lib/candidate-grade.test.ts src/cron/auto-trade.test.ts src/cron/auto-trade-stop-retry.test.ts` passes, 3 files / 84 tests.
- Author: GitHub Copilot (2026-05-27)

### 2026-05-26 — complete — Add uk-mid + us-mid sessions, per-session volume thresholds

- File(s):
  - `src/cron/auto-trade.ts` — Added `uk-mid` and `us-mid` to `Session` type and `SESSION_CONFIGS`. Added `minVolumeRatio` to `SessionConfig` interface. Volume thresholds: uk=0.15, uk-mid=0.5, us=0.15, us-mid=0.6, us-close=0.4, scan=0.8. Updated `isStockForSession` to handle `uk-mid` (same as `uk` — `.L` stocks only). Updated early-close gate to also skip `us-mid`. Updated header docs and error messages.
- Why: Volume ratio at session times was physically unreachable — uk at 08:20 saw 0.03–0.21 (threshold 0.8), us at 14:45 saw 0.03–0.17 (threshold 0.8), us-close at 20:30 saw 0.30–0.60 (threshold 0.6). System had never executed a trade because of this. Mid-day sessions give a second chance with higher volume. Early sessions use low thresholds to catch open breakouts.
- Behaviour preserved:
  - All safety gates unchanged (kill switch, regime, health, risk gates, earnings deferral, max trades per session)
  - Position sizing, stop placement, execution logic untouched
  - Existing sessions (uk, us, us-close, scan) retain same sleeves and market filtering
  - Scan session still never trades
- Tests: auto-trade.test.ts updated with uk-mid and us-mid session filtering tests
- Author: Copilot (2026-05-26)

### 2026-05-18 — pending — ORACLE AUDIT remediation: F-3 trailing-stop level preservation

- File(s):
  - `src/lib/stop-manager.ts` — `generateTrailingStopRecommendations` return type adds `recommendedLevel: ProtectionLevel`. New `levelOrder` array + `TRAILING_ATR_IDX` constant; `recommendedLevel = currentIdx >= TRAILING_ATR_IDX ? currentLevel : 'TRAILING_ATR'`. Reads `position.protectionLevel as ProtectionLevel`.
  - `src/cron/nightly.ts` — Step 3b consumer: passes `rec.recommendedLevel` to `updateStopLoss` and `trailingStopChanges.push({ ...level: rec.recommendedLevel })`.
  - (Non-sacred) `src/lib/candidate-grade.ts` + tests, `src/lib/position-sync.ts`, `DASHBOARD-GUIDE.md` — F-1, F-2, F-4 from same audit; logged here for cross-reference only.
- Why (ORACLE AUDIT 2026-05-18, finding F-3, severity LOW): nightly trailing-step routinely downgraded the displayed protection-level label from `LOCK_08R` / `LOCK_1R_TRAIL` back to `TRAILING_ATR` because `updateStopLoss` was called with a hard-coded `'TRAILING_ATR'` arg. The stop *value* was correct (monotonic invariant held), but the displayed level mis-represented the position's protection state on dashboards and in alerts. Operator-facing only; no risk to capital.
- Behaviour preserved:
  - Monotonic stop invariant unchanged. Stop value still computed by existing `calculateTrailingATRStop`.
  - All decision branches in `generateTrailingStopRecommendations` produce the same `recommendedStop`, `currentStop`, `change`, `changePct` as before.
  - Positions at `INITIAL` or `BREAKEVEN` still upgrade to `TRAILING_ATR` on trailing-step (`currentIdx < TRAILING_ATR_IDX`).
  - Positions already at `LOCK_08R` / `LOCK_1R_TRAIL` keep that label (was: silently downgraded).
  - No call-site outside `nightly.ts` Step 3b is affected.
- Tests: `src/lib/stop-manager.test.ts` and `src/lib/candidate-grade.test.ts` full suites pass (83 tests). Targeted vitest run on position-sync + auto-trade + auto-trade-stop-retry (55 tests) also clean. `npx tsc --noEmit` clean.
- Author: ORACLE AUDIT remediation agent (2026-05-18)

### 2026-05-17 — pending — ORACLE SYSTEM AUDIT remediation: all 8 findings (H-1..4, M-1..4)

- File(s):
  - `src/cron/auto-trade.ts` — H-3 `effectiveStopForFill()` helper + Phase C stop-tightening; H-4 `positionsForGates` uses `gbpPrice * shares` not `entryPrice * fxRatio * shares`; M-3 `realisedGateFootprint()` helper + post-fill push uses realised fill state; M-4 extended retry tier (15s/45s/90s at widest factor) after immediate widen loop, skipped on terminal 401/403.
  - `src/cron/nightly.ts` — H-1 pyramid auto-exec calls `validateRiskGates` with GBP-normalised snapshot (fail-closed, 7-day PYRAMID_ADD alert throttle); H-2 pyramid polls `getOrder` 12×5s (404 fallback to `getPositions`) before DB write, cancel-on-timeout; H-4 pyramid snapshot uses `gbpPrice * shares`; M-1 drift auto-correct gated behind `ENABLE_DRIFT_AUTOCORRECT` env (default OFF), `DB > T212` emits CRITICAL `STOP_MISMATCH` alert with dashboard guidance (12h throttle).
  - `src/lib/scan-engine.ts` — H-4 concentration `value` = `currentPriceGbp * shares` (was `entryPriceGbp * shares`).
  - `src/lib/stop-manager.ts` — M-2 trailing-ATR price-divergence band 20%–500% fires throttled `STALE_MARKET_DATA` alert per ticker (24h dedupe); calc continues so monotonic stop still computed; >500% hard skip unchanged.
  - Tests: `src/lib/risk-gates.test.ts` (+3 H-1 tests), `src/cron/auto-trade-stop-retry.test.ts` (+6 H-3 tests, +7 M-3 tests).
- Why (ORACLE SYSTEM AUDIT 2026-05-17): system-level audit identified 4 HIGH findings (all on the theme of concentration safety eroding over time) and 4 MEDIUM findings (instrumentation + correctness at edges). Detail:
  - **H-1**: pyramid auto-exec in Step 6-auto of nightly bypassed `validateRiskGates`, allowing the size add to breach sleeve/cluster/sector caps if the position had grown materially since the original entry.
  - **H-2**: pyramid wrote DB on order submit, not on fill — broker rejection or partial fill produced phantom DB shares that the position-sizer + risk-gates used as "real" for subsequent calls.
  - **H-3**: gap-up fills inflated realised stop risk to `(filledPrice - plannedStop)`, which could be 2-3× the planned per-share risk the position-sizer was designed against. Worst-case after 3 widen retries ~2.6× planned.
  - **H-4**: concentration value used entry price × shares, so profitable positions silently freed sleeve/cluster headroom that didn't exist at market value.
  - **M-1**: drift detector auto-corrected `DB_HIGHER` by lowering DB stop to broker stop — silently rewriting the DB to the looser of two values, bypassing operator review.
  - **M-3**: after first trade fills, the next candidate's gate snapshot used planned `entryTrigger * planned shares` not realised fill — second trade through gates that the realised footprint would breach.
  - **M-4**: Phase C declared `UNPROTECTED_POSITION` after 3 widen attempts (~2 s total), missing transient T212 hiccups on the 30-90 s scale.
  - **M-2**: trailing-ATR only flagged >500% divergence as data corruption; smaller-scale (20–500%) divergence silently produced bad stops.
- Behaviour preserved:
  - Monotonic stop invariant (stops NEVER decrease) unchanged across all files.
  - Phase A/B/D structure unchanged. Existing buy-failure / fill-timeout / DB-failure / terminal-error / kill-switch / regime-gate / ISA-routing paths byte-identical.
  - Position-sizer, dual-score, regime-detector, risk-gates math unchanged. (`risk-gates.ts` not modified.)
  - First widen attempt (factor 1.0) still uses the original stop exactly for well-formed requests.
  - Pyramid first-time-gate: when `validateRiskGates` returns 0 violations and the existing fill/cancel paths are clean, the new code path is byte-identical to the previous one apart from the (correctly) raised stop on gap-up fills.
  - Drift-detector behaviour byte-identical when operator sets `ENABLE_DRIFT_AUTOCORRECT=true`.
  - Trailing-ATR >500% skip behaviour byte-identical; new alert is fire-and-forget so calc never blocks on alert delivery.
- Tests:
  - +3 new tests for H-1 in `risk-gates.test.ts` (sleeve breach, position-size breach, allow-when-within-caps).
  - +6 new tests for H-3 in `auto-trade-stop-retry.test.ts` (`effectiveStopForFill()` contract + worst-case widen).
  - +7 new tests for M-3 in `auto-trade-stop-retry.test.ts` (`realisedGateFootprint()` contract: filledPrice/shares/stopPrice usage, FX conversion, fallback, risk-floor, gap-up regression).
  - Full vitest suite: **118 files / 1697 tests all pass** (was 1690 + 7 new).
  - `npx tsc --noEmit` clean.
- Operator-visible behaviour change: `ENABLE_DRIFT_AUTOCORRECT=true` env var is now required to keep the old M-1 auto-correct behaviour. Default is OFF — first nightly will surface any pre-existing `DB > T212` drift as a CRITICAL `STOP_MISMATCH` alert instead of silently rewriting the DB.
- Author: ORACLE SYSTEM AUDIT remediation agent (2026-05-17)

### 2026-05-16 — pending — auto-trade.ts: H4 stop-retry-widen + M1 heartbeat.kind stamping

- File(s): `src/cron/auto-trade.ts` (Phase C of `executeTrade`, Phase D `actualStopPrice` propagation, 8 heartbeat sites, top-of-file helpers); supporting test `src/cron/auto-trade-stop-retry.test.ts` (new).
- Why (audit 2026-05-16): Two findings landed in the same sacred file, so they are bundled into one edit:
  - **H4 (HIGH)** — single-attempt stop placement left positions UNPROTECTED on any T212 error. A transient 5xx or price-too-close 400 on the first try meant a live long position with no stop until manual intervention. The catch path raised a CRITICAL alert but did not retry.
  - **M1 (MEDIUM)** — the watchdog and midday-sync drift detector matched heartbeats by `details.contains(...)` JSON-string search, which is brittle and (per the H2 fix in Stage 1) was masking a missed nightly when a midday-OK heartbeat coincidentally matched. The structural fix is a `kind` discriminator column on Heartbeat; this sacred edit stamps `kind: 'AUTO_TRADE'` on the 8 heartbeat writes in this file.
- Fix:
  1. **H4 retry-widen loop**: Phase C of `executeTrade` now attempts stop placement up to 3 times with progressively wider stops (factors `1.0, 1.33, 1.67` applied to the entry-stop gap). Each attempt is logged via `logExecution(STOP_FAILED ...)` with the attempt number and widen factor. 401/403 (terminal auth/permission) short-circuit the loop. A 500 ms delay separates attempts. The variable `actualStopPrice` tracks the price that succeeded and is used for the DB Position write (`stopLoss`, `currentStop`, `initial_stop`, `initialRisk`), the TradeLog write (`initialStop`, `initialR`), the `COMPLETE` execution log, and the `TradeResult` return value — so the DB matches what is live at the broker, not the originally-requested price. After all retries fail, the existing UNPROTECTED_POSITION alert path runs unchanged.
  2. **M1 kind stamping**: added `kind: 'AUTO_TRADE'` to every `prisma.heartbeat.create` in this file (8 sites: weekend skip, market-holiday skip, early-close skip, kill-switch skip, operating-mode skip, regime-block, scan-session done, final summary). Schema migration `20260516120000_add_heartbeat_kind` adds the nullable column and an index.
  3. **Helpers extracted to top-of-file**: `STOP_RETRY_WIDEN_FACTORS`, `STOP_RETRY_DELAY_MS`, `STOP_TERMINAL_STATUS_CODES`, and the pure `widenStop(filledPrice, originalStop, factor)` function. All exported so the contract is locked down by the new test file.
- Behaviour preserved:
  - Phase A (market buy) and Phase B (fill polling) are unchanged.
  - Buy-failure / fill-timeout / DB-failure paths are unchanged.
  - The CRITICAL UNPROTECTED_POSITION alert + Telegram notification still fires when all 3 stop attempts fail (`stopPlaced === false && success === true`).
  - First attempt uses the original `stopPrice` exactly (factor `1.0`) — for a well-formed stop request, behaviour is byte-identical to the previous single-attempt path.
  - All 8 gate paths still return early after writing their heartbeat; nothing in the gating logic changed.
  - Auto-trade kill switch (Gate 2), regime gate (Gate 4), health gate (Gate 5), per-session attempt cap, terminal-error abort, and ISA-routing rule from prior incidents (2026-04-30) are unchanged.
  - Position-sizer, scan-engine, dual-score, regime-detector, stop-manager, risk-gates are not touched.
- Tests:
  - New `src/cron/auto-trade-stop-retry.test.ts` — 11 tests covering `widenStop()` math, factor monotonicity, three-attempt cap, retry-delay non-zero, terminal-status-code set.
  - Existing 22 auto-trade.test.ts contract tests still pass (they test TradeResult shape, not the loop body, so are unaffected).
  - Heartbeat readers in watchdog.ts and midday-sync.ts already migrated in the same audit batch to filter by `kind: 'NIGHTLY'` / `kind: 'MIDDAY_SYNC'`; auto-trade heartbeats are not queried by those readers.
- Author: ORACLE AUDIT remediation agent (2026-05-16)

### 2026-05-01 — pending — auto-trade.ts: persist t212Ticker on Position.create

- File(s): `src/cron/auto-trade.ts` (only the `tx.position.create` call inside Phase D)
- Why (incident report): Today's hourly status report read "Positions: 9/4" with UNFI, GOOGL, and PWR each appearing twice. Auto-trade had created the rows correctly with the right entry-stop `initialRisk` math but left `t212Ticker = null`. The follow-up `/api/trading212/sync` then queried existing positions filtered by `source: 'trading212'`, missed the auto-trade rows, and re-created them as fresh trading212 rows — this time with `t212Ticker` set and `initialRisk` defaulted to 5% of entry. Result: every auto-traded ticker became two OPEN rows, the max-positions blocker tripped, and the dashboard showed 9/4 against 6 real T212 holdings.
- Fix: pass `t212Ticker: t212Ticker` (the value already destructured from `candidate`) into the Position.create payload. The follow-up broker sync now resolves these rows by their full T212 ticker on the next run instead of treating them as missing.
- Behaviour preserved: Order placement, fill detection, stop placement, regime gate, kill switch, attempt cap, terminal error abort, ISA/Invest routing, position sizing, FX, and TradeLog writes are all unchanged. The only schema-touching change is one additional non-null field on the new Position row — and the value is one already in scope from the candidate.
- Tests: 22/22 existing auto-trade unit tests pass. New 15-test regression suite for the broker-sync merge logic (`src/lib/trading212-sync-merge.test.ts`) directly covers the matching path that failed: full T212 ticker primary key, bare-ticker fallback for null-t212Ticker rows, cross-account guard, close-detection. Plus a new A4 health check + 6 unit tests in `src/lib/health-check.test.ts` that fires RED whenever two OPEN rows share `(stockId, accountType)` so the next occurrence is caught within an hour rather than waiting for a Telegram report. Full suite: 109 files, 1565 tests pass.
- Author: RPI Agent (incident response, 2026-05-01)

### 2026-04-30 — pending — auto-trade.ts: CRITICAL — attempt cap + terminal error abort + revert routing

- File(s): `src/cron/auto-trade.ts`
- Why (incident report): At 21:35 BST a manual `us-close` re-run was triggered. The market was closed, so T212 queued buy orders without filling; `executeTrade` returned `result.success = false` for every candidate due to the polling timeout. The previous loop only incremented `tradesExecuted` on success, so `MAX_TRADES_PER_SESSION = 2` was never reached and the loop drained the entire ready list, placing real T212 buy orders on each candidate (3 orders accepted: GOOGL, PWR, UNFI; many more rejected by T212 with `i-s-a-ineligible-instrument` and `insufficient-free-for-stocks-buy`). The previous routing change "let T212 reject anything truly ineligible" — that turned out to mean burning a real order placement before the rejection, which is unsafe.
- Fixes (three layered safety guards):
  1. **Attempt cap**: introduced `tradesAttempted` counter; cap is now applied to ATTEMPTS, not just SUCCESSES. The loop cannot exceed `MAX_TRADES_PER_SESSION` order placements regardless of fill outcomes.
  2. **Terminal error abort**: introduced `TERMINAL_ERROR_PATTERNS` (insufficient funds, kill switch, account suspended). On match, `sessionAbortReason` is set and all subsequent candidates are marked skipped without an attempt.
  3. **Routing reverted to safe rule**: only route to ISA when stock is EXPLICITLY tagged `isaEligible=true` (null and false both → Invest). The previous "ISA-only user → ISA for everything" routing was too permissive and produced T212 ineligible-instrument rejections. The currency advisory log was removed (no longer relevant under strict routing).
- Behaviour preserved: `executeTrade` is unchanged. Stop placement, position sizing, regime gates, kill switch, monotonic stop rule, FX handling, risk gates, A-grade filtering, and Telegram notifications are all identical. The only behaviour changes are the three safety guards above plus the routing tightening.
- Tests: 22/22 auto-trade unit tests pass. Manual incident verified: with attempt cap, the same scenario would have produced exactly 2 attempts (1 success + 1 fill-timeout, then session ends). With terminal error abort, the insufficient-funds pattern from the same incident would have aborted after the first such error. Audit entry follows the rule: "supersede with a new entry that explains the change in understanding" — the prior entry's "let T212 reject" assumption is now superseded.
- Author: PR Review agent (incident response, 2026-04-30 21:35 BST)

### 2026-04-30 — 6d7fe1d — auto-trade.ts: smarter ISA-only routing + currency mismatch advisory

- File(s): `src/cron/auto-trade.ts` (only `getAccountTypeForStock` and the routing call site in `runSession`)
- Why: Old routing required `sleeve='CORE' AND isaEligible=true` to send a candidate to ISA. For an ISA-only user, this excluded GBP-listed ETFs and HIGH_RISK stocks — they fell through to Invest, hit the "Invest not connected" path, and were skipped. The new rule: when only ISA is connected, route everything (except explicit `isaEligible=false`) to ISA. T212 ISA accepts US shares (with FX) and UK-listed UCITS ETFs; let T212 reject anything truly ineligible. The dual-account case (both connected) is unchanged.
- Behaviour preserved: All risk gates, position sizing, regime checks, kill switch, stop placement, monotonic stop rule, position creation, FX handling, and order execution paths are untouched. The change is **routing-only** — `executeTrade` and downstream behaviour are identical. Currency-mismatch logging is **advisory only** (warn log) — no skip, no block.
- Tests: All 22 auto-trade unit tests pass. Full suite 108/108 test files pass. New helper test coverage isn't added because the change is to a private function with no exported surface; existing route-level tests cover the integration.
- Author: PR Review agent (T212 audit, ship-all batch)

### 2026-04-30 — pending — auto-trade.ts: relax t212ApiSecret requirement (legacy single-token auth)

- File(s): `src/cron/auto-trade.ts` (only `getT212Client`)
- Why: T212 docs show two auth modes — Basic `key:secret` AND legacy single-token `Authorization: <apiKey>`. Today T212 commonly issues a single token with no separate secret. The previous gate `!user.t212ApiSecret || !user.t212IsaApiSecret` blocked these users from connecting. `Trading212Client` constructor now treats an empty `apiSecret` as legacy auth and sends the key directly in the header.
- Behaviour preserved: All routing logic, regime gates, kill switch, stop placement, position creation, risk gates, currency handling, and ISA/Invest selection are untouched. Only the credential-validity check changed: secret is no longer required, key + connected flag still are. `decryptField(... ?? '')` is null-safe so missing secret in DB doesn't throw.
- Tests: trading212-dual updated (1 test renamed to focus on missing-key, 1 new test added asserting key-only legacy auth is accepted). Full T212 test suite 39/39 pass. positions/execute (24 tests) pass with the same relaxation applied.
- Author: PR Review agent (T212 audit, ship-all batch)
### 2026-04-30 — pending — auto-trade.ts: skip candidates whose T212 account isn't connected (don't error)

- File(s): `src/cron/auto-trade.ts`
- Why: When the user has only an ISA account connected (no Invest), `getAccountTypeForStock` still routed non-ISA-eligible US stocks (e.g. GOOGL, PWR, IRM, CAT, HASI, FDX) and untagged ETFs (VUSA, EIMI) to Invest. `getT212Client('invest')` then threw "Trading 212 Invest account not connected", producing 8 noisy per-candidate Telegram failures and 8 execution-log writes per session. This is a configuration mismatch, not a trade failure.
- Behaviour preserved: Routing rules unchanged for connected accounts (ISA-eligible CORE → ISA; everything else → Invest). T212 client construction, order placement, polling, fill detection, stop-loss placement, position creation, risk gates, kill switch, regime checks, and Trade Notifications for actual trades are all untouched. Only the routing function's return type changed: `T212AccountType` → `T212AccountType | null`. The single caller in `runSession` now handles `null` by adding to `skipped[]` (same shape used for "Zero shares after sizing", "No T212 ticker mapped", etc.) instead of calling `executeTrade` which would throw.
- Tests: Full suite 108 test files pass (no new tests added — change is defensive and the existing trade-result/skip-result assertions remain valid). Manual trace: ISA-only user with US-only candidates now reports `Trades: 0 executed, 0 failed, 8 skipped (T212 account not connected for this stock)` instead of `0 executed, 8 failed`.
- Author: PR Review agent (live diagnosis from 30/04/2026 US Near-Close session)

### 2026-04-30 — pending — auto-trade.ts: per-candidate dual-score lookup

- File(s): `src/cron/auto-trade.ts`
- Why: Auto-trade's `classifyCandidate` call was passing a shared `GradingContext` with no `ncs/fws/bqs`. The grader defaults missing scores to worst case (NCS=0, FWS=100, BQS=0), so every candidate failed the A_GRADE_BUY thresholds. Result: 0 A-grades across 8,402 historical ScanResult rows; every auto-trade run produced `eligible: 0` and zero trades. Fix wires the existing dual-score data (already produced nightly into ScoreBreakdown) through to grading per candidate via the new `getLatestScoresByTicker` helper.
- Behaviour preserved: Risk gates, regime checks, health checks, Trading212 order placement, ISA/Invest routing, kill switch, throttled alerts, and the entry/exit logic are all unchanged. Only the input to `classifyCandidate` was upgraded — ncs/fws/bqs are now per-candidate instead of always-null. A_GRADE_BUY filtering and ranking logic downstream is untouched.
- Tests: 39/39 candidate-grade + score-lookup tests pass (2 new tests cover the resolver). Full suite 1540/1540. No `auto-trade.test.ts` changes were required because the call signature is preserved (still `classifyCandidate(c, ctx)`).
- Author: RPI agent (Phase 3 implementation)

### 2026-04-29 — 6bba3cf — auto-trade.ts: throttle failure-only Telegram alerts

- File(s): `src/cron/auto-trade.ts`
- Why: Repeated identical failures (kill-switch, mode-blocked, no-T212, scan-fail, fatal crash) were spamming Telegram. Migrated those four blocked-gate notifications and the fatal-crash catch to `sendThrottledTelegramAlert` with new `ALERT_CATEGORY` keys.
- Behaviour preserved: Order placement, gate logic, exit paths, briefings, and success notifications all unchanged. Only failure-path Telegram calls were wrapped; the underlying control flow is untouched.
- Tests: All existing `auto-trade.test.ts` cases still pass (1443/1443 total). No new tests required because the wrapping is purely additive.
- Author: RPI agent (Phase 3 implementation)

### 2026-04-28 — 1b0d9ed — execution-mode: weekday EXECUTION (was Tuesday-only)

- File(s): `src/lib/execution-mode.ts`, `src/types/index.ts` (`getCurrentWeeklyPhase`), `src/cron/auto-trade.ts` (gate read)
- Why: System was blocking buys on Mon/Wed–Fri and only allowing Tuesday. User required consistent buy capability throughout the week.
- Behaviour preserved: Sat/Sun stay PLANNING. Mon–Fri all return EXECUTION. Stop management, regime gates, and risk caps unchanged.
- Tests: `execution-mode.test.ts` weekday matrix expanded; auto-trade integration tests still pass.
- Author: RPI agent (cycle 1)

### 2026-05-22 — auto-trade.ts + candidate-grade.ts: near-trigger A-grade + session volume thresholds
- File(s): `src/cron/auto-trade.ts`, `src/lib/candidate-grade.ts`
- Why: System had **never** auto-traded — 0 execution logs, 0 A-grades ever recorded. Root cause: A-grade required `price >= entryTrigger` (20-day high + ATR buffer) but scans run only 3-4× daily, consistently missing intraday breakouts by <1%. Additionally, volume ratio threshold of 0.8 was unreachable at the 14:45 scan (09:45 ET, ~10% of daily volume).
- Changes:
  - **Near-trigger allowance** (candidate-grade.ts): READY candidates within 1% of trigger (`nearTriggerMaxGap: 1.0`) with NCS ≥ 80 (`nearTriggerMinNCS: 80`, elevated from standard 70) now qualify for A_GRADE_BUY. All other checks (filters, FWS ≤ 30, BQS ≥ 55, volume, RS, ATR) still required. Standard trigger-met path unchanged.
  - **Session volume threshold** (auto-trade.ts): `us-close` session uses `minVolumeRatio: 0.6` (vs default 0.8). By 15:30 ET ~80% of daily volume has traded; 0.6 ratio at that point represents strong participation. Earlier sessions keep 0.8.
- Behaviour preserved: All hard blocks (regime, health, earnings, risk gates, anti-chase, cooldown) unchanged. Stop management, position sizing, execution flow untouched. The near-trigger path raises the NCS bar from 70→80 to offset pre-breakout entry risk.
- Tests: 37/37 candidate-grade tests pass (3 new: near-trigger A-grade, near-trigger NCS<80 → B, gap>1% → B). No auto-trade test changes needed — call signature preserved.
- Author: Copilot CLI agent

<!-- Append new entries above this line. Never edit historical entries; supersede with a new entry that explains the change in understanding. -->
