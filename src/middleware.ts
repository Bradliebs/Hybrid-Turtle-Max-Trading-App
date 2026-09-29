import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { checkRateLimit, getRateLimitCategory, RATE_LIMITS } from '@/lib/rate-limit';

/**
 * Lightweight API auth middleware.
 * Protects all /api/* routes except whitelisted paths.
 * Uses the NextAuth JWT token to verify session — no DB call required.
 *
 * API auth is enforced by default. For local single-user desktop mode,
 * set DISABLE_API_AUTH=true in .env. This is safe because `npm start`
 * runs `next start -H 127.0.0.1`, which binds the dashboard to loopback
 * only (no LAN exposure). To deliberately expose to LAN, use
 * `npm run start:lan` and set a NEXTAUTH_SECRET to keep auth on.
 *
 * NOTE: DISABLE_API_AUTH does NOT bypass CRON_SECRET on cron endpoints
 * (see lib/api-response.ts verifyCronSecret). Cron endpoints stay
 * protected even in desktop mode.
 */

const PUBLIC_PATHS = [
  '/api/auth',        // NextAuth routes (login, callback, csrf, etc.)
  '/api/health',      // Health check endpoint
  '/api/heartbeat',   // Heartbeat (needed by LiveDataBootstrap on mount)
  '/api/db-status',   // Migration status check (needed by MigrationBanner on mount)
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname.startsWith(p));
}

export async function middleware(request: NextRequest) {
  // Local single-user mode: skip API auth when explicitly opted out via env var.
  // This is the default for HybridTurtle desktop deployments (start.bat).
  if (process.env.DISABLE_API_AUTH === 'true') {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  // Only protect /api/* routes
  if (!pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // Allow whitelisted paths through without auth
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Check for valid NextAuth JWT session token
  const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });

  if (!token) {
    return NextResponse.json(
      { error: 'Unauthorised' },
      { status: 401 }
    );
  }

  // Rate limiting for expensive endpoints
  const category = getRateLimitCategory(pathname, request.method);
  if (category) {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const rateLimitKey = `${category}:${ip}`;
    const limit = RATE_LIMITS[category];
    if (!checkRateLimit(rateLimitKey, limit.maxTokens, limit.refillPerSecond)) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429 }
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
