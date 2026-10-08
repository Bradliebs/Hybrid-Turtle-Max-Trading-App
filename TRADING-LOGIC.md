# Hybrid-Turtle — Complete Trading Logic Reference

> Auto-generated reference of all trading rules, thresholds, and decision logic.
> Last verified against source code: **7 March 2026**

---

## Table of Contents

1. [Overall Trade Workflow](#1-overall-trade-workflow)
2. [Scan Engine — 7-Stage Pipeline](#2-scan-engine--7-stage-pipeline)
3. [Anti-Chase Guard](#3-anti-chase-guard)
4. [Risk Gates — 6 Gates](#4-risk-gates--6-gates)
5. [Position Sizing](#5-position-sizing)
6. [Stop Manager](#6-stop-manager)
7. [Dual Score Engine (BQS / FWS / NCS)](#7-dual-score-engine-bqs--fws--ncs)
8. [Regime Detector](#8-regime-detector)
9. [Exit Signals](#9-exit-signals)
10. [Modules](#10-modules)
11. [Weekly Phase Schedule](#11-weekly-phase-schedule)
12. [Pre-Trade Checklist](#12-pre-trade-checklist)
13. [Nightly Process](#13-nightly-process)
14. [Cross-Reference System](#14-cross-reference-system)
15. [Snapshot Sync](#15-snapshot-sync)
16. [Equity Snapshot](#16-equity-snapshot)
17. [Risk Profile Constants](#17-risk-profile-constants)
18. [API Routes — Quick Reference](#18-api-routes--quick-reference)
19. [Breakout Integrity Score (BIS)](#19-breakout-integrity-score-bis)
20. [EV Tracker](#20-ev-tracker)
21. [Correlation Matrix](#21-correlation-matrix)

---

## 1. Overall Trade Workflow

```
Universe (DB)
  → Technical Filters (MA200, ADX, DI, ATR%, data quality, efficiency)
  → Status Classification (READY / WATCH / FAR)
  → Ranking (sleeve priority + status bonus + ADX + volume + efficiency + RS)
  → Adaptive ATR Buffer (entry trigger calculation)
  → Position Sizing (equity × risk% / R-per-share)
  → Risk Gates (6 gates: open risk, max positions, sleeve, cluster, sector, position cap)
  → Anti-Chase Guard (Monday only)
  → Cross-Reference with Dual Scores (BQS/FWS/NCS)
  → Pre-Trade Checklist (14 checks)
  → Execute on Tuesday (EXECUTION phase)
```

**Nightly loop:**
```
Pre-Cache → Health Check → Live Prices + Freshness Check → Stop Management (R-based + trailing ATR + gap risk + stop-hit detection)
  → Laggard/Dead Money Detection → Risk Modules (climax, swap, whipsaw, breadth, correlation)
  → Equity Snapshot + Pyramid Check + Equity Milestone Advisory → Snapshot Sync + Trigger Alerts → Telegram Alert → Heartbeat (SUCCESS/PARTIAL/FAILED)
```

### End-to-End Decision Tree (Current Code)

```text
INPUTS:
  userId, riskProfile, equity, universe stock metadata, live price/technicals

SCAN PATH:
  1) Stage 1 Universe
    - Load active stocks from DB

  2) Stage 2 Technical Filters
    - Hard filters: price>MA200, ADX>=20, +DI>-DI, ATR% cap, data quality
    - Soft rule: efficiency<30 demotes READY->WATCH
    - ATR spike:
      bullish DI -> SOFT_CAP (READY->WATCH)
      bearish DI -> HARD_BLOCK (candidate FAR + fails filters)

  3) Entry Trigger / Stop Seed
    - entryTrigger = adaptive ATR buffer output
    - stop = entryTrigger - ATR * stopMultiplier

  4) Stage 3 Classify
    - distance<=2% READY; <=3% WATCH; else FAR

  5) Stage 4 Rank
    - sleeve priority + status bonus + ADX + volume + efficiency + RS

  6) Stage 7 Sizing (first pass)
    - riskCashRaw = equity * riskPerTrade
    - apply risk_cash_cap / risk_cash_floor
    - shares = floor(riskCash / riskPerShare)
    - enforce sleeve position-size cap
    - enforce per-position max-loss guard

  7) Stage 5 Risk Gates
    - open risk, max positions, sleeve cap, cluster cap, sector cap, position-size cap
    - profile-aware caps via getProfileCaps()

  8) Stage 6 Anti-Chase (3 sub-checks in order)
    a) Failed breakout cooldown:
       - if failedBreakoutAt exists and < 5 days ago:
         status = COOLDOWN, skip remaining anti-chase checks
    b) ext_atr guard (DAILY, not Monday-only):
       - ext_atr = (close - entryTrigger) / ATR
       - if ext_atr > 0.8:
         status = WAIT_PULLBACK (candidate kept, breakout blocked)
    c) Monday-only gap anti-chase:
       - run checkAntiChasingGuard() (gap checks)

  9) Mode B Pullback Continuation (only WAIT_PULLBACK)
    - anchor = max(HH20, EMA20)
    - zone = anchor ± 0.25*ATR
    - trigger if low entered zone AND close > zoneHigh
    - stop = pullbackLow - 0.5*ATR
    - if triggered:
      set mode = PULLBACK_CONTINUATION
      promote status to READY
      replace entry/stop with pullback values
      re-run sizing + risk gates with same caps

 10) Output + Sorting
    - Trigger-met first, then READY, WATCH/WAIT_PULLBACK, FAR
    - Persist scan rows with entryMode + stage6Reason

ENTRY EXECUTION PATH (POST /api/positions):
  A) Hard server-side pre-trade gates
    - block on weekend no-entry phases
    - block if regime != BULLISH
    - block if latest health check is RED
    - block if stop >= entry

  B) If allowed, create position
    - persist entry snapshot:
     entry_price, initial_stop, initial_R, atr_at_entry, profile_used, entry_type
```

---

## 2. Scan Engine — 7-Stage Pipeline

**Source:** `src/lib/scan-engine.ts`

### Stage 1: Universe

Queries all `active: true` stocks from the database, extracting `ticker`, `name`, `sleeve`, `sector`, `cluster`, `currency`.

### Stage 2: Technical Filters

ALL hard filters must pass for a candidate to proceed:

| Filter | Rule | Notes |
|--------|------|-------|
| Price above MA200 | `price > technicals.ma200` | Hard filter |
| ADX ≥ 20 | `technicals.adx >= 20` | Hard filter |
| +DI > −DI | `technicals.plusDI > technicals.minusDI` | Hard filter |
| ATR% below threshold | `technicals.atrPercent < threshold` | 7% for HIGH_RISK, 8% for all others |
| Data quality | `technicals.ma200 > 0 && technicals.adx > 0` | Hard filter |
| Efficiency ≥ 30 | `technicals.efficiency >= 30` | **Soft filter** — demotes READY → WATCH |

**Data Validation Gate (Module 18):**

Before technical filters, `validateTickerData()` is called. If data is invalid (stale, missing, anomalous), the ticker is **skipped entirely** (returns null, not included in results).

**ATR Spike Logic:**

Spike detection uses **median of last 14 ATR values** as baseline: `atr >= medianAtr14 × 1.3`. Falls back to `technicals.atrSpiking` flag if median is unavailable.

- `atrSpiking && bullishDI` → **SOFT_CAP**: demote READY → WATCH
- `atrSpiking && !bullishDI` → **HARD_BLOCK**: force status to FAR, fail filters

**Hurst Exponent (soft flag):**

Calculated via `calcHurst(closePrices)`. Sets `hurstWarn = true` when H < 0.5 (mean-reverting). Flag only — does not block or downgrade status. Also feeds into BQS as a 0–8 point bonus (see [§7](#7-dual-score-engine-bqs--fws--ncs)).

### Stage 3: Status Classification

Based on distance from current price to entry trigger:

```
distance = ((entryTrigger - price) / price) × 100

distance ≤ 2%  → READY
distance ≤ 3%  → WATCH
distance > 3%  → FAR
```

**Post-classification overrides** (applied after initial status):

- ATR spike + bullish DI → READY demoted to `WATCH`
- ATR spike + bearish DI → forced to `FAR` + hard block
- Efficiency < 30 → READY demoted to `WATCH`
- ext_atr > 0.8 → overridden to `WAIT_PULLBACK` (see Stage 6)
- Failed breakout cooldown active → overridden to `COOLDOWN` (see Stage 6)

### Stage 4: Ranking

Composite score calculation:

| Component | Formula |
|-----------|---------|
| Sleeve priority | CORE=40, ETF=20, HIGH_RISK=10, HEDGE=5 |
| Status bonus | READY=+30, WATCH=+10, FAR=0 |
| ADX tiebreaker | `min(adx, 50) × 0.3` |
| Volume ratio | `min(volumeRatio, 3) × 5` |
| Efficiency | `min(efficiency, 100) × 0.2` |
| Relative strength | `min(relativeStrength, 100) × 0.1` |

Results sorted by rank score descending.

### Stage 5: Risk Gates

Delegates to `validateRiskGates()` — see [§4](#4-risk-gates--6-gates).

### Stage 6: Anti-Chase / Execution Guard

Three distinct sub-checks in order:

**6a. Failed Breakout Cooldown** (`FAILED_BREAKOUT_COOLDOWN_DAYS = 5`):
If `technicals.failedBreakoutAt` exists and < 5 days ago → status forced to `COOLDOWN`, anti-chase bypassed entirely.

**6b. ext_atr Volatility Expansion Guard** — **active every day** (not Monday-only):
`extATR = (price − entryTrigger) / ATR`. If `extATR > 0.8` → status forced to `WAIT_PULLBACK` (candidate kept, breakout blocked). Triggers Mode B pullback continuation check.

**6c. Monday-only Gap Anti-Chase** — delegates to `checkAntiChasingGuard()` — see [§3](#3-anti-chase-guard). Only runs if 6a and 6b did not already block.

### Stage 7: Position Sizing

Uses `calculatePositionSize()` — see [§5](#5-position-sizing).

- **Entry trigger:** `adaptiveBuffer.adjustedEntryTrigger` (from Module 11b)
- **Stop price:** `entryTrigger − ATR × 1.5`
- **Processing:** Batches of 10, 300ms pause between batches

---

## 3. Anti-Chase Guard

**Source:** `src/lib/scan-guards.ts`

**Active on all trading days** (configurable via `GapGuardConfig`). Monday uses weekend thresholds (3-day gap); Tue–Fri uses daily thresholds.

Only evaluates when `currentPrice >= entryTrigger`:

| Check | Rule | Monday Threshold | Tue–Fri Threshold |
|-------|------|-----------|----------|
| Gap ATR check | `(currentPrice - entryTrigger) / ATR` | > 0.75 → FAIL | > 1.0 → FAIL |
| Percent above check | `((currentPrice / entryTrigger) - 1) × 100` | > 3.0% → FAIL | > 4.0% → FAIL |

Both must pass to clear the guard.

**Slippage buffer:** When historical trade slippage averages > 0.15% (from `slippage-tracker.ts`), the ATR threshold is tightened by the slippage amount (floor: 0.5 ATR). This prevents repeatedly overshooting entry prices.

---

## 4. Risk Gates — 6 Gates

**Source:** `src/lib/risk-gates.ts`

All 6 gates must pass before a new position is allowed:

| # | Gate | Rule | Default Thresholds |
|---|------|------|--------------------|
| 1 | **Total Open Risk** | `(currentOpenRisk + newRiskDollars) / equity × 100 ≤ maxOpenRisk` | CON=7%, BAL=5.5%, SMALL=10%, AGG=12% |
| 2 | **Max Positions** | `openPositions < maxPositions` (ex-HEDGE) | CON=8, BAL=5, SMALL=4, AGG=3 |
| 3 | **Sleeve Limit** | `sleeveValue / totalPortfolioValue ≤ SLEEVE_CAPS[sleeve]` | CORE=80%, ETF=80%, HIGH_RISK=40%, HEDGE=100% |
| 4 | **Cluster Concentration** | `clusterValue / totalPortfolioValue ≤ clusterCap` | Default 20% — **SMALL_ACCOUNT: 25%** |
| 5 | **Sector Concentration** | `sectorValue / totalPortfolioValue ≤ sectorCap` | Default 25% — **SMALL_ACCOUNT: 30%** |
| 6 | **Position Size Cap** | `newValue / totalPortfolioValue ≤ cap` | See profile-aware table below |

> **Profile-Aware Overrides:** Gates 4–6 support per-profile cap overrides via `getProfileCaps(riskProfile)` in `src/types/index.ts`. Profiles without overrides use the default constants.

**CRITICAL:** HEDGE positions are **excluded** from open risk counting and max position counting.

### Pyramiding Rules

`canPyramid(currentPrice, entryPrice, initialRisk, atr, currentAdds)`:

| Parameter | Value |
|-----------|-------|
| Max adds | 2 |
| Add #1 trigger | `Entry + 0.5 × ATR` |
| Add #2 trigger | `Entry + 1.0 × ATR` |
| Add sizing | Same as original (full equity × risk_per_trade) |
| Fallback (no ATR) | R-multiple ≥ 1.0 required |

### Risk Budget

`getRiskBudget()` calculates used vs available:

- Used risk percent (sum of open position risk)
- Used positions vs max positions
- Sleeve utilization by sleeve type
- HEDGE excluded from open risk total

---

## 5. Position Sizing

**Source:** `src/lib/position-sizer.ts`

### Core Formula

```
Shares = floor( (Equity × Risk%) / ((Entry − Stop) × fxToGbp) × 100 ) / 100
```

Floors to 2 decimal places (0.01 shares) when `allowFractional: true` (Trading 212). Whole shares when `allowFractional: false` (default).

### Position Size Cap Enforcement

If `shares × entryPrice × fxToGbp > equity × positionSizeCap[sleeve]`, clamp shares down.

Position size caps are **profile-aware** — see [Concentration Caps](#concentration-caps) for per-profile values.

### Per-Position Max Loss Guard

After cap enforcement, a final guard checks:
```
perPositionMaxLossPct = profile.per_position_max_loss_pct ?? riskPercent
if (riskPerShare × shares) > equity × (perPositionMaxLossPct / 100)
  → clamp shares down to max allowed loss
```
Currently no profiles set `per_position_max_loss_pct`, so this defaults to `riskPercent` (no-op unless custom risk is used).

### Risk Cash Cap / Floor

Before share calculation, risk cash is bounded:
- `riskCash = min(riskCashRaw, profile.risk_cash_cap)` if cap defined
- `riskCash = max(riskCash, profile.risk_cash_floor)` if floor defined

Currently no profiles set these — they are for future use.

### Risk Per Trade by Profile

| Profile | Risk Per Trade |
|---------|---------------|
| CONSERVATIVE | 0.75% |
| BALANCED | 0.95% |
| SMALL_ACCOUNT | 2.00% |
| AGGRESSIVE | 3.00% |

### Helper Functions

| Function | Formula |
|----------|---------|
| `calculateEntryTrigger(twentyDayHigh, atr)` | `twentyDayHigh + 0.1 × ATR` (legacy — now replaced by adaptive buffer) |
| `calculateRMultiple(currentPrice, entryPrice, initialRisk)` | `(currentPrice − entryPrice) / initialRisk` |
| `calculateGainPercent(currentPrice, entryPrice)` | `((currentPrice − entryPrice) / entryPrice) × 100` |
| `calculateGainDollars(currentPrice, entryPrice, shares)` | `(currentPrice − entryPrice) × shares` |

---

## 6. Stop Manager

**Source:** `src/lib/stop-manager.ts`

### Critical Safety Rule

**Stops NEVER go down.** Monotonic enforcement — any attempt to lower a stop is rejected.

### R-Based Protection Levels

| Level | R-Multiple Threshold | Stop Formula |
|-------|----------------------|--------------|
| `INITIAL` | < 1.5R | `Entry − InitialRisk` |
| `BREAKEVEN` | ≥ 1.5R | `Entry` (break even) |
| `LOCK_08R` | ≥ 2.5R | `Entry + 0.5 × InitialRisk` |
| `LOCK_1R_TRAIL` | ≥ 3.0R | `max(Entry + 1.0 × InitialRisk, Close − 1.5 × ATR)` |

### Stop Recommendation Logic

`calculateStopRecommendation`:

1. Calculate R-multiple from current price
2. Determine recommended protection level
3. Only upgrade levels (never downgrade)
4. Calculate new stop for that level
5. **Monotonic check:** if `newStop ≤ currentStop` → return null (no action)

### Trailing ATR Stop

`calculateTrailingATRStop(ticker, entryPrice, entryDate, currentStop, atrMultiplier=ATR_TRAILING_MULTIPLIER)` (1.5, from `src/types/index.ts`):

- Walks forward through price history from the entry date, so it trails from day
  one, whatever the open profit
- At each bar: `candidateStop = highestClose − 1.5 × ATR(14)`
- With the default 1.5 × ATR initial stop, the first close above entry lifts the
  stop above the initial stop
- Stop only ratchets UP (monotonic)
- Returns recommendation only if `trailingStop > currentStop`

The multiple was 2.0 until commit `4280812` (26 April 2026) introduced
`ATR_TRAILING_MULTIPLIER = 1.5`; every live trade since May has used 1.5.

### Batch Operations

- `generateTrailingStopRecommendations(userId)` — generates recommendations for all open positions
- `updateStopLoss(positionId, newStop, reason)` — writes to DB with stop history, enforces monotonic rule

---

## 7. Dual Score Engine (BQS / FWS / NCS)

**Source:** `src/lib/dual-score.ts`

Three scores: **BQS** (Breakout Quality Score — good), **FWS** (Fatal Weakness Score — bad), **NCS** (Net Composite Score — final verdict).

### BQS Components (0–100, clamped)

Theoretical range is −15 to 148 before `clamp(0, 100)` is applied.

| Component | Weight | Formula |
|-----------|--------|--------|
| Trend Strength | 0–25 | `25 × clamp((ADX − 15) / 20)` |
| Direction Dominance | 0–10 | `10 × clamp((+DI − −DI) / 25)` |
| Volatility Health | 0–15 | ATR% < 1% → scale up; 1–4% → 15 (full); 4–6% → scale down; > 6% → 0 |
| Proximity | 0–15 | `15 × clamp(1 − dist20dHigh / 3.0)` |
| **Dual Regime Score (DRS)** | **−10 to +20** | Replaced old Market Tailwind — see table below |
| RS Score | 0–15 | `15 × clamp((rsPct + 5) / 20)` |
| Volume Bonus | 0–5 | If volRatio > 1.2: `5 × clamp((volRatio − 1.2) / 0.6)` |
| **Weekly ADX Bonus** | **−5 to +10** | Weekly ADX ≥ 30 → +10; ≥ 25 → +5; < 20 → −5; no data → 0 |
| **Breakout Integrity (BIS)** | **0–15** | See [§19](#19-breakout-integrity-score-bis) |
| **Hurst Bonus** | **0 to +8** | H ≥ 0.7 → +8; H ≥ 0.6 → +5; H ≥ 0.5 → +2; H < 0.5 or no data → 0 |

#### Dual Regime Score (DRS) — `calcDualRegimeScore()`

Replaces the old `marketTailwind()`. Consolidates directional regime, volatility regime, and dual-benchmark alignment into one component. Stored in `bqs_tailwind` for backward compatibility.

| Condition | Score |
|-----------|-------|
| BEARISH | −10 |
| SIDEWAYS / NEUTRAL | 0 |
| BULLISH + HIGH_VOL | +10 |
| BULLISH + not dual-aligned | +10 |
| BULLISH + dual-aligned + NORMAL_VOL | +15 |
| BULLISH + dual-aligned + LOW_VOL | +20 |

### FWS Components (0–100 total, higher = worse)

| Component | Weight | Formula |
|-----------|--------|---------|
| Volume Risk | 0–30 | `30 × clamp(1 − (volRatio − 0.6) / 0.6)` |
| Extension Risk | 0–25 | Both chasing flags = 25; either = 15; none = 0 |
| Marginal Trend Risk | 0–10 | ADX < 20 → 10; 20–25 → 7; 25–30 → 3; > 30 → 0 |
| Vol Shock Risk | 0–20 | `atr_spiking` → 20; `atr_collapsing` → 10; else 0 |
| Regime Instability | 0–10 | Not stable → 10; stable → 0 |

### Penalties (applied to NCS)

| Penalty | Formula |
|---------|---------|
| **Earnings** | ≤ 1 day → −20; ≤ 3 days → −15; ≤ 5 days → −10; flag set → −12 |
| **Cluster** | At 80–100% of cap: linear 0–20; above cap: 20 + 30×(overshoot) |
| **Super Cluster** | At 80–100% of cap: linear 0–25; above cap: 25 + 40×(overshoot) |

### NCS (Net Composite Score)

```
BaseNCS      = clamp(BQS − 0.8 × FWS + 10)
totalPenalty = EarningsPenalty + ClusterPenalty + SuperClusterPenalty
cappedPenalty = min(totalPenalty, 40)   ← total penalty capped at 40 to prevent excessive stacking
NCS          = clamp(BaseNCS − cappedPenalty)
```

### Action Classification

| Condition | Action |
|-----------|--------|
| `FWS > 65` | **Auto-No** (fragile) |
| `NCS ≥ 70 && FWS ≤ 30` | **Auto-Yes** |
| Otherwise | **Conditional** — needs confirmation (e.g., volume ≥ 1.0 on breakout day) |

---

## 8. Regime Detector

**Source:** `src/lib/regime-detector.ts`

### Primary Regime Detection

Point-based system (5 signals, max 8 points each side):

| # | Signal | Bullish Condition | Bull Pts | Bearish Condition | Bear Pts |
|---|--------|-------------------|----------|-------------------|----------|
| 1 | **Price vs MA200** | SPY > 200MA | +3 | SPY ≤ 200MA | +3 |
| 2 | **ADX Trend Strength** | ADX ≥ 25 AND +DI > −DI | +1 | ADX ≥ 25 AND −DI ≥ +DI | +1 |
| 3 | **DI Direction** | +DI > −DI | +2 | −DI ≥ +DI | +2 |
| 4 | **VIX Fear Level** | VIX < 20 | +1 | VIX ≥ 30 | +1 |
| 5 | **A/D Ratio** | A/D ratio > 1.2 | +1 | A/D ratio < 0.8 | +1 |

> Signal #2 only awards points when `spyAdx >= 25`. VIX 20–29 and A/D 0.8–1.2 are neutral zones (0 points).

### ±2% CHOP Band (Module 10)

```
upperBand = spy200MA × 1.02
lowerBand = spy200MA × 0.98

If SPY price inside band → forced SIDEWAYS (confidence 0.5)
```

### Without CHOP Band

| Total Points | Regime |
|-------------|--------|
| Bullish ≥ 5 | BULLISH |
| Bearish ≥ 5 | BEARISH |
| Otherwise | SIDEWAYS |

### Regime Stability (Module 9)

`checkRegimeStability(currentRegime, regimeHistory)`:

- Requires **3 consecutive days** of same regime before confirming
- If unstable → display as "CHOP" / SIDEWAYS

### Dual Benchmark (Module 19)

`detectDualRegime(spyPrice, spyMa200, vwrlPrice, vwrlMa200)`:

- Both SPY and VWRL use ±2% CHOP band detection
- **Combined rules:**
  - Both BULLISH → BULLISH
  - Either BEARISH → BEARISH
  - Otherwise → SIDEWAYS

### Volatility Regime

`detectVolRegime(spyAtrPercent)` — classifies SPY's 14-day ATR% into a volatility regime, separate from directional regime.

| SPY ATR% | Volatility Regime |
|----------|------------------|
| < 1.0% | `LOW_VOL` |
| 1.0% – 2.0% | `NORMAL_VOL` |
| > 2.0% | `HIGH_VOL` |

Fed into `calcDualRegimeScore()` (§7) as the `vol_regime` field, affecting BQS scoring.

### Buy Permission

`canBuy(regime)` → returns `true` **only** for BULLISH regime.

---

## 9. Exit Signals

### Failed-Breakout Exit (automatic)

**Source:** `src/lib/breakout-failure-detector.ts` (nightly flag) and
`src/lib/failed-breakout-exit.ts` (sell at the next session, called from
`src/cron/auto-trade.ts`).

* **Flag (nightly, after the close):** `daysHeld ≤ 5`, close below the entry
  trigger and `rMultiple < 0.5`.
* **Sell:** at the first auto-trade session in that position's market (UK
  sessions for `.L`, US sessions for US listings), for auto-trade positions only.
  * The session must be inside regular hours (US 09:35–15:55 New York, UK
    08:05–16:25 London).
  * The flag must have been recorded after the market's close, within the last
    4 days.
  * It sells the position's own shares, then confirms the broker holding fell.
    If it didn't, the order is cancelled and the stop restored. Any other shares
    keep a stop.
  * A ticker held by two open positions is skipped.
* **Runs in every operating mode,** including CAPITAL_PRESERVATION, but not
  when the kill switch blocks automated submissions. Turn it off with
  `FAILED_BREAKOUT_AUTO_EXIT=off`.
* **Evidence:** +0.13R per breakout trade on untouched August–September 2026
  data (`reports/holdout-test-2026-10-08.md`).

### Laggard Detector

**Source:** `src/lib/laggard-detector.ts`

#### TRIM_LAGGARD Flag (all must be true)

1. `daysHeld ≥ 10`
2. `currentPrice < entryPrice` (underwater)
3. `lossPct ≥ 2%`
4. `currentPrice > currentStop` (not already at stop)
5. Not a HEDGE position

#### DEAD_MONEY Flag (all must be true)

1. `daysHeld ≥ 30`
2. `rMultiple < 0.5`
3. `rMultiple > −1.0` (not in freefall)
4. Not a HEDGE position

#### Dead Money Recovery Suppression

Before flagging DEAD_MONEY, checks for trend recovery. If recovering, the flag is suppressed.

**All 3 indicator inputs required** (gracefully skipped if any are missing):
- `ma20` — 20-day moving average
- `adxToday` — current ADX
- `adxYesterday` — previous day ADX

**Exemption conditions (both must be true):**
1. `currentPrice > ma20` — price above 20-day MA
2. `adxToday > adxYesterday` — ADX rising (strengthening trend)

If recovering → `DEAD_MONEY` flag suppressed. If indicator fields missing → exemption skipped (flag applies normally).

These are **suggestions only** — not auto-sell.

### Climax Detector (Module 5 + 14)

**Source:** `src/lib/modules/climax-detector.ts`

**Blow-off top detection** — both conditions must be true:

- Price **≥ 18%** above MA20
- Volume **≥ 3×** average 20-day volume (prior 20 bars, excluding today)

**Action:** TRIM (50%) or TIGHTEN stop (configurable).

### Laggard Purge (Module 3)

**Source:** `src/lib/modules/laggard-purge.ts`

Flags positions held > 10 days that are underwater > 2%. HEDGE exempt. Sorted worst-first.

---

## 10. Modules

### Module 2: Early Bird Entry

**Source:** `src/lib/modules/early-bird.ts`

Aggressive entry before ADX confirms. **All 3 criteria must be met:**

1. Price in top 10% of 55-day range (`rangePctile ≥ 90`)
2. Volume > 1.5× 20-day average
3. Regime is BULLISH

### Module 7: Heatmap Swap

**Source:** `src/lib/modules/heatmap-swap.ts`

Suggests swaps when cluster is ≥ 80% of cap:

- **Weak position:** `rMultiple < 0.5` AND underwater (negative R)
- **Strong candidate:** `rankScore ≥ 50` and status READY
- Only suggests when there's a meaningful upgrade

### Module 8: Heat Check

**Source:** `src/lib/modules/heat-check.ts`

If **3+** positions in same cluster, the 4th candidate must have momentum **20% better** than the cluster average R-multiple. Prevents over-concentration in mediocre names.

### Module 9: Fast-Follower Re-Entry

**Source:** `src/lib/modules/fast-follower.ts`

For STOP_HIT exits within last **10 days**. Re-entry allowed if:

1. Price reclaimed 20-day high
2. Volume > 2× average

### Module 10: Breadth Safety Valve

**Source:** `src/lib/modules/breadth-safety.ts`

- `calculateBreadth(tickers)` — % of universe above 50DMA
- **Threshold:** < 40% → restricted
- **Action:** Max positions reduced to **4** (from profile max)

### Module 11: Whipsaw Kill Switch

**Source:** `src/lib/modules/whipsaw-guard.ts`

Blocks re-entry on tickers stopped out **2 times within 30 days**. Penalty period: **60 days**.

### Module 11b: Adaptive ATR Buffer

**Source:** `src/lib/modules/adaptive-atr-buffer.ts`

Scales entry buffer inversely with ATR%:

| ATR% | Buffer (% of ATR) |
|------|-------------------|
| ≤ 2% | 20% |
| ≥ 6% | 5% |
| Between | Linear interpolation |

```
scaledBufferPercent = bufferPercent × volMultiplier
adjustedEntryTrigger = triggerBaseHigh + scaledBufferPercent × ATR
```

**Vol Regime Multiplier** (scales buffer by SPY volatility environment):

| Vol Regime | Multiplier |
|------------|------------|
| `LOW_VOL` | 0.8 (tighter buffer in calm markets) |
| `NORMAL_VOL` | 1.0 |
| `HIGH_VOL` | 1.3 (wider buffer in volatile markets) |

Feature flag for A/B comparison:

- unset/`true` (default) → `triggerBaseHigh = prior20DayHigh` (excludes most recent bar — correct Donchian breakout)
- `USE_PRIOR_20D_HIGH_FOR_TRIGGER=false` → `triggerBaseHigh = twentyDayHigh` (includes most recent bar — legacy; trigger is mathematically unreachable, ~0 buys)

### Module 12: Super-Cluster

**Source:** `src/lib/modules/super-cluster.ts`

Groups correlated clusters into super-clusters with a **50% aggregate cap** (`SUPER_CLUSTER_CAP = 0.50`).

- `MIN_POSITIONS_FOR_CAP = 2` — breach detection suppressed when total open positions < 2.

### Module 13: Momentum Expansion (**DISABLED**)

**Source:** `src/lib/modules/momentum-expansion.ts`

> **⚠️ Permanently disabled in nightly pipeline.** Import is commented out. Rationale: procyclical risk expansion adds risk near end of moves, not middle.

When SPY ADX > **25** (strong trend):

- Max open risk expanded by factor **1.214** (e.g., 7.0% → 8.5%)
- **MAX_EXPANDED_RISK = 12.0%** — absolute ceiling regardless of profile

### Module 15: Trade Logger

**Source:** `src/lib/modules/trade-logger.ts`

Logs BUY/SELL/TRIM with expected vs actual fill, slippage %. Provides execution quality audit trail.

### Module 16: Turnover Monitor

**Source:** `src/lib/modules/turnover-monitor.ts`

Tracks:

- Trades per 30 days
- Average holding period (days)
- Oldest position age
- Closed positions in last 30 days

### Module 17: Weekly Action Card

**Source:** `src/lib/modules/weekly-action-card.ts`

Auto-generated one-page battle plan combining: regime, breadth, ready candidates, trigger-met, stop updates, risk budget, laggards, climax, whipsaw, swaps, fast-followers, re-entry. Also renders to markdown.

### Module 18: Data Validator

**Source:** `src/lib/modules/data-validator.ts`

| Check | Threshold |
|-------|-----------|
| Data age | ≤ 5 business days |
| Daily price spike | ≤ 25% (anomaly detection) |
| Price validity | Non-zero, positive |
| Volume validity | Non-zero (halt check) |
| Stale data | No 3+ day identical close |

### Module 20: Re-Entry Logic

**Source:** `src/lib/modules/re-entry-logic.ts`

For profitable exits (> 0.5R, NOT stop-hit):

- **5-day cooldown** required
- Must reclaim 20-day high
- Only considers exits within last 30 days

---

## 11. Weekly Phase Schedule

| Day | Phase | Trading Allowed? | Actions |
|-----|-------|-----------------|---------|
| Sunday | PLANNING | No | Review health, run scans |
| Monday–Friday | EXECUTION | **Yes, gated** | Execute only when regime, health, risk, and anti-chase gates pass |
| Saturday | MAINTENANCE | No entries | Review positions and operations |

---

## 12. Pre-Trade Checklist

**Source:** `src/components/plan/PreTradeChecklist.tsx`

14 checks across 4 categories. Items marked **(CRITICAL)** are blocking.

### Market Conditions

1. Market regime is BULLISH **(CRITICAL)**
2. Fear & Greed not in Extreme Fear
3. S&P above 200-day MA

### System Health

4. Health check is GREEN **(CRITICAL)**
5. All 16 health items pass
6. Data is fresh (< 24h)

### Risk Gate

7. Total open risk < limit
8. Position count < max
9. Sleeve caps not breached

### Entry Rules (gated by hasReadyCandidates)

10. Candidate passed all 6 technical filters (100%) **(CRITICAL)**
11. Entry trigger uses 20-day high + ATR buffer
12. Stop-loss is pre-set before entry **(CRITICAL)**
13. Position size uses formula: `Shares = (Equity × Risk%) / (Entry − Stop)`
14. Shares rounded DOWN (never up)

---

## 13. Nightly Process — 10 Steps (+ Sub-steps)

**Source:** `src/cron/nightly.ts`

A `RUNNING` heartbeat is written before Step 0. If the pipeline exits with status still `RUNNING`, a safety-net `FAILED` heartbeat is forced in the `finally` block.

| Step | Action | Details |
|------|--------|---------|
| 0 | Pre-Cache | Cache Yahoo Finance historical data for all active tickers (batch). Runs first. |
| 1 | Health Check | Run 16-point health check |
| 2 | Live Prices | Fetch live prices for all open positions (batch via Yahoo) + normalise to GBP via FX + check data freshness |
| 3 | R-Based Stop Recs | Generate R-based stop recommendations + **auto-apply** via `updateStopLoss()` (monotonic violations caught silently) |
| 3b | Trailing ATR Stops | Generate trailing ATR recs via `generateTrailingStopRecommendations()` + **auto-apply** (1.5×ATR below highest close since entry) |
| 3c | Gap Risk Detection | HIGH_RISK positions only: flags if gap > 2×ATR%. **Advisory only** (no blocks) |
| 3d | Stop-Hit Detection | For each open position, checks `currentPrice ≤ currentStop`. Sends `STOP_HIT` alert for each hit |
| 4 | Laggard Detection | Detect TRIM_LAGGARD + DEAD_MONEY flags (with recovery exemption check) |
| 5 | Risk Modules | Run: Climax, Swap, Whipsaw, Breadth Safety (sampled 30 tickers), Correlation Matrix, Sector ETF Cache. **Module 13 (Momentum Expansion) permanently DISABLED** |
| 6 | Equity Snapshot | Record equity snapshot (min 6h between snapshots) + check pyramid add opportunities (Tuesday-only `PYRAMID_ADD` alerts) |
| 6b | Equity Milestone | Advisory check: if equity crosses £1K/£2K/£5K thresholds, sends Telegram + in-app notification (never auto-changes risk profile) |
| 7 | Snapshot Sync | Sync snapshot data from Yahoo (full universe) + query READY/trigger-met candidates (top 15) |
| 7c | Trade Trigger Alerts | **Tuesday only**: send `TRADE_TRIGGER` in-app alerts for trigger-met candidates (max 3) |
| 7d | Weekly Summary Alert | **Sunday only**: send `WEEKLY_SUMMARY` in-app alert with market mood + position summary (`skipTelegram: true`) |
| 8 | Telegram Alert | Send summary: alerts, positions, stop changes, candidates, module results |
| 9 | Heartbeat | Write heartbeat to DB (SUCCESS / PARTIAL / FAILED with step-level results) |

**Step-level tracking:** Each step is timed via `startStep()`/`finalizeSteps()`. Step results (name, status, duration, error) are stored in heartbeat details JSON.

**Heartbeat status is ternary:**
- **SUCCESS** — all steps completed without error
- **PARTIAL** — some steps failed but pipeline completed (amber on dashboard)
- **FAILED** — critical failure

**Error handling:** Each step is wrapped in its own `try/catch`. One step failing does **not** abort subsequent steps — `hadFailure` is set and execution continues. Telegram failure does not set `hadFailure` (optional infrastructure).

**Watchdog:** A separate `watchdog.ts` script (`watchdog-task.bat`) runs daily at 10:00 AM. If no nightly heartbeat exists within 26 hours, it sends a Telegram alert.

Runs via: `npx tsx src/cron/nightly.ts --run-now`

---

## 14. Cross-Reference System

**Source:** `src/app/api/scan/cross-ref/route.ts`

Merges 7-stage scan results with dual scores:

### Classification

| Condition | Match Type |
|-----------|-----------|
| Scan recommends AND Dual recommends | **BOTH_RECOMMEND** |
| Only scan recommends | SCAN_ONLY |
| Only dual recommends | DUAL_ONLY |
| Scan recommends AND Dual rejects | CONFLICT |
| Neither recommends | BOTH_REJECT |

Where:

- `scanRecommends` = passesAllFilters AND (READY or WATCH)
- `dualRecommends` = NCS ≥ 50 AND FWS ≤ 50

### Agreement Score

Weighted combination:

- 25% — scan recommend (boolean)
- 25% — dual recommend (boolean)
- 25% — NCS normalized (0–1)
- 25% — rank score normalized (0–1)

### Display Priority

Trigger-met first → BOTH_RECOMMEND → others, then by agreement score descending.

---

## 15. Snapshot Sync

**Source:** `src/lib/snapshot-sync.ts`

Replaces the Python `master_snapshot` pipeline.

### Processing Parameters

| Parameter | Value |
|-----------|-------|
| Batch size | 8 concurrent Yahoo requests |
| Batch delay | 400ms between batches |
| Minimum data | 55 bars required per ticker |
| ATR spike detection | Current ATR ≥ 1.3× ATR from 20 days ago |
| ATR collapse detection | Current ATR ≤ 0.5× ATR from 20 days ago |
| Chasing detection | 20d/55d high touched in last 5 bars (within 0.1%) |
| Liquidity check | 20-day avg dollar volume > $500,000 |
| Relative strength | 63-day (~3 month) return vs SPY return |
| Regime stability | `|SPY price − MA200| / MA200 > 2%` |

### Status Classification in Snapshot

Based on distance to **entry trigger** (adaptive buffer output, not raw 20d high):

| Condition | Status |
|-----------|--------|
| Not above MA200 or −DI dominant | IGNORE |
| Distance to entry trigger ≤ 2% | READY |
| Distance to entry trigger ≤ 3% | WATCH |
| Distance to entry trigger > 3% | FAR |
| Override: above MA200 + ADX ≥ 20 + bullish DI + dist to 20d high > 5% | TREND |

### Calculated Values

- **Entry trigger:** Adaptive ATR buffer output (see Module 11b) — `triggerBaseHigh + scaledBufferPercent × ATR`
- **Stop level:** `entryTrigger − ATR × 1.5`
- **Default cluster/super-cluster early-warning thresholds (display only, not gates):** max cluster = 35%, max super-cluster = 60%

---

## 16. Equity Snapshot

**Source:** `src/lib/equity-snapshot.ts`

| Function | Description |
|----------|-------------|
| `recordEquitySnapshot(userId, equity, openRiskPercent?)` | Writes to DB, rate-limited to **once per 6 hours** (360 minutes) |
| `getWeeklyEquityChangePercent(userId)` | Calculates weekly equity change % and max open risk used this week |

---

## 17. Risk Profile Constants

### Risk Per Trade & Limits

| Profile | Risk/Trade | Max Positions | Max Open Risk |
|---------|-----------|---------------|---------------|
| CONSERVATIVE | 0.75% | 8 | 7.0% |
| BALANCED | 0.95% | 5 | 5.5% |
| SMALL_ACCOUNT | 2.00% | 4 | 10.0% |
| AGGRESSIVE | 3.00% | 3 | 12.0% |

> **AGGRESSIVE profile also has `initial_stop_atr_mult = 2.0`** — wider initial stops (`entry − 2.0 × ATR` instead of default 1.5). No other profile overrides this.

### Sleeve Caps

| Sleeve | Allocation Cap | Position Size Cap (default) |
|--------|---------------|----------------------------|
| CORE | 80% | 16% (SMALL_ACCOUNT: 20%, BALANCED: 18%) |
| ETF | 80% | 16% |
| HIGH_RISK | 40% | 12% |
| HEDGE | 100% | 20% |

### Concentration Caps

Default values (used for CONSERVATIVE profile only — AGGRESSIVE and others have overrides):

| Cap | Default Value |
|-----|---------------|
| Cluster | 20% |
| Sector | 25% |
| Super-Cluster | 50% |
| ATR Volatility (all) | 8% |
| ATR Volatility (HIGH_RISK) | 7% |

#### Profile-Aware Overrides

Certain profiles receive looser caps via `getProfileCaps()`. Add new overrides in `PROFILE_CAP_OVERRIDES` in `src/types/index.ts`.

| Override | CONSERVATIVE | BALANCED | SMALL_ACCOUNT | AGGRESSIVE |
|----------|-------------|----------|---------------|------------|
| Cluster Cap | 20% (default) | 20% (default) | **25%** | **35%** |
| Sector Cap | 25% (default) | 25% (default) | **30%** | **45%** |
| Position Size Cap (CORE) | 16% (default) | **18%** | **20%** | **40%** |
| Position Size Cap (ETF) | 16% (default) | 16% (default) | 16% (default) | **40%** |
| Position Size Cap (HIGH_RISK) | 12% (default) | 12% (default) | 12% (default) | **20%** |
| Position Size Cap (HEDGE) | 20% (default) | 20% (default) | 20% (default) | 20% (default) |

### Protection Levels

| Level | R-Multiple Trigger | Stop Formula |
|-------|-------------------|--------------|
| INITIAL | 0R | Entry − InitialRisk |
| BREAKEVEN | 1.5R | Entry |
| LOCK_08R | 2.5R | Entry + 0.5 × InitialRisk |
| LOCK_1R_TRAIL | 3.0R | max(Entry + 1.0 × InitialRisk, Close − 1.5×ATR) |

---

## 18. API Routes — Quick Reference

### Market Data

| Route | Purpose |
|-------|---------|
| `GET /api/market-data?action=quote&ticker=AAPL` | Single stock quote |
| `GET /api/market-data?action=quotes&tickers=AAPL,MSFT` | Batch quotes |
| `GET /api/market-data?action=prices&tickers=AAPL,MSFT` | Batch prices only |
| `GET /api/market-data?action=indices` | Market indices |
| `GET /api/market-data?action=fear-greed` | Fear & Greed Index |
| `GET /api/market-data?action=regime` | Market regime (SPY vs 200-MA) |
| `GET /api/market-data?action=historical&ticker=AAPL` | Daily OHLCV bars |

### Scan & Scoring

| Route | Purpose |
|-------|---------|
| `POST /api/scan` | Run full 7-stage scan |
| `GET /api/scan` | Get cached scan results |
| `GET /api/scan/scores` | Dual scores for all tickers |
| `GET /api/scan/cross-ref` | Cross-referenced scan + dual scores |

### Positions & Stops

| Route | Purpose |
|-------|---------|
| `GET /api/positions` | All positions with live enrichment |
| `POST /api/positions` | Create new position |
| `PATCH /api/positions` | Close/exit position |
| `PUT /api/stops` | Update stop (monotonic) |
| `GET /api/stops` | Generate stop recommendations |
| `GET /api/stops/sync` | Trailing ATR recommendations |
| `POST /api/stops/sync` | Import stops from CSV |
| `PUT /api/stops/sync` | Auto-apply trailing ATR stops |

### Planning & Modules

| Route | Purpose |
|-------|---------|
| `GET /api/plan` | Weekly execution plan |
| `GET /api/modules` | Run all 21 modules |
| `POST /api/nightly` | Full 10-step nightly process |

### Trading 212 Integration

| Route | Purpose |
|-------|--------|
| `GET /api/stops/t212` | List all pending T212 stop orders (both Invest & ISA) |
| `POST /api/stops/t212` | Set/replace a stop-loss on T212 for one position |
| `PUT /api/stops/t212` | Bulk push all DB stops to T212 (batch) |
| `DELETE /api/stops/t212` | Remove stop-loss orders from T212 |
| `POST /api/trading212/connect` | Connect T212 API credentials |
| `POST /api/trading212/sync` | Sync portfolio from T212 |

### Stocks & Trade Log

| Route | Purpose |
|-------|--------|
| `GET /api/stocks` | Stock/ticker management |
| `GET /api/trade-log` | Trade journal entries |
| `GET /api/trade-log/summary` | Trade log summary statistics |
| `GET /api/portfolio/summary` | Portfolio overview |
| `POST /api/positions/hedge` | Hedge position management |

### Scan Extensions

| Route | Purpose |
|-------|--------|
| `GET /api/scan/snapshots` | Scan snapshot data |
| `POST /api/scan/snapshots/sync` | Snapshot sync (universe refresh) |
| `GET /api/scan/live-prices` | Live price updates for scan results |
| `POST /api/modules/early-bird` | Early Bird entry scan (Module 2) |

### Analytics

| Route | Purpose |
|-------|--------|
| `GET /api/ev-stats` | Expectancy stats with optional regime/sleeve/atrBucket/cluster filters |
| `GET /api/risk/correlation` | All cached HIGH_CORR pairs for /risk page |

### Risk & Settings

| Route | Purpose |
|-------|--------|
| `GET /api/risk` | Risk summary |
| `GET /api/settings` | User settings |
| `PUT /api/settings` | Update user settings |
| `GET /api/health-check` | 16-point health check |
| `GET /api/heartbeat` | Heartbeat status |
| `POST /api/settings/telegram-test` | Send test Telegram message |
| `GET /api/publications` | Publication/newsletter data |

---

## 19. Breakout Integrity Score (BIS)

**Source:** `src/lib/breakout-integrity.ts`

Scores the quality of a breakout candle (0–15 points) based on three sub-components measuring conviction, participation, and closing strength.

| Sub-component | 0 pts | +2 pts | +5 pts |
|---------------|-------|--------|--------|
| Body-to-range ratio | < 0.4 | 0.4–0.6 | > 0.6 |
| Volume vs 10d avg | < 1.0× | 1.0–1.5× | > 1.5× |
| Close position in range | Bottom 30% | Middle 40% (0.3–0.7) | Top 30% (≥ 0.7) |

**Integration:** Pre-computed per candle, stored as `bis_score` in the snapshot, then consumed by `computeBQS()` as the `bqs_bis` component (0–15 added directly to BQS sum). Defaults to 0 when not supplied — inert for legacy data.

---

## 20. EV Tracker

**Source:** `src/lib/ev-tracker.ts`

Records outcome data for each closed trade and provides expectancy analytics sliced by multiple dimensions.

### Functions

| Function | Purpose |
|----------|--------|
| `logEVRecord()` | Called on trade close. Non-blocking (errors logged, never thrown). Records: tradeId, regime, atrBucket, cluster, sleeve, entryNCS, outcome, rMultiple, closedAt |
| `getExpectancyStats()` | Returns `ExpectancyStats` with overall + sliced stats |

### ATR Bucket Classification

| ATR% at entry | Bucket |
|---------------|--------|
| ≤ 0 or null | UNKNOWN |
| < 2% | LOW |
| < 4% | MEDIUM |
| < 7% | HIGH |
| ≥ 7% | EXTREME |

### Expectancy Formula

```
E = avgWin × winRate + avgLoss × lossRate
```

**Slices:** overall, byRegime, byAtrBucket, byCluster, bySleeve

---

## 21. Correlation Matrix

**Source:** `src/lib/correlation-matrix.ts`

Computes pairwise Pearson correlation on 90 days of daily log returns for open positions + WATCH/READY scan candidates. Flags pairs > 0.75 as `HIGH_CORR`.

### Parameters

| Parameter | Value |
|-----------|-------|
| Lookback | 90 days |
| High correlation threshold | 0.75 |
| Minimum overlap days | 60 |
| Batch size | 10 concurrent fetches |

### Functions

| Function | Purpose |
|----------|--------|
| `computeCorrelationMatrix()` | Full matrix computation. Batch-fetches daily prices, computes upper triangle, persists to `correlationFlag` table (delete-all + rewrite in transaction). **Runs nightly only.** |
| `getCorrelationFlags(ticker)` | Get HIGH_CORR pairs involving a specific ticker (used by Module 7 Heatmap Swap) |
| `getAllCorrelationFlags()` | All cached flags sorted by correlation desc (used by /risk page) |
| `checkCorrelationWarnings(candidate, openTickers)` | Advisory check: warns if a new candidate is highly correlated with existing positions |

---

## Removed: 14-Phase Prediction Engine (October 2026)

The advisory prediction engine and its TradePulse/Kelly/RL layers were removed in the October 2026 simplification. They were never imported by `auto-trade.ts`, so they did not gate or size live entries (earlier text here describing Auto-Yes blocking by prediction layers did not match the execution path). Hard gates, sizing and stops are unchanged. See `reports/simplification-inventory-2026-10-08.md`.

---

*Last verified against source code: 7 March 2026*
