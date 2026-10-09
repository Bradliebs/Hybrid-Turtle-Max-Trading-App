"""
Would HybridTurtle do better trading only ETFs? Read-only and exploratory.

This uses every stored scan (May-Oct 2026, including the already-seen holdout),
so it is in-sample evidence for an owner decision, not a pre-registered test.

1. Real closed trades by sleeve (Position table).
2. What auto-trade could actually buy in ETF-only mode: auto-trade needs a
   stored T212 ticker and, for the ISA, isaEligible = true (auto-trade.ts).
   Each stored ticker is checked against the cached T212 instrument list
   (prisma/cache/t212-instruments.json, offline; no broker call), and the
   ISA-eligible ETFs' trend structure is summarised from stored scans.
3. Simulated breakouts per sleeve on the same rule as forward test S4 (CORE:
   bullish scan, price > MA200, ADX > 20, at or above the trigger by at most
   0.8 ATR). Entry at the next open, 1R = 1.5 x ATR(14), FAILX exits (live
   since 2026-10-08), 40-session horizon, each ticker at most once per 56 days.
   Reported per trade: R, price return, and the contribution to account equity
   under SMALL_ACCOUNT sizing (2% risk, capped at 16% of equity for ETFs, 20%
   for CORE stocks, 12% for HIGH_RISK; position-sizer.ts / types/index.ts).
   Net figures subtract simple costs: 0.15% FX each way on non-GBP lines and
   0.5% stamp duty on UK shares (UK-listed ETFs are exempt).
4. Buy and hold of two ISA-buyable index ETFs against the account's
   time-weighted return (equity snapshots adjusted for deposits/withdrawals,
   same method as capital-adjusted-drawdown.ts) over the same window.

Usage (pandas, numpy; Yahoo access on cache misses):
  python scripts/research/etf_vs_stock.py [prisma/dev.db]
Price series are cached under prisma/backups/yahoo-cache (git-ignored).
"""
import datetime as dt
import json
import pathlib
import sqlite3
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from shadow_sim import atr, simulate  # noqa: E402
from yahoo_daily import fetch_daily, to_yahoo  # noqa: E402

DB = sys.argv[1] if len(sys.argv) > 1 else 'prisma/dev.db'
CACHE = pathlib.Path('prisma/backups/yahoo-cache')
HORIZON = 40
RISK_PCT = 2.0
CAP = {'ETF': 0.16, 'CORE': 0.20, 'HIGH_RISK': 0.12}
BOOTSTRAPS = 4000
LEVERAGED_OR_INVERSE = {'SQQQ', 'SH', 'SPXS', 'VXX'}

con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
con.execute('PRAGMA query_only = ON')


def bars_for(symbol):
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


def date_ci(frame, column):
    days = frame.date.unique()
    groups = {d: part[column].to_numpy() for d, part in frame.groupby('date')}
    rng = np.random.default_rng(20261009)
    means = [np.concatenate([groups[d] for d in rng.choice(days, len(days))]).mean() for _ in range(BOOTSTRAPS)]
    return np.percentile(means, [2.5, 97.5])


def independent_of(frame):
    kept, last_seen = [], {}
    for row in frame.sort_values('date').itertuples():
        previous = last_seen.get(row.ticker)
        if previous is None or (row.date - previous).days > 56:
            kept.append(row.Index)
            last_seen[row.ticker] = row.date
    return frame.loc[kept]


# 1. Real trades
print('1. Real closed trades by sleeve')
real = pd.read_sql("""
  select st.sleeve, p.source, p.realisedPnlGbp gbp, p.realisedPnlR r
  from Position p join Stock st on st.id = p.stockId where p.status = 'CLOSED'""", con)
for sleeve, part in real.groupby('sleeve'):
    print(f'  {sleeve:<9} n={len(part):>3}  P&L £{part.gbp.sum():+7.2f}  mean {part.r.mean():+.2f}R  wins {int((part.r > 0).sum())}')

# 2. What auto-trade can buy
print('\n2. ETFs auto-trade could buy for the ISA (isaEligible and a stored T212 ticker)')
etfs = pd.read_sql("select ticker, t212Ticker, isaEligible from Stock where sleeve = 'ETF' and active = 1", con)
buyable = etfs[(etfs.isaEligible == 1) & etfs.t212Ticker.notna() & (etfs.t212Ticker != '')]
unmapped_isa = etfs[(etfs.isaEligible == 1) & (etfs.t212Ticker.isna() | (etfs.t212Ticker == ''))]
print(f'  {len(etfs)} active ETFs; buyable now: {len(buyable)} ({", ".join(buyable.ticker)})')
print(f'  ISA-eligible but no T212 ticker: {len(unmapped_isa)} ({", ".join(unmapped_isa.ticker)})')
print(f'  Mapped but not ISA-eligible: {int(((etfs.isaEligible != 1) & etfs.t212Ticker.notna()).sum())} (mostly US-listed)')
cache_path = pathlib.Path('prisma/cache/t212-instruments.json')
if cache_path.exists():
    cache = json.loads(cache_path.read_text(encoding='utf-8'))
    known = {item['ticker']: item for item in cache['instruments']}
    print(f'  Checked against the cached T212 instrument list (fetched {cache.get("fetchedAt", "?")[:10]}):')
    for row in buyable.itertuples():
        print(f'    {row.ticker:<8} stored {row.t212Ticker:<12} -> {"exists" if row.t212Ticker in known else "NOT IN T212 LIST"}')
trend = pd.read_sql("""
  select st.ticker, count(*) n, avg(sr.price > sr.ma200) above, avg(sr.adx) adx
  from ScanResult sr join Stock st on st.id = sr.stockId
  where st.sleeve = 'ETF' and st.isaEligible = 1 group by st.ticker order by above desc""", con)
print('  Trend structure of the ISA-eligible ETFs (all stored scans): share of scans above MA200, mean ADX')
for row in trend.itertuples():
    print(f'    {row.ticker:<8} scans {row.n:>3}  above MA200 {100 * row.above:>3.0f}%  ADX {row.adx:>5.1f}')

# 3. Simulated breakouts
rows = pd.read_sql("""
  select st.ticker, st.yahooTicker, st.sleeve, st.isaEligible, sc.runDate, sr.entryTrigger
  from ScanResult sr join Scan sc on sc.id = sr.scanId join Stock st on st.id = sr.stockId
  where sc.regime = 'BULLISH' and sr.price > sr.ma200 and sr.adx > 20
    and sr.entryTrigger > 0 and sr.atrPercent > 0 and sr.price >= sr.entryTrigger
    and sr.price - sr.entryTrigger <= 0.8 * sr.atrPercent / 100 * sr.price""", con)
rows['date'] = pd.to_datetime(pd.to_numeric(rows.runDate), unit='ms', utc=True).dt.date
rows = rows.sort_values('runDate').drop_duplicates(['ticker', 'date']).reset_index(drop=True)
rows = rows[~rows.ticker.isin(LEVERAGED_OR_INVERSE)]
rows['symbol'] = [to_yahoo(t, o) for t, o in zip(rows.ticker, rows.yahooTicker)]

trades, missing, series = [], 0, {}
for row in rows.itertuples():
    if row.symbol not in series:
        try:
            series[row.symbol] = bars_for(row.symbol)
        except Exception:
            series[row.symbol] = pd.DataFrame()
    bars = series[row.symbol]
    if bars.empty:
        missing += 1
        continue
    dates = list(bars.index)
    signal_index = max((i for i, d in enumerate(dates) if d <= row.date), default=None)
    if signal_index is None or signal_index < 22 or signal_index + 1 >= len(bars):
        continue
    entry_index = signal_index + 1
    entry = bars.open.iloc[entry_index]
    risk = 1.5 * atr(bars, signal_index, 14)
    if not (entry > 0 and risk > 0):
        continue
    r = simulate(bars, entry_index, entry, risk, 'FAILX', row.entryTrigger, horizon=HORIZON)
    if r is None:
        continue
    price_ret = r * risk / entry * 100
    weight = min(CAP[row.sleeve], (RISK_PCT / 100) / (risk / entry))
    uk = row.symbol.endswith('.L')
    cost = 0.0 if (uk and row.sleeve == 'ETF') else 0.5 if uk else 0.30
    trades.append({'ticker': row.ticker, 'date': row.date, 'sleeve': row.sleeve, 'isa': row.isaEligible == 1,
                   'r': r, 'stopPct': risk / entry * 100, 'priceRet': price_ret, 'weight': weight,
                   'contrib': weight * price_ret, 'contribNet': weight * (price_ret - cost)})

df = independent_of(pd.DataFrame(trades))
print(f'\n3. Simulated breakouts, FAILX exits, {HORIZON}-session horizon, each ticker once per 56 days '
      f'(signals {df.date.min()} to {df.date.max()}; {missing} rows without prices)')
print('  group               n  dates  mean R  win%  stop%  price%  weight  equity%/trade  net  [95% CI net]')
groups = [('ETF (all, no lev/inv)', df.sleeve == 'ETF'), ('ETF ISA-eligible', (df.sleeve == 'ETF') & df.isa),
          ('Stocks CORE', df.sleeve == 'CORE'), ('Stocks HIGH_RISK', df.sleeve == 'HIGH_RISK'),
          ('Stocks all', df.sleeve != 'ETF')]
for name, mask in groups:
    part = df[mask]
    if len(part) == 0:
        print(f'  {name:<20} n=0')
        continue
    low, high = date_ci(part, 'contribNet') if part.date.nunique() > 1 else (np.nan, np.nan)
    print(f'  {name:<20}{len(part):>3}  {part.date.nunique():>5}  {part.r.mean():+.2f}  {100 * (part.r > 0).mean():>4.0f}  '
          f'{part.stopPct.mean():>5.1f}  {part.priceRet.mean():+6.2f}  {part.weight.mean():>6.2f}  '
          f'{part.contrib.mean():+13.3f}  {part.contribNet.mean():+.3f}  [{low:+.3f}, {high:+.3f}]')

both = df.assign(group=np.where(df.sleeve == 'ETF', 'ETF', 'STOCK'))
days = both.date.unique()
by_day = {d: part for d, part in both.groupby('date')}
rng = np.random.default_rng(20261009)
diffs = []
for _ in range(BOOTSTRAPS):
    sample = pd.concat([by_day[d] for d in rng.choice(days, len(days))])
    e, s = sample[sample.group == 'ETF'].contribNet, sample[sample.group == 'STOCK'].contribNet
    if len(e) and len(s):
        diffs.append(e.mean() - s.mean())
e_all, s_all = both[both.group == 'ETF'], both[both.group == 'STOCK']
print(f'  ETF minus stocks, net equity % per trade: {e_all.contribNet.mean() - s_all.contribNet.mean():+.3f} '
      f'[95% CI {np.percentile(diffs, 2.5):+.3f}, {np.percentile(diffs, 97.5):+.3f}]')
print(f'  Independent signals: ETF {len(e_all)} on {e_all.date.nunique()} dates, stocks {len(s_all)} on {s_all.date.nunique()} dates')
print('  Caveats: every signal is taken (no ranking, 4-position limit or cluster cap), one bull-market window,'
      ' no bid/ask spread. Same-date signals are correlated, so the ETF sample is closer to 9 observations than 21.')

# 4. Buy and hold against the account
snaps = pd.read_sql("select capturedAt, equity, source from EquitySnapshot order by capturedAt", con)
first_broker = snaps.index[snaps.source == 'BROKER']
snaps = snaps.loc[first_broker[0]:] if len(first_broker) else snaps.iloc[0:0]
setting = con.execute("select value from AppSetting where key = 'capital-events.v1'").fetchone()
events = json.loads(setting[0])['events'] if setting else []
flows = [(pd.Timestamp(e['at']).value // 10**6, e['amount']) for e in events]
index = 100.0
times = snaps.capturedAt.astype('int64').tolist()
equity = snaps.equity.tolist()
for i in range(1, len(times)):
    flow = sum(a for t, a in flows if times[i - 1] < t <= times[i])
    if equity[i - 1] > 0:
        index *= (equity[i] - flow) / equity[i - 1]
start = pd.to_datetime(times[0], unit='ms').date() if times else None
end = pd.to_datetime(times[-1], unit='ms').date() if times else None
print(f'\n4. {start} to {end}: account time-weighted return {index - 100:+.1f}% '
      f'(equity £{equity[0]:.0f} -> £{equity[-1]:.0f}, {len(events)} cash movements)')
for symbol in ('VUAG.L', 'VWRL.L'):
    bars = bars_for(symbol)
    a = bars.adj[bars.index >= start].iloc[0]
    b = bars.adj[bars.index <= end].iloc[-1]
    print(f'  Buy and hold {symbol}: {100 * (b / a - 1):+.1f}%')
