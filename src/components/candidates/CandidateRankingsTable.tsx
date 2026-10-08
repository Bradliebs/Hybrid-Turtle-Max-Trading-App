import Link from 'next/link';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { cn, formatPrice } from '@/lib/utils';
import type { CandidateListView } from '../../../packages/signals/src';

type SortBy = CandidateListView['sortBy'];
type Direction = CandidateListView['direction'];

const columns: Array<{ key: SortBy; label: string; className?: string }> = [
  { key: 'symbol', label: 'Symbol' },
  { key: 'setupStatus', label: 'Status' },
  { key: 'currentPrice', label: 'Current', className: 'text-right' },
  { key: 'triggerPrice', label: 'Trigger', className: 'text-right' },
  { key: 'stopDistancePercent', label: 'Stop %', className: 'text-right' },
  { key: 'rankScore', label: 'Rank', className: 'text-right' },
];

function nextDirection(active: boolean, current: Direction): Direction {
  if (!active) {
    return 'desc';
  }
  return current === 'desc' ? 'asc' : 'desc';
}

function SortLink({ sortBy, activeSortBy, direction }: { sortBy: SortBy; activeSortBy: SortBy; direction: Direction }) {
  const active = sortBy === activeSortBy;
  const href = `/candidates?sortBy=${sortBy}&direction=${nextDirection(active, direction)}`;

  return (
    <Link href={href} className="inline-flex items-center gap-1 hover:text-primary-400 transition-colors">
      <span>{columns.find((column) => column.key === sortBy)?.label ?? sortBy}</span>
      {active ? direction === 'desc' ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" /> : null}
    </Link>
  );
}

export default function CandidateRankingsTable({ view }: { view: CandidateListView }) {
  return (
    <div className="card-surface overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Ranked Candidates</h2>
          <p className="text-sm text-muted-foreground">Persisted next-session candidates sorted from the latest scan run.</p>
        </div>
        <div className="text-sm text-muted-foreground">{view.totalCandidates} candidates</div>
      </div>

      <div className="overflow-x-auto">
        <table className="data-table min-w-[1100px]">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} className={column.className}>
                  <SortLink sortBy={column.key} activeSortBy={view.sortBy} direction={view.direction} />
                </th>
              ))}
              <th>Reasons</th>
              <th>Warnings</th>
            </tr>
          </thead>
          <tbody>
            {view.items.map((candidate) => (
              <tr key={candidate.symbol}>
                <td className="font-semibold text-primary-400">
                  {candidate.symbol}
                </td>
                <td>
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border',
                      candidate.setupStatus === 'READY_NEXT_SESSION' || candidate.setupStatus === 'READY_ON_TRIGGER'
                        ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
                        : candidate.setupStatus === 'EARLY_BIRD'
                          ? 'border-sky-500/30 bg-sky-500/15 text-sky-300'
                          : candidate.setupStatus === 'WATCH'
                            ? 'border-amber-500/30 bg-amber-500/15 text-amber-300'
                            : 'border-border bg-navy-800 text-muted-foreground',
                    )}
                  >
                    {candidate.setupStatus}
                  </span>
                </td>
                <td className="text-right font-mono">{formatPrice(candidate.currentPrice, 'USD')}</td>
                <td className="text-right font-mono text-primary-400">{formatPrice(candidate.triggerPrice, 'USD')}</td>
                <td className="text-right font-mono">{candidate.stopDistancePercent.toFixed(2)}%</td>
                <td className="text-right font-mono font-semibold">{candidate.rankScore.toFixed(1)}</td>
                <td className="max-w-[360px]">
                  <ul className="space-y-1 text-sm text-foreground list-disc pl-4">
                    {candidate.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </td>
                <td className="max-w-[300px]">
                  {candidate.warnings.length > 0 ? (
                    <ul className="space-y-1 text-sm text-amber-300 list-disc pl-4">
                      {candidate.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-sm text-muted-foreground">None</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}