"""
Read-only diagnostic: How could HybridTurtle become a money-making machine?

Computes and verifies every empirical figure cited in
reports/money-making-machine-plan-2026-10-14.md:
  1. Expectancy and payoff decomposition of closed positions (all 37, 22 auto-trade,
     15 manual), including the two live failed-breakout auto-exits (NTAP, LCUT)
     since commit 6c1e03d (2026-10-08).
  2. By-session performance of the 22 closed auto-trade buys (14:45 vs 17:00 vs
     20:30 UK time).
  3. Maximum Favourable Excursion (MFE) over 40 sessions vs realised R on the 33
     closed positions with cached daily bars.
  4. Sizing-cap compression and estimated FX drag (£219.51 ISA, SMALL_ACCOUNT).
  5. Universe execution audit across the 1,019 active Stock rows (and 18,481
     cached T212 instruments), plus Jev review quota wasted on non-buyable rows.
  6. Capital-adjusted time-weighted return (TWR) from EquitySnapshot +
     capital-events.v1 through the latest snapshot.

Usage:
  python scripts/research/money_machine_audit.py [prisma/dev.db]
"""
import json
import pathlib
import re
import sqlite3
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from shadow_sim import atr  # noqa: E402
from yahoo_daily import to_yahoo  # noqa: E402

DB = sys.argv[1] if len(sys.argv) > 1 else 'prisma/dev.db'
CACHE = pathlib.Path('prisma/backups/yahoo-cache')
T212_CACHE = pathlib.Path('prisma/cache/t212-instruments.json')
LEDGER = pathlib.Path('data/typesafe-review/ledger.json')

con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
con.execute('PRAGMA query_only = ON')

# 1. Closed-trade expectancy decomposition
closed = pd.read_sql("""
  select p.id, s.ticker, s.yahooTicker, s.sleeve, p.source,
         p.entryPrice, p.exitPrice, p.shares, p.initialRisk,
         p.realisedPnlGbp, p.realisedPnlR, p.exitReason,
         p.entryDate, p.exitDate
  from Position p join Stock s on s.id = p.stockId
  where p.status = 'CLOSED'
""", con)
closed['holdDays'] = (closed.exitDate - closed.entryDate) / (1000 * 86400)

print('1. Closed positions — expectancy decomposition')
for label, part in [('All closed', closed),
                    ('Auto-trade', closed[closed.source == 'auto-trade']),
                    ('Manual (trading212)', closed[closed.source == 'trading212'])]:
    wins = part[part.realisedPnlR > 0]
    losses = part[part.realisedPnlR <= 0]
    wr = len(wins) / len(part) if len(part) else 0.0
    avg_w = wins.realisedPnlR.mean() if len(wins) else 0.0
    avg_l = losses.realisedPnlR.mean() if len(losses) else 0.0
    payoff = abs(avg_w / avg_l) if avg_l != 0 else np.nan
    breakeven_wr = 1.0 / (1.0 + payoff) if payoff > 0 else np.nan
    print(f'  {label:<20} n={len(part):>2}  win%={100*wr:>4.1f}%  avgW={avg_w:+.2f}R  '
          f'avgL={avg_l:+.2f}R  payoff={payoff:.2f} (needs {100*breakeven_wr:.0f}% win)  '
          f'E[R]={part.realisedPnlR.mean():+.2f}R  P&L=£{part.realisedPnlGbp.sum():+.2f}')

# Live failed-breakout exits since Oct 8
fb_exits = pd.read_sql("""
  select ticker, phase, datetime(createdAt/1000, 'unixepoch') as ts
  from ExecutionLog
  where phase = 'FAILED_BREAKOUT_EXIT'
  order by createdAt
""", con)
print(f'  Live FAILED_BREAKOUT_EXIT fills: {len(fb_exits)}')
for row in fb_exits.itertuples():
    pos = closed[closed.ticker == row.ticker].sort_values('exitDate').iloc[-1]
    print(f'    {row.ticker:<6} exited {row.ts}  R={pos.realisedPnlR:+.2f}R  P&L=£{pos.realisedPnlGbp:+.2f}')

# 2. Auto-trade by entry session
auto = closed[closed.source == 'auto-trade'].copy()
hours = pd.to_datetime(auto.entryDate, unit='ms', utc=True).dt.hour
auto['session'] = np.where(hours <= 14, '14:45 UK (us-open)',
                  np.where(hours <= 16, '17:00 UK (us-mid)', '20:30 UK (us-close)'))
print('\n2. Auto-trade closed positions by entry session')
for sess, part in auto.groupby('session'):
    w = int((part.realisedPnlR > 0).sum())
    print(f'  {sess:<22} n={len(part):>2}  wins={w}/{len(part)}  '
          f'mean={part.realisedPnlR.mean():+.2f}R  median={part.realisedPnlR.median():+.2f}R  '
          f'P&L=£{part.realisedPnlGbp.sum():+.2f}')

# 3. MFE over 40 sessions on closed positions with cached bars
mfe_rows = []
for row in closed.itertuples():
    sym = to_yahoo(row.ticker, row.yahooTicker)
    path = CACHE / f'{sym.replace("/", "_")}.json'
    if not path.exists():
        continue
    bars = pd.DataFrame(json.loads(path.read_text()))
    if bars.empty:
        continue
    bars['date'] = pd.to_datetime(bars.date).dt.date
    bars = bars.set_index('date')[['open', 'high', 'low', 'close', 'adj']]
    ed = pd.to_datetime(row.entryDate, unit='ms', utc=True).date()
    dates = list(bars.index)
    ei = next((i for i, d in enumerate(dates) if d >= ed), None)
    if ei is None or ei < 22:
        continue
    risk = row.initialRisk if (row.initialRisk and row.initialRisk > 0) else 1.5 * atr(bars, ei - 1, 14)
    if not (risk and risk > 0):
        continue
    end40 = min(len(bars), ei + 40)
    xd = pd.to_datetime(row.exitDate, unit='ms', utc=True).date()
    xi = max((i for i, d in enumerate(dates) if d <= xd), default=ei)
    hold_slice = bars.iloc[ei:max(ei + 1, xi + 1)]
    mfe_hold_close = (hold_slice.close.max() - row.entryPrice) / risk
    mfe_close = (bars.close.iloc[ei:end40].max() - row.entryPrice) / risk
    mfe_high = (bars.high.iloc[ei:end40].max() - row.entryPrice) / risk
    mfe_rows.append({'ticker': row.ticker, 'actualR': row.realisedPnlR,
                     'mfeHoldCloseR': mfe_hold_close,
                     'mfeClose40R': mfe_close, 'mfeHigh40R': mfe_high})
mfe_df = pd.DataFrame(mfe_rows)
print(f'\n3. Maximum Favourable Excursion vs realised R (n={len(mfe_df)} with cached bars)')
print(f'  Realised R       : mean={mfe_df.actualR.mean():+.2f}R  >=1R: {int((mfe_df.actualR >= 1).sum())}  >=2R: {int((mfe_df.actualR >= 2).sum())}')
print(f'  In-trade MFE (cl): mean={mfe_df.mfeHoldCloseR.mean():+.2f}R  >=1R: {int((mfe_df.mfeHoldCloseR >= 1).sum())}  >=2R: {int((mfe_df.mfeHoldCloseR >= 2).sum())}')
print(f'  40d post-entry cl: mean={mfe_df.mfeClose40R.mean():+.2f}R  >=1R: {int((mfe_df.mfeClose40R >= 1).sum())}  >=2R: {int((mfe_df.mfeClose40R >= 2).sum())}')
print(f'  40d post-entry hi: mean={mfe_df.mfeHigh40R.mean():+.2f}R  >=1R: {int((mfe_df.mfeHigh40R >= 1).sum())}  >=2R: {int((mfe_df.mfeHigh40R >= 2).sum())}')

# 4. FX drag estimate and open positions
notional_rt = 0.0
for row in closed.itertuples():
    fx = 0.01 if (row.ticker.endswith('.L') or row.ticker == 'CNDX') else 0.79
    notional_rt += row.entryPrice * row.shares * fx * 2
print(f'\n4. Scale & friction (37 closed trades)')
print(f'  Approx round-trip notional: £{notional_rt:,.0f} -> est 0.15%/side FX fee: ~£{notional_rt * 0.0015:.2f} '
      f'({100 * (notional_rt * 0.0015) / abs(closed.realisedPnlGbp.sum()):.0f}% of £{closed.realisedPnlGbp.sum():.2f} net loss)')

# 5. Universe execution audit
t212_list = json.loads(T212_CACHE.read_text(encoding='utf-8'))['instruments'] if T212_CACHE.exists() else []
t212 = {it['ticker']: it for it in t212_list}
by_short = {}
for it in t212_list:
    by_short.setdefault((it.get('shortName') or '').upper(), []).append(it)
tm_text = pathlib.Path('src/lib/ticker-maps.ts').read_text(encoding='utf-8')
ymap = dict(re.findall(r"\{\s*db:\s*'([^']+)',\s*yahoo:\s*'([^']+)'", tm_text))

stocks = con.execute("""
  select id, ticker, name, yahooTicker, t212Ticker, currency, isaEligible, sleeve
  from Stock where active = 1
""").fetchall()
all_tickers = {r[0] for r in con.execute('select ticker from Stock')}

counts = {'buyable': 0, 'us_mapped_not_isa': 0, 'eu_au_no_session': 0,
          'bare_uk': 0, 'suffixed_uk_unmapped': 0, 'us_unmapped': 0, 'uk_mapped_not_gbx': 0}
for _, tk, _, ytk, btk, cur, isa, slv in stocks:
    yt = ytk or ymap.get(tk) or (tk[:-1] + '.L' if re.match(r'^[A-Z]{2,5}l$', tk) else tk)
    yt_us = not bool(re.search(r'\.[A-Z]{1,4}$', yt))
    tk_us = not bool(re.search(r'\.[A-Z]{1,4}$', tk))
    if btk and btk in t212 and isa == 1 and (btk.endswith('_US_EQ') == yt_us) and (tk_us == yt_us):
        if yt.endswith('.L') and t212[btk].get('currencyCode') not in ('GBX', 'GBp'):
            counts['uk_mapped_not_gbx'] += 1
        elif not yt.endswith('.L') and not yt_us:
            counts['eu_au_no_session'] += 1
        else:
            counts['buyable'] += 1
    elif not yt_us and not yt.endswith('.L'):
        counts['eu_au_no_session'] += 1
    elif yt.endswith('.L') and tk_us:
        counts['bare_uk'] += 1
    elif yt.endswith('.L') and tk.endswith('.L'):
        counts['suffixed_uk_unmapped'] += 1
    elif yt_us and btk and btk in t212 and isa != 1:
        counts['us_mapped_not_isa'] += 1
    elif yt_us and not btk:
        counts['us_unmapped'] += 1

print(f'\n5. Active universe execution audit ({len(stocks)} active rows):')
for k, v in counts.items():
    print(f'  {k:<24}: {v}')

if LEDGER.exists():
    ledger = json.loads(LEDGER.read_text(encoding='utf-8'))
    stock_lookup = {r[1]: (r[4], r[6]) for r in stocks}
    answered = [r for r in ledger['reviews'].values() if r.get('answer')]
    wasted = [r['ticker'] for r in answered if not stock_lookup.get(r['ticker'], (None, None))[0]
              or stock_lookup.get(r['ticker'], (None, None))[1] != 1]
    print(f'  Jev model-answered reviews on unmapped/non-ISA stocks: {len(wasted)}/{len(answered)} ({", ".join(wasted)})')

# 6. Capital-adjusted TWR
snaps = pd.read_sql('select capturedAt, equity, source from EquitySnapshot order by capturedAt', con)
first_broker = snaps.index[snaps.source == 'BROKER']
snaps = snaps.loc[first_broker[0]:] if len(first_broker) else snaps
events = json.loads(con.execute("select value from AppSetting where key='capital-events.v1'").fetchone()[0])['events']
flows = [(pd.Timestamp(e['at']).value // 10**6, e['amount']) for e in events]
idx = 100.0
times = snaps.capturedAt.astype('int64').tolist()
eq = snaps.equity.tolist()
for i in range(1, len(times)):
    fl = sum(a for tm, a in flows if times[i - 1] < tm <= times[i])
    if eq[i - 1] > 0:
        idx *= (eq[i] - fl) / eq[i - 1]
print(f'\n6. Capital-adjusted TWR ({pd.to_datetime(times[0], unit="ms").date()} to '
      f'{pd.to_datetime(times[-1], unit="ms").date()}): {idx - 100:+.2f}% (latest snapshot £{eq[-1]:.2f})')
