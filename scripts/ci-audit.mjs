// CI dependency audit: fails on any high or critical advisory except those in
// ALLOWLIST below. Each allowlisted advisory needs a reason and a review date;
// after that date it fails again, so an exception cannot be forgotten.
//
// Usage: node scripts/ci-audit.mjs            (runs `npm audit --json`)
//        node scripts/ci-audit.mjs audit.json (reads a saved report; used by tests)
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ALLOWLIST = {
  'GHSA-vfj7-8cjw-p6xm': {
    reason: 'braces <=3.0.3 stack-exhaustion DoS; no patched version exists. Reached only through '
      + 'tailwindcss/fast-glob build-time globbing of our own config patterns, not untrusted input. '
      + 'The only npm fix is a breaking Tailwind v4 migration.',
    reviewBy: '2027-01-05',
  },
};

const BLOCKING = new Set(['high', 'critical']);

/** Returns blocking findings: high/critical advisories that are not (validly) allowlisted. */
export function blockingAdvisories(report, today = new Date()) {
  const findings = [];
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      // String entries point at another package; its own advisory objects are checked there.
      if (typeof via !== 'object' || !BLOCKING.has(via.severity)) continue;
      const id = String(via.url ?? '').match(/GHSA-[\w-]+/)?.[0] ?? via.url ?? `${name}:${via.title}`;
      const allowed = ALLOWLIST[id];
      if (allowed && today <= new Date(`${allowed.reviewBy}T23:59:59Z`)) continue;
      findings.push({ package: name, id, severity: via.severity, title: via.title,
        expired: Boolean(allowed) });
    }
  }
  return findings;
}

function readReport(path) {
  if (path) return JSON.parse(readFileSync(path, 'utf8'));
  try {
    return JSON.parse(execSync('npm audit --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    // npm audit exits non-zero when it finds anything; the JSON is still on stdout.
    if (error.stdout) return JSON.parse(error.stdout);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const findings = blockingAdvisories(readReport(process.argv[2]));
  for (const [id, entry] of Object.entries(ALLOWLIST)) {
    console.log(`[ci-audit] allowlisted ${id} until ${entry.reviewBy}: ${entry.reason}`);
  }
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`[ci-audit] ${finding.severity.toUpperCase()} ${finding.id} in ${finding.package}: ${finding.title}`
        + (finding.expired ? ' (allowlist review date passed)' : ''));
    }
    process.exit(1);
  }
  console.log('[ci-audit] OK: no blocking high/critical advisories.');
}
