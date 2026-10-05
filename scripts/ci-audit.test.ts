import { describe, expect, it } from 'vitest';
import { ALLOWLIST, blockingAdvisories } from './ci-audit.mjs';

const advisory = (url: string, severity = 'high') => ({ source: 1, name: 'x', url, severity, title: 'test advisory' });

describe('ci-audit', () => {
  const allowed = Object.keys(ALLOWLIST)[0];
  const report = (via: unknown[]) => ({ vulnerabilities: { pkg: { severity: 'high', via } } });

  it('ignores an allowlisted advisory before its review date and chained package entries', () => {
    const findings = blockingAdvisories(
      { vulnerabilities: {
        braces: { severity: 'high', via: [advisory(`https://github.com/advisories/${allowed}`)] },
        micromatch: { severity: 'high', via: ['braces'] },
      } },
      new Date('2026-10-05'),
    );
    expect(findings).toEqual([]);
  });

  it('blocks the allowlisted advisory again after its review date', () => {
    const findings = blockingAdvisories(report([advisory(`https://github.com/advisories/${allowed}`)]), new Date('2099-01-01'));
    expect(findings).toHaveLength(1);
    expect(findings[0].expired).toBe(true);
  });

  it('blocks any other high or critical advisory and ignores moderate/low', () => {
    expect(blockingAdvisories(report([advisory('https://github.com/advisories/GHSA-aaaa-bbbb-cccc', 'critical')]))).toHaveLength(1);
    expect(blockingAdvisories(report([advisory('https://github.com/advisories/GHSA-aaaa-bbbb-cccc', 'moderate')]))).toEqual([]);
  });
});
