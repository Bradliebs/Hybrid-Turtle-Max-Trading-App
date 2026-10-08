"""
One-time holdout test of candidate improvements to HybridTurtle's rules. Read-only.

Pre-registered on 2026-10-08. The hypotheses, data, metric and pass rules below
were written down and committed before this script was ever run on the holdout
period. Do not edit them after the holdout run; write a new version instead.

Periods (reports/candidate-outcome-readiness-2026-09-10.md):
  dev      signals 2026-05-16 .. 2026-06-30 (already studied; hypotheses come from here)
  holdout  signals 2026-08-03 .. 2026-09-08 (untouched until this run; the last
           signal date leaves 20 full sessions before 2026-10-07)

Population: scanner candidates that passed the technical filters
(CandidateOutcome.passedTechFilter = 1), one row per ticker per signal date (the
first scan of the day). "Triggered" means price >= entryTrigger at scan time,
the pool auto-trade buys from. Scores are the point-in-time CandidateOutcome
scores (latest at or before the scan, at most 2 days old).

Returns: Yahoo daily bars from the live listing (yahoo_daily.to_yahoo). Entry at
the next session's open, adjusted (open x adjclose / close); exit at the adjusted
close 20 sessions after entry. Returns are winsorised at +/-50% so a corporate
action or bad print cannot dominate a mean. Rows without 20 complete sessions or
without a price series are dropped and counted.

Hypotheses (direction fixed from the dev results; each uses mean-over-dates
statistics and a date-bootstrap interval, Bonferroni-corrected for five tests,
i.e. 99% two-sided):
  H1 NCS predicts returns: daily Spearman IC of NCS with the 20-session return
     among passers > 0.                               PASS if lower bound > 0
  H2 NCS orders better than rankScore (the live buy order): daily IC(NCS) minus
     IC(rankScore) > 0.                               PASS if lower bound > 0
  H3 FWS predicts returns (lower is better): daily IC of -FWS > 0.
                                                      PASS if lower bound > 0
  H4 Buying the triggered breakout underperforms: daily mean return of
     triggered passers minus non-triggered passers < 0 (dates with >= 5
     triggered rows).                                 PASS if upper bound < 0
  H5 Selling on the app's failed-breakout rule helps: for triggered passers,
     simulated R with FAILX minus LIVE exits (shadow_sim, entry next open,
     1R = 1.5 x ATR(14), 20-session horizon) > 0.     PASS if lower bound > 0

What a pass would justify (owner decision required, never automatic):
  H1 and H2 pass -> change the auto-trade buy order to NCS.
  H4 passes      -> design and forward-test a pullback entry (H4 supports waiting
                    after the trigger; it does not validate a specific rule).
  H5 passes      -> automate the exit on the existing failed-breakout flag.
A hypothesis that fails in the holdout is not adopted, whatever the dev result.
After this run the holdout counts as seen; new ideas need new data.

Usage (needs pandas, numpy, scipy and network access to Yahoo daily bars):
  python scripts/research/holdout_test.py prisma/dev.db dev
  python scripts/research/holdout_test.py prisma/dev.db holdout
Price series are cached under prisma/backups/yahoo-cache (git-ignored).
"""
import datetime as dt
import json
import pathlib
import sqlite3
import sys

import numpy as np
import pandas as pd
from scipy import stats

from shadow_sim import atr, simulate
from yahoo_daily import fetch_daily, to_yahoo

DB = sys.argv[1] if len(sys.argv) > 1 else 'prisma/dev.db'
PERIOD = sys.argv[2] if len(sys.argv) > 2 else 'dev'
PERIODS = {'dev': (dt.date(2026, 5, 16), dt.date(2026, 6, 30)),
           'holdout': (dt.date(2026, 8, 3), dt.date(2026, 9, 8))}
if PERIOD not in PERIODS:
    sys.exit('period must be dev or holdout')
START, END = PERIODS[PERIOD]
HORIZON = 20
WINSOR = 50.0
TAIL = 100 * 0.05 / 5 / 2   # Bonferroni: five tests, two-sided
BOOTSTRAPS = 4000
CACHE = pathlib.Path('prisma/backups/yahoo-cache')

con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
con.execute('PRAGMA query_only = ON')
rows = pd.read_sql("""
  select co.ticker, st.yahooTicker, co.scanDate, co.price, co.entryTrigger, co.ncs, co.fws, co.rankScore
  from CandidateOutcome co left join Stock st on st.ticker = co.ticker
  where co.passedTechFilter = 1""", con)
rows['time'] = pd.to_datetime(rows.scanDate, unit='ms', utc=True)
rows['date'] = rows.time.dt.date
rows = rows[(rows.date >= START) & (rows.date <= END)]
rows = rows.sort_values('time').drop_duplicates(['ticker', 'date'], keep='first').reset_index(drop=True)
rows['triggered'] = rows.price >= rows.entryTrigger


def bars_for(ticker, override):
    symbol = to_yahoo(ticker, override)
    path = CACHE / f'{symbol.replace("/", "_")}.json'
    if path.exists():
        cached = json.loads(path.read_text())
    else:
        cached = [dict(b, date=b['date'].isoformat()) for b in fetch_daily(symbol, dt.date(2026, 4, 1), lookback_days=0)]
        CACHE.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(cached))
    frame = pd.DataFrame(cached)
    if frame.empty:
        return frame
    frame['date'] = pd.to_datetime(frame.date).dt.date
    return frame.set_index('date')[['open', 'high', 'low', 'close', 'adj']]


returns, r_live, r_fail, missing = [], [], [], 0
series = {}
for ticker in rows.ticker.unique():
    override = rows.loc[rows.ticker == ticker, 'yahooTicker'].iloc[0]
    override = None if pd.isna(override) else override
    try:
        series[ticker] = bars_for(ticker, override)
    except Exception:
        series[ticker] = pd.DataFrame()
for row in rows.itertuples():
    bars = series.get(row.ticker)
    value = live = fail = np.nan
    if bars is not None and not bars.empty:
        days = list(bars.index)
        after = [i for i, d in enumerate(days) if d > row.date]
        if after and after[0] + HORIZON - 1 < len(bars):
            i = after[0]
            entry = bars.open.iloc[i] * bars.adj.iloc[i] / bars.close.iloc[i]
            value = float(np.clip((bars.adj.iloc[i + HORIZON - 1] / entry - 1) * 100, -WINSOR, WINSOR))
            if row.triggered and i >= 15:
                risk = 1.5 * atr(bars, i - 1, 14)
                if risk > 0:
                    live = simulate(bars, i, bars.open.iloc[i], risk, 'LIVE', horizon=HORIZON)
                    fail = simulate(bars, i, bars.open.iloc[i], risk, 'FAILX', trigger=row.entryTrigger, horizon=HORIZON)
    missing += np.isnan(value)
    returns.append(value)
    r_live.append(live)
    r_fail.append(fail)
rows['r20'] = returns
rows['live'] = r_live
rows['failx'] = r_fail
data = rows.dropna(subset=['r20'])


def date_interval(values_by_date):
    values = np.array([v for v in values_by_date if np.isfinite(v)])
    if len(values) < 2:
        return np.nan, np.nan, np.nan, len(values)
    rng = np.random.default_rng(20261008)
    means = [rng.choice(values, len(values)).mean() for _ in range(BOOTSTRAPS)]
    low, high = np.percentile(means, [TAIL, 100 - TAIL])
    return values.mean(), low, high, len(values)


def daily_ic(column, sign=1):
    out = []
    for _, group in data.dropna(subset=[column]).groupby('date'):
        if len(group) >= 20:
            out.append(stats.spearmanr(sign * group[column], group.r20).statistic)
    return out


def show(name, values, rule):
    mean, low, high, n = date_interval(values)
    passed = (low > 0) if rule == 'lower>0' else (high < 0)
    print(f'{name}: mean {mean:+.3f}, corrected interval [{low:+.3f}, {high:+.3f}], dates={n} -> '
          f'{"PASS" if passed else "FAIL"}')
    return passed


print(f'Period {PERIOD} {START}..{END}: {len(rows)} passer rows ({rows.ticker.nunique()} tickers, '
      f'{rows.date.nunique()} dates); {missing} without a complete 20-session window; '
      f'{int(rows.triggered.sum())} triggered')
ic_ncs, ic_rank = daily_ic('ncs'), daily_ic('rankScore')
results = {
    'H1': show('H1 IC(NCS)', ic_ncs, 'lower>0'),
    'H2': show('H2 IC(NCS) - IC(rankScore)', [a - b for a, b in zip(ic_ncs, ic_rank)], 'lower>0'),
    'H3': show('H3 IC(-FWS)', daily_ic('fws', -1), 'lower>0'),
}
diffs = []
for _, group in data.groupby('date'):
    trig, rest = group[group.triggered].r20, group[~group.triggered].r20
    if len(trig) >= 5 and len(rest) >= 5:
        diffs.append(trig.mean() - rest.mean())
results['H4'] = show('H4 triggered minus other passers (%, 20 sessions)', diffs, 'upper<0')
sim = data.dropna(subset=['live', 'failx'])
per_date = (sim.failx - sim.live).groupby(sim.date).mean().tolist()
print(f'   H5 sample: {len(sim)} triggered trades; LIVE {sim.live.mean():+.2f}R, FAILX {sim.failx.mean():+.2f}R')
results['H5'] = show('H5 FAILX minus LIVE (R per trade, by date)', per_date, 'lower>0')
print(f'   Context: rankScore IC mean {np.mean(ic_rank):+.3f}; passer mean 20-session return '
      f'{data.r20.mean():+.2f}% (triggered {data[data.triggered].r20.mean():+.2f}%)')
print('Summary:', ', '.join(f'{k} {"PASS" if v else "FAIL"}' for k, v in results.items()))
