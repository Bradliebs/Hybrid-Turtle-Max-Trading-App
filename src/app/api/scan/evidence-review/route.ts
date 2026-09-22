import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { buildCandidateEvidence } from '@/lib/typesafe-candidate-review';
import { reviewDatabasePath, TypesafeReviewSource } from '@/lib/typesafe-review-source';
import { isReviewWeekday, reviewDay, TypesafeReviewStore } from '@/lib/typesafe-review-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const scanIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: NextRequest) {
  const desktop = process.env.DISABLE_API_AUTH === 'true' && ['localhost', '127.0.0.1', '[::1]'].includes(request.nextUrl.hostname);
  const session = desktop ? null : await getServerSession(authOptions);
  const ownerId = desktop ? 'default-user' : session?.user?.id;
  if (!ownerId) return NextResponse.json({ error: 'Unauthorised' }, { status: 401, headers });
  const rawId = request.nextUrl.searchParams.get('scanId');
  const parsedId = rawId === null ? null : scanIdSchema.safeParse(rawId);
  if (parsedId && !parsedId.success) return NextResponse.json({ error: 'Invalid scan ID' }, { status: 400, headers });
  const scanId = parsedId?.success ? parsedId.data : null;
  const now = new Date();
  const empty = { scanId, reviews: [], usedToday: 0, dailyLimit: 20, lastRunAt: null };
  if (process.env.TYPESAFE_REVIEW_ENABLED !== 'true') return NextResponse.json({ ...empty, status: 'DISABLED' }, { headers });
  if (!process.env.TYPESAFE_API_KEY?.trim()) return NextResponse.json({ ...empty, status: 'MISSING_KEY' }, { headers });
  let source: TypesafeReviewSource | undefined;
  try {
    if (scanId) {
      source = new TypesafeReviewSource(reviewDatabasePath(process.env.DATABASE_URL));
      if (!source.ownsScan(scanId, ownerId)) return NextResponse.json({ error: 'Scan not found' }, { status: 404, headers });
    }
    const ledger = new TypesafeReviewStore().read();
    const latest = source?.latest(ownerId);
    const reviews = Object.values(ledger.reviews).filter(review => review.ownerId === ownerId && review.scanId === scanId).map(review => {
      const candidate = latest?.id === scanId ? latest.candidates.find(candidate => candidate.resultId === review.resultId) : null;
      const changed = candidate && review.inputHash !== buildCandidateEvidence(candidate.evidence).inputHash;
      const stale = !candidate || now.getTime() - Date.parse(review.scanTime) > 3_600_000 || Date.parse(review.scanTime) > now.getTime();
      return {
        ...review, ownerId: undefined, inputHash: undefined,
        status: changed ? 'CHANGED_EVIDENCE' : review.status,
        answer: stale || changed ? null : review.answer, stale,
      };
    });
    const lastRun = ledger.lastRun?.ownerId === ownerId ? ledger.lastRun : null;
    const status = !isReviewWeekday(now) ? 'WEEKEND'
      : !lastRun || now.getTime() - Date.parse(lastRun.at) > 30 * 60_000 ? 'WORKER_STALE'
      : ledger.cooldownUntil > now.getTime() ? 'PROVIDER_COOLDOWN' : lastRun.status;
    return NextResponse.json({
      scanId, status, reviews, usedToday: ledger.attempts.filter(attempt => attempt.day === reviewDay(now)).length,
      dailyLimit: 20, lastRunAt: lastRun?.at ?? null,
    }, { headers });
  } catch {
    return NextResponse.json({ ...empty, status: 'REVIEW_UNAVAILABLE' }, { status: 503, headers });
  } finally { source?.close(); }
}