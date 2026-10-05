---
title: Stock Selection and Jev Assessment 2026-10-01
description: Whether the selection pipeline and the Jev veto pick the best stocks, what was fixed, and what needs a decision.
ms.date: 2026-10-01
---

## Answer

**Not demonstrably.** The ordering auto-trade uses to choose which A-grade
stocks to buy (`rankScore`) showed no positive association with later returns
in the development window. The dual scores the system already computes (FWS,
NCS) showed a small but consistent positive in-sample association. Jev has reviewed 8 live buys and allowed all 8, so it has not
yet changed a single pick. None of this justifies a live change on its own: the
evidence covers one bullish six-week period, and the reserved holdout has not
been opened.

The assessment also found that the system had stopped measuring outcomes at
all. The cause is fixed and the first live nightly run (1 October) confirmed
outcomes are being measured again; see "First live run" below.

Independent review: GPT-6.1 Sol reviewed the method and findings. Its
corrections are incorporated below. In particular, the first draft's
"A-grades lose money" result was driven by bad labels (PSIG, WLFC) and has been
withdrawn.

## Method

Read-only. [selection_diagnostic.py](../scripts/research/selection_diagnostic.py)
follows the project's [research protocol](candidate-outcome-readiness-2026-09-10.md):

* **Signals:** 16 May to 30 June 2026 only (21 signal dates).
* **Holdout:** every outcome window ends before the 3 August holdout, which was
  not opened.
* **Returns:** recomputed from local `DailyBar` on an adjusted basis. Entry is
  the next session's open; exits are 10 and 20 sessions later. Stored
  `CandidateOutcome` labels were not used.
* **Scores:** grading-time scores saved on `ScanResult`. The backfilled
  `CandidateOutcome` scores are shown only for contrast (see F4).
* **Exclusion rule (retrospective):** windows containing a one-day move above
  35% are excluded. The rule was chosen after the PSIG and WLFC outliers had
  been seen, so it is a quality-control sensitivity check, not a pre-registered
  filter. It also removes genuine crashes and spikes. 556 windows were excluded;
  the script prints the full per-ticker ledger. WLFC is a confirmed unadjusted
  3:1 split; PSIG is unresolved. Results with nothing excluded are reported too.
* **Sensitivity:** first and last scan of each day are both reported.

Limits: descriptive, not an auto-trade replay. It has no stops, costs, FX,
capital limits or intraday session timing. Windows overlap heavily (21 dates,
20-session horizons), so the naive t-values overstate significance. 73 tickers
had no `DailyBar` series (aliases or delisted names).

## Evidence

Mean daily Spearman rank IC among candidates that passed the technical filters.
Positive means a higher score went with a higher later return; for FWS, lower
is better. All figures are in-sample associations from one period.

| Feature | 10 sessions (first / last scan) | 20 sessions (first / last scan) | Days positive (20s) |
| --- | ---: | ---: | ---: |
| `rankScore` (auto-trade buy order) | −0.029 / −0.042 | −0.007 / −0.022 | 38–48% |
| FWS, grading-time | +0.085 / +0.077 | +0.074 / +0.070 | 85% |
| NCS, grading-time | +0.047 / +0.043 | +0.042 / +0.040 | 75% |
| NCS, look-ahead backfill (contrast) | +0.092 | +0.086 | 76% |
| Volume ratio | −0.034 / −0.061 | −0.097 / −0.110 | 10–14% |

Among triggered candidates only, the pool auto-trade buys from:

| | 10 sessions (first / last) | 20 sessions (first / last) |
| --- | ---: | ---: |
| `rankScore` IC | +0.029 / −0.039 | +0.042 / −0.035 |
| NCS IC | +0.064 / +0.016 | +0.134 / +0.066 |

Mean 20-session return (first scan of day):

| Group | n | Mean | Win rate |
| --- | ---: | ---: | ---: |
| All scanned | 21,360 | +0.92% | 55.1% |
| Passed technical filters | 3,916 | +1.30% | 57.8% |
| Passed and triggered | 387 | −2.41% | 44.2% |
| A-grade proxy (stock rules, grading-time scores) | 75 | +0.64% (last scan: −1.31%, n=55) | 50.7% |

With nothing excluded (first scan, 20 sessions): passed technical filters
+1.01% (n=3,954), passed and triggered −2.93% (n=397), A-grade proxy −1.61%
(n=80). The A-grade sign depends on the exclusion rule.

What holds in both variants:
* `rankScore` has no positive association.
* FWS and NCS have a small positive association.
* A high volume ratio goes with worse 20-session returns.
* Triggered breakouts trailed the pool of passers.

The A-grade subset is too small and unstable to judge: its sign flips between
first and last scan and with the exclusion rule.

## Why `rankScore` may lack predictive value

`rankCandidate` in `src/lib/scan-engine.ts` is a hand-weighted sum:
* sleeve: CORE +40, ETF +20, HIGH_RISK +10;
* status: READY +30, WATCH +10;
* ADX × 0.3;
* volume ratio × 5 (up to +15);
* efficiency × 0.2 (up to +20);
* relative strength × 0.1.

It does not use NCS, FWS or BQS. Volume ratio (up to +15) was the most negative
predictor here; efficiency (up to +20) is the largest variable term. Sleeve gives
CORE a 30-point head start over HIGH_RISK, but the variable terms can overturn
it (e.g. a HIGH_RISK stock at 100 outranks a CORE stock at 86).

## Jev

* **Live record:** 8 reviewed buys, 8 allowed, 0 vetoes.
* **Pick follows the claim:** its TAKE/PASS pick follows the scanner's own claim
  text (A-grade claims get TAKE).
* **Evidence answers:** across the 7-day ledger there are 17 SUPPORTED, 2 MIXED
  (one synthetic test, one real B-grade claim) and 3 INSUFFICIENT_EVIDENCE.
* **Inputs:** Jev sees only the numbers the scanner computed, plus the scanner's
  verdict.
* **Conclusion:** it has no demonstrated incremental value. It is not proven
  useless either, since the same inputs could in principle support a better
  non-linear rule. Its 20-day price calls cannot be scored until outcomes
  mature (unblocked by F1).

## Fixed in this assessment

| ID | Fix | Verification |
| --- | --- | --- |
| F1 | **Outcome enrichment was dead.** The cohort since 11 Sep had 0 of 28,952 rows enriched: a 22:00 UTC guard rejected every scan, and all scheduled scans run before then. Scans before 22:00 UTC are now accepted only when the price is explained exactly: (a) it equals the final close; (b) it falls inside the finalised scan day's raw range with no price adjustment (intraday; checked first); or (c) it equals the previous close, lies outside the scan day's range, and the scan clock was before the listing's regular open (09:30 New York or 08:00 London, local time; pre-open, so the window starts at the previous close). A previous-close match without that clock proof is rejected as `PRE_OPEN_UNPROVEN` (it could be a stale quote seen mid-session); anything else as `SCAN_PRICE_UNEXPLAINED`. All other guards are unchanged. | New enrichment and clock tests (incl. daylight-saving); coverage and cursor tests pass. Rehearsal on a database copy with real prices (before the reviewer's pre-open tightening): 342 of 391 rows enriched, 49 rejected (cause not established); UK stocks 64/64 accepted. Live run: see below. |
| F2 | **Enrichment could never catch up.** It handled 200 rows/night against ~1,450 new rows/day. Each claimed page is now expanded to every eligible row of its tickers, so one price fetch serves all of a ticker's scans. 400 tickers/night. | Cursor tests passing; new single-fetch and same-ticker concurrency tests. |
| F3 | **Score backfill had look-ahead and starvation.** It used the latest score within ±2 days (future scores possible), and its fixed 500-row batch was blocked by unmatchable rows: 0 of 28,952 cohort rows were scored. It now uses the latest score at or before the scan (≤ 2 days old) and matches all unscored rows in memory. | New tests. Rehearsal: 47,291 rows scored in 34s; cohort 28,829/28,952 scored. |
| F4 | **Seven stocks were mapped to the wrong broker listing.** ASML, NVO, RIO, FCX, MP, REMX and PICK get prices from one listing (e.g. RIO.L, in pence) but would buy another (RIO_US_EQ, in USD). Sizing and the stop would be in the wrong units, so a sell-stop could land above the market and fire or be rejected. Auto-trade and the manual Execute route now refuse a buy when the price listing and broker listing are in different markets. None has been bought by auto-trade or the Execute route; ASML has two imported January trade-log records. | Unit tests; execute-route test (no order or stop placed); audit of the live universe: exactly these 7 of 1,004 mapped stocks blocked. |

Earlier rows in `CandidateOutcome` keep their look-ahead scores (rows scored
before 2026-10-01). Re-scoring them is a historical rewrite and is listed below
for decision.

### First live run (1 October, 23:00 UK)

The nightly research refresh ran from this code and finished in 334 seconds
(limit 20 minutes), with all 5 steps OK:
* **Score backfill:** 47,291 rows scored point-in-time, 167 without a matching
  score, 0 errors. Cohort: 28,829 of 28,952 rows now scored.
* **Forward enrichment:** 5,664 rows enriched (381 tickers, including 362 London
  rows), 698 skipped, 0 errors, 0 failed price fetches. Rejections: 653
  `SCAN_PRICE_UNEXPLAINED`, 23 `PRE_OPEN_UNPROVEN`, 18 `INVALID_PRICE_BAR`, 5
  `INVALID_ANCHOR_BAR`. The cause of the unexplained rejections (about 10%) is
  not established.
* **Boundaries held:** no row before the 11 September cohort was touched, and no
  20-session return was written early (the first ones mature around 21 October).
* **Label quality:** NCPL shows 5-session returns of +122% to +166%, which look
  like another unadjusted corporate action. It is added to D8; research labels
  should keep using an exclusion ledger.

At about 5,700 rows a night against about 1,450 new rows a day, the backlog
should clear in roughly a week (estimate, not yet observed).

## Needs a decision

Each of these changes which stocks are bought, or rewrites history, so none
was done unasked.

| ID | Issue | Evidence | Options |
| --- | --- | --- | --- |
| D1 | Buy order ignores the scores with a positive association | Tables above | Run the protocol's frozen comparison (rankScore vs NCS/FWS ordering) prospectively now that outcomes flow, or open the holdout once |
| D2 | Relative-strength gate always passes | RS is a 0–100 score (50 = level with SPY, also the default on missing data); the A-grade threshold is 0 | Define the intended rule (e.g. RS ≥ 50, or excess return ≥ 0) and how missing benchmark data is treated |
| D3 | Scores of any age are used for live grading | `getLatestScoresByTicker` has no age limit; `isScoreStale` (36h) exists but is unused; ages up to 527h seen | Enforce a score-age limit (would block buys after a missed nightly) |
| D4 | Demotions bypassed | READY→WATCH for low efficiency or earnings in 3–5 days can still grade A (the A rule checks trigger met, not READY); 5 of 48 dev A-grades were such WATCH rows | Require "not demoted" for A, or approve demotions as advisory |
| D5 | Indicator price basis mixed | Close is dividend-adjusted, open/high/low raw (`market-data.ts` daily bars); ATR/ADX and triggers combine them | Adopt one coherent basis; touches stops and risk |
| D6 | Correct the 7 mismatched mappings | See F4; MT (MT.AS prices, `MTL_EQ`) is also suspicious but undetectable by the US/non-US rule | Choose the intended listing per stock and update `t212Ticker`/ticker map/currency |
| D7 | Jev's role | No incremental value shown; costs up to 5 requests and ~60s per session | Keep as an unvalidated sanity check; switch the veto off; or fund a separate claim-free shadow request (~6+ paid calls) |
| D8 | Historical labels and scores | Look-ahead scores on rows scored before 2026-10-01; corrupt labels (WLFC unadjusted 3:1 split; PSIG unresolved; NCPL +122–166% in 5 sessions in the live cohort) | Re-score and quarantine historical rows, with a backup and an exclusion ledger |
| D9 | EU/Australian listings routed to US sessions | 16 stocks; dormant (no T212 mapping) | Route by exchange, or remove them from auto-trade |

Volume ratio's negative association and the triggered-breakout lag are
hypotheses for D1-style testing, not grounds for tuning thresholds on
development data.

## Update 2026-10-05: decisions taken

The owner approved the recommended course for D1–D9; details and evidence are in
the [decision-quality review](jev-and-decision-review-2026-10-05.md#decisions-approved-by-the-owner-on-5-october).
In short: D2 relative strength must be at least level with SPY; D3 stale scores
and D4 earnings soon (confirmed in 3–5 days, or unconfirmed within 2) block A-grade (the low-efficiency demotion stays
advisory and is measured prospectively); D9 US sessions take US listings only;
D8 historical outcome scores were re-scored point-in-time after a backup, so the
"NCS, look-ahead backfill" contrast row above can no longer be reproduced from
the live database (use the backup); D1 and D7 are being tested prospectively; D5
and D6 are unchanged after measurement.
## Reproduce

```powershell
python scripts/research/selection_diagnostic.py prisma/dev.db first
python scripts/research/selection_diagnostic.py prisma/dev.db last
```

The script opens the database read-only. It needs pandas, numpy and scipy.
