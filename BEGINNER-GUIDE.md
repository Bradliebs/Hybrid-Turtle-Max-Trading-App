# HybridTurtle — Beginner's Guide

A plain-English guide to installing HybridTurtle and using it every day, whether you only want stock ideas or want it to trade for you.

> **Please read this first.** HybridTurtle is a tool, not financial advice. It follows fixed rules and can still lose money: losing trades are a normal part of trend following. Only trade money you can afford to lose. If you connect a broker, start with a **practice (Demo) account** before using real money.

---

## Contents

1. [What HybridTurtle does, in one minute](#1-what-hybridturtle-does-in-one-minute)
2. [Choose your path](#2-choose-your-path)
3. [Words you will see](#3-words-you-will-see)
4. [Install the app (everyone)](#4-install-the-app-everyone)
5. [First-time settings (everyone)](#5-first-time-settings-everyone)
6. [Reading the Dashboard](#6-reading-the-dashboard)
7. [Path A — Stock ideas only (no broker)](#7-path-a--stock-ideas-only-no-broker)
8. [Path B — Trading 212, you click Buy](#8-path-b--trading-212-you-click-buy)
9. [Path C — Trading 212, fully automatic](#9-path-c--trading-212-fully-automatic)
10. [How the app decides (the rules in plain English)](#10-how-the-app-decides-the-rules-in-plain-english)
11. [A simple weekly routine](#11-a-simple-weekly-routine)
12. [Troubleshooting and common questions](#12-troubleshooting-and-common-questions)
13. [Golden rules](#13-golden-rules)
14. [Where to go next](#14-where-to-go-next)

---

## 1. What HybridTurtle does, in one minute

HybridTurtle looks for shares and funds that are **already rising strongly** and flags the moment they **break out to a new high**. That approach is called *trend following*: buy strength, cut losers quickly with a stop, and let winners run.

In practice it does five jobs for you:

1. **Checks the market mood.** New buys are only allowed when the overall market is rising.
2. **Scans more than 1,000 shares and funds** for breakouts.
3. **Grades each idea.** Only the strongest become A-grade buys.
4. **Works out how much to buy**, so that one losing trade costs only a small, fixed slice of your account.
5. **Protects each trade with a stop**, and only ever moves that stop up as the price rises, never down.

It runs on your own Windows PC. Your data stays on your machine.

---

## 2. Choose your path

Everyone starts with the same install and settings (sections 4–6). Then follow the one path that fits you:

| Path | Who it is for | What the app does | What you do |
|---|---|---|---|
| **A — Stock ideas only** | You want picks but trade elsewhere, or not at all yet | Finds and grades ideas, suggests share numbers and stop prices | Buy and set stops at your own broker |
| **B — Trading 212, you click Buy** | You have a Trading 212 account and want to approve each trade | Everything in A, plus it places the buy and the stop on Trading 212 when you click | Review the idea and click **Execute on T212** |
| **C — Trading 212, fully automatic** | You want hands-off trading within strict rules | Everything in B, on a schedule, without you clicking | Keep your PC on, read the Telegram summaries, review weekly |

**Not sure?** Start with **Path A** for a couple of weeks to learn how the app thinks, then move to B, then C. Each step is easy to undo.

---

## 3. Words you will see

You don't need to memorise these; come back when a word is unfamiliar.

| Word | Plain meaning |
|---|---|
| **Regime** | The market's overall mood. **BULLISH** means rising; only then does the app allow new buys. **SIDEWAYS** or **BEARISH** means no new buys. |
| **Entry trigger** | The price the share must reach to count as a breakout, roughly its highest price of the last 20 days. |
| **Stop (stop-loss)** | The price at which you sell to cap a loss. The app sets it for you. |
| **R** | The amount you risked on a trade. If you risked £100 and made £200, that is **+2R**; if you lost your £100, that is **−1R**. |
| **A-grade** | The top grade: every rule passes, the scores are strong and the breakout has actually happened. The automatic buyer (Path C) only buys A-grade ideas. |
| **Triggered** | The price has reached its entry trigger. On the Scan page these appear under **TRIGGERED — READY TO BUY**. |
| **Scores (NCS, FWS, BQS)** | Three quality numbers for each idea, shown on the Scan page's **Scores** tab. Section 10.2 explains what good looks like. |
| **READY / WATCH / FAR** | How close the price is to its trigger: **READY** is within 2%, **WATCH** is within 2–3%, **FAR** is more than 3% below. |
| **WAIT_PULLBACK** | The price already ran too far past its trigger. Don't chase it; wait for it to settle. |
| **Sleeve** | A bucket for a holding: **CORE** (normal shares), **HIGH_RISK** (more volatile shares), **ETF** (funds), **HEDGE** (long-term defensive holdings). |
| **Risk profile** | How much of your account each trade risks, and how many trades you can hold at once. |

---

## 4. Install the app (everyone)

You need a **Windows 10 or 11** PC and an internet connection.

1. **Install Node.js.** Go to <https://nodejs.org>, choose the **LTS** version (20 or 22), and install it with the default options.
2. **Run the installer.** In the HybridTurtle folder, double-click **`install.bat`**. It installs everything, creates the database, loads the list of shares, and puts a **HybridTurtle Dashboard** shortcut on your Desktop. This takes a few minutes.
3. Near the end it may ask whether to set up a nightly Telegram task. Choose **No** for now; you can add it later (section 5).

**Start the app each day:** double-click the **HybridTurtle Dashboard** shortcut, or `start.bat`. Your browser opens at <http://localhost:3000/dashboard> once it's ready.

> **Keep the black window open** while you use the dashboard. Closing it stops the dashboard. (Scheduled automatic jobs in Path C run separately and don't need this window.)

**If something goes wrong:**

| Problem | What to do |
|---|---|
| "Node.js not found" or "unsupported version" | Install Node.js **20 or 22 LTS** from nodejs.org, then run `install.bat` again. |
| "Port 3000 already in use" | `start.bat` normally closes an old dashboard on port 3000 for you. If another program uses that port (or a Docker copy of the app is running), close it or restart your PC, then start again. |
| A warning box when the black window starts, mentioning `.env` | Your `.env` file still has example values. Follow the fix it prints. The next row covers the most common one. |
| **"Unauthorised"** or **"Too many requests"** when you click **Run Full Scan** or save settings | The app is asking for a login, which a single-user PC doesn't need. Open the `.env` file in the HybridTurtle folder with Notepad and make sure the **only** `DISABLE_API_AUTH` line reads `DISABLE_API_AUTH=true`. When saving, set "Save as type" to **All files** so Notepad doesn't create `.env.txt`. Delete any `.env.local` or `.env.production` files if you didn't create them on purpose. Then close the black window and start the app again. |
| Browser doesn't open | Wait a minute, then go to <http://localhost:3000/dashboard> yourself. |
| You got a newer version of the app | Double-click **`update.bat`**. |

> **Using Docker instead?** Docker suits Path A (stock ideas) and Path B with manual syncing. The scheduled jobs don't run in a container: no automatic Trading 212 sync, nightly stop updates or auto-trading. For Path C, use the Windows install above. Docker setup steps are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## 5. First-time settings (everyone)

Open **Settings** (last item in the top menu).

### 5.1 Account

1. **Account Equity:** enter the amount of money you are trading with, in pounds. If you connect Trading 212 later, this updates automatically.
2. **Risk Profile:** choose how cautious to be:

| Profile | Risk per trade | Max open trades | Max total risk | Good for |
|---|---:|---:|---:|---|
| **Conservative** | 0.75% | 8 | 7% | Cautious beginners, larger accounts |
| **Balanced** | 0.95% | 5 | 5.5% | Most people — **recommended starting point** |
| **Small Account** | 2% | 4 | 10% | Small accounts where tiny positions aren't practical |
| **Aggressive** | 3% | 3 | 12% | Experienced users only |

"Risk per trade" is what **one** losing trade should cost. On Balanced with £10,000, one normal loss is about £95.

3. Click **Save Account**.

### 5.2 Telegram alerts (optional, recommended for Paths B and C)

Telegram sends trade confirmations, daily summaries and warnings to your phone.

1. In the Telegram app, search for **@BotFather**, send `/newbot` and follow the prompts. It gives you a **Bot Token**.
2. Send any message to your new bot. Then search for **@userinfobot**, which replies with your **Chat ID**.
3. In **Settings → Notifications**, paste the **Bot Token** and **Chat ID**, click **Send Test Message**, and check that it arrives on your phone. Then click **Save**.

> If the boxes are greyed out and say **"Set via environment variable"**, your `.env` file already contains `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` lines, and those take priority. If they're example placeholders (`your-telegram-bot-token`), delete both lines from `.env` and restart the app. Then set Telegram up here.

### 5.3 Leave the rest alone for now

**Market Data** (Yahoo Finance is fine), **System** and **Model Layer** can stay on their defaults. **Safety Controls** is covered in Path C.

---

## 6. Reading the Dashboard

The **Dashboard** is your home screen.

**First visit:** a **Getting Started** checklist sits at the top. Click the arrow to see each step. It lists connecting Trading 212 as "required", but that only applies to Paths B and C. If you're following Path A (stock ideas only), click the **×** to dismiss it once your account settings are saved.

**Every visit:** start with the **action card** below it. It shows a coloured badge that tells you in one word what to do, then a one-line headline and a button.

| Badge | What it means | What to do |
|---|---|---|
| **CLEAR** | Nothing needs doing. | Nothing. Close the app. |
| **BUY** | There are ideas ready and buying is allowed. | Click **Go to Positions** and review them (Path B), or see Path A. |
| **WATCH** | The last scan is out of date. | Click **Run Scan**. |
| **PLAN** | It's a planning day. | Click **Run Scan** and look at the week's ideas. Don't buy yet. |
| **STOPS** | Stops should move up. | Click **Review Stops**. |
| **MANAGE** | You have open trades to keep an eye on. | Click **View Positions**. |
| **EXIT** | A trade isn't going anywhere and is flagged for review. | Click **View Positions** and decide whether to sell. |
| **BLOCKED** | Buying isn't allowed right now. The card shows the main reason, often the market regime. | Nothing. Being told "no" is the system protecting you. |
| **SYSTEM BLOCKED** | A safety switch is on. **Disable all submissions** blocks every order; **Disable automated submissions only** blocks automatic orders but still lets you click Buy yourself. | If you paused on purpose, nothing. Otherwise click **Go to Settings** and turn the switch off. |
| **PRESERVE** / **RESEARCH** | The app is in Capital Preservation mode (manage and exit only) or Research mode (look, no trading). | Manage existing trades. These modes were set on purpose. |

Click **System Details** at the bottom of the card for quick numbers: **Positions**, **Open Risk**, **Risk Budget**, **READY**, **Health**, **Scan Age**, **Auto-Trade** and **T212**. Anything shown in amber needs attention.

> **Tip:** The top menu has many pages. Beginners only need **Dashboard**, **Portfolio**, **Scan**, **Risk**, **Trade Log** and **Settings**. The **Analysis**, **Performance** and **System** menus are for later.

---

## 7. Path A — Stock ideas only (no broker)

You use HybridTurtle to find and size ideas, then trade at any broker you like (or just watch and learn).

### Every trading day (about 10 minutes)

1. **Open the app** and check the badge on the Dashboard's action card. If it says **BLOCKED** because of the market regime, there's nothing to buy today. That's normal.
2. **Go to Scan** and click **Run Full Scan**. It takes a few minutes.
3. **Look at the "TRIGGERED — READY TO BUY" section** first. These ideas have broken out. **READY** and **WATCH** ideas below it haven't yet: treat them as a watchlist.
4. **Check the scores.** Open the **Scores** tab and keep only ideas with **NCS 70 or more**, **FWS 30 or less** and **BQS 55 or more**. These are the same score limits the automatic buyer uses (section 10.2). Skip anything showing **WAIT_PULLBACK**: it has already run too far.
5. **Work out how many shares to buy.** For each idea you keep, note the **Entry** and **Stop** prices from the scan table. Type them into the **Position Sizing Calculator** on the Scan page. It gives you **Shares to Buy**, worked out from your account size and risk profile, so a loss at the stop costs only your chosen small slice.
6. **At your own broker**, buy that number of shares near the entry price, and **immediately place a stop-loss order** at the stop price.

### Managing your trades

HybridTurtle can't see or manage trades at other brokers, so you do this part yourself:

- **Never move a stop down.** Only raise it.
- Raise your stop as the trade grows, following the app's rule (section 10.4): to your **buy price** at +1.5R, to **buy price + 0.5R** at +2.5R, then trail it below the price from +3R.
- When a trade closes, record it in **Trade Log → Record Past Trade**. Over time, the Trade Log shows your win rate and average R.

> **Why doesn't my trade appear in Portfolio?** Portfolio shows positions synced from Trading 212 or bought through the app. Trades placed at another broker are logged in the Trade Log once they close.

---

## 8. Path B — Trading 212, you click Buy

The app places the order and the protective stop on Trading 212 for you, but only when you click.

### 8.1 Get your Trading 212 API key

1. Log in to Trading 212 (app or website) and switch to the account you want to use. We strongly recommend starting with the **Practice (Demo)** account.
2. Open **Settings → API** and create a new key. You get an **API key** and an **API secret**. Copy both somewhere safe; the secret may only be shown once.
3. Trading 212 supports API access for **Invest** and **Stocks ISA** accounts. Each account has its own key.

> Trading 212 occasionally renames menus. If you can't find **API** in Settings, search their help centre for "API key".

### 8.2 Connect it

1. In HybridTurtle, go to **Settings → Broker**.
2. Set **Environment** to **Demo** (practice money) or **Live** (real money). **Start with Demo.**
3. Paste the **API Key** (and **API Secret**, if Trading 212 gave you one) for your Invest account and click **Connect & Test**. For an ISA, use the **ISA API Key** and **ISA API Secret** boxes and their own **Connect & Test** button.
4. Click **Sync All Connected Accounts**. Your positions, cash and account value load in. The **T212** status on the Dashboard turns green, and your **Account Equity** updates automatically.

### 8.3 Keep your stops moving automatically (recommended)

Once a day, the app can raise your stops, check your holdings and send a summary. To switch this on:

1. Double-click **`register-all-tasks.bat`** in the HybridTurtle folder and click **Yes** when Windows asks for permission.
2. It sets up the app's scheduled jobs (nightly stop updates, a midday broker check, a watchdog and Telegram briefings). Your PC needs to be **on and awake** at those times.

This also installs the automatic-trading jobs used in Path C, but they **do nothing** until you switch on **Enable auto-trading**. So running it is safe.

### 8.4 Buying

1. When the Dashboard's action card says **BUY**, click **Go to Positions**.
2. The **Ready to Buy** panel lists ideas whose price has reached its trigger, best scores first, with suggested shares, value, risk and stop. Prefer ideas that meet the score limits in section 10.2.
   - A **Buy** button means you can go ahead (weekdays).
   - **Blocked** means a rule is saying no, or it's the weekend. Hover over it to see why.
3. Click **Buy**, read the confirmation screen, then choose:
   - **Execute on T212**: places the buy **and** the protective stop on Trading 212.
   - **Record Only (manual buy)**: records a trade you placed yourself in the Trading 212 app.
   - **Cancel**.
4. Check the Trading 212 app afterwards: you should see the new holding **and** a stop order.

> If you see "Snapshot data is stale — run a fresh scan from the Plan page before buying", run a new scan first. The app won't let you buy on old prices.

### 8.5 Managing trades

- Check the Dashboard's action card each day. **STOPS** means stops are due to move up: click **Review Stops**.
- **Portfolio** shows each trade's price, stop, **R** and profit or loss.
- Don't move stops down in the Trading 212 app. The app will only ever raise them.

---

## 9. Path C — Trading 212, fully automatic

The app scans and buys on a schedule, sets a stop on every buy, and sends you a Telegram summary after each session. You don't need to click anything.

### 9.1 Before you switch it on

Tick all of these first:

- [ ] You've used **Path B** for a while and understand what the app buys and why.
- [ ] Trading 212 is connected (section 8.2). **Demo** is recommended for your first weeks.
- [ ] **Telegram** is set up (section 5.2). Without it, you won't know what happened.
- [ ] You've run **`register-all-tasks.bat`** (section 8.3).
- [ ] Your PC is **on and not asleep** on weekdays from about 08:00 to 21:30 UK time. In Windows Power settings, set sleep to **Never** when plugged in.

### 9.2 Switch it on

1. Go to **Settings → Safety Controls**.
2. Turn on **Enable auto-trading**.
3. **Optional:** turn on **ETF-only auto-trading** to buy only funds (ETFs), not individual shares. Shares are still scanned and graded; skipped shares show as "ETF-only mode" in the Telegram summary. Expect far fewer buys: there are about 58 ETFs against more than 1,000 shares, and only 9 trade in London, so the UK sessions rarely find one. ETFs aren't automatically safer, either: the list includes **leveraged and inverse** funds (such as SQQQ and SPXS) that move 3× the market or against it.

### 9.3 When it runs (UK time, Monday–Friday)

| Time | What happens |
|---|---|
| 08:20 | UK/EU morning session: may buy London-listed ideas |
| 10:30 | UK/EU mid-morning session |
| 14:45 | US session at the US market open |
| 17:00 | US midday session |
| 20:00 | Evening scan only; never buys |
| 20:30 | US near-close session |
| Hourly, 08:02–21:02 | Telegram status update |

Each session buys **at most 2** new positions.

### 9.4 What it checks before every buy

The app only buys when **all** of these are true. If any fails, it skips, and the Telegram summary says why:

1. Auto-trading is switched on and no safety switch is blocking it.
2. It's a weekday and not a market holiday.
3. Trading 212 is connected and your account value is above zero.
4. The market regime is **BULLISH**.
5. The system health check isn't **RED**.
6. The idea is **A-grade** and the price has actually reached its trigger.
7. A fresh live price, checked seconds before buying, still confirms the breakout and isn't too far past it.
8. Company earnings results in the next few days are **flagged** in a Telegram warning. They only block the buy if earnings deferral has been configured (`EARNINGS_DEFERRAL_DAYS` in `.env`).
9. Your risk profile's limits aren't exceeded: number of trades, total risk and concentration.
10. **Optional:** the **Jev** AI reviewer doesn't veto it (see below).
11. The session hasn't already used its 2 buys.

> **About Jev.** Jev is an optional AI reviewer that double-checks each A-grade buy just before it's placed. It can **block** a buy, but it can **never add** one or change sizes or stops. If Jev is unavailable, the normal rules decide. **Honest status:** so far Jev has agreed with every buy it was shown, so treat it as a sanity check, not a second opinion. It only runs if it has been configured.

### 9.5 Pausing or stopping

| You want to… | Do this |
|---|---|
| Stop new automatic buys | Turn off **Enable auto-trading** |
| Stop every order, including your own clicks | Turn on **Disable all submissions** |
| Block automatic orders but keep your manual buttons | Turn on **Disable automated submissions only** |

Your existing positions and their stops on Trading 212 stay in place when you pause.

### 9.6 Your weekly check (15 minutes)

- Read the Sunday **weekly digest** on Telegram.
- In **Trade Log**, look at your win rate and average R. A win rate around 30–45% is normal for trend following; profits come from the few big winners.
- If you see many losing trades in a row, pause (section 9.5) and review rather than changing settings in a hurry.

---

## 10. How the app decides (the rules in plain English)

Knowing these rules explains nearly every "why didn't it buy?" question.

### 10.1 Market regime

The app compares two broad markets, the S&P 500 (**SPY**) and a global fund (**VWRL**), with their average price over the last 200 days:

- Both more than 2% above their average → **BULLISH**: new buys allowed.
- Either more than 2% below → **BEARISH**: no new buys.
- Anything in between → **SIDEWAYS**: no new buys.

The mood must hold for **3 days in a row** to count, so one jumpy day doesn't flip it.

### 10.2 What makes a good idea

A share only gets considered if it's in a clear uptrend:

- its price is above its 200-day average,
- the trend is strong and pointing up,
- it isn't wildly volatile,
- it's close to breaking above its recent high.

It then gets three scores (see the **Scores** tab on the Scan page). The automatic buyer needs all three:

| Score | Meaning | Needs |
|---|---|---|
| **BQS** — Breakout Quality | How strong and clean the setup is | 55 or more |
| **FWS** — Fatal Weakness | Warning signs (lower is better) | 30 or less |
| **NCS** — Net Composite | The overall score | 70 or more |

It also needs decent trading volume and must be doing at least as well as the market (S&P 500) over the last month. Two more things keep an idea out of the A-grade: company results (earnings) due within 5 days, and scores that are more than 36 hours old, for example after a missed nightly run.

### 10.3 How much to buy

> **Shares = (your account × risk per trade) ÷ (buy price − stop price)**

*Example:* £10,000 account on **Balanced** (0.95%) → £95 at risk. The buy price is £50 and the stop is £47, so each share risks £3. £95 ÷ £3 ≈ **31 shares** (about £1,550 of shares). If the stop is hit, you lose about £95, not £1,550.

### 10.4 How stops move

Stops **only ever go up**. As a trade gains, the stop climbs:

| Trade gain | Stop moves to |
|---|---|
| Below +1.5R | The original stop |
| +1.5R | Your buy price (break-even: a losing trade can't lose any more) |
| +2.5R | Buy price + 0.5R (some profit locked in) |
| +3R and up | At least buy price + 1R, then trailing below the price as it rises |

**Failed breakouts are sold early.** If an automatic buy falls back below its
breakout price within 5 days (and is up less than half its risk), the app sells
it at the start of the next trading session instead of waiting for the stop.
The evening check spots these, and the sale happens the next morning (UK
shares) or just after the US open (US shares). You get a Telegram message
either way. This rule was tested on months of history the app hadn't seen
before, and it cut losses. It only applies to the app's own buys, never to
shares you bought yourself.

### 10.5 Spreading risk

To stop one bad week hurting too much, the app also limits:

- how many trades you hold (from your risk profile),
- your total risk across all open trades,
- how much of your account sits in one bucket, one industry, or one group of similar shares.

---

## 11. A simple weekly routine

| Day | What to do |
|---|---|
| **Sunday: plan** | Open the app. Run a scan and look at the triggered and READY ideas for the week. Read the weekly digest if you use Telegram. |
| **Monday–Friday: act** | Check the Dashboard's action card. Buy only triggered, well-scored ideas when it says **BUY**, and review stops when it says **STOPS**. (Path C does this for you.) |
| **Saturday: maintain** | Record any closed trades (Path A). Glance at **Trade Log** and **Risk**. No trading. |

---

## 12. Troubleshooting and common questions

**"Nothing was bought today. Is it broken?"**
Probably not. Most days have no breakouts that pass every rule, and many days the market isn't **BULLISH**. Check the Dashboard's action card or the Telegram summary for the reason. A quiet system is often a safe system.

**The action card says SYSTEM BLOCKED.**
A safety switch is on in **Settings → Safety Controls**. **Disable all submissions** stops every order; **Disable automated submissions only** stops automatic orders but leaves your own Buy buttons working. If you didn't turn it on deliberately, turn it off there. The card also lists any health problems; open **Risk** and **Alerts** to see them.

**The Buy button says Blocked.**
A rule is saying no, such as too many open trades, too much risk, or a stale scan. Hover over it for the reason. The fix is usually to wait, not to change your risk profile.

**Trading 212 won't connect.**
Check that you copied both the key and the secret with no spaces, and that **Environment** matches the account (**Demo** key with Demo, **Live** key with Live). ISA and Invest need separate keys.

**Automatic trading didn't run.**
Is your PC on and awake at the session times? Is **Enable auto-trading** on? Did you run `register-all-tasks.bat`? The Dashboard's **Auto-Trade** status shows whether it's active.

**Stock prices look old.**
Run a fresh scan. If the **Scan Age** figure stays old, restart the app with the Desktop shortcut.

**Can I change the rules?**
The core safety rules are fixed on purpose. Your main choice is the **risk profile**. Changing it after a losing streak is exactly what the rules are there to prevent.

**Is my data private?**
Yes. The app runs on your PC. It only talks to price and news data providers, to Trading 212 if connected, and to Telegram and the Jev reviewer if you switch them on.

---

## 13. Golden rules

1. **Start in Demo.** Use Trading 212's practice account until you trust the process.
2. **Only buy ideas that have triggered and score well.** READY, WATCH and FAR ideas are a watchlist, not a buy signal.
3. **Every trade gets a stop.** No exceptions.
4. **Never move a stop down.**
5. **Don't chase.** If an idea says **WAIT_PULLBACK**, wait.
6. **Losses are normal.** Judge the system over 30+ trades, not three.
7. **When in doubt, do nothing.** "No trade" is always an allowed choice.

---

## 14. Where to go next

- **[DASHBOARD-GUIDE.md](DASHBOARD-GUIDE.md)**: every screen and button in detail.
- **[USER-GUIDE.md](USER-GUIDE.md)**: the complete operator guide.
- **[TRADING-LOGIC.md](TRADING-LOGIC.md)**: the full trading rules, with formulas.
- **[README.md](README.md)**: technical setup and developer notes.
