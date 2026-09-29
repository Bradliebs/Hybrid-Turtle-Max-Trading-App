import { describe, expect, it } from 'vitest';
import { checkRateLimit, getRateLimitCategory } from './rate-limit';

describe('rate-limit', () => {
  describe('checkRateLimit', () => {
    it('allows requests up to the token limit', () => {
      const key = 'test-allow-' + Date.now();
      // maxTokens=3, refill 1/sec
      expect(checkRateLimit(key, 3, 1)).toBe(true);
      expect(checkRateLimit(key, 3, 1)).toBe(true);
      expect(checkRateLimit(key, 3, 1)).toBe(true);
      // 4th request should be blocked (no time to refill)
      expect(checkRateLimit(key, 3, 1)).toBe(false);
    });

    it('uses separate buckets per key', () => {
      const keyA = 'bucket-a-' + Date.now();
      const keyB = 'bucket-b-' + Date.now();
      expect(checkRateLimit(keyA, 1, 0.01)).toBe(true);
      expect(checkRateLimit(keyA, 1, 0.01)).toBe(false);
      // keyB should still have tokens
      expect(checkRateLimit(keyB, 1, 0.01)).toBe(true);
    });
  });

  describe('getRateLimitCategory', () => {
    it('classifies execute endpoints', () => {
      expect(getRateLimitCategory('/api/positions/execute')).toBe('execute');
    });

    it('classifies heavy endpoints', () => {
      expect(getRateLimitCategory('/api/nightly')).toBe('heavy');
      expect(getRateLimitCategory('/api/scan')).toBe('heavy');
      expect(getRateLimitCategory('/api/workflow/tonight')).toBe('heavy');
    });

    it('does not rate-limit scan cache', () => {
      expect(getRateLimitCategory('/api/scan/cache')).toBeNull();
    });

    it('limits scan runs but not scan reads such as progress polling', () => {
      expect(getRateLimitCategory('/api/scan', 'POST')).toBe('heavy');
      expect(getRateLimitCategory('/api/scan/live-prices', 'POST')).toBe('heavy');
      expect(getRateLimitCategory('/api/scan/progress', 'GET')).toBeNull();
      expect(getRateLimitCategory('/api/scan', 'get')).toBeNull();
      expect(getRateLimitCategory('/api/scan/scores', 'GET')).toBeNull();
    });

    it('keeps execute and nightly limits regardless of method', () => {
      expect(getRateLimitCategory('/api/positions/execute', 'GET')).toBe('execute');
      expect(getRateLimitCategory('/api/nightly', 'GET')).toBe('heavy');
    });

    it('returns null for normal endpoints', () => {
      expect(getRateLimitCategory('/api/settings')).toBeNull();
      expect(getRateLimitCategory('/api/portfolio')).toBeNull();
    });
  });
});
