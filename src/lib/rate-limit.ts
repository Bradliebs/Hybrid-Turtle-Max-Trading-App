/**
 * DEPENDENCIES
 * Consumed by: middleware.ts
 * Risk-sensitive: YES — prevents abuse of execution and cron endpoints
 * Notes: Simple in-memory sliding-window rate limiter.
 *        NOT suitable for multi-instance deployments (use Redis instead).
 *        Keyed by IP address from x-forwarded-for or socket.
 */

interface RateBucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, RateBucket>();

// Clean up stale buckets every 5 minutes to prevent memory leak
const CLEANUP_INTERVAL = 5 * 60 * 1000;
const BUCKET_TTL = 10 * 60 * 1000; // Remove buckets inactive for 10 minutes

let lastCleanup = Date.now();

function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefill > BUCKET_TTL) {
      buckets.delete(key);
    }
  }
}

/**
 * Check if a request should be rate-limited.
 * @returns true if allowed, false if rate-limited.
 */
export function checkRateLimit(
  key: string,
  maxTokens: number,
  refillPerSecond: number
): boolean {
  cleanup();
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    bucket = { tokens: maxTokens - 1, lastRefill: now };
    buckets.set(key, bucket);
    return true;
  }

  // Refill tokens based on elapsed time
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(maxTokens, bucket.tokens + elapsed * refillPerSecond);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }

  return false;
}

/** Rate limit profiles for different endpoint categories */
export const RATE_LIMITS = {
  /** Execution endpoints — 5 requests per minute */
  execute: { maxTokens: 5, refillPerSecond: 5 / 60 },
  /** Scan/nightly/workflow — 3 requests per minute */
  heavy: { maxTokens: 3, refillPerSecond: 3 / 60 },
  /** Registration — 5 per 10 minutes */
  register: { maxTokens: 5, refillPerSecond: 5 / 600 },
} as const;

/**
 * Classify a request into a rate limit category.
 * Returns null for requests that don't need rate limiting.
 * Scan reads (GET: cached results, progress polling, scores) are not limited —
 * the Scan page polls progress every 0.8s during a run, which a 3/min budget
 * would block. Only scan runs and other writes count as heavy.
 */
export function getRateLimitCategory(pathname: string, method?: string): keyof typeof RATE_LIMITS | null {
  if (pathname.startsWith('/api/positions/execute')) return 'execute';
  if (pathname.startsWith('/api/nightly')) return 'heavy';
  if (pathname.startsWith('/api/scan') && !pathname.includes('cache') && method?.toUpperCase() !== 'GET') return 'heavy';
  if (pathname.startsWith('/api/workflow')) return 'heavy';
  if (pathname.startsWith('/api/auth') && pathname.includes('register')) return 'register';
  return null;
}
