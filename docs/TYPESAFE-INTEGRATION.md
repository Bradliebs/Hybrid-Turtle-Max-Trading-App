---
title: Typesafe Candidate Evidence Pilot
description: Configuration, boundaries, verification and recovery for the optional advisory worker.
---

## Scope

The pilot reviews narrow technical claims against persisted scan-time evidence.
It cannot change grades, rankings, position sizes, risk gates or stops. The one
exception is the opt-in auto-trade veto described below, which can only remove
a buy that already passed every rule.
Scanning and existing automation do not depend on Typesafe availability.
The scan page reads saved results; opening it never requests an assessment.

The pilot is **disabled by default**. Implementation tests use synthetic evidence
and mocked provider responses. They do not establish model accuracy, key validity,
account billing, live evidence coverage or unattended scheduler success.

## Validation Status as of 2026-09-22

Local activation checks verified authentication with one successful synthetic
provider request. The durable ledger was initialized. On 2026-09-23 the pilot was
enabled and `HybridTurtle-TypesafeReview` was registered from an administrator
terminal; the audit passed and the first scheduled run exited 0 with
`NO_RECENT_SETTLED_SNAPSHOT` (no provider request). Shadow mode only: no trading
path reads the results.

A normal dashboard scan completed and persisted. Its five shortlisted candidates
were all graded `BLOCKED_DATA` because the saved system health was RED. The review
worker returned `INCOMPLETE_EVIDENCE`, saved five `INSUFFICIENT_EVIDENCE` records
and sent no additional provider requests. This verifies the exclusion path, not
a successful real-candidate assessment or model accuracy.

Subsequent operational recovery refreshed broker state through the existing
dashboard sync and refreshed portfolio prices. Three ISA holdings were updated;
none were created or closed, and no broker orders were submitted. System readiness
moved from BLOCKED to WARNING with a current sync timestamp and three fresh cached
prices. A new health check remained RED: CORE was approximately 98% of invested
entry value against the 80% cap. That allocation block remains in force; successful
publication checks do not imply permission to trade or activate the pilot.

The next activation gate is an eligible real-candidate assessment, followed by
deduplication verification and an explicitly enabled, audited scheduled run.
Billing, retention and unattended execution remain unverified. Do not repeat
initialization or the synthetic request merely to resume activation.

## Limits and Evidence

* The independent worker checks every 15 minutes. It exits before database or
  provider access on weekends, using the Europe/London calendar including DST.
* It selects the latest scan for one configured user, aged two minutes to one hour.
  The settling interval allows separately persisted provenance to arrive.
* It reviews at most five candidates per scan and 20 requests per London day.
  Failures, timeouts and unknown crash outcomes consume quota. Requests are
  sequential, have a ten-second timeout, and are never automatically retried
  for the same scan/candidate. A run has a 110-second deadline.
* Selection uses persisted rank order, passing filters and READY, WATCH or
  WAIT_PULLBACK status. It does not reorder trading candidates. Candidates outside
  this shortlist have no assessment.
* Missing, stale, conflicting or withheld evidence produces a local insufficient
  status without a provider call. Incomplete evidence can be checked again before
  the scan expires. Changed evidence after a paid attempt invalidates the answer
  without buying another assessment.
* Only known technical grade-reason templates are eligible. Risk/account reasons,
  arbitrary text and appended instructions are withheld. This first version does
  not review the entire grade or stage-six account/health explanations.

Outbound fields are ticker, regime, price, MA200, entry trigger, ADX, persisted
NCS/BQS/FWS, volume ratio, relative strength, source timestamps, an approved
technical claim and deterministic price comparisons. Credentials are used only
for the Authorization header. Account IDs, user IDs, scan IDs, holdings, balances,
suggested shares, trade history and future outcomes are not sent as evidence.

The reader opens SQLite read-only and matches provenance by exact scan and ticker.
It does not fetch market data or fill gaps with display defaults. The pilot does
not independently certify price-unit provenance or market truth; do not interpret
a consistency result as proof that an upstream normalization was correct.

The pinned SDK is `@typesafe-ai/sdk@0.6.0`, model `jev-1.13.0`, at the fixed HTTPS
endpoint `https://api.typesafe.ai/v1/systemone`. Redirects and SDK retries are
disabled. Input and output are validated; payloads over 16 KiB are rejected.
Review version `candidate-evidence-v2` participates in the payload hash. Bump it
whenever the question, rubric or evidence contract changes.

Confidence measures the model's answer distribution, not correctness or profit
probability. A supported claim is not a buy recommendation. Provider retention
depends on your account agreement; do not assume zero retention.
See the [Typesafe introduction](https://docs.typesafe.ai/introduction).

## Shadow Picks and Price Calls

Each paid review also asks Jev two shadow questions in the same request, so
the request budget is unchanged:

* `pick`: TAKE or PASS for a long entry now, with probabilities
* `move20d`: an expected score from 0 to 4 over five bands for the price 20
  trading days after the scan (more than 10% down, 3-10% down, within 3%,
  3-10% up, more than 10% up)

Answers are appended to `data/typesafe-review/shadow-predictions.jsonl`, with
the scan price, scan identity and input hash. The file is never pruned because
20-day outcomes arrive after the seven-day ledger retention. No dashboard,
grade, ranking, sizing, order or stop reads it.

A malformed shadow answer never voids the evidence answer. The review keeps
its evidence result and records `SHADOW_ANSWER_INVALID` or
`SHADOW_NOT_RECORDED` in its flags instead.

Jev has no demonstrated forecasting skill and sees only the numbers the
scanner already computed. Score predictions against `CandidateOutcome`
(`fwdReturn5d`, `fwdReturn20d`) by scan and ticker, alongside the scanner's
own ranking, across at least 30 distinct signal days before considering any
influence on trading. Granting influence is a separate decision requiring
changes to protected execution code.

## Auto-Trade Veto

On 2026-09-23 the user chose to give Jev a role in automated buys before that
track record exists. The gate lives in `src/lib/jev-entry-gate.ts` and runs in
`src/cron/auto-trade.ts` after grading and the execution scan save. It runs before
the fresh live-price check, earnings deferral, sizing, risk gates and orders, so
time spent waiting on Jev can never let a stale price reach an order.

* **Veto only.** Jev can remove an A-grade candidate. It cannot add a buy or
  change grades, ranking, size, stops, risk gates or the two-attempt session cap.
* **Veto rule.** A candidate is vetoed when the evidence answer is `CONTRADICTED`
  or `MIXED`, or when the pick's PASS probability is at least
  `JEV_VETO_PASS_PROBABILITY` (default 0.6, minimum 0.5).
* **Fails open.** Missing key, missing or incomplete evidence, budget use, provider
  cooldown, lock contention (15-second wait), the 60-second deadline or any error
  leaves the candidate to the existing rules. Automation never waits on Jev.
* **Scope.** The top five remaining candidates of the saved execution scan are
  reviewed. Later candidates are allowed unreviewed.
* **Shared budget.** Requests use the same ledger, lock and 20-per-day budget as
  the scheduled worker; a candidate already reviewed for that scan is not charged
  again.
* **Audit.** Each verdict writes an ExecutionLog row: `JEV_VETO`, `JEV_ALLOW`
  (Jev reviewed and allowed) or `JEV_SKIPPED` (Jev was not consulted, with the
  reason). Vetoes appear under "Jev veto" in the Telegram session summary.
* **Isolated load.** `auto-trade.ts` loads the gate module (and its native
  `better-sqlite3` dependency) only when the veto is enabled, inside `try/catch`.
  A load failure logs `GATE_LOAD_FAILED` and allows every candidate.

Enable it with both flags; either one false turns the veto off:

```dotenv
TYPESAFE_REVIEW_ENABLED=true
JEV_AUTO_TRADE_GATE=veto
```

Vetoed candidates still get `CandidateOutcome` forward returns, so compare the
20-day return of vetoed against allowed candidates before tightening or keeping
the rule.

### Live evidence and the claim-echo finding (2026-09-29)

In the first six days the veto reviewed 6 real buy candidates and allowed all 6.
All 12 completed reviews answered evidence `SUPPORTED`. The `pick` answer tracked
the scanner's own `claim` text exactly: every A-grade "Trigger met … scores
strong" claim got TAKE (PASS 0.06–0.22), and every "not A-grade" or "waiting for
pullback" claim got PASS (0.57–1.00). Evidence also answered SUPPORTED for a
"volume confirmed" claim with a 0.27 volume ratio; the model cannot see the
session-scaled volume threshold. The veto is therefore unlikely ever to fire on
A-grade candidates, and shadow scoring of `pick` mostly measures the scanner's
own grade.

A claim-blind pick was tried and reverted the same day. A fourth question in the
same request, telling Jev to ignore `state.claim`, was sent once with the
supervised `--synthetic` check. The request succeeded, but:
* every shadow answer then failed validation (`SHADOW_ANSWER_INVALID`);
* the evidence answer for the same synthetic claim changed from `SUPPORTED`
  (22 September) to `MIXED`. In the live gate, MIXED is a veto.

Extra questions are not side-effect-free: they can change how the evidence
question is answered. The request is back to exactly the three questions proven
over six live days.

A valid test of Jev's independent judgement needs a **separate** request with
the claim removed from the state. That costs extra requests against the shared
20-per-day budget (roughly 6 stored states would settle it), so it is the user's
decision. Letting any claim-blind answer drive the live veto would also need:
1. enough outcome data (the first 20-day outcomes mature around 21 October);
2. an explicit decision by the user;
3. a circuit breaker, so a model that always says PASS cannot suppress most buys.

### Update 2026-10-01: outcome scoring was not running

Through 1 October the gate reviewed 8 live buys and allowed all 8. The plan above
to score Jev against `CandidateOutcome` could not have worked until 1 October:
* **Forward returns:** forward-return enrichment had written nothing since 11
  September, because a 22:00 UTC guard rejected every scheduled scan.
* **Scores:** the score backfill had not reached the cohort either.

Both are fixed (see the
[stock selection assessment](../reports/stock-selection-assessment-2026-10-01.md)).
The first live nightly run on 1 October enriched 5,664 rows and scored 47,291
point-in-time with 0 errors, so outcomes now accumulate nightly. Jev's live role
(keep, switch off, or fund a separate claim-free test) is listed there as an
open decision.

### Update 2026-10-05: scorecard and grade agreement

[jev_scorecard.py](../scripts/research/jev_scorecard.py) now scores the shadow
predictions read-only, with two rules fixed before any 20-session outcome
existed (A-grades only, at least 30 scan dates each): would-veto minus
would-allow return, and the rank correlation of PASS probability with return.
So far Jev's pick has matched the stored grade on every graded candidate (TAKE
on 7 of 7 A-grades, highest PASS 22%; PASS on 10 of 10 B-grades and 2 of 2 chase
candidates), so the veto has never fired. See the
[decision-quality review](../reports/jev-and-decision-review-2026-10-05.md).
On 5 October the owner chose to keep Jev as it is (veto on, no sell authority,
no extra paid requests) and let the scorecard's tests mature from late October.

## Local Configuration

Use Node 20 or newer with a compatible `better-sqlite3` native build, PowerShell 7,
and the normal project install including development dependencies (`tsx` runs
scheduled TypeScript jobs). Verification used Node 24.13 and Pester 5.7.1.
Keep the repository on a local disk; mapped drives and encrypted files may not be
available to an unattended S4U task. The scheduler identity needs read access to
the database/configuration and write access to the pilot directory and log.

Set the following locally in the existing ignored root environment file. Do not
paste the API key into chat, commit it, put it in a task argument or use a
`NEXT_PUBLIC_` variable. The worker loads the root `.env`, not `.env.local`.

```dotenv
TYPESAFE_REVIEW_ENABLED=false
TYPESAFE_REVIEW_USER_ID=default-user
TYPESAFE_API_KEY=<enter locally>
```

Keep the existing `DATABASE_URL` pointing to the intended SQLite database. Relative
`file:` paths resolve from the Prisma directory. The worker does not create or
migrate a database. Authenticated dashboard users can read only their own scans.
The explicit loopback `DISABLE_API_AUTH=true` desktop mode is limited to
`default-user`; a different pilot user needs the matching authenticated session.

## Activation

Run these from the repository root, with automatic pilot scheduling still absent:

1. Run `npm run typesafe:review` with the feature disabled. Expect `DISABLED`.
2. Run `npm run typesafe:review -- --initialize` once. This creates the durable
   ledger and sends no request. Reinitialization is refused.
3. Configure the key locally and set `TYPESAFE_REVIEW_ENABLED=true`. Restart the
   dashboard after changing its environment.
4. On a weekday, run `npm run typesafe:review -- --synthetic`. This sends at most
   one synthetic request per London day under the same 20-request budget. Verify
   the local result before using real evidence. Repeating it does not retry a
   failure. Never delete the ledger to retry.
5. After a normal existing scan has settled, run `npm run typesafe:review`. Check
   the scan page against the original evidence. Run it a second time and confirm
   the attempt count does not increase for already-assessed candidates.
6. Register only the pilot task, then audit it with the commands below. The task
   first becomes eligible one minute after registration.

```powershell
pwsh -NoProfile -File scripts/register-typesafe-review.ps1 -WhatIf
pwsh -NoProfile -File scripts/register-typesafe-review.ps1
pwsh -NoProfile -File scripts/audit-typesafe-review-task.ps1
```

The task is `HybridTurtle-TypesafeReview`, runs under the current user with S4U and
limited privileges, ignores overlapping invocations and has a five-minute limit.
Registration does not self-elevate or replace an existing task. If Windows denies
registration, run the registration command yourself in an administrator terminal
for the intended user. Do not run the broad task registrar for this pilot.

The dedicated audit is read-only. It reports definition mismatches, last result
and next run; matching configuration does not prove a successful invocation.
After the first scheduled run, inspect the safe status log and dashboard worker
timestamp. The optional task is not part of mandatory trading-health gates.

## State and Recovery

The ignored `data/typesafe-review/` directory holds the initialized marker,
exclusive lock and ledger. Reservations are fsynced and atomically saved **before**
network calls. Saved records retain local identity, safe claims, hashes, response
probabilities/model/token counts and elapsed time, but no API key or raw provider
error body. Records older than seven days are pruned on enabled weekday runs;
disabling the worker stops pruning too. The separate `typesafe-review.log` contains
safe run statuses and is not automatically rotated.

* `MISSING_KEY`: configure the local secret. No request was sent.
* `NO_RECENT_SETTLED_SNAPSHOT`: wait for normal scanning; no backlog is replayed.
* `INCOMPLETE_EVIDENCE` (worker) or `INSUFFICIENT_EVIDENCE` (candidate): inspect
  the displayed flags. Do not manufacture missing provenance or weaken existing
  trading rules to obtain an assessment.
* `PROVIDER_UNAVAILABLE`: the attempt remains charged and will not be retried.
  Authentication errors, rate limits and overload stop the batch and create a
  cooldown of at least 15 minutes, respecting a later provider Retry-After time.
* `BUDGET_EXHAUSTED` or `SCAN_LIMIT_REACHED`: wait for an eligible new scan/day.
* `RESERVED`: a request may have been interrupted. It remains charged.
* `WORKER_STALE`: no recent saved worker heartbeat. Check the pilot task/log.
* `LOCK_BUSY` (worker): the auto-trade Jev gate held the shared lock. Not a
  failure; the next 15-minute run continues.
* `REVIEW_UNAVAILABLE` or `WORKER_FAILED`: inspect local storage, lock and
  configuration. Missing/corrupt initialized storage, failed writes and clock
  rollback prevent further requests rather than resetting quota.

`NO_APPROVED_TECHNICAL_CLAIM` can occur even when market evidence is complete.
Inspect the original grade reason: `BLOCKED_DATA` also represents RED system
health, not only missing prices. In the September 22 check, the cause was a CORE
sleeve-limit breach measured against invested entry value only. The health check
now uses the documented risk-gate basis (mark-to-market value over the larger of
equity and non-HEDGE invested value), and the same portfolio reads about 43%.
The pilot withholds portfolio/health explanations rather than sending them
as technical claims. Do not change holdings, raise caps or bypass health checks
to force an AI assessment.

Locks are never reclaimed on elapsed time alone. Since 2026-09-29 (when the
auto-trade gate became a second, killable lock holder), `worker.lock` is removed
automatically only when both of these are true:
* it is older than 10 minutes;
* its recorded process no longer exists.

That is the manual checklist below, automated. A lock whose process is still
running (or merely asleep) is never taken over, however old. Reservations are
fsynced before each request, so reclaiming a dead holder's lock loses no budget
accounting. For any other stuck lock, disable only the pilot task and stop all
manual pilot runs. Confirm the recorded process is no longer running and cannot
restart, preserve a copy of the pilot directory, then remove only `worker.lock`.
Never delete the initialized marker or ledger to clear quota. Restore damaged
accounting from a trustworthy backup; absent one, leave the pilot disabled
pending manual reconciliation.

To stop the pilot, set `TYPESAFE_REVIEW_ENABLED=false`, restart the dashboard and
disable only its task. An already-sent request cannot be recalled.

```powershell
Disable-ScheduledTask -TaskName 'HybridTurtle-TypesafeReview' -TaskPath '\'
```

## Verification

```powershell
npx vitest run src/lib/typesafe-candidate-review.test.ts src/lib/typesafe-client.test.ts src/lib/typesafe-review-store.test.ts src/lib/typesafe-review-source.test.ts src/cron/typesafe-review.test.ts src/app/api/scan/evidence-review/route.test.ts src/app/api/scan/route.test.ts src/lib/scan-cache-identity.test.ts
npm run typecheck
Import-Module Pester -RequiredVersion 5.7.1
Invoke-Pester -Path scripts/TypesafeReviewTask.Tests.ps1 -Output Detailed
```

Provider tests mock the network. SQLite tests use disposable fixtures and check
source bytes remain unchanged. Scheduler tests mock registration. Browser checks
use synthetic API responses, cover desktop/mobile fit, keyboard disclosure and
old-response suppression on scan changes. Live provider quality and unattended
operation must still be checked during activation.