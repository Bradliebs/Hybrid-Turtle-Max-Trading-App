# HybridTurtle Dashboard — Complete Operating Guide

> **Version:** 6.0 | **Last Updated:** March 2026
>
> Prefer a simpler non-technical walkthrough? See `USER-GUIDE.md`.

---

## Table of Contents

1. [First-Time Setup](#1-first-time-setup)
2. [Settings Screen — Full Walkthrough](#2-settings-screen)
3. [Managing Your Ticker Universe](#3-managing-your-ticker-universe)
4. [Connecting Trading 212](#4-connecting-trading-212)
5. [Dashboard — Your Command Centre](#5-dashboard)
6. [Portfolio — Positions & Distribution](#6-portfolio)
7. [Scan — Finding New Trades](#7-scan)
8. [Plan — Weekly Execution](#8-plan)
9. [Risk — Risk Management](#9-risk)
10. [Trade Log — Journal & Audit](#10-trade-log)
11. [Notifications Centre](#11-notifications)
12. [Backtest — Signal Replay](#12-backtest)
13. [Hedge Portfolio — Long-Term Holds](#13-hedge-portfolio)
14. [Nightly Automation](#14-nightly-automation)
15. [The Weekly Workflow](#15-the-weekly-workflow)
16. [All API Routes — Quick Reference](#16-api-routes)
17. [System Rules — Immutable](#17-immutable-rules)
18. [Module System — 21 Risk Checks](#18-module-system)

---

## 1. First-Time Setup

**Prerequisite:** Node.js **20 LTS** or **22 LTS** (choose the LTS tab on nodejs.org).

### Step 1 — Install & Start

```bash
cd hybridturtle
npm install                    # Install dependencies
npx prisma generate            # Generate Prisma client
npx prisma migrate deploy      # Create/update database tables
npx prisma db seed             # Import stock universe from Planning/ CSVs
npm run dev                    # Start dashboard at http://localhost:3000
```

Or use the batch files:
- `install.bat` — Full install
- `start.bat` — Start the dashboard
- `run-dashboard.bat` — Compatibility alias that redirects to `start.bat`

### Step 2 — Configure Settings

Navigate to `/settings` and complete each section (see below).

### Step 3 — Connect Trading 212

Enter your API credentials and sync your portfolio (see Section 4).

### Step 4 — Verify Health

Check the Dashboard — the traffic light should be GREEN.

---

## 2. Settings Screen

URL: `/settings`

The Settings page has 6 sections:

### 2.1 Account & Risk Profile

| Field | What It Does |
|-------|-------------|
| **Equity (£)** | Your total account equity. Used for position sizing. Auto-updated if Trading 212 is connected. |
| **Risk Profile** | Controls risk-per-trade % and max positions. |

**Risk Profile Options:**

| Profile | Risk/Trade | Max Positions | Max Open Risk |
|---------|-----------|---------------|---------------|
| Conservative | 0.75% | 8 | 7.0% |
| **Balanced** (default) | **0.95%** | **5** | **5.5%** |
| Small Account | 2.00% | 4 | 10.0% |
| Aggressive | 3.00% | 3 | 12.0% |

> **Note:** The AGGRESSIVE profile also uses a wider initial stop (2.0×ATR vs the default 1.5×ATR).

**Aggressive Profile Details:**

| Category | Parameter | Value |
|----------|-----------|-------|
| Caps | Max Positions | 3 |
| Caps | Max Position (Core) | 40% |
| Caps | Max Position (High-Risk) | 20% |
| Caps | Max Cluster | 35% |
| Caps | Max Super-Cluster | 50% |
| Caps | Max Sector | 45% |
| Entry | ATR Buffer | Adaptive 5%–20% (Module 11b) |
| Entry | DIST_READY | ≤ 2.0% |
| Entry | DIST_WATCH | ≤ 3.0% |
| Regime | Benchmarks | SPY + VWRL (dual benchmark) |

Click **Save Settings** to persist. This updates the database via `PUT /api/settings`.

### 2.2 Trading 212 Integration

| Field | Purpose |
|-------|---------|
| API Key | Your Trading 212 API key |
| API Secret | Your Trading 212 API secret |
| Environment | `Demo` or `Live` — start with Demo for testing |

- **Connect & Test** — Tests the connection. If successful, stores credentials and shows your account ID + currency.
- **Sync Now** — Imports all T212 positions into the dashboard.
- **Disconnect** — Removes stored credentials.

**ISA Account (separate section):**

If you also have a T212 ISA account, a second set of API Key / Secret fields is available. Connect and sync ISA positions independently. ISA positions sync with `accountType: ISA` so they’re tracked separately in the portfolio.

### 2.3 Market Data Provider

| Field | Purpose |
|-------|--------|
| Provider | **Yahoo Finance** (default) or **EODHD** (requires API key) |
| EODHD API Key | Only needed if you select EODHD as provider |

Yahoo Finance is free and requires no API key. EODHD is optional and offered as an alternative data source.

### 2.4 Data Sources

| Field | Purpose |
|-------|---------|
| Alpha Vantage API Key | Optional backup data source. Get a free key at [alphavantage.co](https://www.alphavantage.co/support/#api-key) |

### 2.5 Telegram Notifications

| Field | Purpose |
|-------|---------|
| Bot Token | Your Telegram bot token (from @BotFather) |
| Chat ID | Your Telegram chat or group ID |
| **Send Test** | Sends a test message to verify the setup |

The nightly cron sends summaries via Telegram including: health status, regime, open positions, stop updates, and alerts.

### 2.6 Ticker Universe Management

This is where you manage which stocks the system scans and monitors. See Section 3 for full details.

### 2.7 Immutable Rules

Read-only list of 10 rules the system enforces. These cannot be changed:

1. Stops NEVER go down
2. No entries without BULLISH regime
3. No entries without health GREEN/YELLOW
4. Risk per trade ≤ profile limit
5. Total open risk ≤ profile cap
6. Position sizing always rounds DOWN
7. No weekend buying
8. Anti-chasing guard on gaps
9. Super-cluster cap at 50%
10. Heartbeat must be fresh

---

## 3. Managing Your Ticker Universe

### How Stocks Get Into the System

There are 3 ways:

#### Method 1 — Settings Page (Single Ticker)

1. Go to `/settings` → scroll to **Ticker Universe**
2. Type a ticker (e.g. `NVDA`) in the input box
3. Select a sleeve: **CORE**, **ETF**, **HIGH_RISK**, or **HEDGE**
4. Click **Add**
5. The stock is created in the database via `POST /api/stocks`

#### Method 2 — Seed from Planning Files (Bulk)

The Planning folder contains your stock lists:

| File | Contents |
|------|----------|
| `stock_core_200.txt` | Core sleeve tickers |
| `etf_core.txt` | ETF sleeve tickers |
| `stock_high_risk.txt` | High-risk sleeve tickers |
| `hedge.txt` | Hedge sleeve tickers (long-term holds) |
| `ticker_map.csv` | Ticker → name/sector/cluster mappings |
| `cluster_map.csv` | Ticker → cluster assignments |
| `super_cluster_map.csv` | Ticker → super-cluster groupings |
| `region_map.csv` | Ticker → region + currency |

Run the seed to import them all:

```bash
npx prisma db seed
```

This bulk-upserts all stocks with full metadata (name, sector, cluster, super-cluster, region, currency).

#### Method 3 — Auto-Created from Trading 212

When you sync with Trading 212, any position ticker not already in the database is auto-created with sleeve = `CORE`.

### Removing a Stock

- Click the **X** button next to any stock in the Settings ticker table.
- This performs a soft-delete (sets `active = false`).
- The stock won't appear in scans but historical positions are preserved.
- Hard delete is only possible if the stock has zero positions.

### Searching & Filtering

Use the search box above the ticker table to filter by ticker, name, or sector. Use the sleeve tabs to filter by CORE / ETF / HIGH_RISK / HEDGE.

### Stock Data Fields

| Field | Source | Notes |
|-------|--------|-------|
| Ticker | Manual / seed | Yahoo Finance format (e.g. `AAPL`, `GLEN.L`, `SAP.DE`) |
| Name | Seed / auto | Company name |
| Sleeve | Manual / seed | CORE, ETF, HIGH_RISK, or HEDGE |
| Sector | Seed | e.g. Technology, Healthcare |
| Cluster | Seed / `cluster_map.csv` | e.g. Mega Tech, Energy |
| Super Cluster | Seed / `super_cluster_map.csv` | e.g. MEGA_TECH_AI |
| Region | Seed / `region_map.csv` | e.g. US, UK, EU |
| Currency | Seed / `region_map.csv` | USD, GBP, GBX, EUR, etc. |

---

## 4. Connecting Trading 212

### Initial Connection

1. Go to `/settings` → **Trading 212 Integration**
2. Enter your **API Key** and **API Secret** from Trading 212
3. Select **Demo** or **Live** environment
4. Click **Connect & Test**
5. If successful you'll see your Account ID and Currency

### Syncing Positions

Two places to sync:
- **Settings page** → "Sync Now" button
- **Portfolio → Positions page** → "Sync Positions" button

**What sync does:**
1. Fetches all your T212 positions + account summary
2. Creates new positions in the dashboard DB (with 5% default stop-loss)
3. Updates existing positions (shares / entry price)
4. Marks positions closed on T212 as CLOSED in the dashboard
5. Updates your equity from T212 total account value
6. Updates cash, invested, unrealised P&L figures

**After sync:** The Positions page shows a results card with counts: X new, Y updated, Z closed.

### Disconnecting

Settings page → "Disconnect" button. This removes stored credentials but keeps your synced positions.

---

## 5. Dashboard

URL: `/dashboard`

The dashboard is your daily command centre. Data refreshes automatically every 60 seconds.

### Layout (Top to Bottom)

| Section | What It Shows |
|---------|-------------|
| **⚠️ Red Health Banner** | Full-width red overlay if system health is RED. Must dismiss or investigate. |
| **Market Indices Bar** | Live prices for major indices (S&P 500, Nasdaq, FTSE, etc.) |
| **Weekly Phase** | Current phase: 📋 Think (Sun) → 👁️ Observe (Mon) → ⚡ Act (Tue) → 🔧 Manage (Wed–Fri) |
| **Health Traffic Light** | Overall system health: 🟢 GREEN / 🟡 YELLOW / 🔴 RED |
| **Market Regime** | BULLISH / SIDEWAYS / BEARISH (SPY vs 200-day MA) |
| **Heartbeat Monitor** | Timestamp of last nightly run. Green = SUCCESS, Amber = PARTIAL (some steps degraded), Red = STALE/FAILED |
| **Trigger Status Card** | Count of triggered candidates ready to buy |
| **Nightly Snapshot Runner** | Manual "Run Nightly" button for on-demand execution |
| **Evening Review Summary** | Account equity, cash, open risk, protection status, candidate count, broker sync status, data freshness |
| **Tonight Workflow Card** | 7-step evening workflow with status icons and "Run All" button |
| **Safety Alerts Panel** | Active safety alerts (stale data, unprotected positions, risk breaches) with severity badges |
| **Quick Actions** | Shortcut buttons to key pages |
| **Risk Modules Widget** | Summary of breadth, momentum, whipsaw, laggard, climax signals |
| **Pyramid Alerts Widget** | Pyramid-up opportunities for existing positions |
| **Module Status Panel** | All 21 modules at a glance with status lights |
| **Fear & Greed Gauge** | CNN Fear & Greed Index (0–100, Extreme Fear → Extreme Greed) |
| **Dual Regime Widget** | SPY vs VWRL regime comparison + regime stability indicator |
| **Action Card** | This week's action plan — candidates, stop updates, flags |
| **Scoring Guide Widget** | Reference card for BQS / FWS / NCS score interpretation |
| **Hedge Portfolio Card** | Hedge positions summary with P&L and stop guidance |
| **Recent Alerts** | Latest system events: heartbeats, health checks, trades, stop moves |

---

## 6. Portfolio

### 6.1 Positions Page

URL: `/portfolio/positions`

**KPI Banner (top):** Portfolio Value, Unrealised P&L (with %), Cash, Invested, Open Positions, Last Synced.

**T212 Sync Panel:** Sync button + connection status. After sync shows account summary.

**Positions Table:**

| Column | Description |
|--------|------------|
| Ticker | Stock symbol + name |
| Status | OPEN / CLOSED badge |
| R-Multiple | Current profit in R-units (green/red) |
| Entry | Entry price |
| Current | Live price from Yahoo Finance (GBP-normalised) |
| Stop-Loss | Current stop price (🔒 icon if above initial) |
| Protection | Level: INITIAL → BREAKEVEN → LOCK +0.5R → LOCK +1R TRAIL |
| Shares | Number of shares (fractional to 0.01) |
| Gain % | Unrealised gain/loss percentage |
| Value | Current position value in GBP |
| Risk $ | Current risk in GBP (initialRisk × shares) |
| **Actions** | **Update Stop** and **Exit** buttons (hover to reveal) |

**Update Stop (button):**
- Opens a modal showing position context (entry, current price, current stop, R-multiple)
- **Stop Ladder recommendation table** showing all three levels:

| Level | Trigger | Stop Moves To |
|-------|---------|---------------|
| Breakeven | Profit ≥ +1.5R | Entry Price |
| Partial Lock | Profit ≥ +2.5R | Entry + (0.5 × R) |
| Trail + Lock | Profit ≥ +3.0R | max(Entry + 1R, Close − 1.5×ATR) |

- Green highlight + ✓ on levels already reached
- **"Use" button** next to each reached level — click to auto-fill the stop price
- Recommendation text below the table
- Monotonic enforcement: new stop MUST be above current stop

**Exit (button):**
- Opens a modal pre-filled with current market price
- Shows entry, shares, current price, P&L
- **Live preview** of realised P&L based on the entered exit price
- Confirm to close the position via `PATCH /api/positions`

### 6.2 Distribution Page

URL: `/portfolio/distribution`

Shows portfolio diversification analysis:

| Section | What It Shows |
|---------|-------------|
| KPI Banner | Portfolio Value, Unrealised P&L, Cash, Equity, Positions |
| Protection Levels | Donut chart: how many positions at each stop level |
| Sleeve Distribution | Donut chart: Core vs ETF vs High-Risk allocation |
| Cluster Concentration | Donut chart: allocation by cluster |
| Sleeve Allocation Bars | Bar chart: used % vs max % per sleeve |
| Performance Chart | Time-series portfolio performance |

---

## 7. Scan — Finding New Trades

URL: `/scan`

The scan runs a 7-stage pipeline against your entire ticker universe. Click **Run Full Scan** to trigger it.

### The 7 Stages

| Stage | Name | What Happens |
|-------|------|-------------|
| 1 | **Universe** | Loads all active stocks grouped by sleeve |
| 2 | **Technical Filters** | Applies 6 technical filters to each ticker: Price > 200-MA, ADX ≥ 20, +DI > −DI, ATR% < 8% (7% for High-Risk), Efficiency ≥ 30%, Data Quality check |
| 3 | **Classification** | Tags each passing candidate: **READY** (≤ 2% from breakout), **WATCH** (≤ 3%), **FAR** (> 3%). Also flags **TRIGGERED** if price is at/above entry trigger. **COOLDOWN** blocks re-entry for tickers with a recent failed breakout. **Note:** auto-trade execution (A-grade) only fires on **TRIGGERED** candidates — READY candidates appear on the watchlist for human review but are not auto-bought until the breakout confirms. |
| 4 | **Ranking** | Scores candidates: Sleeve priority (Core 40, ETF 20, High-Risk 10, Hedge 5) + Status bonus (READY +30, WATCH +10) + ADX + Volume + Efficiency + Relative Strength |
| 5 | **Risk Gates** | Checks: Total open risk ≤ max, positions < max, sleeve within cap, cluster ≤ cap (20% default, 25% SMALL_ACCOUNT, 35% AGGRESSIVE), sector ≤ cap (25% default, 30% SMALL_ACCOUNT, 45% AGGRESSIVE), position size cap |
| 6 | **Anti-Chase Guard** | Configurable gap guard: blocks if gapped beyond ATR or % thresholds. Monday uses weekend thresholds; Tue–Fri uses daily thresholds. Optional slippage buffer tightens ATR threshold based on historical trade slippage (from `slippage-tracker.ts`). Also applies an **all-days** volatility extension check: extATR > 0.8 → WAIT_PULLBACK. Plus COOLDOWN block for failed breakouts. |
| 7 | **Position Sizing** | Calculates shares = floor((Equity × Risk%) / ((Entry − Stop) × FX)), fractional to 0.01 (T212). Skips if result ≤ 0 |

### Entry Trigger Formula

```
Entry Trigger = 20-day High + (buffer% × ATR(14))
```

The buffer % is **adaptive** (Module 11b): scales from **5% to 20%** based on ATR% and vol regime. Default centre is 10%.

### Stop Price (Initial)

```
Initial Stop = Entry Trigger − (1.5 × ATR(14))
```

### The Sidebar

- **Funnel visualisation:** Shows how many candidates survive each stage
- **Position Sizer calculator:** Standalone calculator to manually size a position given entry, stop, and equity

### Bottom Section

- **Ticker Chart:** Click any candidate row to see an interactive price chart with technical indicators

---

## 8. Plan — Weekly Execution

URL: `/plan`

The Plan page is your pre-trade checklist and weekly battle plan. It follows the weekly rhythm:

| Day | Phase | Action |
|-----|-------|--------|
| Sunday | 📋 Think | Review health, run scans, build plan |
| Monday–Friday | ⚡ Act | Execute only when regime, health, risk, and anti-chase gates pass |
| Saturday | 🔧 Maintain | Markets closed, review positions and operations |

### Layout (3 Columns)

**Left Column:**
- **Phase Timeline** — Visual timeline showing all 4 phases, highlighting the current one
- **Stop Update Queue** — List of positions with recommended stop adjustments. Shows direction (↑ move up / → hold). Based on R-multiple: ≥ 3R → trail to lock 1R, ≥ 1.5R → breakeven, else hold

**Middle Column:**
- **Ready Candidates** — Positions from the most recent scan classified as READY or WATCH. Quick view of what's actionable.

**Right Column:**
- **Pre-Trade Checklist** — Validation checks before any trade:
  - Health report GREEN/YELLOW?
  - Risk budget available?
  - Regime BULLISH?
  - Weekday execution session?
  - Each item shows ✓ pass or ✗ fail

---

## 9. Risk — Risk Management

URL: `/risk`

### Top Banner — Immutable Rules

10 core safety rules displayed in a red panel. These are not configurable — they are hardcoded system constraints.

### Left Column

- **Risk Profile Selector** — Quick-switch between Conservative / Balanced / Small Account / Aggressive. Shows risk/trade % and max positions.
- **Risk Budget Meter** — Visual budget showing:
  - Used risk % vs max risk %
  - Used positions vs max positions
  - Sleeve utilisation: CORE (used/80%), ETF (used/80%), HIGH_RISK (used/40%), HEDGE (used/100%)

### Middle Column

- **Stop-Loss Panel** — All open positions with their stops:
  - Entry price, current stop, gap (how far stop is from current price)
  - Protection level badge (INITIAL → BREAKEVEN → LOCK → TRAIL)
  - Visual progress bar showing stop progression

### Right Column

- **Trailing Stop Panel** — Shows trailing ATR stop recommendations:
  - For each position: highest close since entry, current ATR, calculated trailing stop (Highest Close − 1.5×ATR, applied from the entry day)
  - If trailing stop > current stop → recommendation to ratchet up
- **Protection Progress** — Pie/bar chart showing how many positions are at each protection tier

---

## 10. Trade Log — Journal & Audit

URL: `/trade-log`

A post-trade review page showing what worked, what failed, and why.

### Top Section

**Filters bar (6 controls):** ticker search, decision (TAKEN / SKIPPED / PARTIAL), trade type (ENTRY / EXIT / STOP_HIT / ADD / TRIM), date range, Apply button. Date presets: Last 30D, Last 90D, YTD, All Time.

**Summary cards (6):** Win Rate, Expectancy (R), Avg Slippage %, Worked count, Failed count, Total Logs.

### Charts

- **Performance by Regime** — bar chart: trade count and avg R per regime (BULLISH / SIDEWAYS / BEARISH)
- **Monthly Win Rate Trend** — bar chart: win rate % and outcome count per month
- **Top Decision Reasons / Top Winning Tags / Top Losing Tags** — ranked frequency lists

### Trade Journal Table

| Column | Description |
|--------|------------|
| Date | Trade date |
| Ticker | Symbol + name |
| Type | ENTRY / EXIT / STOP_HIT / ADD / TRIM |
| Regime | Market regime at time of trade |
| R-multiple | Risk-adjusted return |
| P/L (£) | Realised profit/loss |
| Why | Decision reason / exit reason |
| What Worked | Post-trade positive notes |
| What Failed | Post-trade negative notes |
| Lessons | Key takeaways |

---

## 11. Notifications Centre

URL: `/notifications`

Centralised inbox for trade alerts, stop warnings, and nightly pipeline outputs.

### Features

- **Unread badge** (red pill) in header
- **Filter tabs:** All / Unread
- **Mark all as read** button
- **Notification cards** with type icon, relative timestamp, unread indicator (pulsing blue dot), title, and message body
- **Priority-based left border:** CRITICAL = red, WARNING = amber, INFO = blue

### Notification Types

| Type | Meaning |
|------|---------|
| TRADE_TRIGGER | Trade alert — candidate hit entry trigger |
| STOP_HIT | Stop-loss warning |
| PYRAMID_ADD | Add/pyramid-up signal for existing position |
| WEEKLY_SUMMARY | Weekly recap |
| SYSTEM | System events (health, errors, heartbeat) |

---

## 12. Backtest — Removed

The `/backtest` signal-replay page was removed in the October 2026 simplification. The `GET /api/backtest` endpoint remains for the Telegram `/backtest` command.

---

## 13. Hedge Portfolio — Long-Term Holds

### What Is the Hedge Sleeve?

The **HEDGE** sleeve is for stocks you want to hold long term — conviction positions that fall outside the normal swing-trading rules. They still receive full system guidance (stop recommendations, protection levels, P&L tracking) but are **exempt** from:

- **Open risk % calculation** — Hedge positions are excluded from the risk budget so they don't block new entries
- **Laggard purge** — No forced-exit flags, even if underwater for weeks
- **Position count limits** — Hedge positions don't count against your max positions
- **Sleeve cap** — Hedge has a 100% cap (effectively unlimited)

### Dashboard Card

The **Hedge Portfolio** card appears on the main dashboard and shows:

| Element | Description |
|---------|-------------|
| Total Value | Combined GBP value of all hedge positions |
| Total P&L | Aggregate profit/loss in £ and % |
| Position Count | Number of active hedge holdings |
| Per-Position Row | Ticker, current price, P&L %, R-multiple |
| Stop Guidance | Current protection level + recommended upgrade if available |
| Near-Stop Alert | Red highlight if price is within 5% of stop |
| Stop Upgrade Badge | Blue "↑ B/E" or "↑ Trail" badge when stop level can be raised |

### How to Add Hedge Positions

1. **Settings → Ticker Universe** — Add a stock with sleeve = **Hedge**
2. **Portfolio → Add Position** — Select **Hedge** from the sleeve dropdown
3. **Planning file** — Add tickers to `hedge.txt` and run `npx prisma db seed`

### Stop Guidance (Not Enforced)

Hedge positions still receive the full stop ladder recommendations:
- **Breakeven** at ≥ 1.5R → stop moves to entry
- **Partial Lock** at ≥ 2.5R → stop moves to entry + 0.5R
- **Trail + Lock** at ≥ 3.0R → stop = max(entry + 1R, close − 1.5×ATR)

These are shown as guidance badges on the dashboard card. You decide whether to act on them — the system won't auto-apply or flag for forced exit.

### API

`GET /api/positions/hedge?userId=default` — Returns all open hedge positions with live prices, P&L, and stop guidance.

---

## 14. Nightly Automation

### What Runs Automatically

The nightly cron executes at **9:30 PM UK time**, Monday–Friday.

### The 10-Step Nightly Process (Steps 0–9)

> **Note:** SYSTEM-BREAKDOWN.md refers to this as a "9-step" process, counting steps 1–9 only. Step 0 (pre-cache) is a preparatory step that runs before the main pipeline.

| Step | What Happens |
|------|-------------|
| 0 | Pre-cache historical data for all active tickers |
| 1 | Run 16-point health check |
| 2 | Fetch live prices for all open positions + check data freshness |
| 3 | R-based stop recommendations (breakeven / lock levels) |
| 3b | Trailing ATR stop recommendations + **auto-apply** if stop moves up |
| 3c | Gap risk detection for HIGH_RISK positions (advisory) |
| 3d | Stop-hit detection — alert if price ≤ currentStop |
| 4 | Detect laggards + collect alerts |
| 5 | Risk-signal modules (breadth, momentum, whipsaw, climax, etc.) |
| 6 | Equity snapshot + pyramid-up checks (rate-limited: once per 6 hours) |
| 6b | Equity milestone advisory (£1K/£2K/£5K thresholds → Telegram + in-app notification) |
| 7 | Snapshot sync — full universe refresh + top 15 READY candidates |
| 8 | Send Telegram summary with health, regime, positions, stops, alerts |
| 9 | Write heartbeat (SUCCESS / PARTIAL / FAILED with step-level results) |

**Step-level tracking:** Each step is timed via `startStep()`/`finalizeSteps()`. Failed steps are recorded individually in the heartbeat details JSON.

**Heartbeat status is ternary:**
- **SUCCESS** — all steps completed without error (green on dashboard)
- **PARTIAL** — some steps failed but pipeline completed (amber on dashboard)
- **FAILED** — critical failure (red on dashboard)

**Watchdog:** A separate `watchdog.ts` script (`watchdog-task.bat`) runs daily at 10:00 AM. If no nightly heartbeat exists within 26 hours, it sends a Telegram alert.

### Manual Trigger

```bash
npx tsx src/cron/nightly.ts --run-now
```

Or call the API directly: `POST /api/nightly` with `{"userId": "default-user"}`.

### Health Check — 16 Points

| ID | Check | Category |
|----|-------|----------|
| A1 | Data Freshness (> 2 days warn, > 5 days fail) | Data |
| A2 | Duplicate Tickers | Data |
| A3 | Column Population | Data |
| C1 | Equity > £0 | Risk |
| C2 | Open Risk Within Cap | Risk |
| C3 | Valid Position Sizes | Risk |
| D | Stop Monotonicity | Logic |
| E | State File Currency | Logic |
| F | Config Coherence | Logic |
| G1 | Sleeve Limits | Allocation |
| G2 | Cluster Concentration (≤ cap: 20% default, 25% SMALL_ACCOUNT, 35% AGGRESSIVE) | Allocation |
| G3 | Sector Concentration (≤ cap: 25% default, 30% SMALL_ACCOUNT, 45% AGGRESSIVE) | Allocation |
| H1 | Heartbeat Recent | System |
| H2 | API Connectivity | System |
| H3 | Database Integrity | System |
| H4 | Cron Job Active | System |

---

## 15. The Weekly Workflow

### Sunday — THINK

1. Open Dashboard → check traffic light health
2. Review Fear & Greed, Regime, Dual Benchmark
3. Go to `/scan` → **Run Full Scan**
4. Review READY candidates
5. Go to `/plan` → review pre-trade checklist
6. Build your execution list for the next weekday session

### Monday to Friday — ACT

1. Go to `/plan` → confirm pre-trade checklist is all-green
2. For each planned trade:
   - Verify the candidate is still READY (check scan)
   - Confirm the entry trigger price
   - Use the position sizer for exact shares
   - Place the trade on Trading 212
3. After trading → Sync positions from T212
4. Verify positions appear correctly in Portfolio

### Saturday — MAINTAIN

1. Dashboard → check daily health + heartbeat
2. Portfolio → review R-multiples on open positions
3. If any position hits a stop-ladder threshold:
   - Click **Update Stop** → use the recommended level
4. Review the Plan page stop-update queue
5. Risk page → check budget utilisation

> **Weekday entries:** Entries are permitted Monday to Friday only when the execution checklist passes: BULLISH regime, GREEN/YELLOW health, risk capacity, fresh data, and anti-chase checks.

### Every Night (Automated)

- 9:30 PM: Nightly cron runs health check, updates trailing stops, sends Telegram summary

---

## 16. API Routes — Quick Reference

### Core Data

| Route | Method | Purpose |
|-------|--------|---------|
| `GET /api/market-data?action=quote&ticker=AAPL` | GET | Single stock quote |
| `GET /api/market-data?action=quotes&tickers=AAPL,MSFT` | GET | Batch quotes |
| `GET /api/market-data?action=prices&tickers=AAPL,MSFT` | GET | Batch prices only |
| `GET /api/market-data?action=indices` | GET | Market indices |
| `GET /api/market-data?action=fear-greed` | GET | CNN Fear & Greed |
| `GET /api/market-data?action=regime` | GET | Market regime (SPY vs 200-MA) |
| `GET /api/market-data?action=historical&ticker=AAPL` | GET | Daily OHLCV bars |

### Settings & Auth

| Route | Method | Purpose |
|-------|--------|---------|
| `GET /api/settings?userId=X` | GET | Get risk profile + equity |
| `PUT /api/settings` | PUT | Update risk profile + equity |
| `POST /api/auth/register` | POST | Create new user |
| `POST /api/auth/[...nextauth]` | POST | Login (NextAuth) |

### Stock Universe

| Route | Method | Purpose |
|-------|--------|---------|
| `GET /api/stocks?sleeve=CORE&search=NVD` | GET | List/filter stocks |
| `POST /api/stocks` | POST | Add single: `{ticker, sleeve}` or bulk: `{stocks:[...]}` |
| `DELETE /api/stocks?ticker=AAPL` | DELETE | Soft-delete (active=false) |
| `DELETE /api/stocks?ticker=AAPL&hard=true` | DELETE | Hard-delete (if no positions) |

### Trading 212

| Route | Method | Purpose |
|-------|--------|---------|
| `POST /api/trading212/connect` | POST | Test + save T212 credentials |
| `DELETE /api/trading212/connect?userId=X` | DELETE | Disconnect T212 |
| `POST /api/trading212/sync` | POST | Full position sync from T212 |
| `GET /api/trading212/sync?userId=X` | GET | Get sync status + account summary |

### Positions & Stops

| Route | Method | Purpose |
|-------|--------|---------|
| `GET /api/positions?userId=X&status=OPEN` | GET | Get enriched positions (live prices, GBP) |
| `POST /api/positions` | POST | Create manual position |
| `POST /api/positions/execute` | POST | Execute a planned trade (from Plan page) |
| `PATCH /api/positions` | PATCH | Close/exit position: `{positionId, exitPrice}` |
| `POST /api/positions/reset-from-t212` | POST | Reset position data from Trading 212 source |
| `POST /api/positions/sync-account-types` | POST | Sync ISA/CFD account type assignments |
| `PUT /api/stops` | PUT | Update stop: `{positionId, newStop, reason}` — **monotonic** |
| `GET /api/stops?userId=X` | GET | Get R-based stop recommendations |
| `GET /api/stops/sync?userId=X` | GET | Get trailing ATR stop recommendations |

### Scan & Plan

| Route | Method | Purpose |
|-------|--------|---------|
| `POST /api/scan` | POST | Run 7-stage scan: `{userId, riskProfile, equity}` |
| `GET /api/plan?userId=X` | GET | Get weekly phase + execution plan |
| `POST /api/plan` | POST | Create execution plan: `{userId, candidates, notes}` |

### Risk & Health

| Route | Method | Purpose |
|-------|--------|---------|
| `GET /api/risk?userId=X` | GET | Risk budget + positions |
| `GET /api/health-check?userId=X` | GET | Run 16-point health check |
| `GET /api/heartbeat` | GET | Last heartbeat status |
| `POST /api/heartbeat` | POST | Record new heartbeat |

### Modules & Nightly

| Route | Method | Purpose |
|-------|--------|---------|
| `GET /api/modules?userId=X` | GET | Run all 21 modules |
| `POST /api/nightly` | POST | Trigger full nightly process |
| `GET /api/portfolio/summary?userId=X` | GET | Portfolio distribution data |
| `GET /api/publications?userId=X` | GET | Recent system events |
### Notifications & Trade Log

| Route | Method | Purpose |
|-------|--------|--------|
| `GET /api/notifications?userId=X` | GET | Get all notifications |
| `PUT /api/notifications/read-all?userId=X` | PUT | Mark all notifications read |
| `PUT /api/notifications/:id` | PUT | Mark single notification read |
| `GET /api/trade-log?userId=X` | GET | Get trade journal entries |
| `GET /api/trade-log/summary?userId=X` | GET | Get trade log summary statistics |

### Backtest & Analytics

| Route | Method | Purpose |
|-------|--------|--------|
| `GET /api/backtest` | GET | Run signal replay backtest (used by Telegram `/backtest`) |
| `GET /api/ev-stats?userId=X` | GET | Expected value statistics |
### Hedge

| Route | Method | Purpose |
|-------|--------|---------|
| `GET /api/positions/hedge?userId=X` | GET | Hedge positions with live prices & stop guidance |

---

## 17. Immutable Rules

These are hardcoded into the system and cannot be overridden:

| # | Rule |
|---|------|
| 1 | **Stops NEVER go down** — monotonic enforcement throws error if attempted |
| 2 | **No entries without BULLISH regime** — scan gates block SIDEWAYS/BEARISH |
| 3 | **No entries without GREEN/YELLOW health** — pre-trade checklist enforces |
| 4 | **Risk per trade ≤ profile limit** — position sizer caps at profile % |
| 5 | **Total open risk ≤ profile cap** — risk gate rejects if exceeded |
| 6 | **Position sizing rounds DOWN** — fractional to 0.01 (T212), zero-size = skip |
| 7 | **No weekend buying** — Saturday and Sunday block entries |
| 8 | **Anti-chasing: gap > 0.75 ATR or > 3% blocks entry** — applies every execution day |
| 9 | **Super-cluster cap at 50%** — concentration limit per super-cluster |
| 10 | **Heartbeat must be fresh** — data > 2 days = warn, > 5 days = fail |

---

## 18. Module System — 16 Active Risk & Analysis Modules

All modules run via `GET /api/modules?userId=X` and report to the Dashboard's Module Status Panel.

> **Note:** Module numbering has intentional gaps — modules 1, 4, and 6 are retired/removed. The 16 active modules are listed below.

| # | Module | Status Meaning |
|---|--------|---------------|
| 2 | **Early Bird Entry** | 🟢 = candidates found during bullish regime, 🟡 = none found, 🔴 = wrong regime |
| 3 | **Laggard Purge** | 🟢 = no laggards, 🟡 = laggards flagged (held ≥ 10 days, down ≥ 2%), 🔴 = severe laggards |
| 5 | **Climax Top Exit** | 🟢 = no climax signals, 🟡 = tighten stops, 🔴 = trim recommended |
| 7 | **Heat-Map Swap** | 🟢 = no swaps, 🟡 = swap suggestions available |
| 8 | **Heat Check** | 🟢 = cluster OK, 🔴 = blocked (overweight cluster) |
| 9 | **Fast-Follower Re-Entry** | **DISABLED** — re-entry after stop-hit fights the tape at 4-position account size |
| 9.1 | **Regime Stability** | 🟢 = stable 3+ days, 🟡 = transitioning, 🔴 = chop detected |
| 10 | **Breadth Safety Valve** | 🟢 = breadth healthy (≥ 50%), 🟡 = below threshold, 🔴 = max positions restricted |
| 11 | **Whipsaw Kill Switch** | 🟢 = no blocks, 🔴 = ticker blocked (recent whipsaw) |
| 11b | **Adaptive ATR Buffer** | Internal — scales entry buffer 5%–20% based on ATR% and vol regime |
| 12 | **Super-Cluster Cap** | 🟢 = within 50% cap, 🔴 = breached |
| 13 | **Momentum Expansion** | **DISABLED** — procyclical risk expansion adds risk near end of moves, not middle |
| 14 | **Climax Trim/Tighten** | 🟢 = no action, 🟡 = tighten, 🔴 = trim |
| 15 | **Trades Log** | 🟢 = logged OK, includes slippage tracking |
| 16 | **Turnover Monitor** | 🟢 = healthy pace, 🟡 = high turnover (avg hold < 5d or > 20 trades/30d) |
| 17 | **Weekly Action Card** | Generated summary: candidates, stop updates, flags, budget |
| 18 | **Data Validation** | 🟢 = all data fresh, 🟡/🔴 = stale or anomalous tickers |
| 19 | **Dual Benchmark** | SPY + VWRL regime comparison, chop detection |
| 20 | **Re-Entry Logic** | Monitors closed positions for bullish re-entry after cooldown |
| 21 | **Position Tracking** | 🟢 = all positions valid, 🟡/🔴 = mismatches detected |

---

## 19. Removed: Prediction Engine and AI Analyst (October 2026)

The advisory prediction engine (conformal intervals, failure modes, signal weighting, stress test, immune system/danger level, lead-lag, GNN, Bayesian beliefs, RL advisor, Kelly sizing, causal audit, TDA badge, TradePulse, Phase 6 ridge model) and the AI analyst were removed in the October 2026 simplification. None of them were on the auto-trade path. See `reports/simplification-inventory-2026-10-08.md`.

Still available (advisory only): VPIN and sentiment panels on the Plan page (advanced view), and the model-assisted ranking toggle in Settings → Model Layer.

---

## Quick-Start Checklist

- [ ] Run `npm install` and `npx prisma migrate deploy`
- [ ] Seed the stock universe: `npx prisma db seed`
- [ ] Start the dashboard: `npm run dev`
- [ ] Go to `/settings` and set your equity + risk profile
- [ ] Connect Trading 212 (API key + secret)
- [ ] Sync your T212 positions
- [ ] Check Dashboard — traffic light should be GREEN
- [ ] Run your first scan from `/scan`
- [ ] Review the Plan page on Sunday
- [ ] Let the nightly cron handle the rest

---

*Built for the Turtle Way. Systematic. Disciplined. Sleep well.*
