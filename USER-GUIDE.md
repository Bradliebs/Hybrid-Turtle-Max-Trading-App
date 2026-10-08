# HybridTurtle User Guide (Complete)

This guide is for everyday users (including non-coders) who want to run HybridTurtle confidently.

---

## 1) What HybridTurtle Does

HybridTurtle is a trading dashboard that helps you:

- track your portfolio and risk in one place
- scan a stock universe for candidates
- follow a weekly trading rhythm (Think → Observe → Act → Manage)
- enforce risk rules automatically (so emotional decisions are reduced)
- update stops using a structured ladder
- run nightly checks and optional Telegram summaries

---

## 2) What You Need Before You Start

- Windows 10/11
- Node.js **20 LTS** or **22 LTS** (LTS tab on nodejs.org)
- Internet connection
- Optional: Trading 212 API credentials (if you want account sync)

---

## 3) First-Time Setup (One-Time)

1. Double-click `install.bat`
2. If Node.js is missing/unsupported, install Node.js 20 or 22 LTS and run `install.bat` again
3. Wait while installer sets up dependencies and database
4. Optional: choose whether to set up nightly Telegram task
5. When complete, use desktop shortcut or `start.bat`

### Launcher Files

- `start.bat` = main launcher for daily use
- `run-dashboard.bat` = compatibility alias that redirects to `start.bat`

---

## 4) Daily Startup

1. Double-click desktop shortcut **HybridTurtle Dashboard** (or run `start.bat`)
2. Wait for browser to open at `http://localhost:3000/dashboard`
3. Keep terminal window open while using the app
4. Close terminal window to stop the dashboard

---

## 5) Main Pages and What To Do There

## Dashboard (`/dashboard`)
Use this as your control center.

Check these first:
- Health traffic light (green/yellow/red)
- Market regime (bullish/sideways/bearish)
- Heartbeat freshness (nightly job health — green = SUCCESS, amber = PARTIAL, red = STALE/FAILED)
- Data source freshness (Live / Cache / Stale Cache indicator)
- Module panel statuses
- Fear & Greed and dual benchmark context

If a red health banner appears, fix that issue before placing trades.

## Portfolio Positions (`/portfolio/positions`)
Use this to manage open positions.

You can:
- sync positions from Trading 212
- view entry/current/stop, R-multiple, risk, and P&L
- update stops using guided recommendations
- close positions with exit-price preview

## Portfolio Distribution (`/portfolio/distribution`)
Use this to monitor concentration.

You can see:
- sleeve allocation
- cluster concentration
- protection level distribution
- overall portfolio value and trend

## Scan (`/scan`)
Use this to find candidates.

- Click **Run Full Scan**
- Review READY / WATCH / FAR classifications
- Review funnel survival by stage
- Use built-in position sizer for share sizing

## Plan (`/plan`)
Use this as your weekly execution board.

Includes:
- weekly phase timeline
- ready/watch candidate review
- pre-trade checklist
- stop-update queue

## Risk (`/risk`)
Use this to protect the account.

Includes:
- risk profile selector
- risk budget meter
- stop-loss panel
- trailing stop recommendations
- immutable safety rules

## Settings (`/settings`)
Use this for account-level configuration.

Set or verify:
- account equity
- risk profile
- Trading 212 connection details
- market data provider (Yahoo or EODHD)
- model layer toggle: model-assisted ranking (advisory only — never changes execution)

## Trade Log (`/trade-log`)
Use this to review past trades and learn.

You can:
- filter by ticker, decision, trade type, date range
- see win rate, expectancy, and slippage stats
- review what worked and what failed per trade
- view performance by regime and monthly trends

## Journal (`/journal`)
Use this to track per-position notes and lessons.

The journal provides a per-position timeline for entry notes, confidence levels, close notes, and post-trade lessons. Each position can have an entry note (recorded at time of trade) and a close note (recorded when exiting). The journal is also accessible via the **Journal Drawer** in Portfolio → Positions — click the journal icon on any position row.

## Notifications (`/notifications`)
Use this to track system alerts.

Shows:
- trade trigger alerts
- stop-hit warnings
- pyramid-up signals
- nightly summaries and system events
- mark individual or all notifications as read

---

## 6) Weekly Workflow (Recommended)

## Sunday — THINK
- review dashboard health/regime
- run full scan
- review READY candidates
- draft trade plan

## Monday to Friday — ACT
- confirm plan checklist is green/yellow
- verify candidates are still valid
- size positions and execute
- sync positions after execution

## Saturday — MAINTAIN
- check dashboard health daily
- review stops and update when ladder thresholds are hit
- monitor risk budget and concentration

> **Weekday entries:** Entries are permitted Monday to Friday only when the execution checklist passes: BULLISH regime, GREEN/YELLOW health, risk capacity, fresh data, and anti-chase checks.

---

## 7) Core System Rules You Should Know

The platform enforces hard safety constraints, including:

- stops never move down
- no entries on weekends
- anti-chasing blocks excessive gap entries (tightened by historical slippage data)
- position sizing is risk-capped and rounded down
- total risk and concentration caps are enforced
- stale heartbeat/data triggers warnings or failures
- Yahoo Finance calls retry automatically on transient errors (3 attempts with backoff)
- on Tuesdays (execution day), price data is force-refreshed to bypass cache
- a watchdog script alerts via Telegram if the nightly pipeline fails to run

Treat these rules as safeguards, not optional suggestions.

---

## 8) Trading 212 Connection and Sync

If you connect Trading 212:

1. Open Settings and save credentials
2. Go to Positions page and run sync
3. Verify portfolio values and open positions after sync

If you disconnect later, stored credentials are removed; synced historical data remains.

---

## 9) Signal Messages (Telegram) Setup

Use this if you want nightly signal/summary messages in Telegram.

1. In Telegram, open **@BotFather** and create a bot (`/newbot`).
2. Copy the **bot token** from BotFather.
3. Send at least one message to your new bot.
4. Get your **chat ID** by opening this URL in a browser (replace `<TOKEN>`):
	- `https://api.telegram.org/bot<TOKEN>/getUpdates`
	- Look for `"chat"` then the numeric `"id"` value.
5. Open HybridTurtle → **Settings** → **Telegram Notifications**.
6. Paste **Bot Token** and **Chat ID**, then click **Send Test Message**.
7. Add the same values to your `.env` file:
	- `TELEGRAM_BOT_TOKEN="..."`
	- `TELEGRAM_CHAT_ID="..."`
8. Restart the dashboard (`start.bat`) so environment variables are reloaded.

---

## 10) Nightly Automation (Optional)

If enabled in installer:
- runs on weeknights (scheduled task)
- executes health checks and stop-related automation
- can send Telegram summary (if token/chat ID are configured)

If PC is off at schedule time, task may run late when machine resumes (depending on task scheduler behavior).

---

## 11) Troubleshooting

## Installer says unsupported Node version
- install Node.js 20 or 22 LTS
- re-run `install.bat`

## `npm install` fails
- close other terminals/apps using project files
- temporarily disable antivirus
- run installer as Administrator
- reboot and retry

## Port 3000 is busy
- close old dashboard windows/terminals
- re-run `start.bat` (it attempts to clear stale process)

## Dashboard opens but no data
- run full scan from Scan page
- verify internet connection
- verify heartbeat and health status

## Trading 212 sync fails
- re-check credentials in Settings
- confirm API access is active
- retry sync from positions page

## Trading 212 connection fails immediately / auth error
- Trading 212 uses Basic Auth with base64 encoding, not a bearer token
- verify your API key and secret are correct
- confirm you are using the right environment (Demo vs Live)

---

## 12) Update Procedure (When You Receive New Code)

1. Close running dashboard
2. Run `update.bat`
3. Run `start.bat`
4. Check dashboard health and heartbeat after launch

---

## 13) Quick Non-Technical Checklist

- Use `install.bat` once
- Use `start.bat` daily
- Keep terminal open while dashboard is running
- Check health + regime before trading
- Use Scan for candidates, Plan for timing, Risk for limits
- Move stops only upward (the app enforces this)
- Sync positions after trading activity
- Review nightly summaries/alerts regularly
- Run `npm run system:check` after any update

---

## 14) Operating Modes

The system has four operating modes (Settings → Account):

| Mode | What it does |
|------|-------------|
| **Normal** | Standard operation — scan, review, buy, manage |
| **Aggressive Quality** | Only A-grade candidates shown. Fewer but stronger trades. |
| **Capital Preservation** | No new trades. Manage exits and stops only. |
| **Research** | Read-only. Scan and review with no execution at all. |

Operating mode controls **behaviour** (what you can do). Risk profile controls **sizing** (how much you risk). They are independent — you can combine any profile with any mode.

---

## 15) Pre-Execution Safety (Dry Run)

Before any trade executes on Trading 212, the system runs 13 automatic checks:

1. Kill switch off
2. System health not RED
3. Account equity positive
4. Execution day valid (not Monday, not weekend)
5. Market regime BULLISH
6. Position size valid
7. Stop-loss below entry
8. T212 broker connected
9. Heartbeat recent
10. Market data fresh
11. Backup recent
12. No Fatal Weakness (FWS ≤ 65)
13. Operating mode allows buying

If any hard check fails, execution is blocked with a clear reason and recovery steps.

---

## 16) Profit Scoreboard (`/performance`)

View R-based trading performance:

- Win rate, expectancy per trade, profit factor
- Max and current drawdown
- Average and median hold time
- System grade (A through F)
- Sample-size warnings at 30/50/100 trade milestones

The system will not declare you profitable until you have enough closed trades to prove it.

---

## 17) Discipline Score (`/api/discipline`)

Tracks rule compliance:

- Score starts at 100
- Drops -5 per soft-block override
- Drops -15 per hard-block attempt
- Recovers +1 per compliant trade
- Displayed as GREEN (90+), AMBER (70-89), RED (<70)

---

## 18) System Safety Check

After any update or if something feels wrong, run:

```
npm run system:check
```

This runs 8 checks: TypeScript, sacred file tests, scoring, risk maths, execution safety, evidence analytics, full test suite, and production build.

- **✅ PASS — system safe to use** → you're good
- **❌ FAIL — do not trade until fixed** → something is broken

---

## 19) Automated Stop Pushing and Pyramid Adds

When `ENABLE_AUTO_TRADING=true` is set:

**Auto Stop Push (nightly Step 3g):**
- After the nightly updates stops in the database, it automatically pushes them to Trading 212
- Only changed stops are pushed (not all positions)
- Failures are logged and reported via Telegram

**Auto Pyramid Adds (nightly Step 6-auto):**
- When a position qualifies for a pyramid add, the system:
  1. Checks your T212 cash balance
  2. If sufficient funds → places a market buy order
  3. Updates the stop to cover the full position (original + added shares)
  4. Logs to execution audit and trade log
  5. Sends a Telegram alert
- Only executes Tuesday-Friday in BULLISH regime
- All existing safety gates apply

---

## 20) Where to Read More

- `SETUP-README.md` for concise installation help
- `DASHBOARD-GUIDE.md` for deep technical/feature reference

---

Built for systematic, rules-driven execution: consistent process over emotion.