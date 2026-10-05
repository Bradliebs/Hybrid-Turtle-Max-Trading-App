"""
Read-only stock-selection diagnostic for HybridTurtle.

Question: does the current selection pipeline (filters, triggers, scores, rankScore)
rank stocks by subsequent return? Descriptive only. NOT a tuning tool, NOT a backtest
of auto-trade (no stops, costs, FX, capital limits or intraday session timing).

Research protocol (reports/candidate-outcome-readiness-2026-09-10.md):
  * signals from the May-June 2026 development window only;
  * every outcome window must end before the 2026-08-03 reserved holdout;
  * stored CandidateOutcome return labels are NOT used (known bar-order defect);
    returns are recomputed from local DailyBar on an adjusted basis;
  * scores are the grading-time scores saved on ScanResult. CandidateOutcome scores
    are shown only for contrast: before 2026-10-01 they were backfilled with the
    latest score within +/-2 days, i.e. they can contain look-ahead.

Retrospective quality-control rule (chosen after PSIG and WLFC outliers had been
seen, so it is a sensitivity check, not a pre-registered filter): a window is
excluded if any adjusted close-to-close move inside it exceeds 35%. This also
removes genuine crashes and spikes, so excluded and unexcluded results are both
reported, with the full exclusion ledger.

Usage (requires pandas, numpy, scipy):
  python scripts/research/selection_diagnostic.py prisma/dev.db [first|last]
"""
import datetime as dt
import sqlite3
import sys

import numpy as np
import pandas as pd
from scipy import stats

DB = sys.argv[1] if len(sys.argv) > 1 else 'prisma/dev.db'
KEEP = sys.argv[2] if len(sys.argv) > 2 else 'first'   # which scan of the day to keep
START, END = dt.date(2026, 5, 16), dt.date(2026, 6, 30)
HOLDOUT = dt.date(2026, 8, 3)
QUARANTINE_MOVE = 0.35
H = (10, 20)

con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True, isolation_level=None)
con.execute('PRAGMA query_only = ON')
con.execute('BEGIN')  # one consistent read snapshot for every query below
start_ms = int(dt.datetime(2026, 5, 15, tzinfo=dt.UTC).timestamp() * 1000)
end_ms = int(dt.datetime(2026, 7, 2, tzinfo=dt.UTC).timestamp() * 1000)
holdout_ms = int(dt.datetime.combine(HOLDOUT, dt.time(), dt.UTC).timestamp() * 1000)
df = pd.read_sql('''
  select co.scanDate, co.ticker, co.sleeve, co.status, co.passedTechFilter, co.passedAntiChase, co.atrSpiking,
         co.price, co.entryTrigger, co.rankScore, co.volumeRatio, co.relativeStrength, co.adx, co.atrPct,
         co.efficiency, co.distancePct, co.ncs as co_ncs, co.fws as co_fws,
         sr.ncs as ncs, sr.fws as fws, sr.bqs as bqs, sr.grade as grade
  from CandidateOutcome co
  join Stock s on s.ticker = co.ticker
  join ScanResult sr on sr.scanId = co.scanId and sr.stockId = s.id
  where co.scanDate between ? and ?''', con, params=(start_ms, end_ms))
df['date'] = pd.to_datetime(df.scanDate, unit='ms', utc=True).dt.tz_convert('Europe/London').dt.date
df = df[(df.date >= START) & (df.date <= END)]
df = df.sort_values('scanDate').drop_duplicates(['ticker', 'date'], keep=KEEP)

inst = pd.read_sql('select id, symbol from Instrument', con)
unmatched = sorted(set(df.ticker) - set(inst.symbol))
df = df.merge(inst, left_on='ticker', right_on='symbol', how='inner')

# Holdout prices are never loaded: the SQL cutoff enforces the protocol, not just the code below.
bars = pd.read_sql('select instrumentId, date, open, close, adjustedClose from DailyBar where date < ?',
                   con, params=(holdout_ms,))
bars['d'] = pd.to_datetime(bars.date, unit='ms', utc=True).dt.date
bars = bars.sort_values(['instrumentId', 'd']).drop_duplicates(['instrumentId', 'd'], keep='last')
bars['open_adj'] = bars.open * bars.adjustedClose / bars.close
by_inst = {k: g.reset_index(drop=True) for k, g in bars.groupby('instrumentId')}
quarantined = []

def forward(row):
    out = {}
    for h in H:
        out[f'r{h}'] = np.nan       # primary: quarantined windows excluded
        out[f'raw{h}'] = np.nan     # sensitivity: nothing excluded
    g = by_inst.get(row.id)
    if g is None:
        return pd.Series(out)
    after = g[g.d > row.date].reset_index(drop=True)
    if after.empty or not (after.open_adj.iloc[0] > 0):
        return pd.Series(out)
    entry = after.open_adj.iloc[0]
    for h in H:
        if len(after) < h or after.d.iloc[h - 1] >= HOLDOUT:
            continue
        window = after.adjustedClose.iloc[:h]
        value = (after.adjustedClose.iloc[h - 1] / entry - 1) * 100
        out[f'raw{h}'] = value
        moves = window.pct_change().abs().dropna()
        if (moves > QUARANTINE_MOVE).any() or abs(window.iloc[0] / entry - 1) > QUARANTINE_MOVE:
            quarantined.append((row.ticker, row.date, h))
            continue
        out[f'r{h}'] = value
    return pd.Series(out)

df = pd.concat([df.reset_index(drop=True), df.apply(forward, axis=1)], axis=1)
P = df[df.passedTechFilter == 1].copy()
P['triggered'] = P.price >= P.entryTrigger
P['qualityA'] = (P.triggered & (P.ncs >= 70) & (P.fws <= 30) & (P.bqs >= 55) & (P.volumeRatio >= 0.8)
                 & (P.relativeStrength >= 0) & (P.passedAntiChase == 1) & (P.atrSpiking == 0)
                 & ~P.status.isin(['WAIT_PULLBACK', 'COOLDOWN']))

def group(name, s, h):
    x = s[f'r{h}'].dropna()
    per_day = s.dropna(subset=[f'r{h}']).groupby('date')[f'r{h}'].mean()
    return {'group': name, 'n': len(x), 'dates': per_day.size, 'mean%': round(x.mean(), 2),
            'median%': round(x.median(), 2), 'win%': round((x > 0).mean() * 100, 1),
            'date-avg%': round(per_day.mean(), 2)}

print(f'Dev window {START}..{END}, dedupe={KEEP} scan of day, holdout {HOLDOUT} untouched.')
print(f'Unmatched tickers (no DailyBar series): {len(unmatched)}; quarantined windows: {len(quarantined)}')
ledger = pd.DataFrame(quarantined, columns=['ticker', 'signal_date', 'horizon'])
if not ledger.empty:
    print('Quarantine ledger (ticker: windows excluded):',
          ', '.join(f'{t}: {n}' for t, n in ledger.groupby('ticker').size().sort_values(ascending=False).items()))
for h in H:
    print(f'\n=== {h} sessions after next-open entry (quarantined windows excluded) ===')
    rows = [group('All scanned', df, h), group('Passed tech filters', P, h)]
    for status in ['READY', 'WATCH', 'FAR']:
        rows.append(group(f'  passed & {status}', P[P.status == status], h))
    rows += [group('  passed & triggered', P[P.triggered], h),
             group('  quality-A proxy (grading-time scores)', P[P.qualityA], h)]
    print(pd.DataFrame(rows).to_string(index=False))
    print(f'-- sensitivity, nothing excluded ({h} sessions):')
    for name, s in [('Passed tech filters', P), ('passed & triggered', P[P.triggered]), ('quality-A proxy', P[P.qualityA])]:
        x = s[f'raw{h}'].dropna()
        print(f'   {name}: n={len(x)} mean={x.mean():.2f}% median={x.median():.2f}% win={(x > 0).mean() * 100:.1f}%')

print('\n=== Mean daily Spearman rank IC among passers (naive t ignores overlapping windows) ===')
features = {'rankScore': 1, 'ncs': 1, 'fws': -1, 'bqs': 1, 'co_ncs (look-ahead)': 1, 'co_fws (look-ahead)': -1,
            'volumeRatio': 1, 'relativeStrength': 1, 'adx': 1, 'atrPct': -1, 'efficiency': 1}
for h in H:
    out = []
    for feature, sign in features.items():
        column = feature.split(' ')[0]
        ics = [stats.spearmanr(sign * g[column], g[f'r{h}']).statistic
               for _, g in P.dropna(subset=[f'r{h}', column]).groupby('date') if len(g) >= 20]
        ics = np.array([i for i in ics if np.isfinite(i)])
        if len(ics) > 1:
            out.append({'feature': feature + (' (lower=better)' if sign < 0 else ''), 'dates': len(ics),
                        'meanIC': round(ics.mean(), 3), 'pos%': round((ics > 0).mean() * 100),
                        't(naive)': round(ics.mean() / (ics.std(ddof=1) / np.sqrt(len(ics))), 2)})
    print(f'-- {h} sessions'); print(pd.DataFrame(out).sort_values('meanIC', ascending=False).to_string(index=False))

print('\n=== Among triggered passers only (the pool auto-trade buys from) ===')
T = P[P.triggered]
for h in H:
    for column in ('rankScore', 'ncs'):
        ics = [stats.spearmanr(g[column], g[f'r{h}']).statistic
               for _, g in T.dropna(subset=[f'r{h}', column]).groupby('date') if len(g) >= 10]
        ics = [i for i in ics if np.isfinite(i)]
        if ics:
            print(f'{h} sessions {column}: dates={len(ics)} meanIC={np.mean(ics):.3f}')

print('\nCounts: rows', len(df), '| passers', len(P), '| triggered', int(P.triggered.sum()),
      '| quality-A', int(P.qualityA.sum()), 'on', P[P.qualityA].date.nunique(), 'dates')

print('\n=== Exclusion ledger: every excluded window (ticker, signal date, horizon in sessions) ===')
print(ledger.sort_values(['ticker', 'signal_date', 'horizon']).to_string(index=False) if not ledger.empty else '(none)')
