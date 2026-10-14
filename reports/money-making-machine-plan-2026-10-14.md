# How Could We Turn HybridTurtle Into a Money-Making Machine? (2026-10-14)

Read-only audit plus two small code fixes (`typesafe-review-source.ts` and
`repair-t212-tickers-from-instruments.ts`). Script:
[money_machine_audit.py](../scripts/research/money_machine_audit.py).

## 1. The Short Answer: Account Scale & Expectancy Mathematics

A trend-following system makes money only when:

$$\text{Expectancy per trade} = (\text{Win\%} \times \text{Avg Win}) - (\text{Loss\%} \times \text{Avg Loss}) - \text{Costs} > 0$$

Right now, two structural facts govern the account (`£219.51` ISA equity,
`SMALL_ACCOUNT` profile):

1. **At £219 equity, no strategy tweak turns the account into a "money machine"
   in pound terms.** Because `SMALL_ACCOUNT` caps any `CORE` position at 20% of
   equity (~£44) and `HIGH_RISK` at 12% (~£26), a stock with a 5% stop distance
   risks only **~£2.20 (`1R`)**. Even a strong institutional trend-following
   edge of **+0.25R to +0.30R per trade** over 80 trades a year earns **£44 to
   £53 per year before FX fees**. At this capital size, the account is a **live
   testbed** whose job is to prove positive R-expectancy at minimal pound cost
   before scaling capital.
2. **Realised live expectancy is currently negative (`-0.20R` overall, `-0.38R`
   on auto-trade), though on a small sample (`n=37`) with wide confidence
   intervals.** Meanwhile, passive zero-FX UK index ETFs (`VUAG.L` +7.2%,
   `VWRL.L` +6.3%) beat the account's capital-adjusted time-weighted return
   (`-8.76%` from 17 May to 13 October 2026) by **15–16 percentage points**.

| Cohort (through 2026-10-14) | Trades (`n`) | Win Rate | Avg Win | Avg Loss | Payoff Ratio (Breakeven Win%) | Expectancy `E[R]` | Net Realised P&L |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| All closed positions | 37 | 29.7% | +0.84R | −0.64R | 1.32 (needs 43%) | **−0.20R** | −£45.84 |
| Auto-trade closed | 22 | 18.2% | +0.81R | −0.65R | 1.25 (needs 44%) | **−0.38R** | −£42.14 |
| Manual (`trading212`) closed | 15 | 46.7% | +0.85R | −0.61R | 1.41 (needs 42%) | **+0.08R** | −£3.70 |

*Note on sample size:* With `n=22` auto-trades (mostly July–October) and `n=15`
manual trades (mostly May–June), the 95% confidence interval on the 18.2% win
rate spans roughly 5%–40%, and source is confounded with market period. And
across 502 `CORE` stocks in the database, cross-sectional momentum and ADX
filters flipped sign between the June–July development window and the
August–September holdout window. The buy signal is therefore **unproven**, not
fixable by in-sample filter tuning.

---

## 2. What Is Already Working (Keep It)

1. **Failed-breakout auto-exit (`FAILX`, live since 8 October, commit
   `6c1e03d`).** This was the only rule that passed the pre-registered holdout
   test (`+0.13R` per trade, 99% CI `[+0.03, +0.23]`, `n=531`). Since going
   live six days ago, it has already executed **two automatic exits**:
   - **NTAP** (exited 9 Oct 13:46 UTC at **−0.45R / −£1.03** instead of riding
     to a full −1.0R stop).
   - **LCUT** (exited 13 Oct 13:46 UTC at **−0.25R / −£0.56**).
2. **Stop ratcheting on winners.** Of the 4 currently open positions (`PLTR`,
   `MRNA`, `VEEV`, `V`), `PLTR` (entered 23 Sep at $190.61) has had its stop
   ratcheted above entry to $200.08 (**+0.84R locked in**, currently ~+1.16R).

---

## 3. Concrete Leaks Found in This Audit (And What We Fixed vs What Needs Your Decision)

### A. Fixed now: Background Jev worker was spending 44% of its reviews on unbuyable stocks (`M3a`)
- **Evidence:** In `data/typesafe-review/ledger.json`, 14 of the 32
  model-answered reviews (`OCDO.L` ×5, `SHEL` ×3, `PSON.L` ×2, `ACVA` ×2,
  `COLO-B.CO` ×1, `DSFIR.AS` ×1) were spent on stocks with `t212Ticker = null`
  or `isaEligible != 1`. `TypesafeReviewSource.latest()` in
  `src/lib/typesafe-review-source.ts` did not filter for `stock.t212Ticker` or
  `stock.isaEligible`.
- **Fix applied:** `TypesafeReviewSource.latest()` now requires
  `stock.t212Ticker IS NOT NULL AND stock.t212Ticker != '' AND stock.isaEligible = 1`.
  Unit test updated in `src/lib/typesafe-review-source.test.ts`.

### B. Fixed now (dry-run tool): Repair script skipped `t212Ticker = null` rows (`M3b`)
- **Evidence:** 29 active FTSE `.L` stocks (`OCDO.L`, `PSON.L`, `LLOY.L`,
  `RR.L`, `GLEN.L`, `BATS.L`, `LGEN.L`, `LSEG.L`, etc.) have `isaEligible = 1`
  and an unambiguous pence-quoted (`GBX`) London line in `t212-instruments.json`
  (`OCDOl_EQ`, `PSONl_EQ`, etc.), but `t212Ticker = null`. On 9 Oct (`OCDO.L`,
  rank 117.53) and 13 Oct (`PSON.L`, rank 104.20), the #1-ranked A-grade buys in
  UK sessions failed with `No T212 ticker mapped`.
- **Fix applied (code):** Added `--include-unmapped` to
  `scripts/repair-t212-tickers-from-instruments.ts`, restricted `.L` matches to
  pence-quoted (`GBX`/`GBp`) lines (matching `ukLineUnitsIssue`), and refused to
  auto-map bare non-US tickers or EU/AU listings that lack a trading session.
- **Dry-run result:** Identifies **29 of the 33 unmapped `.L` stocks** ready to
  map; the remaining 4 (`CPG.L` USD line, `IWQU.L` EUR/USD lines, and `VUAG.L` /
  `VAGS.L` GBP lines) stay unmapped because T212 does not quote them in pence.
  Applying this (`--include-unmapped --apply`) expands what auto-trade can buy
  in UK sessions (note: UK shares pay 0.5% stamp duty), so it is in **Needs
  your decision (`D2`)**.

### C. Universe hygiene: 122 of 1,019 active stocks cannot execute or are misrouted (`M2`)
From `python scripts/research/money_machine_audit.py`:
- **21 bare UK rows** (`SHEL`, `AZN`, `GSK`, `ULVR`, `DGE`, `REL`, `HSBA`, `NG`,
  `SSE`, `RIO`, `INRG`, `SGLN`, `SSLN`, `VUSA`, `CNDX`, etc.) are stored without
  `.L`, while `toYahooTicker` prices them from `.L` in pence. Because
  `isStockForSession` checks `ticker.endsWith('.L')`, auto-trade routes them
  into **US sessions** (`SHEL` entered US auto-trade 3 times on 12–13 Oct before
  aborting at the ticker check). Three (`RIO`, `REL`, `SHEL`) are also
  duplicates of `RIO.L`, `REL.L`, `SHEL.L`.
- **31 EU/Swiss/Nordic/Australian rows** (`SAP`, `ASML`, `NVO`, `NOVN`,
  `COLO-B.CO`, `DSFIR.AS`, etc.) have no trading session at all since commit
  `8a24f01` restricted US sessions to US listings.
- **34 US mapped rows** (`META`, `ARM`, `NKE`, `SMCI`, `NET`, `WFC`, `FDX`,
  `CMG`, etc.) have valid `_US_EQ` tickers in T212's cache but
  `isaEligible = null`.
- **Decision (`D3`):** Deactivate the 31 EU/AU rows (no session) and the 3
  duplicate bare UK rows (`RIO`, `REL`, `SHEL`), and either convert the
  remaining bare UK rows to `.L` or deactivate them.

### D. Session timing: 20:30 UK (`us-close`) accounts for 66% of auto-trade £ losses (`M4`)
| Entry Session (UK) | Closed Auto-Trades | Wins | Mean `R` | Median `R` | Net Realised P&L |
| --- | ---: | ---: | ---: | ---: | ---: |
| `14:45` (`us` open) | 6 | 2 / 6 (33%) | −0.17R | −0.33R | −£0.50 |
| `17:00` (`us-mid`) | 4 | 1 / 4 (25%) | −0.16R | −0.74R | −£13.71 |
| `20:30` (`us-close`) | 12 | 1 / 12 (8%) | **−0.57R** | −0.67R | **−£27.93** |

*Caveat:* `n=12` across three sessions is a small post-hoc subgroup (the most
recent 20:30 buy, `LCUT` on 12 Oct, also failed the next day at −0.25R). Rather
than treating it as proven, disabling `HybridTurtle-Trade-USC` (or switching it
to scan-only) is a low-cost **operational decision (`D4`)** if you want fewer,
higher-quality entries while the forward tests run.

### E. FX friction and profit giveback (`M1` / `M5`)
- **Estimated FX drag:** The 37 closed trades turned over ~£10,549 of round-trip
  notional. At Trading 212's 0.15% FX fee per side on USD stocks [estimate from
  notional; exact fee per fill is not stored in `Position`], FX cost **~£15.82**
  — about **35% of the −£45.84 total loss**. Fewer trades and longer holds
  directly reduce this drag.
- **Profit giveback (`M5`):** Among the 33 closed trades with cached daily bars,
  10 reached at least `+1.0R` on a closing basis while held (and 18 reached
  `+1.0R` within 40 sessions of entry), yet only 4 closed at `+1.0R` or better.
  Because the live trailing stop (`highestClose - 1.5 × ATR`) is active from Day
  1, a dip or ATR contraction pulls the stop up before a trend establishes. The
  `LATE` variant (trail only after a `+1.0R` close) and `CHAND` (22-day
  Chandelier exit) are already running in `prospective_shadow_tests.py` (`E1`).
  Do not modify `stop-manager.ts` until `E1` reaches its 30-trade gate.

---

## 4. The Practical Roadmap ("Needs Your Decision")

| ID | Decision | Impact | Recommendation |
| --- | --- | --- | --- |
| **D1** | **Capital allocation & operating mode:** Put main capital in a zero-FX GBP index ETF (`VUAG` / `VWRP`) in an account HybridTurtle is **not** connected to, and either set HybridTurtle to `CAPITAL_PRESERVATION` (pause new buys while keeping stops/FAILX/scans running) or let the £219 ISA run as a small testbed until the restart check (`LIVE` lower 95% CI > 0 over 30 independent signals) passes | Stops negative-expectancy compounding and 0.30% RT FX bleed on main capital while preserving forward evidence | **Yes — highest-leverage move** |
| **D2** | **Apply the 29 FTSE `.L` GBX mappings** (`npx tsx scripts/repair-t212-tickers-from-instruments.ts --include-unmapped --apply`) | Makes 29 FTSE 100/250 stocks (`OCDO.L`, `PSON.L`, `LLOY.L`, `RR.L`, etc.) buyable in UK sessions with zero FX fee (0.5% UK stamp duty applies) | **Approve if you want UK stocks active; skip if you prefer US-only** |
| **D3** | **Clean the 122 non-buyable / misrouted active Stock rows:** deactivate the 31 EU/AU rows (no session) and 3 duplicate bare UK rows (`RIO`, `REL`, `SHEL`), and normalise or deactivate the remaining 18 bare UK rows | Stops `SHEL` and EU stocks from polluting US sessions, rankings, and candidate slots | **Yes — pure hygiene** |
| **D4** | **Pause the 20:30 UK (`us-close`) buying session** (`HybridTurtle-Trade-USC`) | Removes the session responsible for 11 of 12 losses (−£27.93, −0.57R mean); entries happen only at 14:45 and 17:00 UK | **Optional — low-risk way to cut trade frequency and FX churn** |

## 5. Update (Same Day): Owner Approved D1–D4

All four recommendations have been applied (full DB backup saved first at
`prisma/backups/dev-pre-d1-d4-2026-10-14.db`):

1. **D1 — `CAPITAL_PRESERVATION` active:** `User.operatingMode` is now
   `CAPITAL_PRESERVATION` (`/api/dashboard/today-directive` confirms: *"Capital
   Preservation mode — no new trades. Managing 4 existing positions. Stops and
   exits only."*). Auto-trade Step 0 (`FAILX` failed-breakout exits), nightly
   stop ratcheting, midday sync, and the 20:00 evening scan continue to run so
   the forward tests (`prospective_shadow_tests.py` restart check, `E1`, `S4`)
   keep accumulating evidence without risking new capital.
   - *Your manual action outside the app:* Hold long-term capital in a zero-FX
     GBP index ETF (`VUAG` or `VWRP`) in an account HybridTurtle is **not**
     connected to.
2. **D2 — 29 FTSE `.L` pence-quoted stocks mapped:** Ran
   `npx tsx scripts/repair-t212-tickers-from-instruments.ts --include-unmapped --apply`,
   mapping 29 FTSE 100/250 stocks (`OCDO.L` → `OCDOl_EQ`, `PSON.L` → `PSONl_EQ`,
   `LLOY.L` → `LLOYl_EQ`, `RR.L` → `RRl_EQ`, `GLEN.L` → `GLENl_EQ`, `BATS.L` →
   `BATSl_EQ`, `LGEN.L`, `LSEG.L`, `EXPN.L`, `IMB.L`, `III.L`, `BBOX.L`,
   `LAND.L`, `SGRO.L`, `BLND.L`, `NXT.L`, `SBRY.L`, `WISE.L`, `JET2.L`,
   `HIK.L`, `MNDI.L`, `ITV.L`, `MKS.L`, `AUTO.L`, `DPLM.L`, `WPP.L`, `REL.L`,
   `SHEL.L`, `AAL.L`).
3. **D3 — 93 non-buyable / misrouted active `Stock` rows deactivated:** Every
   remaining active row that could not execute cleanly in the ISA (31 EU/AU rows
   with no session, 21 bare UK rows including duplicates `RIO`/`REL`/`SHEL` that
   routed into US sessions, 34 non-ISA-tagged US rows, 6 non-GBX UK ETFs, 1
   unmapped US ETF) was set to `active = 0` (undo file saved at
   `prisma/backups/d3-universe-hygiene-undo-2026-10-14.json`).
   `python scripts/research/money_machine_audit.py` now confirms **926 active
   rows (`CORE` 556, `HIGH_RISK` 368, `ETF` 2) and 926 buyable (100% clean, 0
   misrouted or unbuyable)**.
4. **D4 — 20:30 UK (`us-close`) buying session paused:** `auto-trade-task.bat`
   now exits 0 immediately when called with `us-close` (unless
   `PAUSE_US_CLOSE=0` is set in the environment), keeping the Windows Scheduled
   Task manifest intact while pausing the session where 11 of 12 historical
   auto-trades lost money.

## Reproduce

```powershell
python scripts/research/money_machine_audit.py
npx tsx scripts/repair-t212-tickers-from-instruments.ts --include-unmapped
```
