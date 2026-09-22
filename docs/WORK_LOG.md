---
title: HybridTurtle Work Log
description: Append-only record of substantial engineering decisions and verified outcomes.
ms.date: 2026-09-10
---

## Entry format

Append a dated section containing scope, changes, decisions, verification, and
remaining work. Supersede earlier decisions with a new entry; do not rewrite
historical entries. This log begins with the current task and does not reconstruct
work performed before September 10, 2026.

## 2026-09-10 Trade performance Phase 1

### Scope and changes

Started the approved read-only baseline phase of the performance-improvement
plan. Added a standalone SQLite reporting script and nine unit/integration tests.
Produced [the baseline report](../reports/trade-performance-review-2026-09-10.md).
No application behavior, sacred files, database data, broker orders, or scheduled
automation changed. Existing edits in ready-to-buy code/tests, VRP data and an
untracked PDF were left untouched.

### Decisions

Use descriptive stored-record results, not verified net-account performance.
The automated cohort has 13 closed positions, only 11 measured outcomes across
six entry days, and a stored GBP subtotal of -14.96. Two automated outcomes and
one synced outcome are missing; five linked exits have quantity mismatches.
CandidateOutcome has 81,999 rows but zero placed-trade links. Do not tune risk,
ranking, entries or stops based on this incomplete evidence.

The reporting path opens SQLite read-only with query-only enabled and reads core
evidence in one transaction. It avoids application Prisma initialization, schema
verifier scripts, history imports and live services. Explicitly preserve existing
trading risk limits and advisory-only boundaries.

### Verification

* `node --test scripts/trade-performance-baseline.test.mjs`: 9 passed.
* Scoped ESLint for the two reporting files: passed.
* `npm run typecheck`: passed.
* Local read-only report execution and fill/quantity spot checks: completed.
* SQLite fixture byte-preservation and deterministic fingerprint: passed.

### Remaining work

Reconcile missing/partial exits and establish exact candidate-to-trade identity
before strategy experiments. Any historical record repair requires its own
reviewed reconciliation proposal. Historical live/demo provenance, complete
fees/cash flows and full holding-window prices remain unverified. The baseline
report lists separate existing analytics issues without changing their code.

## 2026-09-10 Exit reconciliation continuation

### Scope and changes

Extended the read-only baseline with a per-position reconciliation queue and
three additional tests. Added the
[exit reconciliation proposal](../reports/trade-exit-reconciliation-2026-09-10.md).
No production files, database records, broker state or scheduled jobs changed.

### Decisions

The account-sync closure branch can mark positions CLOSED without outcomes;
the separate OPEN-only reconciler cannot revisit them. Latest-sell selection
does not prove full position quantity coverage, and its no-order entry-price
fallback can create an unverified zero. Local evidence does not justify a
historical correction for the nine exceptions. Require account-scoped fills.

Candidate backfill excludes TAKEN; widening its decision filter alone would
permit ambiguous ticker/date links and exit attribution. Do not run it as a
repair. Keep historical corrections and prospective production repairs separate
from the current reporting scope and from strategy tuning.

### Verification

* `node --test scripts/trade-performance-baseline.test.mjs`: 12 passed.
* Scoped ESLint and `npm run typecheck`: passed.
* Actual read-only queue: exactly nine expected exceptions, none repair-authorized.
* Selected baseline source fingerprint: unchanged from the Phase 1 report.

### Remaining work

Obtain complete ISA fill evidence for UNH, TKNO, GCBC, CLDX, HAYW, DSFIR.AS,
CCRN, PEBO and CRON before proposing replacement values. Scope and approve
production closure/linkage repairs separately. No strategy experiment has begun.

## 2026-09-10 Multi-fill evidence follow-up

### Scope and changes

Continued autonomously within the read-only boundary because no export or
explicit production-repair choice was available. Inspected local cache folders
and broker-history transformation. Added two mocked characterization cases to
the existing Trading212 client test file and refined the reconciliation proposal.
Production code, historical records, live services and user edits remain unchanged.

### Decisions

The history client emits individual fill records under a repeated order ID and
discards raw fill IDs. The closure selector can therefore select just the final
fill, not merely one partial sell order. Its one-page fetch can also omit earlier
fills. Future repair must preserve account-scoped fill identity and establish
history completeness before aggregation; an increased page limit alone is not
sufficient. The historical cause for each affected ticker is still unproven.

### Verification

* `npx vitest run src/lib/trading212.test.ts`: 31 passed, including two new cases.
* Synthetic 10-share sell: one page yields 2 shares/GBP 1; two yield 10 shares/GBP 5.
* No full order-history file found in the inspected local data/cache/report folders.

### Remaining work

Historical P&L replacement remains blocked on independent complete fill evidence.
The updated proposal names pagination, duplicate-fill and account-isolation tests
required before a separately authorized production fix. No parameter tuning or
live reconciliation changes were made.

## 2026-09-10 authorized closure-accounting repair

### Scope and changes

The user authorized the necessary production changes. Implemented the prospective
closure-accounting prerequisite to performance analysis, without changing strategy
parameters or historical records. Changed the Trading212 client and tests,
position sync and tests, account-sync route and tests, and added a pure closure
evidence helper and tests. Added an implementation section to the
[reconciliation report](../reports/trade-exit-reconciliation-2026-09-10.md).

### Decisions

Preserve fill IDs and GBP wallet currency, isolate history by account, and accept
only one full-size order with complete distinct fills inside the stored holding
window. Incomplete evidence closes the absent holding with null accounting and
a retryable pending marker. Record the current environment for those retries.
Do not reopen holdings, estimate missing P&L, widen pagination, or revisit legacy
historical closure reasons automatically. Preserve existing broker-fetch guards.

Position plus exit-log accounting is transactional, with errors propagated and
expected-state filters guarding stale writes. Null R is not an EV zero. Identical
Invest/ISA credentials use the existing Invest-primary convention for accounting.
No sacred files, live database records, broker orders or automation settings were
modified. Pre-existing ready-to-buy changes, VRP data and the PDF remain untouched.

### Verification

* Changed accounting slice: 71 Vitest tests passed across four files.
* Adjacent midday sync, sync merge and synced-risk suites: 31 tests passed.
* Read-only baseline: 12 Node tests passed.
* `npm run typecheck`, scoped ESLint and editor diagnostics passed.
* Application broker and database calls were mocked; no live closure was invoked.

Focused tests caught and resolved a local-time/UTC fixture mismatch and a patch
anchored to the wrong repeated `const now` statement. Use the owning function as
patch context for repeated statements. No outstanding test failures remain.

### Remaining work

Observe the next routine sync and compare outcomes with broker fill statements.
The full application suite and live concurrent database behavior were not tested.
One-page order coverage is not whole-lifecycle proof; multiple sells, partial
lifecycles, entry provenance, account replacement and raw-fill archival remain
outside this repair. Global TradeLog order-ID collisions fail visibly rather than
being silently accepted. Obtain independent evidence for the nine historical ISA
exceptions before a historical write proposal. Exact candidate-to-entry linkage
and strategy experiments are subsequent work, not part of this implementation.

## 2026-09-10 automated scan-to-entry attribution

### Scope and changes

Implemented prospective attribution in `src/cron/auto-trade.ts`,
`src/lib/persist-scan-snapshot.ts` and `src/lib/candidate-outcome.ts`.
Extended snapshot tests and added candidate-link and mocked execution tests.
Persist the fresh scan before live-price revalidation, preserving the execution
session's candidate inputs, grades and score context. Retain the full scan
universe for existing snapshot consumers. Other candidates keep normal grading.

Capture the actual ENTRY TradeLog ID and link only after the position transaction
commits. Validate user, ticker, entry decision, position presence, chronology and
fill; refuse conflicting links. Store scan identity in Position notes and exact
identifiers in the COMPLETE execution payload. Missing attribution produces an
ATTRIBUTION_PENDING execution log without undoing a filled, protected position.

### Historical evidence and decisions

Read-only SQLite inventory found 81,999 candidate rows across 76 scans from
May 16 through September 9, 2026. Of these, 11,337 have a 20-day forward return;
none is linked to a placed trade. These are repeated candidate observations,
not 81,999 independent trades. The 145 trade logs span January 15 through
September 10: 15 ENTRY, 106 EXIT and 24 STOP_HIT, all with decision TAKEN.
There are 30 positions and 208 execution logs.

None of the inspected execution payloads contains scanId or tradeLogId;
15 contain positionId. No Position notes mention a scan, and the non-null ENTRY
position IDs have no duplicates. This does not establish historical decision
identity. Do not use ticker/date proximity or invoke the legacy backfill.
No historical records, schema, strategy parameters, broker orders or scheduler
settings were changed. No sacred files were edited. New snapshot persistence
adds database work before fresh quotes and updates the latest visible scan.

### Verification

* Six affected Vitest suites: 133 tests passed.
* Final score-provenance and post-commit integration checks: 10 tests passed.
* Typecheck, scoped ESLint and touched-file editor diagnostics passed.
* Broker calls, database writes and polling timers were mocked in execution tests.

Typecheck caught an attempted write to a nonexistent TradeLog notes field;
the correction uses existing Position notes and ExecutionLog JSON instead.

### Remaining work and manual checks

During the next normal automated fill, inspect the COMPLETE payload for scanId,
tradeLogId and candidateLinked, then verify the matching CandidateOutcome row.
If attribution is pending, investigate the exact recorded IDs without guessing.
Manual/dashboard entries remain outside this slice. No live trading run, full
suite, persistence latency measurement or concurrent database test was performed.
Historical accounting exceptions still require complete broker fill evidence.
Next research step: audit forward-outcome coverage by date and ticker, then
define a chronological held-out, advisory-only experiment with overlap controls.

## 2026-09-10 outcome-coverage readiness check

### Scope and evidence

Completed the requested read-only coverage check and wrote the
[research readiness report](../reports/candidate-outcome-readiness-2026-09-10.md).
Added a standalone coverage script with four Node tests and three mocked
characterization tests beside enrichment. No production code, live data,
provider calls or broker actions changed in this slice.

At the September 10 UTC cutoff, 81,999 observations span 67 dates and 1,121
tickers, but the 11,337 stored twenty-day outcomes span only ten May-June dates.
Only eight A-grade observations across three dates have twenty-day outcomes.
There are 43,032 old missing outcomes using a conservative 42-calendar-day age
flag, including 7,227 partially enriched rows. Recent missing outcomes are not
automatically classified as immature. Exact scan/ticker grade joins were used.

The current Yahoo provider returns newest-first bars, whereas enrichment indexes
them chronologically without sorting. A controlled batch fixture confirms wrong
horizon returns. The enrichedAt=null selector also prevents incomplete horizons
from maturing. MFE includes rallies after a stop touch and is not captured profit.
These are verified current-code behaviors, not inferred causes for every legacy
record. Production repairs remain a separate step.

### Decision and verification

Do not tune using stored labels. Local DailyBar now contains 294,052 rows across
1,088 instruments, substantially more than earlier project inventories, but
session coverage, aliases and adjustment consistency still require validation.
Proposed first conditional experiment: same eligible slate and risk constraints,
current rankScore versus NCS ordering, with chronological purging and a verified
unexposed holdout. No ranking comparison was evaluated in this check.

Four read-only reporter tests and twelve enrichment tests passed. Typecheck,
scoped lint and diagnostics passed. The reporter's temporary SQLite fixture
remained byte-identical. No full application suite or live-provider test ran.
The report records the fixed cutoff, source fingerprint, limitations and gates.

### Next action

Implement a small research-only reconstruction pilot before changing enrichment
or bulk-writing outcomes. Validate full post-scan sessions, price units and
corporate-action basis. Historical fill reconciliation and normal automated
entry-link observation remain separate outstanding work.

## 2026-09-10 research reconstruction pilot

### Scope and implementation

Added a standalone read-only reconstruction script and ten focused tests.
The [pilot report](../reports/candidate-outcome-pilot-2026-09-10.md) links two
separate JSON evidence artifacts, retaining the original and corrected runs.
Frozen sampling selects earliest May/June rows by symbol and enrichment status
for AA, AAPL, ABBV, AAL.L, AIAI, AD.AS and ASML. Of 42 slots, 29 exist. Canonical
aliases, exact identity, currency units, bounded exchange calendars, individual
horizon completeness, scan baseline and adjustment consistency are checked.
No production code, database data, broker actions, schema, provider refreshes,
sacred files or scheduled automation were changed. Unrelated edits remain intact.

### Evidence and decisions

Version 1 rejected every row because raw/adjusted equality is too restrictive.
Version 2 uses the structural invariant that a constant adjustment factor cancels
in a return ratio. Synthetic scale tests prove this; changing factors still fail.
The two runs' sample, candidates, metadata and bars were asserted identical.
This is a mathematical correction, not return-based threshold optimization.

Eight rows pass all three horizons conditionally; 21 are rejected. The accepted
rows span three dates, with five stored five-session comparisons all on May 16.
All five differ in magnitude and sign; maximum absolute gap is 12.2455 percentage
points. No accepted ten/twenty-session result has a stored comparator. Reasons
overlap: 18 before the conservative post-close cutoff, 18 baseline mismatches,
four AIAI GBP/USD metadata conflicts, and two factor-changing windows. The
pilot does not establish the historical cause of stored-label discrepancies.

Selected version 2 source fingerprint:
`33186f7a20596470c86b86dc0761f9bbfbbe6fd5e4355bc30132a471c566032a`.
July candidate rows and August 3 onward holdout outcomes were not queried.
July bars were read only as required endpoints of May-June candidates.

### Verification and next work

Ten Node tests, scoped lint, typecheck and script diagnostics passed. SQLite
fixture bytes were preserved. Changing holdout rows/bars does not change pilot
evidence. Independent raw-SQL endpoint and arithmetic checks passed for all 24
accepted horizons. Calendar sources and raw-price spot checks are in the report.
The existing TS ticker-map import produces a nonfatal Node module-type warning.

Conditional labels are not executed trades, net profit, or sufficient evidence
for optimization. Source bars are normalized and revised, not immutable raw
archives. Next scope: prospective enrichment ordering, partial-horizon retries
and explicit data-quality gates; no bulk history rewrite. Intraday baseline,
corporate-action and historical metadata provenance need further evidence.
No ranking comparison, full application suite, live-provider or broker test ran.

## 2026-09-11 prospective outcome enrichment repair

### Scope and implementation

Changed [candidate enrichment](../src/lib/candidate-outcome-enrichment.ts) to
sort a copied provider window chronologically and retry missing 5/10/20-bar
returns even after initial enrichment. The fixed cohort starts September 11,
2026 UTC; earlier scan rows are excluded from this enrichment path. Existing
nonnull returns must match recalculation and are not overwritten. Expected-state
updates prevent stale writes when selected inputs or prior returns change.
Excursion and threshold fields are written only with a full twenty-bar window.

Added optional raw close, adjusted close and fetch timestamp evidence to the
[Yahoo adapter](../src/lib/market-data.ts). Existing scanner-facing close,
open/high/low, volume, newest-first ordering and cache behavior remain unchanged.
Enrichment requires a matching adjusted-close anchor and a constant positive
adjusted/raw factor across each accepted prefix. Raw highs/lows are converted
to the anchor's adjusted basis for excursions. A missing factor is not assumed
to be one. Prior cache entries and EODHD responses without evidence are skipped.

Dates, positive finite values, unique weekday rows, anchor recency and OHLC
range consistency are checked. Same-day anchors require a scan at or after
22:00 UTC. Each accepted bar must have been fetched on a later UTC date,
no later than the post-fetch observation time. Current-day bars are excluded.
The age cutoff remains fixed at batch start; the observation timestamp is
captured after fetching so fresh responses are not rejected as future data.

No database records, historical outcomes, broker state, strategy parameters,
schema, scheduler settings or sacred files were changed during verification.
No enrichment endpoint, research-refresh job, broker sync or live provider call
was invoked. Existing unrelated edits were preserved. The shared market-data
change is additive evidence only, not a scanner or risk calculation change.

### Verification

* `npx vitest run src/lib/candidate-outcome-coverage.test.ts src/lib/candidate-outcome-enrichment.test.ts src/lib/market-data.test.ts src/lib/market-data.trigger-window.test.ts src/lib/market-data.enrichment-evidence.test.ts`: 53 tests passed across five suites.
* `npm run typecheck`: passed.
* Scoped ESLint and editor diagnostics for the four changed code/test files: passed.
* Mocked provider and database checks cover retries, preserved zero returns,
	conflicting prior horizons, concurrent writes, invalid arguments and errors.
* The Yahoo boundary test checks unchanged existing fields and ordering, missing
	adjustment evidence, preserved cache evidence and one provider call.
* An advancing-clock test covers a provider fetch completing after batch start.

### Limits and next observation

These are conditional price outcomes, not trade activation, realized profit or
captured winner returns. Excursions still include moves after a stop touch.
Entry/stop currency and historical price-basis provenance are not independently
certified. A matching anchor alone does not verify instrument identity or units.
No experiment or holdout comparison has been run.

Weekdays are not exchange calendars. Missing holiday sessions conservatively
truncate windows; the global cutoff also rejects some legitimate intraday or
earlier regional-close scans. Rejected rows retain their existing enrichment
timestamp. Oldest rejected rows can occupy a full batch and delay later rows;
`BATCH_LIMIT_WITH_SKIPS` exposes this limitation but does not fix scheduling
fairness. No persistent retry state or schema migration was introduced.

The cohort date is a write boundary, not a durable algorithm-version marker.
Existing complete rows are not revisited, and existing excursion fields on a
partial cohort row can be replaced when its full window first completes.
Consumers must not interpret nonnull `enrichedAt` as complete or research-grade
coverage. This change does not remediate the separate legacy trade-link backfill.

Next, observe the already scheduled routine job after the cohort reaches the
eight-calendar-day minimum age. Check for successful horizon advances and
rejection reasons, especially batch-cap warnings; inspect records read-only.
Do not manually invoke the combined refresh or default analytics POST to test
this repair, because those paths also invoke legacy backfills. Live coverage,
real database concurrency, exchange calendars and fair retry scheduling remain
unverified or deferred. Historical repair needs a separate reviewed proposal.

## 2026-09-11 enrichment batch progress

### Scope and decision

Supersedes the oldest-rejected-row starvation limitation in the preceding entry.
[Candidate enrichment](../src/lib/candidate-outcome-enrichment.ts) now stores a
keyset cursor under `candidate-outcome-enrichment.cursor.v1` in the existing
AppSetting table. No schema migration is needed. Eligible rows are selected in
ascending ID order after that cursor, up to the existing per-call row limit.
An empty tail wraps to the start of the eligible cohort. A short final page is
not padded, so each run processes at most one bounded page.

Selection and cursor advancement commit in one short transaction before any
provider requests. Rejected rows, unchanged partial horizons and provider errors
therefore no longer keep selecting the same first page. The outcome write guards,
null-only return completion, prospective date boundary and data-quality rules
are unchanged. Removed the obsolete `BATCH_LIMIT_WITH_SKIPS` warning.

### Verification

* `npx vitest run src/lib/candidate-outcome-cursor.test.ts src/lib/candidate-outcome-coverage.test.ts src/lib/candidate-outcome-enrichment.test.ts`: 27 tests passed across three suites.
* `npm run typecheck`, scoped ESLint, editor diagnostics and scoped diff whitespace checks: passed.
* Five tests use real Prisma against a disposable SQLite database containing
	only the two required table projections; no production Prisma initialization
	or production database connection is used.
* Database tests cover persistence across reconnects, successful later-row
	outcome writes, historical and immature exclusions, deleted cursor rows,
	newly inserted earlier IDs, concurrent claims and cursor-write rollback.
* Mocked tests cover row limits, rejected and failed pages, wraparound, empty
	cohorts and stopping before provider work when cursor persistence fails.

### Risk and operational limits

This changes analytics scheduling order, not execution, ranking, risk limits,
broker state or sacred files. Production jobs were not invoked; the production
cursor will be created on a future eligible routine invocation. No live records,
historical outcomes, schema, scheduler settings or holdout evidence were changed.

Progress assumes recurring successful invocations and a backlog whose arrival
rate does not indefinitely outrun processing capacity. ID order is not age or
profit order. A process crash after claiming a page delays those rows until the
next sweep. SQLite contention may reject a claim loudly; it is not swallowed or
reported as successful. A full sweep may revisit an in-flight row, so the existing
expected-state outcome write guard remains necessary. This is not an exactly-once
queue or a per-row retry audit. The cursor version identifies traversal state,
not the version or quality of stored labels.

Next, observe cursor movement and outcome progression read-only after routine
batches become eligible. Do not invoke combined refresh/default analytics POST
for testing, because those paths also run separate legacy backfills. Production
throughput and provider coverage are unverified. Exchange calendars, price-unit
provenance and the historical reconciliation backlog remain separate work.

## 2026-09-11 entry-quality measurement

### Evidence and scope

Continued the authorized profit-improvement investigation with entry evidence,
not looser gates or increased exposure. Read-only SQLite inspection found fifteen
automated ENTRY logs across eight dates, with a mean planned-trigger-to-fill gap
of 1.6283% and 0.4658 planned-risk units. Seven exceeded 0.5 planned-risk units.
These include open positions and unresolved closures, not fifteen independently
verified realized outcomes. The [entry-quality review](../reports/entry-quality-review-2026-09-11.md)
records measurements, assumptions and next research steps. No candidate holdout
outcomes or ranking comparisons were queried.

### Implementation and verification

Fixed execution-drag's exclusion of TAKEN entries and added ENTRY-only selection.
Replaced dimensionally invalid model-R subtraction and unconverted per-share GBP
cost estimates with nulls. Explicit planned prices and actual fills are required
for measurements; missing values do not become zero. Added signed entry-gap R,
coverage counts, distinct dates and response caveats. Existing field names remain,
but shared summary types now correctly permit null. Timing is not inferred from
log-write dates. The separate execution-audit dashboard is unchanged.

Replaced copied-formula tests with production-module tests and added API route
serialization tests: 26 passed. Typecheck, scoped ESLint and diagnostics passed.
One recorded ATRC example verifies use of planned risk rather than fill-based
initialR. An initial patch was rejected without changes due to duplicate file
paths; an in-place replacement succeeded. A shell-quoted SQL attempt failed
before execution; the subsequent read-only query succeeded.

### Risk and next work

Changed only execution-drag, its tests, response types and research documentation.
No live orders, risk rules, sacred files, database writes or scheduler settings
changed. External API consumers must handle corrected null values. Price-unit
and adjustment provenance, spread and contemporaneous decision quotes remain
unverified. No recoverable GBP profit or live threshold is inferred.

Next, establish exact decision-quote-to-fill evidence and freeze one prospective
shadow entry challenger before evaluating it. Include missed fills and costs,
not only trades that execute. Winner-capture research still requires reconciled
exits and trustworthy holding-window prices. No strategy change has been proven
to increase profit by this work.

## 2026-09-11 prospective entry reference evidence

### Decision and implementation

Continued entry-quality work with observational capture, not a live challenger.
Auto-trade now retains the forced-refresh reference price, batch request window,
local evaluation time and exact decision identity for kept and skipped candidates.
Existing BUY_PLACED and BUY_FAILED JSON payloads carry the same reference and
local submission-start time. Broker request arguments are unchanged. The small
fetch wrapper preserves the original price object and empty-price error path;
it timestamps completion before any remaining technical-data wait.

Source is explicitly GET_BATCH_PRICES; price basis is UNVERIFIED and executable
quote status is false. Provider time, bid and ask remain null. The same exact
decision ID survives into successful or failed submissions. Missing capture stays
null, including callers outside this orchestration. No schema change is needed.

Checking direct log consumers found a necessary compatibility repair: watchdog
counted all log rows as buy attempts. New KEEP observations would mask its
zero-buy warning. Its count now accepts only BUY_PLACED and BUY_FAILED, retaining
the existing time window and warning conditions. No restart behavior changed.

### Verification and boundaries

Production-function tests cover submission success and rejection, unchanged buy
and stop arguments, missing capture, visible log persistence failure, forced
refresh and async observation timing. Existing anti-chase and stop retry suites
pass. Real Prisma queries against a disposable SQLite fixture prove observation
and stop logs do not suppress the watchdog alert and verify submission-window
boundaries. No production database or external service is used by those tests.

The first typecheck caught the KEEP union having no reason; its evidence now
records null and typecheck passes. No live trading or provider jobs ran. The
full scheduled loop is source-inspected, not tested end to end. A kept candidate
adds an awaited best-effort log write and possible database latency; failures
remain visible but leave incomplete research evidence. Sacred files, orders,
sizing, risk limits, stops, scheduler settings and historical records are unchanged.

Next, verify exact log linkage read-only after routine execution. Establish
executable quote and fill provenance before freezing an entry challenger; these
reference records alone cannot establish feasible limit fills or profit uplift.
The [entry-quality review](../reports/entry-quality-review-2026-09-11.md)
contains payload semantics and manual verification steps.

## 2026-09-11 fill provenance and collection check

### Evidence and change

Read-only SQLite inspection at 14:34:38.612Z found 208 ExecutionLog rows, zero
version-1 entryReference payloads and zero malformed request JSON values. No
live linkage could be verified and no trading job was invoked to create data.

The next local evidence gap was fill-price provenance: pending-order polling
can substitute planned entry for missing filled value, while history helpers
can apply their own fallbacks. Added fillEvidence to COMPLETE responseBody,
identifying pending value/quantity, planned-entry fallback, history helper or
timeout recovery. It captures local observation time before stop handling,
used price/quantity, user and decision ID. Broker execution time remains null
and price basis remains UNVERIFIED. No label certifies independent fills.

### Verification and limits

All four routes are exercised through production executeTrade with fake broker
responses and timers. Tests assert unchanged buy and stop arguments, cancellation
only on timeout, and observation time independent of later stop processing.
The focused attribution, stop-retry and timeout suites passed 47 tests; typecheck,
scoped lint and editor diagnostics passed. Live orchestration was not run.

This adds no provider calls or log rows and changes no trade values, acceptance
rules, stops, sizing, gates, schema or historical records. Failed completion
logging still leaves missing evidence. The existing dashboard does not consume
the new provenance; historical reported fills are not retrospectively certified.
Next, inspect routine capture read-only, then assess evidence sufficiency before
selecting a prospective entry challenger. Profit improvement remains unproven.

## 2026-09-11 provenance-aware execution-drag analytics

### Scope and behavior

Made the existing execution-drag API consume COMPLETE fillEvidence through exact
trade-log and position identities. Supported source payloads must agree with the
entry user, ticker, stored fill and shares; order ID and account label must be
present and valid. Known planned-price fallbacks no longer count as actual fills
or contribute a false zero to entry-gap averages. Invalid linked evidence and
duplicate completions are excluded. Legacy values remain explicitly unverified.

Added record source status and summary source counts to the shared types, with
production-calculator and API regressions. Unreadable trade IDs cannot be linked;
no nearby-date fallback is attempted. Source labels certify neither broker price
basis nor actual account reconciliation. Details and manual follow-up are in the
[entry-quality review](../reports/entry-quality-review-2026-09-11.md).

### Verification and remaining limits

The initial fallback check passed; five parameterized cases had an array-spreading
fixture defect, corrected before proceeding. The final focused run passed 50
tests across the calculator and API suites. Typecheck, scoped ESLint and editor
diagnostics passed. Prisma queries were mocked; no live endpoint or production
job was invoked. No schema, stored history, execution rules, sacred files or
automation changed. Existing unrelated edits remain untouched.

This corrects the read-only report, not the separate execution-quality dashboard.
Next, inspect evidence from routine execution read-only before selecting an entry
policy experiment. Profit improvement and executable-price evidence remain unproven.

## 2026-09-11 trading health blocker and sector preservation

### Observed operational blocker

Read-only SQLite inspection at 18:01:29.892Z found 208 execution logs, 15
completions, no version-1 entry references and no fillEvidence payloads. Scheduled
trading tasks had run successfully. The September 11 US logs reported BULLISH
with 7 READY candidates at 14:45 UK and 9 at 17:00 UK, then stopped at Health: RED.
These are pre-gate candidates, not established missed fills or lost profit.

The latest stored health report, September 10 at 20:06:47.775Z, had one RED check:
A7 Sector Coverage, with PRTS missing sector on one of two open positions. The
prior report also had a sleeve-limit breach, absent from the latest result.
PRTS has null Stock.sector but Consumer_Discretionary cluster and CONSUMER_DISC
super-cluster, consistent with checked-in planning maps. This identifies a
metadata gap, not permission to weaken health or concentration checks.

### Code change and verification

The HIGH_RISK seed path supplies null sector, and the stock upsert previously
wrote that null to existing rows. Changed only the update sector assignment to
omit the field when its source value is null. Explicit source classifications
still update; creation with an unknown sector remains null. This prevents future
reseeding from erasing populated sectors; it does not populate missing sectors.

Added production seed-module tests with mocked Prisma, planning files and password
hashing. They inspect actual upsert arguments for HIGH_RISK, ETF, HEDGE and CORE
rows, including PRTS identity/cluster preservation. An incorrect test import was
caught by typecheck, corrected, and all checks rerun. Final result: 60 tests across
four seed/health suites passed; typecheck, scoped lint and editor diagnostics passed.

### Live boundary and next action

Requested explicit approval for a targeted PRTS live metadata correction because
it can permit future automated entries. The user was unavailable, so only code
and tests were changed. No seed, health, broker or trading job was invoked; no
database records, gates, sacred files or task settings changed. Live health remains
unresolved. Do not run the full seed as a substitute for a one-row repair.

Next, approve and apply a guarded correction of PRTS's missing sector, supported
by its classification evidence, then let routine health recompute all checks.
Do not overwrite a populated sector, manually force GREEN, or assume other gates
will pass. Wider sector taxonomy inconsistencies were observed but not changed.

## 2026-09-11 approved PRTS metadata correction and combined verification

### Authorization and guarded repair

The user subsequently asked to complete the pending work autonomously while away.
Applied the previously described PRTS-only metadata correction under that request.
Immediately before repair, the latest routine health report at 20:04:23.781Z
still had only A7 RED, and PRTS's sector remained null.

Created a consistent SQLite backup before the write:
`prisma/backups/dev.db.before-prts-sector-2026-09-11T21-12-06-420Z.backup`.
Its quick_check returned ok. An immediate transaction required the exact PRTS ID,
null sector, Consumer_Discretionary cluster, CONSUMER_DISC super-cluster and the
previously inspected updatedAt value. A mismatch would abort rather than overwrite
concurrent changes. Updated exactly one Stock row at 21:12:10.133Z, changing sector
to CONSUMER DISCRETIONARY and updatedAt. Full-row comparison inside the transaction
confirmed that no other fields changed.

An independent read-only connection confirmed the committed value, sector coverage
for both open positions (ATRC and PRTS), and live SQLite quick_check = ok. The
stored health report remained RED and was not rewritten. The normal health process
must reassess all checks; this correction is not a promise that trading will pass
other gates. No seed, health, broker, trading or enrichment job was manually run,
and no task settings, positions, trade history or risk thresholds were changed.

### Combined verification and outstanding evidence

All 382 tests passed across 22 affected application suites, covering accounting,
attribution, enrichment, execution analytics, execution protections, watchdog,
health and seed behavior. All 26 Node research-tool tests and the project
typecheck passed. Existing nonblocking node-cron sourcemap and Node module-type
warnings remain; no dependency or module-system changes were made for them.

Implementation and the targeted metadata correction are verified. Remaining
milestones require observation or independently reconciled data: routine health
reassessment; prospective entry/fill capture and exact linkage; historical closure
exception reconciliation; executable price and missed-fill evidence; and a frozen
out-of-sample strategy comparison. No profit uplift is established. The separate
execution-quality dashboard and broader sector taxonomy are unchanged. Do not
invoke legacy approximate backfill or loosen safety gates to accelerate evidence.

## 2026-09-11 exact recovery and health reassessment

### Scope and implementation

Continued under the user's instruction to finish the remaining work. Replaced
the legacy ticker/date candidate backfill in
[candidate-outcome.ts](../src/lib/candidate-outcome.ts) with recovery from explicit
COMPLETE execution-log scan, trade and position identities. Both existing callers
(scheduled research refresh and analytics POST) now use this recovery path.
No combined research job or production attribution backfill was invoked.

Recovery validates the trade's user against the scan, ENTRY/TAKEN status, ticker,
position identity, positive stored fill and scan timing inside the transaction.
It rejects missing or duplicate completion identities, competing trades claiming
one candidate and existing conflicting links. It updates only unlinked rows and
counts zero on a repeat. A source label or exact link does not independently
certify a broker fill's price basis. Legacy entries remain unattributed.

Maintenance query/write failures propagate to callers; the live execution linker
retains its logged, best-effort failure behavior so attribution cannot interrupt
order protection. No strategy parameter, sacred file, schema or order logic changed.

### Operational result and side effects

A read-only preflight at 22:09:48Z confirmed PRTS's populated sector, the old RED
report and 208 execution logs with no version-1 entry/fill evidence or exact
completion identities. Ran the existing standalone health evaluator for the
account owning the latest report after verifying the database target. It appended
a computed report at 22:11:12.457Z: overall YELLOW, A7 GREEN, with both open
positions classified. No historical health report was overwritten or forced GREEN.

The remaining YELLOW checks are C3 position size, G2 cluster concentration and
G3 sector concentration. Allocation warnings were not suppressed and no holdings
were sold or resized. This supersedes the earlier pending health-reassessment
milestone and the earlier statement that no health run had been invoked.

Importing health-check also triggered market-data's existing delayed startup
historical pre-cache unexpectedly. It completed for 1,073 tickers, with zero
failures in 234.2 seconds. This was additional market-data work, not a broker or
trading job. Future bounded standalone checks must set
`HYBRIDTURTLE_SKIP_STARTUP_PRECACHE=true` before importing market-data dependants;
normal automation defaults remain unchanged. Independent read-back confirmed
the saved YELLOW report, unchanged 208 execution logs, 28 closed and two open
positions, and SQLite quick_check = ok.

### Verification and remaining evidence

The combined regression run passed 349 tests across 20 application suites before
the final competing-claim case was added. The subsequent focused run passed all
52 tests across exact-link unit tests, isolated SQLite/API recovery tests and
automated execution attribution. The 26 Node research-tool tests, typecheck,
scoped ESLint and editor diagnostics also passed before that final small addition.
The SQLite tests use the real Prisma queries and actual analytics POST, including
reconnect/retry persistence; no test uses the live database. The first fixture run
caught an integer ExecutionLog primary-key mismatch, corrected before passing.

Read-only reporting at 22:15Z still found all nine historical closure exceptions.
Coverage at 22:17Z was 84,116 candidate rows across 69 dates, with 11,462 twenty-day
labels across only ten dates and zero linked entries. Coverage is not evidence
that historical labels or prices are suitable for strategy selection. No held-out
return comparison, threshold tuning or profit uplift claim was made.

The [completion ledger](../reports/entry-quality-review-2026-09-11.md#completion-ledger)
records remaining prerequisites. Historical broker reconciliation needs missing
account-scoped fills. Historical/manual attribution cannot be reconstructed from
the current manual confirmation payload, which has no exact scan identity.
Prospective collection, enrichment throughput and out-of-sample validation still
need observations not present today. These milestones are not complete.

Final verification after the competing-claim guard passed 350 application tests
across 20 suites, project typecheck, scoped ESLint, editor diagnostics and
git diff --check (only the pre-existing unrelated VRP line-ending warning).
The 26 research-tool tests passed earlier in this continuation. Full-row hashes
against the retained pre-PRTS-repair backup matched for all 30 Position rows and
145 TradeLog rows, independently confirming unchanged accounting records.

## 2026-09-12 isolated trading simulation

### Scope and implementation

Started the simulation programme authorized by "Go for it". Corrected the
backtest-only stop fill to include adverse opening gaps and bounded stop
evaluation by the selected time exit. Removed post-exit close contamination
from close-based excursions. Stop thresholds and all live execution rules stay
unchanged; no sacred files or production data were edited.

Added an opt-in historical harness with a disposable SQLite backup, account-table
removal, August-onward exclusion, a query-only Prisma client, blocked network
access and before/after sandbox byte verification. Added a connected synthetic
exact-attribution, closure-evidence and analytics fixture. Its entry and closure
persistence are supplied by the fixture, not a full broker workflow.

### Results and decisions

The [simulation report](../reports/trading-simulation-2026-09-12.md) and
[JSON results](../reports/trading-simulation-2026-09-12.json) record the fixed
May-June development experiment: two existing modes, three cost assumptions,
with and without deterministic omitted entries. Nine funded trades across four
dates is not enough to select a strategy. FULL and CORE_LITE aggregates match.
Baseline modeled closed P&L is GBP184.19 at zero costs, GBP68.52 at 0.25%/side,
and -GBP51.56 at 0.5%/side. All-signal evidence remains INCONCLUSIVE/PARTIAL.
Do not raise risk or position limits, claim improvement, or tune against this
result. August data was excluded before evaluation; no holdout result was used.

### Verification and boundaries

The historical harness passed all six checks, including zero network calls,
rejected sandbox writes and identical pre/post sandbox SHA256. Default replay
and stress checks passed 45 tests, with the opt-in historical test skipped as
intended. The separate connected evidence fixture passed. Existing operational
scenarios passed 283 tests across 14 suites. No live broker or research job ran.

Simulation does not recover missing historical fills or certify executable
prices. Prospective manual attribution and dashboard integration remain software
work, not historical-data blockers. Alternative entry/exit strategies, policy
parity, data-basis validation, full scan-to-close integration and independent
holdout/shadow evaluation remain outside this first completed simulation phase.

Final project typecheck, scoped lint for all four touched code/test files,
editor diagnostics and git diff --check passed. The latter emitted only the
existing unrelated VRP line-ending warning. Report values were checked against
the generated JSON and local documentation links resolved. Verification totals
by distinct slice: 40 replay tests, six opted-in harness tests, one connected
evidence test, and 283 operational component tests. The full repository suite
was not run.

## 2026-09-12 documentation and repository handoff

Updated the completion ledger with the completed offline simulation, its
cost-sensitive results and the next priority: policy-aligned replay with explicit
price-basis and evidence-coverage checks. Manual attribution and dashboard
integration remain software tasks; missing broker records remain a separate
historical reconciliation requirement. No additional trading changes are part
of this documentation handoff.

The requested commit includes the accumulated accounting, attribution,
enrichment, execution-evidence and simulation work with tests and reports.
Exclude pre-existing ready-to-buy edits, runtime VRP data and the untracked PDF.

Publication checks passed 396 tests across 23 scoped Vitest suites, with the
opt-in historical database replay skipped as intended, plus 26 research-tool
tests. Documentation links and diagnostics passed. The staged-file exclusion
check and common credential-pattern scan passed. The required risk-sensitive
change-log entry records auto-trade evidence capture and preserved behaviour.
The full repository suite was not run for this publication step.

## 2026-09-12 trade lifecycle diagnosis

Investigated the user's losing trade-history chart in read-only mode. The
[trade-by-trade report](../reports/trade-lifecycle-review-2026-09-12.md)
reproduces 25 measured closures, nine wins, fifteen losses and one flat,
totaling -3.6912R. Eleven measured automated entries contribute -5.2892R
across six entry dates. Imported positions have different entry periods and
5%-of-entry stored risk distances, so the source split is not a strategy test.

Seven automated losers have sparse logged closing-price references below
+0.45R; CLDX lacks such a reference. Cached interior-session closes for
CLDX, HAYW and ETSY are all below entry. This supports investigating entry
follow-through without proving invalid entries or selecting new thresholds.
SCHW's cached exit-session open of 108.25 is below the logged 110.84 stop and
near the stored 108.21 fill, supporting gap risk over an assumed large
avoidable execution loss. Broker stop/fill sequence verification remains open.

Added a date-specific, read-only report verifier. It passed all 25 trade rows,
eleven entry gaps, eleven cached-coverage rows, SCHW exit-session prices,
the baseline total and local report links. Cached data has incomplete coverage;
SCHW has adjustment-basis variation. No historical outcomes were repaired,
no market or broker request was sent, and no live rule or risk gate changed.
Actual August/September held-position outcomes were inspected, but reserved
candidate forward labels and holdout policy comparisons were not. These
observed trade outcomes are development evidence, not an unseen validation set.

## 2026-09-12 entry policy resolution attempt

The user requested resolution of the lifecycle findings. Added a research-only
necessary-condition screen and integrated it with the existing isolated replay.
The [resolution report](../reports/entry-policy-resolution-2026-09-12.md)
and retained JSON distinguish observable rejections from incomplete eligibility.
Production classifier parity is tested; no live rule, sacred file or database
record changed. Existing unrelated edits remain untouched.

The replay's 1,224 May-June trigger crossings match exact ticker/timestamps.
At the existing 0.15 session-volume threshold, 921 fail observable necessary
conditions and 303 remain incomplete. Other existing execution thresholds
leave 291-296 incomplete candidates. The modeled subsets fund 9-10 trades on
4-5 dates and lose GBP 96.03-117.78 at 0.5% cost per side. This does not validate
a strategy change, prove historical rule violations or justify removing filters.
Snapshot defaults, recomputed scores and missing execution/portfolio evidence
prevent full policy parity. No reserved August candidate outcomes were used.

Final replay/screen tests passed 35/35; screen/classifier tests passed 64/64.
Typecheck and scoped lint passed. A duplicate report write was refused by the
existing exclusive-write guard; a clean rerun without report output passed.
The baseline fingerprint and nine reconciliation exceptions remain unchanged.
Full historical reconciliation requires account-scoped broker fills; SCHW also
requires stop amendment/acknowledgement history. No historical correction or
profit uplift is claimed. The report records the specific export requirements.

## 2026-09-12 broker evidence recovery and closure selector fixes

The user was unavailable and requested autonomous continuation. A GET-only
account-summary probe confirmed the existing live ISA identity and GBP currency.
A tested, explicitly opted-in collector retained raw and normalized broker
history in Git-ignored backups without printing credentials or raw account ID.
The initial eight-page archive was incomplete. A second bounded collection
exhausted history at 15 pages and 749 records. This supersedes the earlier
export-unavailable blocker; no manual export is needed for the nine proposals.

Complete archive SHA-256:
`0a41156bd2f757e48f531d8eca86ea7d4f3a9852e1c293cd0318abb772be2e1b`.
Across the successful probe and two collections there were 26 GET requests.
Initial TypeScript loader failures made no network calls; CommonJS with tsx
resolved them. Existing quota telemetry updates are expected.

The actual dry run exposed two false rejections in closure-evidence: cancelled
sells with zero execution totals and no fills, and later same-ticker lifecycles
included in an earlier closed position. Surgical fixes preserve all quantity,
fill-ID, conflict, GBP and holding-window requirements. Tests passed 43/43 for
closure/sync and 8/8 for the collector boundary. Typecheck and lint passed.

All 28 closed positions now yield closure candidates; 19 other GBP outcomes
match. The [broker-supported proposal](../reports/broker-closure-proposal-2026-09-12.md)
lists nine corrections, which would change the displayed subtotal to -4.905926R
and GBP -42.36 across 28 measured closures. No historical writes were made;
review and backup-backed expected-old-value application remain necessary.
SCHW's exact STOP order confirms stop 110.84, fill 108.21 and GBP -1 P&L.
No risk/entry/stop strategy change, broker order mutation, commit or push occurred.

## 2026-09-12 approved historical closure corrections applied

The user approved the nine broker-supported corrections with "Go for it" after
the explicit accounting approval request. Added a standalone, dry-run-default
repair pinned to the reviewed archive and nine position/order identities. It
checks account scope and approved outcomes, verifies a fresh SQLite backup,
records the exact intended changes and uses an atomic Prisma transaction with
full target-snapshot rechecks and postconditions. No broker client is invoked.

All 13 tests passed, including actual-copy backup fidelity, forced rollback,
scope preservation and byte-identical repeat application. Initial rehearsal
failures exposed Windows handle cleanup masking the actual assertion and tiny
Prisma float serialization differences; both were resolved before live writes.
Numeric postconditions use absolute tolerance 1e-10; identity, dates, archive
hash and stale snapshot checks stay exact. Typecheck and scoped lint passed.

Live application changed exactly nine closed positions, updated six exit logs
and created three missing exits. Independent backup comparison confirmed all
other positions/logs and stop history unchanged, with original risk, entry,
shares and stops preserved. Integrity is ok. Repeating apply returned zero
pending, nine already applied and zero writes. Final totals: 28 measured,
10 wins, 18 losses, -4.9059260508793R total and GBP -42.36. CCRN remains a market
exit, not a stop hit. These are corrected past results, not profit improvement.

Recovery directory: `prisma/backups/closure-corrections-2026-09-12-approved/`.
Backup SHA-256: `2f5e09a9733f8f3bc92b3ac2d2802b857af35828023eb898f2fdf443fb071cae`.
Backup, exact intent and receipt are Git-ignored. The
[application report](../reports/broker-closure-applied-2026-09-12.md) supersedes
the pending-approval status above. Reproduce the old lifecycle report or repair
rehearsal using this pre-repair backup, not the corrected live database.
Dashboard browser rendering remains a manual check. No commit/push, live
strategy change, broker request or automation change occurred in this step.

## 2026-09-13 automation repair pending administrator application

Read-only inspection found all 17 expected tasks present, but the watchdog ran
only at 10:05, all tasks had wake disabled and 15 used interactive-only logon.
Two recent nightly runs completed core work without delivering their summary;
the latest log showed Telegram rejecting unescaped HTML. The watchdog's text
audit parser also dropped task names containing spaces.

Escaped nightly summary fields and comparisons, made delivery failure visible
in step results, and added a separate watchdog notification check without
changing core trading-health semantics. Scheduler findings now use validated
JSON, and runtime inspection checks unattended settings and afternoon watchdog
coverage. Invalid audit output is reported as unknown health.

Added a preview-first PowerShell repair with original XML backups, stale-state
checks, post-registration verification and attempted rollback. It preserves
owners, actions, trading schedules and limits. Register-all now includes the
heartbeat, corrects the relevant time-limit defaults and ends with the repair.
The XML fixture and scheduler tests passed (74 tests), live preview passed for
17 tasks, and live read-only inspection correctly found the remaining drift.
Typecheck and scoped lint passed. No live task definition was changed.

Administrator application remains blocked in this non-elevated session. Follow
[the scheduler repair procedure](SCHEDULER-AUDIT.md#unattended-operation-repair),
then verify the audit, signed-out/sleep recovery and the next nightly delivery.
No trading job was manually run, no broker action or strategy change was made,
and no commit or push was requested for this repair.

## 2026-09-13 live scheduler verification and publication approval

After the user performed the administrator step and reported a clean audit,
an independent `node scripts/audit-scheduled-tasks.mjs --json` returned `[]`
with exit code 0. The prior administrator blocker is resolved: all 17 tasks
pass the configured checks, including unattended settings and watchdog timing.
The combined automation regression suite passed 114 tests; typecheck, scoped
lint and PowerShell syntax checks also passed.

The user authorized committing and pushing the automation repair. Publication
excludes the unrelated ready-to-buy changes, VRP telemetry, reference PDF and
private task/database backups. Signed-out execution, wake from sleep and the
next nightly Telegram delivery remain operational checks, not verified outcomes.

## 2026-09-22 Typesafe candidate-evidence pilot

Implemented the approved advisory-only background pilot after the user selected
minimal candidate evidence, weekday 15-minute checks, five candidates per scan
and 20 requests per London day. The feature remains disabled by default; no key
was inspected, live provider request sent or scheduled task registered.

The pinned Typesafe SDK/model use allowlisted technical claims and market facts,
strict input/output validation, no retries, redacted errors and fixed-origin
transport. A read-only SQLite reader selects exact scan-time provenance without
market/broker imports, future outcomes or mutable score backfills. A separate
fsynced ledger reserves quota before sending, deduplicates across restarts, caps
each scan even if its shortlist changes, and fails closed on corrupt accounting,
write failures, overlaps or clock rollback. Lock recovery is deliberately manual.

Added the one-shot worker, authenticated read-only endpoint and compact scan-page
advisory section. Existing scan responses/cache now retain optional scan IDs.
Old caches are still viewable but never matched by ticker alone. Browser results
are bound to exact scan identity; changed/stale evidence suppresses answers and
old in-flight responses cannot overwrite a newly selected scan.

Added only the optional pilot's batch launcher, task registrar and read-only audit.
The task definition uses S4U/limited privileges, IgnoreNew and a five-minute limit;
it is excluded from mandatory trading-health task manifests. SDK installation
and runtime SQLite dependency classification changed package metadata only.
No sacred files, schema, live trading records or existing task definitions were
edited. Pre-existing ready-to-buy changes, telemetry and reference PDF were left
untouched. Setup and recovery are in [TYPESAFE-INTEGRATION.md](TYPESAFE-INTEGRATION.md).

Verification: 229 focused tests passed; the full unit suite passed 2,261 tests
across 162 files with two existing opt-in tests skipped. Typecheck, scoped ESLint
and editor diagnostics passed. Four Pester 5.7.1 scheduler tests passed with mocked
registration, including quoted paths and child exit status. The real CLI returned
DISABLED and the compiled HTTP endpoint returned DISABLED without provider access.
Browser checks at 1440px and 375px passed for the new section's fit, keyboard
disclosure and old-response suppression using synthetic fetch responses. Preview
used a disposable database; initial route-interception misses produced missing
fixture-table errors, resolved for UI checks by stubbing fetch before page scripts.

Still unverified: live provider quality/key/billing/retention, real-snapshot
coverage, unattended S4U execution and first scheduled result. Upstream price-unit
correctness is not independently certified by this pilot. Installation reported
18 dependency vulnerabilities (3 low, 2 moderate, 9 high, 4 critical); no unrelated
dependency upgrade was attempted. Activation is a separate local credential and
operational check, not inferred from passing mocks. No commit or push performed.

## 2026-09-22 Typesafe controlled activation and health diagnosis

After implementation, the user configured the API key locally. Configuration
checks exposed only presence/validity flags, never the key. Initialized the
durable ledger and completed one authorized synthetic provider request with a
validated SUPPORTED response. This establishes authentication, not model quality,
billing or retention. Manual worker enablement was limited to child processes;
the saved configuration remains disabled and no pilot task was registered.

Ran the normal guarded dashboard scan using existing stored settings. The HTTP
client disconnected before completion; the scan continued and its saved snapshot
was verified before proceeding. No duplicate scan was submitted. The subsequent
real worker run returned INCOMPLETE_EVIDENCE and saved five exclusions without
additional paid requests. The ledger retained one total attempt and released its
lock. No order endpoint was invoked or trading setting changed.

Read-only diagnosis traced every shortlisted BLOCKED_DATA grade to RED system
health, caused by the CORE sleeve cap. Stored entry-value allocation reproduced
82.74% against the 80% limit; all open positions used USD. The health check uses
entry price times shares, not cash-inclusive equity or current market values.
Seven existing sleeve-limit tests passed. No health records, risk rules, holdings
or sacred files were changed to obtain a review.

Updated the integration guide with the verified activation state, worker versus
candidate status names and health-gate troubleshooting. A successful eligible
real-candidate assessment, its live deduplication check and unattended scheduling
remain pending. Preserve the ledger and existing safety policy when resuming.