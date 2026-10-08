---
title: Trade Logic Efficiency Review 2026-10-08
description: Whether HybridTurtle's live trading logic is working and efficient, judged from its trade history, and how it compares with what successful breakout and trend traders do.
ms.date: 2026-10-08
---

## Answer

**No, not yet.** The automated buys are losing money. Their interval just
excludes zero, but pooled with the manual trades it does not, and source is
mixed up with period.

* **Results:** 19 auto-trade buys averaged −0.40R (95% interval −0.70R to
  −0.03R) and won 21% of the time. Manual buys (15) averaged +0.08R. All 34
  closed trades: −0.19R (−0.46R to +0.11R).
* **Shape of the losses:** most losing trades fail within days. Nine of 34
  closed within 3 days at −0.70R on average, and the app's own failed-breakout
  detector flagged 20 of the 34 (16 usable for the analysis below). It only
  raises an alert.
* **What explains them, and what does not:** a replay of the real buys on
  the live exit engine shows that entry timing explains little. Entering at
  the next morning's open instead of the actual fill helped only 9 of 21
  trades. The same rules made +0.15R a trade in the May–June simulation, so
  the gap is mainly which stocks were bought and when (July to September),
  not how they were entered. That gap is not yet explained.
* **What successful traders do differently:** they cut failed breakouts fast
  and mechanically, size by volatility, and hold more, smaller positions. This
  system detects failures but does not act on them. Its notional cap turns the
  intended volatility sizing into equal-money sizing.
* **What to change:** nothing is proven enough to switch on. Acting on failed
  breakouts is the strongest lead, but the evidence conflicts, so it now has a
  frozen forward test. That test can't conclude before about February 2027.

Separately, the nightly job reports a 79% "drawdown" every night. The equity
history shows four one-day falls with no matching trades. They look like
withdrawals, not trading losses [unverified]. A permanent false alarm would
hide a real one.

## Evidence

All figures are from read-only scripts on the live database and public Yahoo
daily bars, priced from the same listing the app uses (no account access).
See [Reproduce](#reproduce).

### Results by source

| Group | n | Expectancy (95% interval) | Win rate | Payoff | Median hold |
| --- | ---: | ---: | ---: | ---: | ---: |
| All closed | 34 | −0.19R (−0.46 to +0.11) | 32% | 1.23 | 6d |
| Auto-trade | 19 | −0.40R (−0.70 to −0.03) | 21% | 1.13 | 6d |
| Manual (Trading 212) | 15 | +0.08R (−0.37 to +0.59) | 47% | 1.41 | 7d |

Manual trades were mostly earlier (May–June), so period and source are mixed.

### Entries

[live_entry_replay.py](../scripts/research/live_entry_replay.py) replays all
21 fetchable auto-trade buys on the live exit engine. The simulator reproduces
the real results closely: the median gap to the actual R is 0.02R.

| | Mean R | Trades |
| --- | ---: | ---: |
| Actual (closed trades) | −0.42R | 18 |
| Simulated at the actual fill | −0.27R | 21 |
| Simulated with entry at the next open instead | −0.15R | 21 |

* The next-open entry did better on only 9 of 21 trades. Two of those (CLDX
  +1.10R, PEBO +2.06R) supply all of the average gain.
* By session:

  | Session (UK) | Buys | Actual | Next-open entry | Median position in day's range |
  | --- | ---: | ---: | ---: | ---: |
  | 14:45 | 6 | −0.21R (n=4) | +0.10R | 0.58 |
  | 17:00 | 4 | −0.16R (n=4) | +0.06R | 0.72 |
  | 20:30 | 11 | −0.61R (n=10) | −0.36R | 0.75 |

  The 20:30 buys did worst, but they still lose when entered the next morning.
  So the stocks picked late in the day were weaker, not just badly timed. The
  sample is small and clustered on a few dates (5 August, 14 and 28
  September).
* Buys were on average 0.24R above the trigger, and 13 of 20 were below entry
  three sessions later. Earlier sessions bought slightly further above the
  trigger than 20:30 did, so "chasing" is not the explanation either.
* For comparison, the May–June development simulation earns +0.15R a trade
  with the same rules (44 candidates). The live buys simulate at −0.27R. The
  difference lies in the stocks and the period, which this review cannot
  separate.

### Failed breakouts

The nightly job flags a position when, within 5 days of entry, it closes back
below its trigger with under +0.5R profit
(`src/lib/breakout-failure-detector.ts`). Today that is only an alert.

[failed_breakout_exit_review.py](../scripts/research/failed_breakout_exit_review.py)
compares the actual result with selling at the next open after the flag. It
counts only flags recorded after that day's close, before the exit:

| Flags | n | Actual | Sell at next open | Better |
| --- | ---: | ---: | ---: | ---: |
| All usable | 16 | −0.37R | −0.14R | 13 of 16 |
| Auto-trade (live rule: close below the trigger) | 8 | −0.59R | −0.27R | 7 of 8 |

* Spread over the 30 usable closed trades, that is about +0.13R a trade.
* Manual trades have no stored trigger, so their flags used "close below the
  fill price", a different rule. Four rows were skipped and are listed by the
  script. Two had no price data. One (CORT) was flagged by a mid-session
  manual run. One (CRON) was flagged after it had already exited.
* Fills are assumed at the official open. Real gap fills can be worse: SCHW
  filled 0.77R below its stop.
* **The evidence conflicts.** In the development simulation (44 candidates,
  entered at the next open), the same rule scored −0.08R against the live
  exit (corrected interval −0.42R to +0.10R). The real-trade figure is a
  subset chosen by the rule itself, mostly from the reserved holdout period.
* It is now a frozen forward test (`FAILX` in
  [prospective_shadow_tests.py](../scripts/research/prospective_shadow_tests.py)).
  It was added after seeing the real-trade result, but before any forward
  outcome existed (0 completed).

### How long the forward tests take

* Every auto-trade buy since 14 September has a graded scan row, so the
  forward tests now see what live trading buys. Before that, 13 of the 15
  buys had none.
* A-grade candidates arrive at about 10–13 unique stock-days a month (13 in
  September, 3 so far in October).
* The exit tests need 30 completed candidates on 15 dates, plus 40 sessions
  for each window to finish. The earliest conclusion is therefore about
  February 2027. The WATCH-versus-READY test needs 30 of each, so later still.

### Position sizing

The Small Account profile risks 2% a trade, but caps a CORE position at 20% of
equity (12% observed for HIGH_RISK). On a £220 account the cap binds on almost
every trade:

* Actual risk at entry: median 0.97% of equity, range 0.6% to 2.0%. That
  excludes two odd fills at 0.06%.
* With a notional cap, the money at risk is proportional to the stop distance.
  A volatile stock (SDGR, 10.8% stop) risked 2.0% of equity; a quiet one (T,
  3.0% stop) risked 0.6%. That is the opposite of volatility sizing, which
  equalises risk per trade.
* R is still the right unit for judging the logic, but the £ result is driven
  by the most volatile trades.

### Costs and capital use

* Trading 212 charges 0.15% FX on each conversion. On a 20%-of-equity
  position risking about 1%, a round trip costs about 0.06R in FX alone
  [estimate; spread not measured].
* At most 4 positions of 20% can be held, so cash use tops out at 80%. Open
  risk has been 1–3.5% of equity against a 10% cap.

### Equity history and the drawdown alert

| Date | Equity before | Equity after | Change |
| --- | ---: | ---: | ---: |
| 4 July (Saturday) | £976 | £831 | −£145 |
| 3 August | £817 | £417 | −£400 |
| 10 August | £419 | £309 | −£110 |
| 19 August | £311 | £232 | −£79 |

* Broker snapshots confirm the fall: £1,019 on 24 June, £416 on 6 August and
  £220 on 2 September.
* Total realised trading P&L since May is about −£44. The falls are one-day
  steps with no matching trades, one of them on a Saturday, so they look like
  withdrawals. Only the £400 is a round sum, and there is no
  deposit/withdrawal ledger to confirm it.
* `src/cron/nightly.ts` alerts "Equity drawdown: 79.4% below peak £1,055.15 …
  Consider CAPITAL_PRESERVATION mode" every night (in `nightly.log` up to 7
  October).
* `src/lib/safety-alerts.ts` shows a permanent CRITICAL "Excessive drawdown".
  The equity-curve page (`src/app/api/performance/equity-curve/route.ts`)
  plots the same drawdown.
* `src/lib/profit-scoreboard.ts` marks the evidence verdict DEGRADING ("Negative
  evidence … max drawdown") whenever the equity drawdown exceeds 20%. That
  verdict feeds the `/performance` page, the Telegram evidence command and the
  weekly digest warning (`src/cron/weekly-digest.ts`). The verdict is therefore
  stuck on DEGRADING for a reason that may not be trading.
* No trading gate reads any of these, but a real drawdown would look the same.

### What successful traders do

| Practice | Who | This system |
| --- | --- | --- |
| Cut failed breakouts quickly and mechanically | O'Neil's 7–8% rule; Minervini exits on a close back below the pivot [practitioner summaries, not primary texts: [ChartMill](https://www.chartmill.com/documentation/trading-and-investing/methodologies/527-William-ONeils-7-8-Sell-Rule-Explained), [OpenSwingTrading](https://www.openswingtrading.com/blog/mark-minervini-rules-tested-on-1-000-breakouts-2015-2025)] | Detects failures, does not act on them |
| Enter on the break, with a stop order at the breakout level | Turtle rules ([turtletrader.com](https://www.turtletrader.com/rules/)) | Buys at four fixed sessions; timing explains little of the losses here |
| Size by volatility, equal risk per trade | Turtle "N" units; Clenow's ATR sizing | Notional cap makes it equal-money |
| Many small positions | Clenow and Turtle portfolios run 10–30 positions | At most 4 |
| Low win rate, large winners (payoff above 2) | Hurst, Ooi and Pedersen; Turtle results | 32% win rate, payoff 1.2 |
| Mechanical rules judged on large samples | All of the above | 34 trades; forward tests need months more |

A £220 account cannot run 20 positions or fine-grained volatility sizing, so
some of these differences come from account size, not design.

## Changed in this review

| ID | Change | Verification |
| --- | --- | --- |
| C1 | New read-only `scripts/research/failed_breakout_exit_review.py`; counts only flags recorded after the close and before the exit | Runs; figures above |
| C2 | New read-only `scripts/research/live_entry_replay.py` (actual fill against next-open entry, by session) | Simulator within 0.02R of actual results |
| C3 | New `scripts/research/yahoo_daily.py` (the app's Yahoo symbol mapping and a daily-bar fetch) and `scripts/research/shadow_sim.py` (exit engine moved out of `prospective_shadow_tests.py` unchanged) | Smoke run identical before and after the move |
| C4 | `prospective_shadow_tests.py` priced mapped tickers from the wrong listing (`coalesce(yahooTicker, ticker)` skipped the ticker map, e.g. SAP was not priced from `SAP.DE`); now uses the app's mapping | Smoke run: 44 completed, was 43 |
| C5 | Frozen forward test `FAILX` added before any forward outcome existed; Bonferroni correction widened from six to seven comparisons | Prospective run: 2 candidates pending, 0 complete |

No live trading behaviour was changed by this review.

## Needs your decision

| ID | Decision | Evidence | Recommendation |
| --- | --- | --- | --- |
| N1 | Sell automatically on a failed-breakout flag | +0.33R on 7 of 8 faithful real trades, but −0.08R in the development simulation | Not yet. Let `FAILX` run; no manual change in the meantime |
| N2 | Drop the 20:30 UK buying session | Worst session (−0.61R, n=10), and still negative with next-morning entries, so it points to weaker picks rather than timing [small, clustered sample] | Watch it; do not change on 10 trades |
| N3 | Size by risk, not notional (position-sizer, sacred) | Risk per trade ranges 0.6–2.0% and grows with volatility; risk = notional × stop distance, and the median stop is about 4.9% | Lowering risk per trade to 1% would remove the volatile 2% tail (stops wider than 5%) but leave tight-stop trades capped, so sizing would stay equal-money on about half the trades. Smaller volatile positions are the only gain; test before changing |
| N4 | Confirm the July–August equity falls were withdrawals | One-day falls with no matching trades; they drive the nightly alert, the CRITICAL drawdown alert, the equity-curve drawdown and the DEGRADING evidence verdict | If so, record capital events and re-base the drawdown peak on them (needs a new setting or table), or import Trading 212 deposits and withdrawals (a read-only call to the live account) |
| N5 | Uncommitted change in `src/lib/ready-to-buy.ts` (last written 9 August) | Counts weekday hours instead of clock hours for the "critical, block buys" staleness gate, which slightly loosens it; flagged on 5 October and still uncommitted | Confirm it is intended, then commit it or discard it |

## Update 2026-10-08: decisions applied

The owner approved every recommendation and pointed out that the system has run
for nine months. Results:

* **Nine months, not five.** The trade log holds 139 sells since 15 January;
  this review had used the Position table, which starts on 8 May. Realised P&L
  over all 139 is −£42.
  * January's 55 sells were Trading 212 AutoInvest (pie) positions being closed,
    not this system.
  * The system's API-placed trades from March to May made +£48 on 35 sells (49%
    winners). They were driven by a few large wins and losses, and have no
    recorded stops, so they can't be measured in R.
  * Everything since June has lost −£73, of which −£40.55 came from auto-trade
    buys.
  * Lifetime of the account (deposits since February 2025): £1,023 deposited,
    £744.28 withdrawn, £6.21 transferred in [whether that transfer was new money
    is unverified], equity now about £217, so about −£68 overall.
* **N4, withdrawals: confirmed and fixed.** A read-only fetch of the Trading 212
  cash history (2 requests, account identity checked) found withdrawals of £150
  (3 July), £400 (3 August), £113.13 (10 August) and £81.15 (19 August). They
  fall on exactly the dates of the equity steps.
  * They are stored as capital events in `AppSetting` `capital-events.v1` (after
    a database backup).
  * Drawdown is now measured on a capital-adjusted performance index in the
    nightly alert, the alerts page, the equity-curve page and the evidence
    verdict.
  * Measured that way, trading performance is about 13% below its June peak,
    not 79%. That is a real drawdown, so the nightly alert keeps firing, but now
    with the true figure. The alerts page shows a WARNING, not CRITICAL.
  * The equity-curve card now separates the two. Over 180 days equity fell
    £792, of which £738 was withdrawn and £54 (−6%) was trading. Its drawdown is
    computed on the daily history, not the sparse broker snapshots.
  * If equity drops more than 5% in one step with no recorded cash movement,
    the nightly summary now says so and asks for a refresh.
  * **Refresh after any future deposit or withdrawal**, or the alert will be
    wrong again: `npx tsx scripts/collect-cash-transactions.ts --fetch …` then
    `--store …`.
* **N3, sizing: tested, not changed.** Stop width does not predict the result
  (correlation 0.07 on 28 trades; mean −0.29R for stops wider than 5% against
  −0.35R for tighter ones), and at 1% risk the modelled £ result barely changes
  (−£59 against −£63). Sizing cannot create an edge while expectancy is
  negative; it only sets how fast money is made or lost. The sacred position
  sizer was left alone.
* **N5, `ready-to-buy.ts`: kept.** It only drives the manual Ready-to-Buy
  panel; auto-trade does not read it. It stops a false "stale" warning every
  Monday, and scans run daily, so the looser 7-weekday "critical" limit rarely
  matters. Its 29 tests pass.
* **N1 and N2: no live change**, as recommended. `FAILX` and the session data
  keep accruing.

None of these makes the system profitable. No tested change has shown an edge
yet.

### New recommendation: pause new buys until there is evidence (needs your decision)

* **Why:** nine months of net loss (−£42 realised); auto-trade −£40.55 over 20
  trades, with an interval excluding zero; a real 13% trading drawdown; and no
  tested change with a demonstrated edge.
* **The cost of pausing is small.** Most forward-test candidates come from the
  evening scan (71 of the last 80 scans), which still runs in this mode. The
  pause also stops the few intraday scans (about 5 intraday A-grades are in the
  sample so far), stops pyramiding, and ends live fill and slippage data.
* **How:** Settings → operating mode **CAPITAL_PRESERVATION**. It blocks only
  auto-trade buys (`src/cron/auto-trade.ts`, Gate 3a). Gate 3a logs a SKIPPED
  heartbeat, which the watchdog treats as healthy. Nightly stop updates, midday
  sync and the evening scan don't read the mode and keep running. Open positions
  (PLTR, NTAP) keep their stops.
* **Restart rule, now built into `prospective_shadow_tests.py`:** resume only
  when the restart check prints RESUME BUYING SUPPORTED. That needs the current
  rules (`LIVE`) to show a 95% lower bound above zero, on at least 30 forward
  candidates across 15 dates and 15 tickers. Each ticker counts at most once per
  56 days, because overlapping repeats are near-duplicates.
  * The check covers every A-grade candidate, not only the few auto-trade would
    have bought.
  * A variant such as `FAILX` is not a resume signal by itself: it must pass its
    own E1 gate and be adopted first.
  * If you would rather keep collecting live data, keep trading at the current
    size (about £2 per losing trade).
* Not done unasked: it changes live trading and was not on the approved list.
## Review

Independent review by Claude Sonnet 5.5 over two rounds; each finding was
checked against code, data or script output before it was accepted.

* **Round 1:** the reviewer said the forward tests mostly missed what live
  trading buys before 14 September and could not conclude by December. It
  said "late and high" entries were not established, since range position
  barely differed by session. It also said two counterfactual rows were invalid
  (CORT flagged mid-session, CRON after its exit), manual flags used a
  different rule, the "sell by hand" advice contradicted the evidence, and the
  drawdown write-up was imprecise. All were accepted. The new entry replay then
  showed timing explains little. Verdict: "NO, not yet."
* **Round 2:** it reproduced every figure and corrected the flagged-trade
  count (20, not 18), the skip count, the reasoning behind N3 and an
  overstated headline. It also found the drawdown also locks the evidence
  verdict on DEGRADING. Verdict: "YES, the remaining items are
  diminishing-return."

## Reproduce

```powershell
python scripts/research/live_trade_review.py prisma/dev.db
python scripts/research/live_entry_replay.py prisma/dev.db
python scripts/research/failed_breakout_exit_review.py prisma/dev.db
python scripts/research/prospective_shadow_tests.py prisma/dev.db --smoke 2026-05-15 2026-06-30
python scripts/research/prospective_shadow_tests.py prisma/dev.db
```

The sizing and equity-history figures came from read-only queries in this
session; the scripts above reproduce everything else.
