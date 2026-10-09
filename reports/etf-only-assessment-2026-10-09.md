# Would we be better off trading only ETFs? (2026-10-09)

Read-only analysis plus one block-only safety fix. Script:
[etf_vs_stock.py](../scripts/research/etf_vs_stock.py).

## Answer

**Not by switching the breakout system to ETFs.** Over the same period, simply
holding an index ETF beat the system by 16–17 percentage points:

| 17 May – 8 Oct 2026 | Return |
| --- | ---: |
| This account (time-weighted, deposits and withdrawals removed) | **−9.7%** |
| Buy and hold VUAG (S&P 500, ISA-buyable) | **+7.2%** |
| Buy and hold VWRL (FTSE All-World, ISA-buyable) | **+6.3%** |

This is one five-month bull-market window and a lump-sum comparison in
hindsight, so it is not a stable measure of the gap. But it is the honest
benchmark, and the system is behind it.

Trading ETFs with the same breakout rules would not have fixed this:

- **No evidence ETFs do better.** In the simulation, ETF breakouts made no more
  per trade than stock breakouts: −0.02% of equity per trade, with a 95%
  interval of −0.17% to +0.16%. That is only 21 ETF signals on 9 dates, so it
  is *inconclusive*, not a proof that they are worse. Both groups lost money
  in this period.
- **Hardly any ETF is tradable for this ISA.** Only 12 of the 58 ETFs in the
  universe are ISA-eligible. Of those, 8 have no broker ticker, and the 4 that
  have one (CMOD, IGLT, IIND, HMWO) use codes Trading 212 doesn't have
  (e.g. `IGLT_UK_EQ`; the real one is `IGLTl_EQ`). So **ETF-only mode would
  buy nothing today.** It is off, and should stay off until this is fixed.
- **Few signals and small wins.** Only 6 of the 12 ISA ETFs were in uptrends
  (S&P 500, Nasdaq, World, commodities). Low-volatility ETFs hit the 16%
  position cap, so each trade risks only about 0.2–0.5% of equity. A full +1R
  ETF win is worth about £1 on £217.
- **Real ETF history is one trade** (CNDX, +0.45R, +£3.70). The 35 stock
  trades lost about £49.

## What the review found along the way

1. **No UK stock or ETF can be bought by auto-trade.** None of the 50 active UK
   instruments has a broker ticker that exists at Trading 212. In practice the
   system trades US stocks only (779 valid ISA-eligible instruments).
2. **About 190 broker tickers look invalid**, checked against Trading 212's
   instrument list (cached on 2 June). Trading 212 still uses legacy codes,
   e.g. META = `FB_US_EQ` and RTX = `UTX_US_EQ`. One cost a real buy: VTRS was
   rejected on 28 September with "does not recognise the instrument". A few
   others may simply be newer than the June list, so this is likely, not
   certain.
3. **Latent 100× sizing bug — fixed.** All three buy paths (auto-trade, the
   manual Buy button and nightly pyramid adds) treat every UK price as pence. Several London ETFs trade
   in pounds or dollars (VUAG, VUSA, VWRL and IGLT in GBP; CNDX and CMOD in
   USD). Mapping any of them would have bought about 100× the intended size,
   with the stop in the wrong units. All three now refuse a UK line unless
   Trading 212's instrument list says it trades in pence. This changes nothing
   today, because no UK line is mapped correctly.
   - **Still open:** the valuation code (open risk, exposure, pyramid cash
     check) also treats a held UK line as pence. It only matters if you hold a
     pound- or dollar-quoted London ETF in the connected ISA, so don't.
     Logged as a follow-up.
4. Leveraged and inverse products (SQQQ, SH, SPXS, VXX) sit in the ETF list.
   They are not ISA-eligible, so they can't be bought. They're low priority.

## Recommendation

1. **Core and satellite, with the core outside the connected account.** Hold
   most of your money in one buy-and-hold index ETF (VUAG or VWRP/VWRL). Let
   the system trade a small satellite until the forward tests (restart check,
   S4) show it has an edge.
   - **Do not buy the core in the ISA the app is connected to.** The sync
     adopts every holding there as a trading position, and nightly pushes
     trailing stops onto all open positions, HEDGE included. Your one manual
     ETF (CNDX) was stopped out this way. The core would be managed and could
     be sold, and auto-trade would size from the combined equity.
   - Put the core in an account the app can't see: another provider's Stocks
     & Shares ISA, or the Trading 212 Invest account (not connected; taxable).
     Whether Trading 212 lets you hold a second ISA is [unverified]; check in
     the app.
   - Making the app ignore a core holding inside the same ISA would be a new
     feature, needing your decision.
2. **Keep ETF-only mode off.** If you want ETFs in the satellite, first fix the
   mappings, starting with the lines Trading 212 quotes in pence: EQQQ
   (`EQQQl_EQ`), HMWO (`HMWOl_EQ`), INRG (`INRGl_EQ`), SGLN (`SGLNl_EQ`).
   Pound- and dollar-quoted lines stay blocked until UK units are handled.
3. **Refresh the instrument list and repair the tickers.** This needs one
   read-only call to the broker: `scripts/repair-t212-tickers-from-instruments.ts`,
   a dry run by default.

## Follow-up: owner approved the recommendations (same day)

**D3 — instrument list refreshed, tickers repaired.**
- One read-only call to Trading 212 fetched 18,481 instruments.
- `scripts/repair-t212-tickers-from-instruments.ts` gained `--include-unknown`,
  which also repairs well-formed tickers that don't exist at Trading 212. In
  every mode, a US-priced stock now maps only to a `_US_EQ` line, and a
  non-US-priced one never does.
- 136 broker tickers were repaired, e.g. META → `FB_US_EQ`,
  VTRS → `MYL_US_EQ`, TSCO.L → `TSCOl_EQ`.
- 90 US stocks had no stored currency, so auto-trade had been skipping them.
  Each now has Trading 212's currency for its line (USD).
- 242 rows still have no match. 62 of them are active, mostly US-listed ETFs
  that UK accounts can't buy.

**D2 — ETF mappings.**
- EQQQ.L → `EQQQl_EQ`; HMWO.L → `HMWOl_EQ` (currency GBX). Both lines trade in
  pence.
- IGLT.L and IIND.L are now mapped too. They trade in pounds, so the new
  guard blocks them, as intended.
- INRG and SGLN are **not** mapped. They are stored without `.L`, so
  auto-trade's session filter would treat them as US stocks and try to buy
  them after the London market closes. Fixing that is a sacred-file change
  (`isStockForSession`), listed below.
- ETF-only mode stays off.

**Result.** Checked with the app's own guards (ticker exists, listing guard,
UK units guard, currency, session), ISA-eligible instruments auto-trade can now
buy:

| Sleeve | Buyable | Still not |
| --- | ---: | --- |
| CORE | 449 | 54 unmapped, 2 listing mismatches (ASML, RIO ADR rows; correct blocks) |
| HIGH_RISK | 359 | 2 tickers not at T212 |
| ETF | 2 (EQQQ.L, HMWO.L) | 7 unmapped, 2 blocked GBP lines, 1 not at T212 |

- **UK shares are now buyable by auto-trade for the first time**, in UK
  sessions: BA, TSCO, ABF, WEIR, BP, HSX, PRU, RIO, SMT, INF, plus the two
  ETFs. UK share purchases pay 0.5% stamp duty; the ETFs don't.
- **To undo:** restore the `Stock.t212Ticker` and `currency` columns from
  `prisma/backups/dev-pre-ticker-repair-2026-10-09.db`.

**D1 — core and satellite (your action in Trading 212; nothing was traded).**
1. Put long-term money in one buy-and-hold index ETF, for example VWRP
   (all-world, accumulating) or VUAG (S&P 500). Hold it in an account
   HybridTurtle is **not** connected to: the Trading 212 Invest account
   (taxable), or a Stocks & Shares ISA at another provider. UK rules have
   allowed paying into more than one S&S ISA in a tax year since April 2024
   [unverified for your provider; check before opening].
2. Don't give HybridTurtle that account's API key.
3. Leave the connected ISA as the satellite. Auto-trade sizes from that
   account's equity only.

**D4 — not done.** With the core outside the connected account, the app
doesn't need to ignore core holdings.

**Still open (owner decision):** `isStockForSession` and the UK checks key off
a `.L` suffix. London ETFs stored without it (CNDX, INRG, SGLN, SSLN, VUSA)
would be routed to US sessions. Use the Yahoo listing (`toYahooTicker`)
instead, then map them.

## Method and limits

- **Real trades:** the `Position` table.
- **Simulation:** every scan row that met the S4 CORE rule.
  - Entry at the next open, 1R = 1.5 × ATR, FAILX exits, 40-session horizon.
  - Each ticker counted at most once per 56 days.
  - Equity contribution uses SMALL_ACCOUNT sizing (2% risk, capped at 16% for
    ETFs, 20% for CORE, 12% for HIGH_RISK).
  - Costs: 0.15% FX each way on non-GBP lines; 0.5% stamp duty on UK shares.
- **Simulation limits:** every signal is taken (no ranking, no 4-position limit,
  no cluster cap); bid/ask spread is not modelled; it is in-sample (it includes
  the already-seen holdout).
- **Account return:** time-weighted, from equity snapshots with the 34 recorded
  cash movements removed (same method as the capital-adjusted drawdown).

```powershell
python scripts/research/etf_vs_stock.py
```
