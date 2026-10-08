"""
Read-only replay of HybridTurtle's real auto-trade buys: does entry timing explain
the losses?

For each auto-trade position, on Yahoo daily bars (the live listing, via
yahoo_daily.to_yahoo) and the live exit engine (shadow_sim.simulate, LIVE):
  * FILL  enter at the actual fill price on the entry day (as live), same 1R;
  * OPEN  enter at the next session's open instead, same 1R in price.
Both are marked after up to 40 sessions or at the latest close. Also reported:
the actual result, the fill's position in the day's range, its distance above
the trigger, and a split by auto-trade session (UK clock).

Descriptive operational review of real trades (mostly the reserved holdout
period); a hypothesis for a forward test, not grounds to change live rules.

Usage: python scripts/research/live_entry_replay.py [prisma/dev.db]
"""
import datetime as dt
import sqlite3
import statistics
import sys
from zoneinfo import ZoneInfo

from shadow_sim import fetch, simulate
from yahoo_daily import to_yahoo

DB = sys.argv[1] if len(sys.argv) > 1 else 'prisma/dev.db'
UK = ZoneInfo('Europe/London')
con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
con.execute('PRAGMA query_only = ON')
positions = con.execute("""
  select s.ticker, s.yahooTicker, p.entryDate, p.entryPrice, p.initialRisk, p.entryTrigger,
         coalesce(p.realisedPnlR, p.exitProfitR), p.status
  from Position p join Stock s on s.id = p.stockId
  where p.source = 'auto-trade' and p.initialRisk > 0 order by p.entryDate""").fetchall()


def session(uk_time):
    minutes = uk_time.hour * 60 + uk_time.minute
    if minutes >= 20 * 60 + 15:
        return 'us-close 20:30'
    if minutes >= 16 * 60 + 45:
        return 'us-mid 17:00'
    if minutes >= 14 * 60 + 30:
        return 'us 14:45'
    return 'uk'


rows, skipped = [], []
for ticker, override, entry_ms, fill, risk, trigger, actual, status in positions:
    entered = dt.datetime.fromtimestamp(entry_ms / 1000, dt.UTC)
    symbol = to_yahoo(ticker, override)
    try:
        bars = fetch(symbol, entered.date())
    except Exception as error:  # list it, never guess
        skipped.append(f'{ticker} ({symbol}): fetch failed, {type(error).__name__}')
        continue
    days = list(bars.index)
    if entered.date() not in days:
        skipped.append(f'{ticker}: no bar on the entry day')
        continue
    i = days.index(entered.date())
    day = bars.iloc[i]
    if not (day.low * 0.98 <= fill <= day.high * 1.02):
        skipped.append(f'{ticker} ({symbol}): fill {fill:.2f} outside the day range, listing mismatch')
        continue
    if i + 1 >= len(bars):
        skipped.append(f'{ticker}: no session after entry yet')
        continue
    horizon = min(40, len(bars) - i - 1)
    fill_r = simulate(bars, i, fill, risk, 'LIVE', horizon=horizon, intraday_entry=True)
    open_price = bars.open.iloc[i + 1]
    open_r = simulate(bars, i + 1, open_price, risk, 'LIVE', horizon=min(40, len(bars) - i - 2) or 1)
    if fill_r is None or open_r is None:
        skipped.append(f'{ticker}: window too short')
        continue
    rows.append({
        'ticker': ticker, 'session': session(entered.astimezone(UK)), 'actual': actual, 'status': status,
        'fill': fill_r, 'open': open_r, 'range': (fill - day.low) / (day.high - day.low) if day.high > day.low else None,
        'above': (fill - trigger) / risk if trigger else None,
    })
    print(f"{ticker:6} {entered.astimezone(UK):%m-%d %H:%M} {rows[-1]['session']:15} "
          f"actual {'open' if actual is None else f'{actual:+.2f}R':>7}  sim fill {fill_r:+.2f}R  "
          f"sim next open {open_r:+.2f}R  range {rows[-1]['range']:.2f}")


def mean(values):
    values = [v for v in values if v is not None]
    return f'{statistics.mean(values):+.2f}R (n={len(values)})' if values else 'n/a'


print(f"\nAll: actual {mean(r['actual'] for r in rows)}, sim fill {mean(r['fill'] for r in rows)}, "
      f"sim next open {mean(r['open'] for r in rows)}")
closed = [r for r in rows if r['actual'] is not None]
if closed:
    gaps = [abs(r['fill'] - r['actual']) for r in closed]
    print(f"Simulator fidelity on closed trades: median |sim fill - actual| {statistics.median(gaps):.2f}R")
for name in sorted({r['session'] for r in rows}):
    part = [r for r in rows if r['session'] == name]
    ranges = [r['range'] for r in part if r['range'] is not None]
    above = [r['above'] for r in part if r['above'] is not None]
    print(f"  {name:15} buys {len(part):2}  actual {mean(r['actual'] for r in part)}  "
          f"sim next open {mean(r['open'] for r in part)}  median range {statistics.median(ranges):.2f}  "
          f"mean above trigger {statistics.mean(above) if above else float('nan'):+.2f}R")
for line in skipped:
    print('Skipped:', line)
