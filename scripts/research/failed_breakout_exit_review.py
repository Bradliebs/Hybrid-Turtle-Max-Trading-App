"""
Read-only review: would acting on the breakout-failure flag have helped the real trades?

The nightly job flags a position when, within 5 days of entry, the price closes
back below its entry trigger with less than +0.5R open profit
(src/lib/breakout-failure-detector.ts). Today that is an alert only. For every
closed position that was flagged, this compares the actual result with selling
at the next session's open after the flag date.

Descriptive operational review of real trades, not a tuning tool: the flagged
trades are a subset chosen by the rule itself, most are from the reserved
holdout period, and the pre-registered forward test of the same rule is the
FAILX variant in prospective_shadow_tests.py.

Usage (needs network access to Yahoo daily bars; no account access):
  python scripts/research/failed_breakout_exit_review.py [prisma/dev.db]
"""
import datetime as dt
import sqlite3
import statistics
import sys
from zoneinfo import ZoneInfo

from yahoo_daily import fetch_daily, to_yahoo

# Regular close by listing, so a flag only counts when it was recorded after that
# day's close (as the scheduled nightly run does); intraday manual runs are skipped.
CLOSES = {'': ('America/New_York', 16, 0), '.L': ('Europe/London', 16, 30), '.AS': ('Europe/Amsterdam', 17, 30),
          '.DE': ('Europe/Berlin', 17, 30), '.PA': ('Europe/Paris', 17, 30)}


def after_close(symbol, moment):
    suffix = '' if '.' not in symbol else symbol[symbol.rindex('.'):]
    if suffix not in CLOSES:
        return None
    zone, hour, minute = CLOSES[suffix]
    local = moment.astimezone(ZoneInfo(zone))
    return local.weekday() >= 5 or (local.hour, local.minute) >= (hour, minute)

DB = sys.argv[1] if len(sys.argv) > 1 else 'prisma/dev.db'
con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
con.execute('PRAGMA query_only = ON')
rows = con.execute("""
  select s.ticker, s.yahooTicker, p.source, p.breakoutFailureDetectedAt, p.exitDate, p.entryPrice, p.initialRisk,
         p.entryTrigger, coalesce(p.realisedPnlR, p.exitProfitR)
  from Position p join Stock s on s.id = p.stockId
  where p.breakoutFailureDetectedAt is not null and p.status = 'CLOSED'
    and coalesce(p.realisedPnlR, p.exitProfitR) is not null
  order by p.breakoutFailureDetectedAt""").fetchall()

results, skipped = [], []
for ticker, override, source, flagged_ms, exit_ms, entry, risk, trigger, actual in rows:
    flagged_at = dt.datetime.fromtimestamp(flagged_ms / 1000, dt.UTC)
    symbol = to_yahoo(ticker, override)
    if exit_ms is not None and flagged_ms >= exit_ms:
        skipped.append(f'{ticker}: flagged after it had already exited')
        continue
    timing = after_close(symbol, flagged_at)
    if timing is None:
        skipped.append(f'{ticker} ({symbol}): exchange close time unknown')
        continue
    if not timing:
        skipped.append(f'{ticker}: flag recorded during the session ({flagged_at:%Y-%m-%d %H:%M} UTC), not by a close-based run')
        continue
    try:
        bars = fetch_daily(symbol, flagged_at.date(), lookback_days=10)
    except Exception as error:  # list it, never guess
        skipped.append(f'{ticker} ({symbol}): fetch failed, {type(error).__name__}')
        continue
    after = [bar for bar in bars if bar['date'] > flagged_at.date()]
    if not after or not risk:
        skipped.append(f'{ticker}: no bar after the flag')
        continue
    exit_r = (after[0]['open'] - entry) / risk
    rule = 'trigger' if trigger else 'fill price'
    results.append((ticker, source, rule, exit_r, actual))
    print(f'{ticker:9} {source:10} rule: below {rule:10} flagged {flagged_at:%Y-%m-%d}  sell next open {exit_r:+.2f}R  '
          f'actual {actual:+.2f}R  difference {exit_r - actual:+.2f}R')


def summary(label, part):
    diffs = [r[3] - r[4] for r in part]
    print(f'{label}: n={len(part)}  mean actual {statistics.mean(r[4] for r in part):+.2f}R  '
          f'mean sell-on-flag {statistics.mean(r[3] for r in part):+.2f}R  mean difference {statistics.mean(diffs):+.2f}R  '
          f'better in {sum(d > 0 for d in diffs)}/{len(diffs)}')


if results:
    print()
    summary('All usable flags', results)
    faithful = [r for r in results if r[2] == 'trigger']
    if faithful:
        summary('Faithful to the live rule (entry trigger known; auto-trade)', faithful)
    total = con.execute("select count(*) from Position where status = 'CLOSED' "
                        "and coalesce(realisedPnlR, exitProfitR) is not null").fetchone()[0]
    usable_total = total - len(skipped)
    print(f'Spread over the {usable_total} closed trades not skipped: '
          f'{sum(r[3] - r[4] for r in results) / usable_total:+.2f}R per trade (unflagged trades unchanged).')
    print('Fills are assumed at the official open; real gap fills can be worse (SCHW filled 0.77R below its stop).')
for line in skipped:
    print('Skipped:', line)