---
title: Typesafe Candidate Evidence Pilot
description: Configuration, boundaries, verification and recovery for the optional advisory worker.
---

## Scope

The pilot reviews narrow technical claims against persisted scan-time evidence.
It cannot change grades, rankings, orders, position sizes, risk gates or stops.
Scanning and existing automation do not depend on Typesafe availability.
The scan page reads saved results; opening it never requests an assessment.

The pilot is **disabled by default**. Implementation tests use synthetic evidence
and mocked provider responses. They do not establish model accuracy, key validity,
account billing, live evidence coverage or unattended scheduler success.

## Validation Status as of 2026-09-22

Local activation checks verified authentication with one successful synthetic
provider request. The durable ledger was initialized and the saved configuration
remains disabled; the optional scheduled task has not been registered.

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
Review version `candidate-evidence-v1` participates in the payload hash. Bump it
whenever the question, rubric or evidence contract changes.

Confidence measures the model's answer distribution, not correctness or profit
probability. A supported claim is not a buy recommendation. Provider retention
depends on your account agreement; do not assume zero retention.
See the [Typesafe introduction](https://docs.typesafe.ai/introduction).

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
* `REVIEW_UNAVAILABLE` or `WORKER_FAILED`: inspect local storage, lock and
  configuration. Missing/corrupt initialized storage, failed writes and clock
  rollback prevent further requests rather than resetting quota.

`NO_APPROVED_TECHNICAL_CLAIM` can occur even when market evidence is complete.
Inspect the original grade reason: `BLOCKED_DATA` also represents RED system
health, not only missing prices. In the September 22 check, the cause was a CORE
sleeve-limit breach. The current health calculation uses entry price times shares
as a fraction of total invested entry value, excluding cash and current prices.
The pilot withholds these portfolio/health explanations rather than sending them
as technical claims. Resolve or review the underlying policy separately; do not
change holdings, raise caps or bypass health checks to force an AI assessment.

Locks are never reclaimed automatically based on elapsed time. For a leftover
lock, disable only the pilot task and stop all manual pilot runs. Confirm the
recorded process is no longer running and cannot restart, preserve a copy of the
pilot directory, then remove only `worker.lock`. Never delete the initialized
marker or ledger to clear quota. Restore damaged accounting from a trustworthy
backup; absent one, leave the pilot disabled pending manual reconciliation.

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