import { describe, expect, it } from 'vitest';
import { parseCommand } from './telegram-commands';

describe('parseCommand', () => {
  it('treats the removed AI and research commands as unknown', () => {
    for (const removed of ['/watchlist', '/feedback', '/analyst', '/news AAPL', '/ask hi', '/explain AAPL', '/scorecard']) {
      expect(parseCommand(removed)).toBe('unknown');
    }
  });

  it('parses existing commands correctly', () => {
    expect(parseCommand('/status')).toBe('/status');
    expect(parseCommand('/positions')).toBe('/positions');
    expect(parseCommand('/stopsdue')).toBe('/stopsdue');
    expect(parseCommand('/regime')).toBe('/regime');
    expect(parseCommand('/risk')).toBe('/risk');
    expect(parseCommand('/candidates')).toBe('/candidates');
    expect(parseCommand('/help')).toBe('/help');
    expect(parseCommand('/start')).toBe('/help');
    expect(parseCommand('/earnings')).toBe('/earnings');
    expect(parseCommand('/briefing')).toBe('/briefing');
    expect(parseCommand('/stops')).toBe('/stopsdue');
    expect(parseCommand('/backtest')).toBe('/backtest');
  });

  it('returns unknown for unrecognized commands', () => {
    expect(parseCommand('/foo')).toBe('unknown');
    expect(parseCommand('hello')).toBe('unknown');
    expect(parseCommand('')).toBe('unknown');
  });

  it('handles case-insensitive and extra whitespace', () => {
    expect(parseCommand('/STATUS')).toBe('/status');
    expect(parseCommand('  /positions  ')).toBe('/positions');
    expect(parseCommand('/EARNINGS  ')).toBe('/earnings');
  });
});
