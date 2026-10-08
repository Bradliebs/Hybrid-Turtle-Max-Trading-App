"""
Prospective shadow tests for HybridTurtle's buy and sell rules. Read-only.

Pre-registered on 2026-10-05 (reports/jev-and-decision-review-2026-10-05.md,
decisions N1, N3 and D4). Only signals on or after FREEZE count as evidence. The
rules below are fixed; do not change them after seeing results. Write a new
version with a new freeze date instead. Nothing here changes live trading: a
result that passes its gate supports an owner decision, it does not enact one.

Population: A_GRADE_BUY rows in ScanResult (grading-time scores, as used live),
one per ticker per UTC signal date (the first of the day). Prices: Yahoo daily
bars (raw OHLC), fetched at evaluation time because the local DailyBar table is
not refreshed nightly. A candidate is excluded (and listed) when its bars cannot
be fetched or a split/corporate action changes the adjustment factor by more than
2% inside its window.

Common trade model (no costs, no capital limits, daily bars only):
  * Breakout entry at the open of the first session after the signal date.
  * ATR = simple mean of the 14 true ranges ending on the signal day.
  * Initial stop = entry - 1.5 x ATR, so 1R = 1.5 x ATR (as live).
  * Stops are recalculated after each close and apply from the next session:
    exit at the open if it gaps through the stop, else at the stop if the low
    touches it. R-ladder as live: close >= +1.5R -> stop >= entry; >= +2.5R ->
    entry + 0.5R; >= +3R -> max(entry + 1R, close - m x ATR).
  * Horizon: 40 sessions after entry; an open trade is marked at that close.
    Candidates whose window is not complete yet are reported as pending.

Exit variants (N3; m is the trailing multiple used everywhere in the variant):
  LIVE   highest close since entry - 1.5 x ATR(14), from the entry day (m = 1.5)
  W20    same with m = 2.0 (the design before commit 4280812)
  LATE   m = 1.5, but the trail starts only after a close at or above +1R
  CHAND  highest high of the last 22 sessions - 3 x ATR(22), from the entry day
  FAILX  LIVE, plus the app's breakout-failure rule acted on: within 5 calendar days
         of entry, a close below the entry trigger with under +0.5R open profit
         sells at the next session's open

Amendment 2026-10-08 (before any prospective outcome existed; the first 40-session
window ends in December): FAILX added, Bonferroni widened from six to seven
comparisons, and prices now come from the live listing via yahoo_daily.to_yahoo
(the first version ignored the app's ticker map, e.g. SAP -> SAP.DE). Later the
same day: a restart check was added for the owner's pause decision. It reports
the current rules (LIVE) on their own, counting each ticker at most once per 56
calendar days (overlapping repeats are near-duplicates), with a 95%
date-bootstrap interval. Buying resumes only if the lower bound is above zero
with at least 30 such candidates on 15 dates and 15 tickers. It is a
stand-alone check, not one of the seven. It covers every A-grade candidate, not
only the ones auto-trade would have bought. A variant (e.g. FAILX) is not a
resume signal on its own; it must first pass its E1 gate and be adopted.

Amendment 2026-10-08, evening (still before any prospective outcome existed):
S4 added for the owner's simplification decision, Bonferroni widened from seven
to eight comparisons. S4 asks whether a much simpler buy rule does at least as
well as the current A-grade selection. CORE population: every scanned stock
(any grade), first scan of each UTC date, where the scan regime is BULLISH,
price > MA200, ADX > 20, and price is at or above the entry trigger by no more
than 0.8 x ATR (ATR from the scan's atrPercent). Both groups use the common trade
model with FAILX exits (live since 2026-10-08) and count each ticker at most once
per 56 calendar days.

Tests and evidence gates. Intervals resample whole signal dates and are
Bonferroni-corrected for the eight comparisons (99.375% two-sided, i.e. 0.05 / 8):
  E1 exits: variant R minus LIVE R per candidate, over every completed candidate.
     (Variants can differ even on trades that never rise: the live trail uses the
     current ATR, so a falling ATR tightens it with no price gain.) Gate: at least
     30 candidates on at least 15 dates; BETTER/WORSE only if the interval
     excludes zero, otherwise INCONCLUSIVE.
  S1 buy order (N1/D1): on each date with two or more candidates, the top pick by
     NCS minus the top pick by rankScore (LIVE exits). Gate: 30 dates on which the
     picks differ.
  S2 efficiency demotion (D4, advisory today): WATCH-status A-grades minus
     READY-status A-grades, LIVE exits. Gate: 30 candidates in each group.
  S3 entry style (N1): pullback entry minus breakout entry per candidate. The
     pullback buys at the entry trigger if any of the 5 sessions after the signal
     trades down to it (at the open if it opens below), with the same 1R and LIVE
     exits; unfilled pullbacks score 0R. A candidate counts only once the latest
     possible pullback window (fill on session 5 plus 40 sessions) is complete.
     Gate: 30 candidates on 15 dates.
  S4 simple CORE rule: mean CORE R minus mean A-grade R (FAILX exits, each ticker
     once per 56 days), resampling dates from both groups together. Gate: 30
     candidates on 15 dates in each group. CORE NOT WORSE (interval low end above
     -0.10R) supports replacing the scoring stack with the simple rule; WORSE
     (high end below zero) supports keeping it; otherwise INCONCLUSIVE.

Expected pace: about 15 A-grade signals a month, so most gates need 6-12 months
and many results will read INCONCLUSIVE. That is the honest outcome, not a
reason to loosen the gates.

Usage (needs pandas and numpy; network access to query1.finance.yahoo.com):
  python scripts/research/prospective_shadow_tests.py [prisma/dev.db]
  python scripts/research/prospective_shadow_tests.py prisma/dev.db --smoke 2026-05-15 2026-06-30
The --smoke option replays a past window to check the code runs. Its output is
labelled SMOKE and is not evidence.
"""
import datetime as dt
import sqlite3
import sys
import time

import numpy as np
import pandas as pd

from shadow_sim import atr, fetch, simulate
from yahoo_daily import to_yahoo

FREEZE = dt.date(2026, 10, 6)
HORIZON = 40
MIN_N, MIN_DATES = 30, 15
BOOTSTRAPS = 4000
TAIL = 100 * 0.05 / 8 / 2  # Bonferroni: eight comparisons, two-sided

args = [a for a in sys.argv[1:] if not a.startswith('--')]
DB = args[0] if args else 'prisma/dev.db'
SMOKE = '--smoke' in sys.argv
start, end = (dt.date.fromisoformat(args[1]), dt.date.fromisoformat(args[2])) if SMOKE else (FREEZE, None)

con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
con.execute('PRAGMA query_only = ON')
rows = pd.read_sql("""
  select st.ticker, st.yahooTicker, sc.runDate, sr.status,
         sr.rankScore, sr.ncs, sr.entryTrigger
  from ScanResult sr join Scan sc on sc.id = sr.scanId join Stock st on st.id = sr.stockId
  where sr.grade = 'A_GRADE_BUY'""", con)
# Same listing as the live system (toYahooTicker); amended 2026-10-08, before any prospective outcome existed.
rows['symbol'] = [to_yahoo(t, o) for t, o in zip(rows.ticker, rows.yahooTicker)]
rows['time'] = pd.to_datetime(pd.to_numeric(rows.runDate, errors='coerce'), unit='ms', utc=True)
rows['date'] = rows.time.dt.date
rows = rows[(rows.date >= start) & ((rows.date <= end) if end else True)]
rows = rows.sort_values('time').drop_duplicates(['ticker', 'date'], keep='first').reset_index(drop=True)

# S4 CORE population (amendment 2026-10-08, evening).
core = pd.read_sql("""
  select st.ticker, st.yahooTicker, sc.runDate, sr.entryTrigger
  from ScanResult sr join Scan sc on sc.id = sr.scanId join Stock st on st.id = sr.stockId
  where sc.regime = 'BULLISH' and sr.price > sr.ma200 and sr.adx > 20
    and sr.entryTrigger > 0 and sr.atrPercent > 0 and sr.price >= sr.entryTrigger
    and sr.price - sr.entryTrigger <= 0.8 * sr.atrPercent / 100 * sr.price""", con)
core['symbol'] = [to_yahoo(t, o) for t, o in zip(core.ticker, core.yahooTicker)]
core['time'] = pd.to_datetime(pd.to_numeric(core.runDate, errors='coerce'), unit='ms', utc=True)
core['date'] = core.time.dt.date
core = core[(core.date >= start) & ((core.date <= end) if end else True)]
core = core.sort_values('time').drop_duplicates(['ticker', 'date'], keep='first').reset_index(drop=True)
# Fetch each symbol once, from the earliest date either population needs.
first_needed = pd.concat([rows[['symbol', 'date']], core[['symbol', 'date']]]).groupby('symbol').date.min().to_dict()




def date_bootstrap(frame, column, tail=None):
    days = frame.date.unique()
    groups = {day: part[column].to_numpy() for day, part in frame.groupby('date')}
    rng = np.random.default_rng(20261005)
    means = [np.concatenate([groups[d] for d in rng.choice(days, len(days))]).mean() for _ in range(BOOTSTRAPS)]
    cut = TAIL if tail is None else tail
    return np.percentile(means, [cut, 100 - cut])


def verdict(frame, column, n_needed, dates_needed):
    if len(frame) == 0:
        return 'INSUFFICIENT EVIDENCE (no completed candidates)'
    low, high = date_bootstrap(frame, column)
    text = f'mean {frame[column].mean():+.2f}R, corrected interval [{low:+.2f}, {high:+.2f}], n={len(frame)}, dates={frame.date.nunique()}'
    if len(frame) < n_needed or frame.date.nunique() < dates_needed:
        return text + ' -> INSUFFICIENT EVIDENCE'
    return text + (' -> BETTER' if low > 0 else ' -> WORSE' if high < 0 else ' -> INCONCLUSIVE')


cache = {}


def prepare(row):
    """(bars, entry_index, entry, risk) for one candidate, or the reason it is excluded."""
    try:
        if row.symbol not in cache:
            cache[row.symbol] = fetch(row.symbol, first_needed[row.symbol])
            time.sleep(0.4)
        bars = cache[row.symbol]
    except Exception as error:  # network or symbol failure: list it, never guess
        return f'fetch failed: {type(error).__name__}'
    dates = list(bars.index)
    signal_index = max((i for i, d in enumerate(dates) if d <= row.date), default=None)
    if signal_index is None or signal_index < 22 or signal_index + 1 >= len(bars):
        return 'not enough bars yet'
    window = bars.iloc[signal_index - 22:min(len(bars), signal_index + 1 + HORIZON + 5)]
    factor = window.adj / window.close
    if (factor / factor.iloc[0] - 1).abs().max() > 0.02:
        return 'adjustment factor changed (corporate action)'
    entry_index = signal_index + 1
    return bars, entry_index, bars.open.iloc[entry_index], 1.5 * atr(bars, signal_index, 14)


def independent_of(frame):
    """Each ticker at most once per 56 calendar days (overlapping repeats are near-duplicates)."""
    kept, last_seen = [], {}
    for row in (frame.sort_values('date').itertuples() if len(frame) else []):
        previous = last_seen.get(row.ticker)
        if previous is None or (row.date - previous).days > 56:
            kept.append(row.Index)
            last_seen[row.ticker] = row.date
    return frame.loc[kept] if kept else frame.iloc[0:0]


label = 'SMOKE RUN (past window; not evidence)' if SMOKE else f'Prospective (signals from {FREEZE})'
print(f'{label}: {len(rows)} A-grade candidates on {rows.date.nunique()} dates; '
      f'{len(core)} CORE candidates on {core.date.nunique()} dates')
results, excluded = [], []
for row in rows.itertuples():
    prepared = prepare(row)
    if isinstance(prepared, str):
        excluded.append((row.ticker, str(row.date), prepared))
        continue
    bars, entry_index, entry, risk = prepared
    record = {'ticker': row.ticker, 'date': row.date, 'status': row.status, 'rankScore': row.rankScore, 'ncs': row.ncs}
    for variant in ('LIVE', 'W20', 'LATE', 'CHAND', 'FAILX'):
        record[variant] = simulate(bars, entry_index, entry, risk, variant, row.entryTrigger)
    last = entry_index + HORIZON - 1
    record['bestR'] = None if last >= len(bars) else (bars.close.iloc[entry_index:last + 1].max() - entry) / risk
    # Score S3 only once the latest possible pullback (fill on session 5) has a full window.
    pullback = None
    if entry_index + 4 + HORIZON - 1 < len(bars):
        pullback = 0.0
        for i in range(entry_index, entry_index + 5):
            if bars.low.iloc[i] <= row.entryTrigger:
                fill = min(bars.open.iloc[i], row.entryTrigger)
                pullback = simulate(bars, i, fill, risk, 'LIVE')
                break
    record['PULLBACK'] = pullback
    results.append(record)

df = pd.DataFrame(results)
done = df.dropna(subset=['LIVE']) if len(df) else df
print(f'Completed {len(done)}, pending {len(df) - len(done)}, excluded {len(excluded)}')
if len(done):
    for variant in ('LIVE', 'W20', 'LATE', 'CHAND', 'FAILX', 'PULLBACK'):
        values = done[variant].dropna()
        print(f'  {variant:<8} mean {values.mean():+.2f}R  win {100 * (values > 0).mean():.0f}%  n={len(values)}')

print('\nRestart check (not part of the corrected family): current rules (LIVE) on their own')
independent = independent_of(done)
if len(independent):
    low, high = date_bootstrap(independent, 'LIVE', tail=2.5)
    enough = (len(independent) >= MIN_N and independent.date.nunique() >= MIN_DATES
              and independent.ticker.nunique() >= MIN_DATES)
    state = ('RESUME BUYING SUPPORTED' if low > 0 else 'KEEP PAUSED') if enough else 'INSUFFICIENT EVIDENCE'
    print(f'  LIVE mean {independent.LIVE.mean():+.2f}R, 95% date-bootstrap interval [{low:+.2f}, {high:+.2f}], '
          f'n={len(independent)} independent of {len(done)}, dates={independent.date.nunique()}, '
          f'tickers={independent.ticker.nunique()} -> {state}')
else:
    print('  INSUFFICIENT EVIDENCE (no completed candidates)')

print('\nE1 exits (every completed candidate):')
eligible = done
for variant in ('W20', 'LATE', 'CHAND', 'FAILX'):
    frame = eligible.assign(diff=eligible[variant] - eligible.LIVE) if len(eligible) else eligible
    print(f'  {variant} minus LIVE: {verdict(frame, "diff", MIN_N, MIN_DATES) if len(frame) else "INSUFFICIENT EVIDENCE"}')

print('\nS1 buy order (top NCS pick minus top rankScore pick, per date):')
pairs = []
for day, part in (done.groupby('date') if len(done) else []):
    if len(part) < 2 or part.ncs.isna().all():
        continue
    by_rank = part.sort_values(['rankScore', 'ticker'], ascending=[False, True]).iloc[0]
    by_ncs = part.sort_values(['ncs', 'ticker'], ascending=[False, True]).iloc[0]
    if by_rank.ticker != by_ncs.ticker:
        pairs.append({'date': day, 'diff': by_ncs.LIVE - by_rank.LIVE})
pairs = pd.DataFrame(pairs)
print('  ' + (verdict(pairs, 'diff', MIN_N, MIN_N) if len(pairs) else 'INSUFFICIENT EVIDENCE (no dates with differing picks)'))

print('\nS2 efficiency demotion (WATCH-status A-grades minus READY-status A-grades):')
watch = done[done.status == 'WATCH'] if len(done) else done
ready = done[done.status == 'READY'] if len(done) else done
if len(watch) and len(ready):
    gap = watch.LIVE.mean() - ready.LIVE.mean()
    text = f'  WATCH n={len(watch)} {watch.LIVE.mean():+.2f}R, READY n={len(ready)} {ready.LIVE.mean():+.2f}R, gap {gap:+.2f}R'
    if len(watch) >= MIN_N and len(ready) >= MIN_N:
        both = pd.concat([watch, ready])
        days = both.date.unique()
        groups = {day: part for day, part in both.groupby('date')}
        rng = np.random.default_rng(20261005)
        gaps = []
        for _ in range(BOOTSTRAPS):
            sample = pd.concat([groups[d] for d in rng.choice(days, len(days))])
            w, r = sample[sample.status == 'WATCH'].LIVE, sample[sample.status == 'READY'].LIVE
            if len(w) and len(r):
                gaps.append(w.mean() - r.mean())
        low, high = np.percentile(gaps, [TAIL, 100 - TAIL])
        text += f', corrected interval [{low:+.2f}, {high:+.2f}] -> ' + ('WATCH BETTER' if low > 0 else 'WATCH WORSE' if high < 0 else 'INCONCLUSIVE')
    else:
        text += ' -> INSUFFICIENT EVIDENCE'
    print(text)
else:
    print('  INSUFFICIENT EVIDENCE')

print('\nS3 entry style (pullback minus breakout, per candidate):')
paired = done.dropna(subset=['PULLBACK']) if len(done) else done
print('  ' + (verdict(paired.assign(diff=paired.PULLBACK - paired.LIVE), 'diff', MIN_N, MIN_DATES)
              if len(paired) else 'INSUFFICIENT EVIDENCE'))

print('\nS4 simple CORE rule (CORE minus A-grade, FAILX exits, each ticker once per 56 days):')
core_results = []
for row in core.itertuples():
    prepared = prepare(row)
    if isinstance(prepared, str):
        if prepared != 'not enough bars yet':
            excluded.append((row.ticker, str(row.date), 'CORE: ' + prepared))
        continue
    bars, entry_index, entry, risk = prepared
    core_results.append({'ticker': row.ticker, 'date': row.date,
                         'FAILX': simulate(bars, entry_index, entry, risk, 'FAILX', row.entryTrigger)})
core_df = pd.DataFrame(core_results)
core_done = independent_of(core_df.dropna(subset=['FAILX']).reset_index(drop=True)) if len(core_df) else core_df
grade_done = independent_of(done.dropna(subset=['FAILX'])) if len(done) else done
if len(core_done) and len(grade_done):
    gap = core_done.FAILX.mean() - grade_done.FAILX.mean()
    text = (f'  CORE n={len(core_done)} {core_done.FAILX.mean():+.2f}R, A-grade n={len(grade_done)} '
            f'{grade_done.FAILX.mean():+.2f}R, gap {gap:+.2f}R')
    if (len(core_done) >= MIN_N and len(grade_done) >= MIN_N
            and core_done.date.nunique() >= MIN_DATES and grade_done.date.nunique() >= MIN_DATES):
        both = pd.concat([core_done.assign(group='CORE'), grade_done[['ticker', 'date', 'FAILX']].assign(group='A')])
        days = both.date.unique()
        groups = {day: part for day, part in both.groupby('date')}
        rng = np.random.default_rng(20261005)
        gaps = []
        for _ in range(BOOTSTRAPS):
            sample = pd.concat([groups[d] for d in rng.choice(days, len(days))])
            c, a = sample[sample.group == 'CORE'].FAILX, sample[sample.group == 'A'].FAILX
            if len(c) and len(a):
                gaps.append(c.mean() - a.mean())
        low, high = np.percentile(gaps, [TAIL, 100 - TAIL])
        text += f', corrected interval [{low:+.2f}, {high:+.2f}] -> ' + (
            'CORE NOT WORSE' if low > -0.10 else 'CORE WORSE' if high < 0 else 'INCONCLUSIVE')
    else:
        text += ' -> INSUFFICIENT EVIDENCE'
    print(text)
else:
    print('  INSUFFICIENT EVIDENCE')

if excluded:
    print('\nExcluded (ticker, signal date, reason):')
    for item in excluded:
        print('  ', *item)