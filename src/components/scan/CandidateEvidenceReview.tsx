'use client';

import { useEffect, useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { z } from 'zod';

const viewSchema = z.object({
  scanId: z.string().nullable(), status: z.string(), usedToday: z.number(), dailyLimit: z.number(),
  lastRunAt: z.string().nullable(),
  reviews: z.array(z.object({
    resultId: z.string(), ticker: z.string(), status: z.string(), stale: z.boolean(),
    claim: z.string().nullable(), flags: z.array(z.string()), scanTime: z.string(), reviewedAt: z.string(),
    answer: z.object({
      choice: z.string(), confidence: z.number(), model: z.string(),
      probabilities: z.record(z.string(), z.number()),
    }).nullable(),
  })),
});
type ReviewView = z.infer<typeof viewSchema>;
const labels: Record<string, string> = {
  DISABLED: 'Disabled', MISSING_KEY: 'API key not configured', REVIEW_UNAVAILABLE: 'Review unavailable',
  WORKER_STALE: 'Worker has not checked recently', WEEKEND: 'Paused for weekend',
  PROVIDER_COOLDOWN: 'Provider cooldown', PROVIDER_UNAVAILABLE: 'Provider unavailable',
  COMPLETE: 'Review complete', NO_NEW_CANDIDATES: 'No new candidates', NO_SNAPSHOT: 'No scan available',
  NO_RECENT_SETTLED_SNAPSHOT: 'Awaiting a recent completed scan', INCOMPLETE_EVIDENCE: 'Incomplete evidence',
  BUDGET_EXHAUSTED: 'Daily request limit reached', INSUFFICIENT_EVIDENCE: 'Insufficient evidence',
  CHANGED_EVIDENCE: 'Evidence changed since review', RESERVED: 'Request outcome not yet recorded',
  UNAVAILABLE: 'Assessment unavailable', SUPPORTED: 'Supported by supplied evidence',
  CONTRADICTED: 'Contradicted by supplied evidence', MIXED: 'Mixed evidence',
};
function label(value: string): string { return labels[value] ?? value.replaceAll('_', ' ').toLowerCase(); }

export default function CandidateEvidenceReview({ scanId }: { scanId?: string | null }) {
  const [view, setView] = useState<ReviewView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let controller: AbortController | undefined;
    setView(null);
    setFailed(false);
    const refresh = async () => {
      if (document.hidden) return;
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(`/api/scan/evidence-review${scanId ? `?scanId=${encodeURIComponent(scanId)}` : ''}`, {
          signal: controller.signal, cache: 'no-store',
        });
        const parsed = viewSchema.safeParse(await response.json());
        if (!active) return;
        if (!parsed.success || parsed.data.scanId !== (scanId ?? null)) throw new Error('Invalid review view');
        setView(parsed.data);
        setFailed(!response.ok);
      } catch (error) {
        if (active && !(error instanceof Error && error.name === 'AbortError')) { setFailed(true); setView(null); }
      }
    };
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 60_000);
    const onVisibility = () => { if (document.hidden) controller?.abort(); else void refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { active = false; controller?.abort(); clearInterval(interval); document.removeEventListener('visibilitychange', onVisibility); };
  }, [scanId]);
  const current = view?.scanId === (scanId ?? null) ? view : null;
  return (
    <section aria-label="Typesafe evidence review" className="border-y border-border py-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ClipboardCheck aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          Typesafe evidence review <span className="font-normal text-muted-foreground">Advisory</span>
        </h2>
        <p role="status" className="text-xs text-muted-foreground">
          {failed ? 'Review unavailable' : current ? label(current.status) : 'Checking review status'}
          {current && ` | ${current.usedToday}/${current.dailyLimit} requests today`}
        </p>
      </div>
      {!scanId && <p className="text-xs text-muted-foreground">No persisted scan selected</p>}
      {scanId && current && current.reviews.length === 0 && <p className="text-xs text-muted-foreground">No assessment for this scan</p>}
      {current?.reviews.map(review => (
        <details key={review.resultId} className="border-t border-border pt-2 text-sm">
          <summary className="cursor-pointer flex flex-wrap items-center gap-x-4 gap-y-1 py-1">
            <span className="font-semibold">{review.ticker}</span>
            <span className={review.answer?.choice === 'CONTRADICTED' || review.answer?.choice === 'MIXED' ? 'text-warning' : 'text-muted-foreground'}>
              {review.stale ? 'Stale scan-time review' : label(review.answer?.choice ?? review.status)}
            </span>
            {review.answer && <span className="text-xs text-muted-foreground">Model confidence {review.answer.confidence.toFixed(2)}</span>}
          </summary>
          <div className="pl-2 py-2 space-y-2 text-xs text-muted-foreground break-words">
            <p>Scan: {new Date(review.scanTime).toLocaleString()} | Reviewed: {new Date(review.reviewedAt).toLocaleString()}</p>
            {review.claim && <blockquote className="border-l-2 border-border pl-3 text-foreground">{review.claim}</blockquote>}
            {review.flags.map(flag => <p key={flag}>{label(flag)}</p>)}
            {review.answer && <>
              <p>{review.answer.model} | Confidence is not a trade-success probability.</p>
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 max-w-lg">
                {Object.entries(review.answer.probabilities).map(([name, value]) => (
                  <div className="contents" key={name}><dt>{label(name)}</dt><dd>{value.toFixed(2)}</dd></div>
                ))}
              </dl>
            </>}
          </div>
        </details>
      ))}
    </section>
  );
}