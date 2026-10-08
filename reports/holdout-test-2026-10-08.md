---
title: One-Time Holdout Test 2026-10-08
description: Which proposed rule changes survive a test on untouched history (August–September 2026).
ms.date: 2026-10-08
---

## Answer

Of five ideas drawn from the May–June history, **only one held up on the
untouched August–September history: selling automatically when a breakout
fails.** It improved breakout trades by +0.13R each (corrected interval +0.03R
to +0.23R, 531 trades, 24 dates). On its own it reduces losses but does not
create a profit: those trades still averaged −0.18R with it, against −0.27R
without.

None of the other ideas is a reliable improvement, and one reversed:

| Hypothesis | May–June (dev) | August–September (holdout) | Result |
| --- | --- | --- | --- |
| H1 NCS predicts 20-session returns | IC +0.034 [−0.008, +0.073] | IC +0.029 [−0.009, +0.070] | Not proven |
| H2 NCS orders better than the live rankScore | +0.033 [−0.032, +0.093] | +0.012 [−0.022, +0.048] | Not proven, so keep the buy order |
| H3 FWS predicts returns (lower is better) | IC +0.063 [+0.017, +0.106] | IC **−0.039** [−0.067, −0.011] | Reversed, so FWS is unstable |
| H4 Triggered breakouts underperform other passers | −2.26% [−4.61, −0.14] | +0.08% [−2.35, +2.68] | Did not replicate |
| H5 Selling on the failed-breakout flag helps | +0.03R [−0.07, +0.14] | **+0.13R [+0.03, +0.23]** | **Pass** |

Intervals are 99% date-bootstrap intervals (Bonferroni for five tests).

## Context

* **The market mattered more than the rules.** Every candidate that passed the
  technical filters in August–September lost 3.2% on average over the next 20
  sessions (May–June: +1.1%). The scanner's choices did not escape a falling
  tape.
* **FWS reversed.** FWS ≤ 30 is part of the A-grade rule. A score that helps in
  one period and hurts in the next is not a dependable filter. This is noted,
  not acted on: removing it would also need a test.

## Method

[holdout_test.py](../scripts/research/holdout_test.py), committed in `5cd374f`
before its single holdout run:

* **Population:** candidates that passed the technical filters, one per stock
  per day. The holdout has 6,125 rows, 520 stocks and 24 dates.
* **Returns:** next-open entry, 20-session exit, from Yahoo bars on the app's own
  listing.
* **H5:** uses the live exit engine (`shadow_sim.py`) on triggered candidates.

The raw output is saved in `prisma/backups/holdout-test-2026-10-08.txt`. The
August–September data now counts as seen: new ideas need new data (the forward
tests in `prospective_shadow_tests.py`).

Limits:

* It is one test of five months of one market.
* Simulated fills are at the official open, with no costs.
* The test covers every triggered candidate, not only the ones auto-trade would
  have picked.

## Needs your decision

**Update (same day):** the owner approved H1. It is live from 8 October 2026
(`src/lib/failed-breakout-exit.ts`, called at the start of each auto-trade
session; see `docs/SACRED_FILE_CHANGES.md`). Claude Sonnet 5.5 reviewed it
twice. The first review found three serious gaps: it could sell outside market
hours, treat "order accepted" as "sold", and sell the whole broker holding. All
three were fixed before release. The second review said "Safe to ship: YES".
Turn it off with `FAILED_BREAKOUT_AUTO_EXIT=off`. PLTR (flagged on 28
September) is outside the 4-day window and stays with its normal stop.

| ID | Decision | Recommendation |
| --- | --- | --- |
| H1 | Turn on automatic selling when a breakout fails (within 5 days of entry, a close back below the trigger with under +0.5R profit, sold at the next open) | Yes. It passed on untouched data, and it agrees with the 7 real auto-trade trades (+0.33R each). It changes how live positions are sold (sacred code: auto-exit logic and Telegram reporting), so it needs your go-ahead, tests and a sacred-file log entry |
| H2 | Pause new buys (from the earlier review) | Still recommended. Even with the better exit, breakout trades lost money in August–September |
| H3 | Look again at FWS in the A-grade rule | Not now; test it on fresh data first |
