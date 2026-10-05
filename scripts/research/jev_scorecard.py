"""
Read-only scorecard for Jev's shadow predictions (data/typesafe-review/shadow-predictions.jsonl).

Question: do Jev's TAKE/PASS pick and 20-day move call carry information about what
the stock did next? Jev's live role is a veto on A-grade buys (PASS probability at or
above JEV_VETO_PASS_PROBABILITY, default 0.6), so the decisive comparison is whether
candidates Jev would veto did worse than the ones it would allow.

Pre-registered on 2026-10-05, before any 20-session outcome for these predictions
existed (first ones mature around 21-28 October). Do not change these rules after
looking at results; write a new version instead.
  * Unit: one real prediction per (ticker, scan date); the first of the day is kept.
    Synthetic TEST rows are dropped.
  * Population for the primary metrics: A-grade candidates only (ScanResult.grade =
    A_GRADE_BUY for the reviewed resultId). Only these can be vetoed; on B-grade or
    chase candidates a PASS just repeats the scanner's own verdict, so including them
    would measure the grade, not Jev.
  * Outcome: CandidateOutcome.fwdReturn20d joined exactly on (scanId, ticker).
    5- and 10-session returns are shown as descriptive context only.
  * Primary metric 1 (the live veto): mean 20-session return of would-be-vetoed
    predictions (PASS >= threshold) minus would-be-allowed, with a 95% bootstrap
    interval that resamples whole scan dates (predictions on one date share the
    market move). Gate: at least 30 distinct scan dates with matured outcomes in BOTH
    groups, and an interval that excludes zero.
  * Primary metric 2 (added the same day, also before any outcome, because metric 1
    is unreachable while Jev never reaches the veto threshold on A-grades): Spearman
    correlation of P(PASS) with the 20-session return, 95% date-bootstrap interval.
    Gate: at least 30 distinct scan dates; Jev is informative only if the interval
    lies wholly below zero (higher PASS probability, lower return).
  * Anything short of a gate prints INSUFFICIENT EVIDENCE. Passing a gate justifies a
    decision by the owner, not an automatic change.
  * Descriptive: Spearman of the move20d score with the 20-session return.

Uses stored forward returns only (not path metrics such as MFE or stopHit).

Usage (requires pandas, numpy, scipy):
  python scripts/research/jev_scorecard.py [prisma/dev.db] [shadow.jsonl] [pass_threshold]
"""
import json
import sqlite3
import sys

import numpy as np
import pandas as pd
from scipy import stats

DB = sys.argv[1] if len(sys.argv) > 1 else 'prisma/dev.db'
SHADOW = sys.argv[2] if len(sys.argv) > 2 else 'data/typesafe-review/shadow-predictions.jsonl'
THRESHOLD = float(sys.argv[3]) if len(sys.argv) > 3 else 0.6
MIN_DATES = 30
BOOTSTRAPS = 5000
GRADES = {'A_GRADE_BUY': 'A', 'B_GRADE_WATCH': 'B', 'BLOCKED_CHASE': 'CHASE'}

con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
con.execute('PRAGMA query_only = ON')
stored_grades = dict(con.execute('select id, grade from ScanResult where grade is not null').fetchall())

with open(SHADOW, encoding='utf-8') as handle:
    raw = [json.loads(line) for line in handle if line.strip()]
shadow = pd.DataFrame([{
    'scanId': row['scanId'], 'ticker': row['ticker'], 'scanTime': row['scanTime'],
    'grade': GRADES.get(stored_grades.get(row['resultId']), 'OTHER' if row['resultId'] in stored_grades else 'UNKNOWN'),
    'pick': row['pick']['choice'], 'pTake': row['pick']['probabilities']['TAKE'],
    'pPass': row['pick']['probabilities']['PASS'], 'move20d': row['move20d']['score'],
} for row in raw if row.get('ticker') != 'TEST'])
if shadow.empty:
    sys.exit('No real shadow predictions found.')
shadow['scanDay'] = pd.to_datetime(shadow.scanTime, utc=True).dt.date
shadow = shadow.sort_values('scanTime').drop_duplicates(['ticker', 'scanDay'], keep='first')

outcomes = pd.read_sql('select scanId, ticker, fwdReturn5d, fwdReturn10d, fwdReturn20d from CandidateOutcome', con)
df = shadow.merge(outcomes.drop_duplicates(['scanId', 'ticker']), on=['scanId', 'ticker'], how='left')
df['veto'] = df.pPass >= THRESHOLD

print(f'Jev shadow scorecard  (veto threshold PASS >= {THRESHOLD})')
print(f'Prediction lines: {len(raw)} -> {len(shadow)} unique real (ticker, day); '
      f'{shadow.scanDay.nunique()} scan dates, {shadow.scanDay.min()}..{shadow.scanDay.max()}')
print('Pick by stored grade:', df.groupby(['grade', 'pick']).size().to_dict())
for horizon in ('fwdReturn5d', 'fwdReturn10d', 'fwdReturn20d'):
    matured = df.dropna(subset=[horizon])
    line = f'{horizon}: matured {len(matured)}'
    for grade, group in matured.groupby('grade'):
        for label, part in (('veto', group[group.veto]), ('allow', group[~group.veto])):
            if len(part):
                line += f' | {grade}-{label} n={len(part)} mean={part[horizon].mean():+.2f}%'
    print(line)

matured = df[df.grade == 'A'].dropna(subset=['fwdReturn20d'])
veto, allow = matured[matured.veto], matured[~matured.veto]
dates_veto, dates_allow = veto.scanDay.nunique(), allow.scanDay.nunique()
print(f'\nPrimary 1 (A-grade, veto minus allow, 20 sessions): veto dates={dates_veto}, allow dates={dates_allow} (need {MIN_DATES} each)')
if len(veto) and len(allow):
    diff = veto.fwdReturn20d.mean() - allow.fwdReturn20d.mean()
    rng = np.random.default_rng(20261005)
    days = matured.scanDay.unique()
    by_day = {day: group for day, group in matured.groupby('scanDay')}
    samples = []
    for _ in range(BOOTSTRAPS):
        pick = pd.concat([by_day[day] for day in rng.choice(days, len(days), replace=True)])
        v, a = pick[pick.veto].fwdReturn20d, pick[~pick.veto].fwdReturn20d
        if len(v) and len(a):
            samples.append(v.mean() - a.mean())
    low, high = np.percentile(samples, [2.5, 97.5])
    print(f'Veto minus allow: {diff:+.2f}%  95% date-bootstrap interval [{low:+.2f}%, {high:+.2f}%]')
    if dates_veto >= MIN_DATES and dates_allow >= MIN_DATES and (high < 0 or low > 0):
        verdict = 'VETO HELPS' if high < 0 else 'VETO HURTS'
        print(f'Verdict: {verdict} (evidence gate met; owner decision required before any live change)')
    else:
        print('Verdict: INSUFFICIENT EVIDENCE')
else:
    print('Verdict: INSUFFICIENT EVIDENCE (no matured outcomes in one or both groups)')

a_all = df[df.grade == 'A']
print(f'\nA-grade predictions: {len(a_all)}; highest PASS probability {a_all.pPass.max():.0%}' if len(a_all) else '\nA-grade predictions: 0')
dates = matured.scanDay.nunique()
print(f'Primary 2 (A-grade, Spearman P(PASS) vs 20-session return): dates={dates} (need {MIN_DATES})')
if len(matured) >= 10 and matured.pPass.nunique() > 1:
    rho = stats.spearmanr(matured.pPass, matured.fwdReturn20d).statistic
    rng = np.random.default_rng(20261006)
    days = matured.scanDay.unique()
    by_day = {day: group for day, group in matured.groupby('scanDay')}
    samples = []
    for _ in range(BOOTSTRAPS):
        pick = pd.concat([by_day[day] for day in rng.choice(days, len(days), replace=True)])
        if pick.pPass.nunique() > 1:
            samples.append(stats.spearmanr(pick.pPass, pick.fwdReturn20d).statistic)
    low, high = np.nanpercentile(samples, [2.5, 97.5])
    print(f'rho={rho:+.3f}  95% date-bootstrap interval [{low:+.3f}, {high:+.3f}]  n={len(matured)}')
    print('Verdict: PASS PROBABILITY INFORMATIVE (owner decision required before any live change)'
          if dates >= MIN_DATES and high < 0 else 'Verdict: INSUFFICIENT EVIDENCE')
    move = stats.spearmanr(matured.move20d, matured.fwdReturn20d).statistic
    print(f'Descriptive: Spearman move20d vs 20-session return {move:+.3f}')
else:
    print('Verdict: INSUFFICIENT EVIDENCE (fewer than 10 matured A-grade predictions)')
