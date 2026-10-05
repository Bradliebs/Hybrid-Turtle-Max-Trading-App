---
title: Jev and Decision-Quality Review 2026-10-05
description: How to improve HybridTurtle's buy and sell decisions with Jev, what successful systematic traders do, and whether to add day trading.
ms.date: 2026-10-05
---

## Answer

* **Jev has added no information so far.** On every graded candidate it has
  reviewed, its pick matched the scanner's stored grade: TAKE on 7 of 7
  A-grades (highest PASS probability 22%, against a 60% veto threshold), PASS
  on 10 of 10 B-grades and 2 of 2 chase candidates. The prompt includes the
  scanner's own verdict, so this agreement is partly built in; on the current
  prompt the veto is inert. That rests on 19 candidates over 6 scan dates.
  Giving Jev a say on sells would repeat the problem. It can only add value if
  it is asked something the scanner does not already answer, and that needs a
  paid, shadow-only test.
* **Most losses come from entries that never worked, not from the exit.** Of
  the 20 closed trades with local price data, 12 never closed above +0.5R and
  averaged −0.81R. Nine trades closed within 3 days at −0.70R on average. The
  trailing-stop width mostly matters once a trade has risen, so the
  buy side (which stocks, and when to enter) is the bigger lever.
* **The trailing stop is tighter than classic trend-following, and was
  tightened without review.** It trails 1.5 × ATR below the highest close from
  the entry day; a bundled April commit lowered it from 2.0. A development-window
  smoke run of the new shadow test found wider or later trails did worse, not
  better, so the live stop stays as it is while the forward test runs.
* **Do not add day trading.** The evidence on retail day trading is poor, the
  system runs on daily bars, and costs would be a larger share of each trade.
  If a second horizon is wanted, add a slower trend sleeve, not a faster one.

None of this is proven. The live record is 32 trades on a £220 account in one
market period; the overall expectancy of −0.17R has a 95% interval of −0.45R
to +0.17R. What was decided and changed is under
[Decisions](#decisions-approved-by-the-owner-on-5-october).

## Evidence

### Live trades

[live_trade_review.py](../scripts/research/live_trade_review.py), read-only,
32 closed trades from 8 May to 1 October 2026. Intervals are 95% bootstrap.

| Group | n | Expectancy (interval) | Win rate | Avg win | Avg loss | Payoff | Best |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| All | 32 | −0.17R (−0.45 to +0.17) | 34% | +0.84R | −0.69R | 1.21 | +2.57R |
| Auto-trade buys | 17 | −0.38R (−0.71 to +0.03) | 24% | +0.81R | −0.74R | 1.09 | +1.96R |
| Manual buys | 15 | +0.08R (−0.37 to +0.59) | 47% | +0.85R | −0.61R | 1.41 | +2.57R |

Auto-trade and manual buys cannot be separated statistically, and the manual
trades were mostly earlier, so period and source are confounded.

By the best close a trade reached before it exited (20 trades with local
bars):

| Best close reached | n | Mean result |
| --- | ---: | ---: |
| Never above +0.5R | 12 | −0.81R |
| +0.5R to +1.5R | 4 | +0.13R |
| +1.5R or more | 4 | +1.02R |

* The stop level recorded at exit is a label set by the trade's path
  (`LOCK_1R_TRAIL` means the trade had already reached +3R), so it cannot be
  used to compare stop rules.
* Trail width matters most once a trade has risen: with a constant ATR, a
  2.0 × ATR trail only rises above the −1R initial stop after the highest close
  passes about +0.33R. The live trail uses the current ATR, though, so when
  volatility falls after entry the stop also tightens with no price gain, and
  the rules then differ even on trades that never rose. A wider trail keeps more
  of a pullback and also gives back more on a reversal; which effect wins is
  not measured by the live trades.
* The only exit evidence not confounded by the path: the 4 trades whose best
  close reached +1.5R or more gave back about 1.6R on average before exiting
  (best +2.60R, exit +1.01R). That is n = 4, so it motivates a test, nothing
  more. Post-exit drift on dev-window exits (7 of 11 closed higher 20 sessions
  later) is hypothesis-generating only: no market baseline, and a wider stop
  also enlarges losses.
* Trend-following normally wins 30–45% of trades and relies on winners several
  times larger than losers (Turtle rules; Hurst, Ooi and Pedersen, *A Century
  of Evidence on Trend-Following Investing*). The win rate here is in range;
  the payoff ratio (1.2) is not, because few entries ever ran.
* **Fills below the stop are gaps, not a sync fault.** SCHW opened at 108.25,
  below its 110.84 stop, and filled at 108.21 (−0.77R versus the stop); HST
  opened at 24.00 below 24.29. Recorded stops matched the nightly history.

### How the exit works today

* Initial stop: entry − 1.5 × ATR (`ATR_STOP_MULTIPLIER`).
* Trailing stop: highest close since entry − 1.5 × ATR
  (`ATR_TRAILING_MULTIPLIER`), applied nightly from the entry day with no
  profit threshold. For auto-trade positions the trailing ATR matches the ATR
  at entry, so the stop rises only as price rises.
* For positions entered with a wider stop (older manual trades), the first
  night tightens it to 1.5 × ATR at once: UNH +0.61R, NUE +0.82R, HST +0.34R,
  with no price gain.
* Commit `4280812` (26 April 2026) lowered the trail from 2.0 to 1.5. It had no
  sacred-file log entry, and the docs, the trailing-stop panel and the analyst
  prompt still said 2 × ATR (all corrected in this review).
* Both backtests (`src/app/api/backtest/route.ts`,
  `packages/backtest/src/runner.ts`) still hard-code 2 × ATR, so they do not
  model the live exit and cannot answer the exit question as they stand.
* Classic conventions are wider: Turtle 2N initial stop with exits on a 10- or
  20-day low ([Turtle rules](https://www.turtletrader.com/rules/));
  Chandelier exit 3 × ATR(22) below the 22-day high
  ([StockCharts](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/chandelier-exit)).

### Jev

[jev_scorecard.py](../scripts/research/jev_scorecard.py), read-only, 24
shadow predictions (19 unique stock-days, 23 September to 1 October), graded
from `ScanResult.grade`:

| Stored grade | Jev TAKE | Jev PASS |
| --- | ---: | ---: |
| A-grade (could be bought) | 7 | 0 |
| B-grade (would not be bought) | 0 | 10 |
| Chase (waiting for pullback) | 0 | 2 |

* Highest PASS probability on an A-grade: 22% (PLTR). RGEN, bought on an 8%
  PASS, lost 1R in 3 days.
* Only 4 predictions have 5-session outcomes; none has a 20-session outcome
  (first ones mature around 21–28 October).
* Jev sees only numbers the scanner computed plus the scanner's verdict, so
  agreement is expected. Published LLM forecasting results (Lopez-Lira and
  Tang 2023) use news text, not price features, and are sensitive to
  look-ahead bias from training data (Glasserman and Lin 2023). No study was
  found validating an LLM veto on technical breakout candidates.
* The shadow predictions are produced by the same paid request as the gate
  and the scheduled review, so switching the gate off also stops most of the
  data needed to judge Jev.
* Two evaluation rules were fixed in the scorecard before any 20-session
  outcome existed, both on A-grades only, both needing at least 30 scan dates:
  1. would-veto minus would-allow 20-session return (unreachable while Jev
     never vetoes an A-grade);
  2. rank correlation of PASS probability with the 20-session return, which
     tests whether Jev's doubt carries information even below the threshold.

### Buy side (from the 1 October assessment)

* `rankScore`, the buy order, showed no positive association with later
  returns; grading-time FWS and NCS showed a small positive one (in-sample).
* Triggered breakouts trailed the wider pool of candidates that passed the
  filters (20 sessions: −2.41% vs +1.30%). Short-term reversal research
  (Jegadeesh 1990; Lehmann 1990) predicts this for entries made right after a
  sharp move. Pullback entries are a hypothesis to test, not a finding.
* Together with the 12 trades that never reached +0.5R, this makes entry
  selection and timing the first thing to test.

### Day trading

* Retail day trading loses for most participants: of Brazilian individuals
  who day-traded futures for over 300 days, 97% lost money (Chague, De-Losso
  and Giovannetti, *Day Trading for a Living?*, 2019). Barber, Lee, Liu and
  Odean report similar results for Taiwan [not checked against the primary
  paper].
* The US Pattern Day Trader rule does not apply to Trading 212, which is
  FCA-regulated
  ([Trading 212](https://helpcentre.trading212.com/hc/en-us/articles/360009042317-Does-PDT-Pattern-Day-Trading-apply-to-Trading-212)),
  so the obstacle is economics, not regulation.
* Costs: 0.15% FX on each conversion
  ([Trading 212 fees](https://helpcentre.trading212.com/hc/en-us/articles/11471996799517-What-are-the-fees-in-the-Invest-ISAs-and-SIPP))
  plus spread. On current positions (about $60 each, about $2–3.50 of risk) a
  round trip costs roughly 0.05–0.1R in FX alone [estimate]. A day trade's R is
  smaller, so the same cost is a larger share of it.
* Every signal, stop and outcome in the system uses daily bars. Intraday
  trading would need intraday data, intraday stop logic and a new evidence
  base, i.e. a separate system.
* A second horizon that fits the design is a **slower** one (a longer breakout
  with a wider trail, or the existing ETF sleeve as a core holding), using the
  same daily data and trading less often.

## Changed in this review

| ID | Change | Verification |
| --- | --- | --- |
| C1 | Docs said the trailing stop is 2 × ATR; corrected to 1.5 × ATR from the entry day in `TRADING-LOGIC.md`, `SYSTEM-BREAKDOWN.md` and `DASHBOARD-GUIDE.md`, plus a stale comment in `stop-manager.ts` (comment only) | Re-read against `src/types/index.ts` and `stop-manager.ts` |
| C2 | The trailing-stop panel and the analyst prompt showed 2 × ATR; both now read `ATR_TRAILING_MULTIPLIER`. The prompt's ladder also said `LOCK_08R` locks 0.8R (the code locks 0.5R) and omitted `TRAILING_ATR`; corrected | Typecheck, lint, tests |
| C3 | The April 2.0 → 1.5 change was never logged; retrospective entry added to `docs/SACRED_FILE_CHANGES.md` | `git log -L` on `ATR_TRAILING_MULTIPLIER` |
| C4 | Nothing scored Jev's shadow predictions; new read-only `scripts/research/jev_scorecard.py` with two pre-registered tests, grading from the stored grade | Runs; INSUFFICIENT EVIDENCE today |
| C5 | No reproducible live-trade review; new read-only `scripts/research/live_trade_review.py` with intervals, best-close buckets and gap checks | Runs; figures above |

The review itself changed no live buying or selling behaviour; the approved
decisions below do (block-only).

## Decisions (approved by the owner on 5 October)

The owner asked for every open item to follow the review's recommendation. Each
was checked against data before acting; three recommendations changed as a result
(N3, D4 and D5, below).

| ID | Decision | What was done | Evidence |
| --- | --- | --- | --- |
| N1 / D1 | Test buy order and entry style before changing them | New pre-registered [prospective_shadow_tests.py](../scripts/research/prospective_shadow_tests.py) (tests S1 and S3); only signals from 6 October count | Rules frozen in the script before any qualifying signal |
| N2 / D7 | Keep Jev as is; no sell authority | No change; the scorecard's second test matures from late October | 19 of 19 graded candidates matched the grade |
| N3 | Do **not** restore 2.0 × ATR now; test exits prospectively | Test E1 in the same script compares 2.0 × ATR, trail-after-+1R and Chandelier with the live stop on every completed candidate | A development-window smoke run (43 candidates, 14 dates, below the gate; intervals corrected for six tests) found every alternative **worse** than live: 2.0 × ATR −0.17R (interval −0.30 to −0.03), trail-after-+1R −0.20R (−0.29 to −0.08), Chandelier −0.23R (−0.43 to +0.07). This reverses the earlier lean towards wider stops |
| N4 | No change | Auto-trade entries already start at 1.5 × ATR, so the trail never overrides them; only older manual entries were affected | ATR comparison above |
| N5 | Backtests use the live multiple | `src/app/api/backtest/route.ts` and `packages/backtest/src/runner.ts` read `ATR_TRAILING_MULTIPLIER`. They still model only the R-ladder, not the day-one trail, so E1 is the exit test to use | Backtest tests pass |
| N6 | Defer a slower second horizon | Not built: the protocol tests selection first, and a separate risk budget is impractical on a £220 account | — |
| N7 | No day trading | — | Evidence section |
| D2 | Relative strength must be at least level with the market | A-grade threshold 0 → 50 on the scanner's 0–100 score (50 = level with SPY; also the default when SPY data is missing) | Would have removed 0 of the last 90 days' 30 A-grade rows. The score saturates quickly (it divides by the size of SPY's move, and all 30 rows scored 100), so this is a sanity floor, not a strong filter |
| D3 | Stale scores cannot make a buy | Scores older than 36 hours block A-grade, in auto-trade and in persisted grades; an unknown timestamp counts as stale | 3 of 30 recent A-grade rows; scores are written every day, so Mondays are unaffected |
| D4 | Earnings soon blocks A-grade; the low-efficiency demotion stays advisory | Grader now honours the scanner's earnings demotion: confirmed earnings in 3–5 days, or an unconfirmed (low-confidence) date within 2 days | All 22 demoted A-grades on record were low-efficiency; their 5-day returns were no worse than READY ones (+1.69%, n=10 vs +1.09%, n=24). Blocking them would have removed 17 of 30 recent A-grade rows (20 unique stock-days) on no evidence; test S2 measures it |
| D5 | No change to the price basis | Documented | Mixed-basis ATR equals raw ATR for 90% of 1,087 instruments; 1.7% differ by more than 5% (an ex-dividend inside the window). Not worth a sacred-file rewrite |
| D6 | Keep the 7 mismatched listings blocked | No change; the guard from 1 October already refuses them | 7 of 1,004 mapped stocks |
| D8 | Re-score historical outcome scores point-in-time | Database backed up to `prisma/backups/dev-pre-rescore-2026-10-05.db`, scores cleared and re-filled by the point-in-time backfill | 110,598 rows scored; 62,598 changed; 2,311 had no score from within 2 days before the scan and are now honestly empty; rows since 11 September unchanged; no return touched. The exclusion ledger for corrupt labels stays in the research scripts |
| D9 | US sessions take US listings only | `isStockForSession` uses `isUsPriceListing`; EU/Australian listings get no session | None of the 17 such stocks has a broker mapping, so nothing live is blocked |

Live buying is affected only by D2, D3, D4 (earnings) and D9, all of which can
only block a buy. Stops, sizing, ranking and order flow are unchanged.

## Review

Independent review by Claude Sonnet 5.5 over two rounds; each finding was
checked against code, data or script output before it was accepted.

* **Round 1:** the "exits at `TRAILING_ATR` lose" comparison was invalid
  (exit level is a path label), so the headline moved from the exit to entry
  quality. Fills below the stop were checked and found to be overnight gaps.
  The panel, the analyst prompt and the backtests still said 2 × ATR (first
  two fixed, backtests listed as N5). The scorecard now grades from
  `ScanResult.grade` and has a second, reachable test. Intervals were added.
  The suspected ATR mismatch held only for older manual trades (N4).
* **Round 2:** trail width matters above about +0.33R, not only above +1R;
  the give-back of the 4 best trades is the cleaner exit evidence; Jev wording
  softened; the paid-call figure corrected. Verdict: "Diminishing returns?
  YES", with further rounds to wait for outcome or shadow data.

## Reproduce

```powershell
python scripts/research/live_trade_review.py prisma/dev.db
python scripts/research/jev_scorecard.py prisma/dev.db
python scripts/research/prospective_shadow_tests.py prisma/dev.db
python scripts/research/prospective_shadow_tests.py prisma/dev.db --smoke 2026-05-15 2026-06-30
git --no-pager log -L '/ATR_TRAILING_MULTIPLIER =/,+1:src/types/index.ts'
```

The scripts open the database read-only and need pandas and numpy (the
scorecard also needs scipy). The shadow tests fetch Yahoo daily bars at run
time because the local `DailyBar` table is a research snapshot that stops at
2 September and is not refreshed nightly. Run them monthly; the 40-session
exit windows for the first prospective signals complete in early December.
Twelve recent trades have no local daily bars, so best-close figures cover 20
of 32 trades.