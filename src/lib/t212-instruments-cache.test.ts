import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { T212Instrument } from './trading212';
import {
  getT212LineCurrency,
  indexInstruments,
  isKnownT212Ticker,
  loadT212InstrumentsCache,
  writeT212InstrumentsCache,
} from './t212-instruments-cache';

function makeInstrument(overrides: Partial<T212Instrument>): T212Instrument {
  return {
    ticker: 'AAPL_US_EQ',
    shortName: 'AAPL',
    isin: 'US0378331005',
    currencyCode: 'USD',
    name: 'Apple Inc.',
    type: 'STOCK',
    maxOpenQuantity: 1000,
    addedOn: '2020-01-01',
    ...overrides,
  };
}

describe('indexInstruments', () => {
  it('indexes by full T212 ticker for O(1) hot-path lookups', () => {
    const idx = indexInstruments(
      [
        makeInstrument({ ticker: 'AAPL_US_EQ' }),
        makeInstrument({ ticker: 'RBOTl_EQ' }),
      ],
      new Date(),
    );
    expect(idx.byT212Ticker.has('AAPL_US_EQ')).toBe(true);
    expect(idx.byT212Ticker.has('RBOTl_EQ')).toBe(true);
    expect(idx.byT212Ticker.has('NOPE')).toBe(false);
  });

  it('groups listings under the stripped bare ticker', () => {
    // Cross-listed example: AZN exists in both US ADR and LSE forms.
    // Stripping the suffix on US gives 'AZN', on LSE gives 'AZNl' (lowercase-l)
    // — so byBareTicker treats them as separate keys. byShortName collapses
    // them onto the canonical 'AZN'.
    const idx = indexInstruments(
      [
        makeInstrument({ ticker: 'AZN_US_EQ', shortName: 'AZN', currencyCode: 'USD' }),
        makeInstrument({ ticker: 'AZNl_EQ', shortName: 'AZN', currencyCode: 'GBX' }),
      ],
      new Date(),
    );
    // byBareTicker: separate keys per stripped suffix
    expect(idx.byBareTicker.get('AZN')).toHaveLength(1);
    expect(idx.byBareTicker.get('AZNl')).toHaveLength(1);
    // byShortName: collapsed onto the canonical bare display ticker
    const azn = idx.byShortName.get('AZN');
    expect(azn).toHaveLength(2);
    expect(azn?.map((i) => i.currencyCode).sort()).toEqual(['GBX', 'USD']);
  });

  it('byShortName uppercases the key', () => {
    const idx = indexInstruments(
      [makeInstrument({ ticker: 'aapl_us_eq', shortName: 'aapl' })],
      new Date(),
    );
    expect(idx.byShortName.get('AAPL')).toHaveLength(1);
  });

  it('omits byShortName entries when the instrument lacks shortName', () => {
    const idx = indexInstruments(
      [makeInstrument({ ticker: 'WEIRD_EQ', shortName: undefined })],
      new Date(),
    );
    expect(idx.byShortName.size).toBe(0);
    // Still indexed by bare ticker.
    expect(idx.byBareTicker.has('WEIRD')).toBe(true);
  });

  it('skips instruments with no ticker', () => {
    const idx = indexInstruments(
      [makeInstrument({ ticker: '' as unknown as string })],
      new Date(),
    );
    expect(idx.byT212Ticker.size).toBe(0);
  });
});

describe('isKnownT212Ticker', () => {
  const lookup = indexInstruments(
    [makeInstrument({ ticker: 'AAPL_US_EQ' })],
    new Date(),
  );

  it('returns true when the ticker is present', () => {
    expect(isKnownT212Ticker(lookup, 'AAPL_US_EQ')).toBe(true);
  });

  it('returns false when the cache is loaded but the ticker is absent', () => {
    expect(isKnownT212Ticker(lookup, 'GHOST_US_EQ')).toBe(false);
  });

  it('returns null when the cache is missing — caller must fall back', () => {
    expect(isKnownT212Ticker(null, 'AAPL_US_EQ')).toBeNull();
  });
});

describe('loadT212InstrumentsCache + writeT212InstrumentsCache', () => {
  let tmpDir: string;
  let cachePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't212-cache-'));
    cachePath = path.join(tmpDir, 't212-instruments.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips: write then load returns equivalent index', () => {
    writeT212InstrumentsCache(
      [makeInstrument({ ticker: 'AAPL_US_EQ' }), makeInstrument({ ticker: 'GOOGL_US_EQ' })],
      cachePath,
    );
    const loaded = loadT212InstrumentsCache(cachePath);
    expect(loaded).not.toBeNull();
    expect(loaded?.count).toBe(2);
    expect(loaded?.byT212Ticker.has('AAPL_US_EQ')).toBe(true);
    expect(loaded?.byT212Ticker.has('GOOGL_US_EQ')).toBe(true);
  });

  it('getT212LineCurrency reads the line currency even from an old snapshot', () => {
    writeT212InstrumentsCache([makeInstrument({ ticker: 'VUAGl_EQ', currencyCode: 'GBP' })], cachePath);
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    raw.fetchedAt = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(cachePath, JSON.stringify(raw), 'utf8');
    expect(getT212LineCurrency('VUAGl_EQ', cachePath)).toBe('GBP');
    expect(getT212LineCurrency('GHOSTl_EQ', cachePath)).toBeNull();
    expect(getT212LineCurrency('VUAGl_EQ', path.join(tmpDir, 'missing.json'))).toBeNull();
  });

  it('returns null when the cache file is missing', () => {
    expect(loadT212InstrumentsCache(path.join(tmpDir, 'no-such-file.json'))).toBeNull();
  });

  it('returns null when the cache file is corrupt JSON', () => {
    fs.writeFileSync(cachePath, '{ not json', 'utf8');
    expect(loadT212InstrumentsCache(cachePath)).toBeNull();
  });

  it('returns null when the cache file is missing required fields', () => {
    fs.writeFileSync(cachePath, JSON.stringify({ instruments: [] }), 'utf8');
    expect(loadT212InstrumentsCache(cachePath)).toBeNull();
  });

  it('returns null when the cache is older than maxAgeMs', () => {
    writeT212InstrumentsCache([makeInstrument({})], cachePath);
    // Force the file's logical age forward by rewriting fetchedAt to long ago.
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    raw.fetchedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(cachePath, JSON.stringify(raw), 'utf8');
    // 1 day max age → 30 days old → null.
    expect(loadT212InstrumentsCache(cachePath, 24 * 60 * 60 * 1000)).toBeNull();
  });

  it('writes via tmp+rename so concurrent readers never see partial files', () => {
    writeT212InstrumentsCache([makeInstrument({})], cachePath);
    // Verify only the final file exists (no stray .tmp).
    const entries = fs.readdirSync(tmpDir);
    expect(entries).toContain('t212-instruments.json');
    expect(entries.filter((e) => e.endsWith('.tmp'))).toHaveLength(0);
  });
});
