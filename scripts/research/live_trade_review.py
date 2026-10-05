"""
Read-only review of HybridTurtle's realised trades (Position table).

Question: how do live exits behave? Reports expectancy (with a 95% bootstrap
interval), win rate, payoff ratio and holding time; outcomes by the best close the
trade reached (did the entry ever work?); fills versus the recorded stop (gap
slippage); and a descriptive post-exit check: where the price was 20 sessions after
the exit, in R units.

The protection level at exit is a path label, not a cause: LOCK_1R_TRAIL means the
trade had already reached +3R, so comparing outcomes by exit level selects on the
outcome. Operational review of real trades; no rule is tuned from it.

Not a backtest and not a tuning tool. The post-exit check only uses trades whose
20-session post-exit window ends before the 2026-08-03 reserved holdout
(reports/candidate-outcome-readiness-2026-09-10.md); it does not simulate any
alternative stop, which would also change the losing trades.

Usage (requires pandas and numpy):
  python scripts/research/live_trade_review.py [prisma/dev.db]
"""
import datetime as dt
import sqlite3
import sys

import numpy as np
import pandas as pd

DB = sys.argv[1] if len(sys.argv) > 1 else 'prisma/dev.db'
HOLDOUT_MS = int(dt.datetime(2026, 8, 3, tzinfo=dt.UTC).timestamp() * 1000)

con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
con.execute('PRAGMA query_only = ON')
trades = pd.read_sql("""
  select s.ticker, p.source, p.entryDate, p.exitDate, p.entryPrice, p.exitPrice, p.initialRisk,
         p.protectionLevel, p.currentStop, coalesce(p.realisedPnlR, p.exitProfitR) as R
  from Position p join Stock s on s.id = p.stockId
  where p.status = 'CLOSED' and coalesce(p.realisedPnlR, p.exitProfitR) is not null""", con)

def to_time(column):
    numeric = pd.to_numeric(column, errors='coerce')
    return pd.to_datetime(numeric, unit='ms', utc=True).fillna(pd.to_datetime(column, utc=True, errors='coerce'))

trades['entry'] = to_time(trades.entryDate)
trades['exit'] = to_time(trades.exitDate)
trades['days'] = (trades.exit - trades.entry).dt.days

def bootstrap_mean(values, seed=20261005, draws=5000):
    rng = np.random.default_rng(seed)
    samples = [rng.choice(values, len(values), replace=True).mean() for _ in range(draws)]
    return np.percentile(samples, [2.5, 97.5])

def summary(name, frame):
    wins, losses = frame[frame.R > 0].R, frame[frame.R <= 0].R
    payoff = wins.mean() / -losses.mean() if len(wins) and len(losses) and losses.mean() < 0 else float('nan')
    print(f'{name:<24} n={len(frame):>3}  expectancy={frame.R.mean():+.2f}R  win={100 * len(wins) / len(frame):.0f}%  '
          f'avg win={wins.mean():+.2f}R  avg loss={losses.mean():+.2f}R  payoff={payoff:.2f}  '
          f'best={frame.R.max():+.2f}R  median hold={frame.days.median():.0f}d')

print(f'Closed trades with a realised R: {len(trades)} ({trades.entry.min():%Y-%m-%d}..{trades.exit.max():%Y-%m-%d})')
summary('All', trades)
low, high = bootstrap_mean(trades.R.to_numpy())
print(f'{"":<24} expectancy 95% bootstrap interval [{low:+.2f}R, {high:+.2f}R]')
for source, frame in trades.groupby('source'):
    summary(f'source={source}', frame)
    low, high = bootstrap_mean(frame.R.to_numpy())
    print(f'{"":<24} expectancy 95% bootstrap interval [{low:+.2f}R, {high:+.2f}R]')
print(f'Exited within 3 days: {int((trades.days <= 3).sum())}, mean {trades[trades.days <= 3].R.mean():+.2f}R')

instruments = dict(con.execute('select symbol, id from Instrument').fetchall())

def daily(ticker, before_ms=None):
    instrument = instruments.get(ticker)
    if instrument is None:
        return None
    sql, params = 'select date, high, close from DailyBar where instrumentId = ?', [instrument]
    if before_ms is not None:
        sql, params = sql + ' and date < ?', params + [before_ms]
    bars = pd.read_sql(sql + ' order by date', con, params=params)
    bars['day'] = pd.to_datetime(bars.date, unit='ms', utc=True).dt.date
    return bars

best = []
for _, trade in trades.iterrows():
    bars = daily(trade.ticker)
    window = None if bars is None else bars[(bars.day >= trade.entry.date()) & (bars.day <= trade.exit.date())]
    best.append(np.nan if window is None or window.empty or not trade.initialRisk
                else (window.close.max() - trade.entryPrice) / trade.initialRisk)
trades['bestR'] = best
trades['bucket'] = pd.cut(trades.bestR, [-np.inf, 0.5, 1.5, np.inf], right=False,
                          labels=['never above +0.5R', '+0.5R to +1.5R', '+1.5R or more'])
print('\nBy best close reached between entry and exit (did the entry ever work?):')
print(trades.groupby('bucket', observed=False).R.agg(['count', 'mean']).round(2).to_string())
print(f'(no local bars for {int(trades.bestR.isna().sum())} trades)')

trades['fillVsStopR'] = (trades.exitPrice - trades.currentStop) / trades.initialRisk
gaps = trades[trades.fillVsStopR < -0.1].sort_values('fillVsStopR')
print('\nFilled more than 0.1R below the recorded stop (gap through the stop, or a stale broker stop):')
print(gaps.assign(exit=gaps.exit.dt.date)[['ticker', 'exit', 'currentStop', 'exitPrice', 'fillVsStopR']]
      .round(2).to_string(index=False) if len(gaps) else '(none)')

print('\nPost-exit drift (exits whose 20-session follow-up ends before the holdout):')
rows = []
for _, trade in trades.sort_values('exit').iterrows():
    bars = daily(trade.ticker, HOLDOUT_MS)
    if bars is None or pd.isna(trade.exitPrice) or not trade.initialRisk:
        continue
    after = bars[bars.day > trade.exit.date()].head(20)
    if len(after) < 20:
        continue
    rows.append({'ticker': trade.ticker, 'exit': trade.exit.date(), 'R': round(trade.R, 2),
                 'close+20 vs exit (R)': round((after.close.iloc[-1] - trade.exitPrice) / trade.initialRisk, 2),
                 'max high+20 vs entry (R)': round((after.high.max() - trade.entryPrice) / trade.initialRisk, 2)})
if rows:
    drift = pd.DataFrame(rows)
    print(drift.to_string(index=False))
    higher = (drift['close+20 vs exit (R)'] > 0).sum()
    print(f'{higher} of {len(drift)} closed higher 20 sessions after the exit; '
          f'mean {drift["close+20 vs exit (R)"].mean():+.2f}R. Hypothesis-generating only: no market baseline, '
          'small n, one period, and a wider stop would also have enlarged the losses.')
else:
    print('(no eligible exits)')
