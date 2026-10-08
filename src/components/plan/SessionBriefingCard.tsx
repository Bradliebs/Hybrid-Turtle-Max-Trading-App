'use client';

import { useSessionBriefing } from '@/hooks/useSessionBriefing';
import { cn } from '@/lib/utils';
import { Briefcase, TrendingUp, AlertTriangle, Clock } from 'lucide-react';

const FLAG: Record<string, string> = { 'pre-UK': '🇬🇧', UK: '🇬🇧', US: '🇺🇸', 'post-market': '🌙' };
const SESSION_LABEL: Record<string, string> = {
  'pre-UK': 'Pre-UK Session',
  UK: 'UK Session',
  US: 'US Session',
  'post-market': 'Post-Market',
};

export interface BriefingCandidate {
  ticker: string;
  status: string;
}

export default function SessionBriefingCard({ candidates = [] }: { candidates?: BriefingCandidate[] }) {
  const { data, loading, error, refresh } = useSessionBriefing();

  if (loading) return null; // Don't show loading state — TodayPanel already shows it
  if (error || !data) return null;

  const isUKSession = data.session === 'pre-UK' || data.session === 'UK';
  const readyCandidates = candidates.filter(c =>
    c.status === 'READY' && (isUKSession ? c.ticker.endsWith('.L') : !c.ticker.endsWith('.L'))
  );

  const regimeColor = data.regime === 'BULLISH' ? 'text-profit' : data.regime === 'BEARISH' ? 'text-loss' : 'text-warning';
  const hasWarnings = data.regime !== 'BULLISH' || data.availableRiskPct <= 0 || data.isHoliday;

  return (
    <div className={cn(
      'card-surface p-4 mb-4 border-l-4',
      hasWarnings ? 'border-l-warning' : 'border-l-profit'
    )}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Briefcase className="w-4 h-4 text-primary-400" />
          {FLAG[data.session] || '📋'} {SESSION_LABEL[data.session] || data.session} Briefing
        </h3>
        <button onClick={refresh} className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">
          <Clock className="w-3 h-3 inline mr-1" />refresh
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div>
          <span className="text-muted-foreground">Regime</span>
          <div className={cn('font-semibold', regimeColor)}>{data.regime}</div>
        </div>
        <div>
          <span className="text-muted-foreground">Risk Used</span>
          <div className="font-mono">{data.usedRiskPct.toFixed(1)}% / {data.maxRiskPct}%</div>
        </div>
        <div>
          <span className="text-muted-foreground">Positions</span>
          <div className="font-mono">{data.usedPositions}/{data.maxPositions}</div>
        </div>
        <div>
          <span className="text-muted-foreground">READY</span>
          <div className={cn('font-semibold', readyCandidates.length > 0 ? 'text-profit' : 'text-muted-foreground')}>
            {readyCandidates.length} candidate{readyCandidates.length !== 1 ? 's' : ''}
          </div>
        </div>
      </div>

      {/* Warnings */}
      {hasWarnings && (
        <div className="mt-2 space-y-1">
          {data.regime !== 'BULLISH' && (
            <div className="text-[10px] text-warning flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> Regime not BULLISH — buying blocked
            </div>
          )}
          {data.availableRiskPct <= 0 && (
            <div className="text-[10px] text-warning flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> Risk budget full
            </div>
          )}
          {data.isHoliday && (
            <div className="text-[10px] text-warning flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> Market holiday: {data.holidayLabel}
            </div>
          )}
        </div>
      )}

      {/* Top candidates preview */}
      {readyCandidates.length > 0 && (
        <div className="mt-2 pt-2 border-t border-border/30">
          <div className="flex flex-wrap gap-2">
            {readyCandidates.slice(0, 4).map(c => (
              <span key={c.ticker} className="text-[10px] px-1.5 py-0.5 rounded bg-profit/10 text-profit font-medium">
                <TrendingUp className="w-2.5 h-2.5 inline mr-0.5" />
                {c.ticker}
              </span>
            ))}
            {readyCandidates.length > 4 && (
              <span className="text-[10px] text-muted-foreground">+{readyCandidates.length - 4} more</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
