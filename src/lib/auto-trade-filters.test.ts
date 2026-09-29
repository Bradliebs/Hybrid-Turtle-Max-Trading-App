import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JEV_VETO_PASS_PROBABILITY, ETF_ONLY_SKIP_REASON, jevLogPhase, partitionEtfOnly,
  partitionJevVerdicts, readJevGateConfig, type JevVerdict,
} from './auto-trade-filters';

const c = (ticker: string, sleeve = 'CORE') => ({ ticker, sleeve, rankScore: 1 });
const allow: JevVerdict = { action: 'ALLOW', reviewed: true, reason: 'Jev allow' };
const veto: JevVerdict = { action: 'VETO', reviewed: true, reason: 'Jev veto: PASS (80% pass)' };
const skipped: JevVerdict = { action: 'ALLOW', reviewed: false, reason: 'Jev not consulted: lock busy' };

describe('ETF-only partition', () => {
  it('keeps only ETFs, preserves rank order and reports each skipped stock', () => {
    const result = partitionEtfOnly([c('SPY', 'ETF'), c('AAPL'), c('QQQ', 'ETF'), c('TSLA', 'HIGH_RISK')]);
    expect(result.kept.map(x => x.ticker)).toEqual(['SPY', 'QQQ']);
    expect(result.skipped).toEqual([
      { ticker: 'AAPL', reason: ETF_ONLY_SKIP_REASON },
      { ticker: 'TSLA', reason: ETF_ONLY_SKIP_REASON },
    ]);
  });
  it('never adds candidates', () => {
    const input = [c('AAPL')];
    expect(partitionEtfOnly(input).kept.length).toBeLessThanOrEqual(input.length);
    expect(partitionEtfOnly([]).kept).toEqual([]);
  });
});

describe('Jev verdict partition', () => {
  it('removes only explicit vetoes and preserves order', () => {
    const verdicts = new Map([['A', allow], ['B', veto], ['C', skipped]]);
    const result = partitionJevVerdicts([c('A'), c('B'), c('C'), c('D')], verdicts);
    expect(result.kept.map(x => x.ticker)).toEqual(['A', 'C', 'D']);
    expect(result.vetoed).toEqual([{ ticker: 'B', reason: veto.reason }]);
  });
  it('keeps every candidate when there are no verdicts (fail-open)', () => {
    expect(partitionJevVerdicts([c('A'), c('B')], new Map()).kept).toHaveLength(2);
  });
});

describe('Jev audit phase', () => {
  it('separates reviewed allows from unreviewed skips', () => {
    expect(jevLogPhase(veto)).toBe('JEV_VETO');
    expect(jevLogPhase(allow)).toBe('JEV_ALLOW');
    expect(jevLogPhase(skipped)).toBe('JEV_SKIPPED');
  });
});

describe('Jev gate config (dependency-free)', () => {
  it('requires both flags and clamps the threshold', () => {
    expect(readJevGateConfig({ JEV_AUTO_TRADE_GATE: 'veto' }).enabled).toBe(false);
    expect(readJevGateConfig({ JEV_AUTO_TRADE_GATE: 'veto', TYPESAFE_REVIEW_ENABLED: 'true' }).enabled).toBe(true);
    expect(readJevGateConfig({ JEV_VETO_PASS_PROBABILITY: '0.2' }).passThreshold).toBe(DEFAULT_JEV_VETO_PASS_PROBABILITY);
  });
});
