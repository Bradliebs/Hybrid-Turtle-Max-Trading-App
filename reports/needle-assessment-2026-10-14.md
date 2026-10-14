# Could Needle help auto-trading? (2026-10-14)

Question: could [cactus-compute/needle](https://github.com/cactus-compute/needle)
help HybridTurtle auto-trade better?

## Answer

**No, not for buy or sell decisions.** Needle is a well-made tool, but it
solves a problem this system doesn't have.

| Needle does | HybridTurtle needs |
| --- | --- |
| Pick an app function and fill its arguments from what a user says (tool calling) | Decide which breakouts to buy, then size, stop and exit them, from prices |
| Pull typed fields out of messy text (invoices, bookings, forms) | Its inputs are already numbers: prices, ATR, ADX and scores from Yahoo and Trading 212 |
| Sentence embeddings for search and routing | No text search on the trading path |
| Speech-to-text on phones, cars and microcontrollers | A Windows PC with plenty of compute |

Needle is a small language model (29–121M parameters at 2-bit; the shipped `needle3.cact` is 35 MB). It is tuned for following
commands, not for forecasting markets. Neither its README nor its `llms.txt`
reference mentions numeric, time-series or financial prediction, and it
trades away general reasoning to stay small.

## Where it could plug in, and why each is not worth it

1. **A local Jev.** Jev (Typesafe) checks whether a candidate's numbers back
   its grade. A fine-tuned Needle could give the same four labels locally,
   with no fee and no daily request limit. But:
   - **Jev hasn't changed a single trade.** ExecutionLog shows 20 live
     checks on 18 tickers (23 Sep – 13 Oct): 20 `JEV_ALLOW`, 0 `JEV_VETO`.
     The gate *can* fire (it vetoes on CONTRADICTED, MIXED or a PASS pick
     ≥ 60%); it just hasn't on a buy.
   - **Most reviews never reached the model.** The review ledger (since
     7 Oct) holds 70 reviews, but only 32 got a model answer: 29 SUPPORTED,
     2 INSUFFICIENT_EVIDENCE and 1 MIXED. The other 37 were stopped for
     missing inputs, and 1 failed (unavailable).
   - **The one MIXED was inconsistent.** It was ACVA on the 7 Oct 19:13
     evening scan, which isn't a buy session. On the next scan, 30 minutes
     later, Jev rated ACVA SUPPORTED.
   - **The check is close to circular.** The claim is a sentence the app
     writes from its own scan data (e.g. "READY — within 2% of trigger"),
     checked against that same data. The scanner already computed those
     comparisons exactly. A language model can only add mistakes, whether
     it is Jev or Needle.
   - So a copy of Jev would copy a gate that has had no effect. The Jev
     keep-or-remove decision (late October) is the right lever, not a
     replacement.
2. **A trade-picking classifier.** Needle's extraction can classify (for
   example BUY or PASS) after fine-tuning. But:
   - It has no mechanism for learning from numeric or time-series data.
   - With 37 closed trades (Position table), nothing can be fitted
     meaningfully.
   - The out-of-sample holdout failed to show that the scores order results
     (NCS "not proven"; FWS reversed) ([holdout test](holdout-test-2026-10-08.md)).
   - Platform fine-tuning is also a paid service.
3. **Reading news or earnings.** The earnings gate already reads the
   structured `calendarEvents` date from Yahoo. Nothing on the trading path
   parses free text.
4. **Telegram in plain English** (e.g. "how's PLTR doing?" instead of
   `/status`). This is the one thing Needle is genuinely built for. But:
   - It makes no trade better.
   - **Needle's own docs say the base model can invent values.** It "does
     not pass all six suites on engine 2.0.4 at the default gate: five fall
     short, missing calls the query did state and inventing values it did
     not" (`llms.txt`).
   - On a live account, an invented ticker, quantity or stop in a command is
     a real-money risk.
   - It would also add a Python runtime and a model to a system that was
     just simplified.

## Costs if it were adopted anyway

- **Runtime:** a Python package (`cactus-needle`) or a prebuilt binary next to
  the Node app.
- **Telemetry:** on by default, but limited to anonymous usage counts
  (function name, version, OS and a random install id, per `llms.txt`). The
  README says to set both `NEEDLE_TELEMETRY=0` and `DO_NOT_TRACK=1` to turn
  it off.
- **Fine-tuning:** the confidence score is only calibrated with the paid
  platform. Local LoRA fine-tuning returns `confidence = None`.
- **Maturity:** the repository was created on 2026-02-24 and is on its third
  model generation. Apache-2.0 licence.

## What would actually improve auto-trading

These are the open items, unchanged by this review:

- the forward tests (restart check, S4 simple rule) completing on new data;
- the Jev keep-or-remove decision in late October;
- the pause-new-buys recommendation.

The evidence so far says the weak point is the buy signal itself
([holdout test](holdout-test-2026-10-08.md),
[ETF assessment](etf-only-assessment-2026-10-09.md)), not anything Needle
addresses.

## Sources

- **Needle:** README, `llms.txt` and repository metadata (`gh repo view`,
  `gh api repos/cactus-compute/needle/...`) on 2026-10-14.
- **Jev:**
  - `data/typesafe-review/ledger.json` (70 reviews, 32 with a model answer,
    since 2026-10-07);
  - `ExecutionLog` phases `JEV_*` (20 `JEV_ALLOW`, 0 `JEV_VETO`);
  - `src/lib/jev-entry-gate.ts` (a veto needs CONTRADICTED, MIXED, or a
    PASS pick of at least 60%);
  - `.env` (gate on, `JEV_VETO_PASS_PROBABILITY=0.6`).
