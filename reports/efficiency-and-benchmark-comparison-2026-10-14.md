# How to Make HybridTurtle More Efficient & What Successful Auto-Trade Systems Do (2026-10-14)

Read-only operational and strategy audit plus three surgical efficiency fixes.

---

## 1. What Successful Automated Trend Systems Do That HybridTurtle Does Not

Comparing HybridTurtle against institutional and proven systematic trend-following architectures (Turtle System 1/2, Andreas Clenow's *Stocks on the Move*, Carver's *Systematic Trading*, O'Neil/Minervini breakout rules):

| Dimension | What Successful Automated Systems Do | What HybridTurtle Currently Does | Why It Matters & What to Do |
| --- | --- | --- | --- |
| **1. Scan & Compute Architecture (Data Once, Evaluate Cheaply)** | **Decouple market-data ingestion from order execution.** Daily OHLCV bars and indicators (`MA200`, `ADX`, `ATR`, `20d High`) are computed **once per day** after the close and written to a local table/cache. Intraday execution jobs only fetch live quotes for the **10–30 stocks within ~2% of their trigger**, finishing in **2–5 seconds**. | Every session (`uk`, `uk-mid`, `us`, `us-mid`, `scan`) calls `runFullScan()`, which fetches and computes full technicals for **all 926 active stocks** (~12 minutes per session, even when `uk` only trades **41 `.L` stocks**). And when `CAPITAL_PRESERVATION` is active, Gate 3a exits *before* Step 1, so the 20:00 `scan` session still scans all 926 stocks while daytime sessions do Step 0 (`FAILX`) and exit in 2s. | **Already improved today** by `CAPITAL_PRESERVATION` (daytime sessions no longer run 12-min scans) and pausing `us-close`. **Next efficiency step (`O1`, optional sacred-file change):** pass a session market filter into `runFullScan` (or read the 20:00 `Scan` snapshot and only fetch live quotes for `READY`/`WATCH` stocks), cutting daytime UK scans from **926 stocks (~12 min) to 41 stocks (~30 sec)**. |
| **2. Order Execution Mechanics (Resting Stop-Limit vs Market-on-Poll)** | **Place resting `STOP` or `STOP_LIMIT` buy orders at `entryTrigger`** before the session opens (or evaluate at the daily close / next open). The exchange triggers the order at the exact breakout level with bounded slippage. | Polls prices at fixed clock times (`08:20`, `10:30`, `14:45`, `17:00`) and submits a **`MARKET` order** (`placeMarketOrder`). Average live fill was `0.24R` above trigger; `20:30` near-close market buys lost 11 of 12 times (`-0.57R`). | Pausing `20:30` (`D4`, done) and using `FAILX` (live) remove the worst late-day chase fills. Trading 212's API supports `STOP` / `STOP_LIMIT` orders, but switching from market-then-stop to resting entry orders is a major execution change—**do not build until forward tests prove the entry signal itself has positive expectancy**. |
| **3. Cross-Sectional Relative Strength Ranking** | **Rank the entire universe by risk-adjusted trend slope** (e.g. Clenow's 90-day exponential regression slope $\times R^2$, or 6-month volatility-adjusted relative strength) and **only allow breakouts in the top 10%–20% of the universe**. Breakouts in laggard or mid-pack stocks are ignored. | Computes `BQS` / `FWS` / `NCS` (10+ weighted sub-components) and `rankScore`. On the pre-registered Aug–Sep holdout (`reports/holdout-test-2026-10-08.md`), `NCS` ordering failed to beat `rankScore` (`IC +0.029`, not significant) and `FWS` **reversed sign** (`IC -0.039`). | Complex multi-factor composite scores (`NCS`/`FWS`) overfit noise. Forward test `S4` (`prospective_shadow_tests.py`) is already testing whether a simple 4-rule `CORE` filter beats `A_GRADE_BUY`. |
| **4. Volatility-Parity Sizing vs Notional Caps** | **Equalise risk (`1R`) across every trade** (`Shares = (Equity × Risk%) / (1.5 × ATR)`), holding 10–25 positions so no single stop distance dominates pound P&L. | `SMALL_ACCOUNT` sets `riskPerTrade = 2%`, but caps `CORE` position value at **20% of equity (~£44)**. Any stock with a stop tighter than 10% is cap-bound at £44, making sizing **equal-notional rather than equal-risk**: a 10% stop risks 2.0% of equity, while a 3% stop risks 0.6%. | Structural effect of a £219 4-position account. Lowering `riskPerTrade` to `1.0%` (`O2`, sacred file) would align the risk target with the 20% notional cap for all stops $\ge 5\%$. |
| **5. Asymmetric Exits (Fast Failure Cut + Wide Initial Trail)** | **Cut failed breakouts immediately** (O'Neil/Minervini pivot failure), then **keep the initial stop fixed until the trade reaches $+1.0R$ to $+1.5R$** (or trail with a wide $3\times \text{ATR}_{22}$ Chandelier exit) so normal post-breakout pullbacks don't choke winners at $+0.2R$. | `FAILX` (live since 8 Oct) now cuts failed breakouts fast (already saved money on `NTAP` at `-0.45R` and `LCUT` at `-0.25R`). However, the trailing stop (`highestClose - 1.5 × ATR`) is active from **Day 1**, so an ATR contraction tightens the stop before $+1R$ is reached (10 of 33 closed trades reached $\ge +1.0R$ close while held, but only 4 closed $\ge +1.0R$). | `LATE` (trail only after $+1.0R$ close) and `CHAND` (22-day $3\times \text{ATR}$ Chandelier) are already running in `prospective_shadow_tests.py` (`E1`). **Wait for `E1` to reach its 30-trade gate before touching `stop-manager.ts`.** |
| **6. Cost-to-Risk Ratio (< 2% of `1R`)** | Trade instruments or account sizes where round-trip commission + FX + spread is **under 1%–2% of `1R`**. | On a £44 USD stock position (`1R` ≈ £2.20), Trading 212's `0.15%` FX fee per side (`0.30%` round-trip ≈ £0.13) plus spread consumes **~6%–8% of `1R` on every trade** (~£15.82 estimated FX drag across 37 closed trades = 35% of total loss). | Keep main capital in zero-FX GBP index ETFs (`VUAG`/`VWRP`) in an unconnected account (`D1`), and prefer low-turnover holds. |

---

## 2. Concrete Efficiency & Accuracy Bugs Found and Fixed in This Review

### Fix 1 (`E1` — P1): `health-check.ts` `C3`, `G2`, and `G3` used the wrong denominator (and raw USD entry prices), causing a permanent false `YELLOW` health status
- **Evidence:** In `prisma/dev.db`, the latest `HealthCheck` row (`cmv8cvad10005vbwo061fx6di`) was `YELLOW` solely because:
  - `C3 (Valid Position Sizes)`: *"4 position(s) exceed size limits (mark-to-market)"*
  - `G2 (Cluster Concentration)`: *"Concentration warning: AI_Robotics: 27% > 25%, Technology: 25% > 25%"*
- **Root cause:**
  - `src/lib/risk-gates.ts` (Gates 3–6) and `checkSleeveLimits` (`G1` in `src/lib/health-check.ts:640`) measure each position/cluster/sector against `denominator = Math.max(equity, nonHedgeInvested)` in GBP.
  - However, `checkPositionSizes` (`C3`, `src/lib/health-check.ts:532`) divided each position by `totalValue` (**invested positions only**, ignoring cash). Whenever 4 `CORE` positions are held at roughly equal size, their average share of *invested* capital is $1/4 = 25\% > 20\%$ (`SMALL_ACCOUNT` `CORE` cap), so **every 4-position portfolio was guaranteed to fail `C3` on at least one position** even when every position was $\le 20\%$ of account equity!
  - Similarly, `checkClusterConcentration` (`G2`, line 665) and `checkSectorConcentration` (`G3`, line 704) summed raw `p.entryPrice * p.shares` (mixing USD and GBX without GBP normalisation) and divided by `totalValue` (invested-only) instead of `Math.max(equity, nonHedgeInvested)`.
- **Impact on auto-trade:** `persist-scan-snapshot.ts:81` and `auto-trade.ts:1441` pass `latestHealth.overall` into `classifyCandidate`. A false `YELLOW` health status did not block buys, but it permanently degraded dashboard readiness (`WARNING`) and polluted nightly alerts.
- **Fix applied:** `checkPositionSizes` (`C3`), `checkClusterConcentration` (`G2`), and `checkSectorConcentration` (`G3`) in `src/lib/health-check.ts` now use mark-to-market GBP prices over `Math.max(equity, nonHedgeInvested)`, matching `risk-gates.ts` and `G1`. Unit tests added in `src/lib/health-check.test.ts`.

### Fix 2 (`E2` — P1): `midday-sync.ts` called `GET /equity/account/summary` twice within 1 second on every run, tripping Trading 212 HTTP 429 rate limits 4 times a day
- **Evidence:** `midday-sync.log` (10:00, 13:00, 16:00, 19:00 on 13–14 Oct) logged on every run:
  `T212 rate limited on GET /equity/account/summary, retrying in 4581ms (attempt 1/2)`.
- **Root cause:** `syncClosedPositions()` in `src/lib/position-sync.ts:475` calls `dualClient.fetchBothAccounts()`, which calls `client.getAccountSummary()` (`1 req / 5s` rate limit at Trading 212) and `client.getPositions()`. Immediately after `syncClosedPositions()` returned, `src/cron/midday-sync.ts:109` called `refreshUserEquityFromBroker(userId)`, which called `client.getAccountSummary()` a **second time** within milliseconds—guaranteeing a 429 rate-limit error and a 4.5-second retry sleep on every midday sync.
- **Fix applied:** `syncClosedPositions()` (`src/lib/position-sync.ts`) now extracts `totalValue` from the `dualResult` summary it already fetched, writes `User.equity` in the same `prisma.user.update` call that records `t212LastSync`/`t212IsaLastSync` (only when all configured accounts succeeded, which is safer than writing a partial total if one account fails; `hourly-status.ts` also gets this equity refresh for free), and returns `result.equityRefreshed`. Both `src/cron/midday-sync.ts` and `src/cron/nightly.ts` use `result.equityRefreshed` when present and only call `refreshUserEquityFromBroker` as a fallback. This cuts their `/equity/account/summary` calls in half (from 2 to 1) and eliminates the midday-sync 429 rate-limit hit.

### Fix 3 (`E3` — P2): `/api/system-status` reported a false `WARNING` (`T212 Prices: 4 tickers, 527s old`) whenever the dashboard tab was idle
- **Evidence:** Calling `GET /api/system-status` returned `readiness: "WARNING"` because `t212_prices` required the in-memory `t212PriceCache` age to be `< 300s` (5 minutes) and never rehydrated from `prisma/cache/t212-prices.json` once the server's in-memory map had entries (`rehydrateT212PriceCache()` returned early if `t212PriceCache.size > 0`). Because standalone cron processes (`midday-sync`, `hourly-status`) update `prisma/cache/t212-prices.json` on disk roughly once an hour and cannot update the Next.js server's in-memory map directly, the Next.js server's in-memory timestamp went stale whenever no browser tab was actively polling `/api/positions`.
- **Fix applied:** `rehydrateT212PriceCache()` (`src/lib/position-sync.ts`) now merges newer on-disk entries from `prisma/cache/t212-prices.json` even when the in-memory cache already has entries (throttled to at most one disk read per 30 seconds), and `/api/system-status` (`src/app/api/system-status/route.ts`, display-only check, not used by any trading gate) calls `rehydrateT212PriceCache()` and allows up to `5400s` (90 minutes, matching the hourly background cadence) before flagging `t212_prices`.

---

## 3. Optional Next-Step Improvements ("Needs Your Decision")

| ID | Proposal | Files Affected | Benefit vs Trade-off |
| --- | --- | --- | --- |
| **O1** | **Filter `runFullScan` universe by session market** (pass an optional ticker/sleeve predicate into `runFullScan` so `uk` / `uk-mid` only scan the **41 active `.L` stocks** instead of all **926 stocks**) | `src/lib/scan-engine.ts` (**sacred**), `src/cron/auto-trade.ts` (**sacred**) | Cuts `uk` and `uk-mid` runtime and Yahoo Finance API calls by **95%** (from 926 stocks / ~12 min to 41 stocks / ~30 sec) once you return to `NORMAL` mode. *(While in `CAPITAL_PRESERVATION`, daytime sessions already exit at Gate 3a before scanning.)* |
| **O2** | **Align `SMALL_ACCOUNT` `riskPerTrade` (2.0% → 1.0%) with the 20% notional cap** | `src/types/index.ts`, `src/lib/position-sizer.ts` (**sacred**) | Equalises risk per trade at ~1.0% of equity across both moderate-volatility (5% stop) and high-volatility (10% stop) stocks, preventing wide-stop stocks from taking 3× the pound risk of normal stocks. |
| **O3** | **Keep `E1` (`LATE` / `CHAND`) and `S4` (`CORE` simple rule) running in shadow mode** | None (`scripts/research/prospective_shadow_tests.py` already active) | Evaluates whether delaying the trailing stop until $+1.0R$ (`LATE`) and replacing `BQS`/`FWS`/`NCS` with the 4-rule `CORE` filter improve out-of-sample expectancy before any live change. |

---

## 4. Update (Same Day): Owner Approved O1 & O2

Both sacred-file enhancements have been implemented, tested, and logged in
`docs/SACRED_FILE_CHANGES.md`:

- **O1 — Session universe filter in `runFullScan` (`src/lib/scan-engine.ts`,
  `src/cron/auto-trade.ts`):** `runFullScan` now accepts an optional
  `universeFilter` predicate. For trading sessions (`uk`, `uk-mid`, `us`,
  `us-mid`, `us-close`), `auto-trade.ts` passes `isStockForSession`, so `uk` /
  `uk-mid` scan only the **41 active `.L` stocks** (~30 seconds) instead of all
  **926 stocks** (~12 minutes). The 20:00 `scan` session and `/api/scan`
  continue to scan the full 926-stock universe.
- **O2 — `SMALL_ACCOUNT` `riskPerTrade` aligned from `2.0%` to `1.0%`
  (`src/types/index.ts`, `src/lib/allocation-score.ts`,
  `src/lib/position-sizer.test.ts`):** Equalises pound risk at `1.0%` of equity
  (~£2.20 on £220) across both 5%-stop and 10%-stop stocks.
