---
title: Simplification Inventory 2026-10-08
description: What in HybridTurtle actually affects buying and selling, what could be removed, and how to simplify the trading rules safely.
ms.date: 2026-10-08
---

## Answer

Yes: the application is far larger than the job it does, and the extra size has
not bought better results.

* **Size:** 588 source files (112,501 lines), 37 pages, 137 API routes, 18
  scheduled jobs, running a £217 account with at most 4 positions.
* **What trades:** the scheduled jobs that buy, sell, protect or sync
  (auto-trade, nightly, midday sync, watchdog, research refresh) reach only 155
  files (34,100 lines, about 30%). The rest is dashboard, research and advisory
  features.
* **Rules:** a buy currently passes roughly 30 checks. On untouched history,
  none of the scoring checks tested reliably improved picks, and one (FWS)
  reversed. The one change that held up was an exit rule.

Simplify in two steps. Remove features that cannot affect trading first, which
is low risk. Simplifying the trading rules comes second and must be
paper-tested first. No files have been deleted; the lists below need your
approval.

## Step 1: remove what does not affect trading (low risk)

From [trading_path_inventory.py](../scripts/research/trading_path_inventory.py),
a static import map from the trading jobs. "Not reached" means no scheduled
trading job imports it. Each item still needs a check that nothing else
depends on it.

| Area | Size | Reached by trading? | Recommendation |
| --- | ---: | --- | --- |
| Prediction and ML engine (`src/lib/prediction`, `src/app/api/prediction`, Prediction page, Danger and TDA badges) | 40 files, about 5,850 lines | No | Remove: advisory only, never validated, and its badges add noise to every page |
| AI analyst (`src/lib/analyst`, `src/app/api/analyst`) | 18 files, about 2,870 lines | No | Remove, or keep only if you use the explanations |
| Research and audit pages: Causal Audit, Signal Audit, Score Lab, Filter Scorecard, Breakout Evidence, Evidence, Execution Quality, Exec Audit, Trade Pulse, Watchlist News, Signals/Backtest | 11 pages (about 5,500 lines) plus their API routes and components | No | Remove or merge into one "Research" page; the scripts in `scripts/research` now do this work reproducibly |
| Module system (`src/lib/modules`, `/api/modules`) | 11 files, about 1,570 lines | No | Check, then remove |
| Jev (Typesafe) veto | 7 library files, a scheduled job, paid requests | Yes (auto-trade) | Keep until its scorecard reports (late October); remove if it still adds nothing |

**Keep:** the buy path, stops and sync, the manual Buy/Execute and Stops screens
and their routes, the dashboard, positions, trade log, alerts, settings, and
the research scripts.

## Step 2: simplify the trading rules (needs a paper test)

Successful trend systems use a handful of rules. A simpler core for this app,
built only from parts it already has:

1. Trade only when the market regime is bullish (existing regime check).
2. Stock above its 200-day average, trend strength (ADX) above 20, price data
   fresh.
3. Buy when the price breaks above the 20-day high (the existing trigger),
   without chasing more than 0.8 ATR above it.
4. Stop at 1.5 × ATR; position size from risk; existing risk caps.
5. Sell on a failed breakout (now live) or on the trailing stop.

That leaves out the three scores, the rank score, the volume and
relative-strength gates, ATR-spike demotion, Jev and the prediction overlays.
Fewer parts make it easier to test, harder to overfit, and leave fewer places
for bugs.

**Do not switch to it directly.** A simpler rule set is still a new strategy:

1. Add it as a frozen variant to the forward test
   (`prospective_shadow_tests.py`), alongside the current rules.
2. Compare both on the same new signals.
3. Switch only if the simple core does at least as well, with the same evidence
   bar as the restart check.

Until then, the current rules stay, and pausing new buys is still recommended.

## Needs your decision

| ID | Decision | Recommendation |
| --- | --- | --- |
| S1 | Remove the prediction/ML engine and its badges | Yes |
| S2 | Remove the AI analyst | Yes, unless you use it |
| S3 | Remove or merge the 11 research and audit pages | Merge into one page, or remove |
| S4 | Paper-test the simple core strategy | Yes; it runs alongside, with no live change |
| S5 | Jev | Decide after its scorecard in late October |

## Reproduce

```powershell
python scripts/research/trading_path_inventory.py
```
