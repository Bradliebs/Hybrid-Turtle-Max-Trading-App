'use client';

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { apiRequest } from '@/lib/api-client';
import {
  AlertTriangle, Eye, Crosshair, Wrench, ArrowRight,
  ShieldCheck, TrendingUp, Clock, XCircle, ChevronDown, ChevronUp,
  CheckCircle2, Ban,
} from 'lucide-react';

// ── Types (mirrors the API response) ──
type Decision =
  | 'NO_ACTION'
  | 'MANAGE_EXISTING'
  | 'UPDATE_STOPS'
  | 'WATCH_CANDIDATES'
  | 'PREPARE_PLAN'
  | 'BUY_ALLOWED'
  | 'BUY_BLOCKED'
  | 'EXIT_REVIEW'
  | 'SYSTEM_BLOCKED'
  | 'CAPITAL_PRESERVATION_ACTIVE'
  | 'RESEARCH_ONLY';

interface Blocker {
  code: string;
  label: string;
  severity: 'hard' | 'soft';
}

interface DirectiveContext {
  phase: string;
  regime: string;
  healthOverall: string;
  heartbeatStatus: string;
  heartbeatAgeHours: number;
  scanAgeHours: number;
  openPositionCount: number;
  maxPositions: number;
  openRiskPct: number;
  maxOpenRisk: number;
  riskBudgetUsedPct: number;
  readyCandidateCount: number;
  triggerMetCount: number;
  stopsPending: number;
  laggardCount: number;
  pyramidCount: number;
  killSwitchActive: boolean;
  autoTradingEnabled: boolean;
  t212Connected: boolean;
  dataStale: boolean;
  canEnter: boolean;
}

interface DirectiveData {
  decision: Decision;
  headline: string;
  explanation: string;
  action: { label: string; href: string } | null;
  urgency: 'high' | 'medium' | 'low' | 'none';
  blockers: Blocker[];
  context: DirectiveContext;
}

// ── Visual config per decision ──────────────────────────────

function getDecisionStyle(decision: Decision): {
  border: string;
  icon: React.ReactNode;
  badge: string;
  badgeColor: string;
} {
  const iconClass = 'w-6 h-6';
  switch (decision) {
    case 'SYSTEM_BLOCKED':
      return {
        border: 'border-l-red-600',
        icon: <XCircle className={cn(iconClass, 'text-red-400')} />,
        badge: 'SYSTEM BLOCKED',
        badgeColor: 'bg-red-500/20 text-red-400 border-red-500/40',
      };
    case 'CAPITAL_PRESERVATION_ACTIVE':
      return {
        border: 'border-l-amber-500',
        icon: <ShieldCheck className={cn(iconClass, 'text-amber-400')} />,
        badge: 'PRESERVE',
        badgeColor: 'bg-amber-500/20 text-amber-400 border-amber-500/40',
      };
    case 'RESEARCH_ONLY':
      return {
        border: 'border-l-violet-500',
        icon: <Wrench className={cn(iconClass, 'text-violet-400')} />,
        badge: 'RESEARCH',
        badgeColor: 'bg-violet-500/20 text-violet-300 border-violet-500/40',
      };
    case 'BUY_ALLOWED':
      return {
        border: 'border-l-emerald-500',
        icon: <Crosshair className={cn(iconClass, 'text-emerald-400')} />,
        badge: 'BUY',
        badgeColor: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
      };
    case 'BUY_BLOCKED':
      return {
        border: 'border-l-red-500',
        icon: <Ban className={cn(iconClass, 'text-red-400')} />,
        badge: 'BLOCKED',
        badgeColor: 'bg-red-500/20 text-red-400 border-red-500/40',
      };
    case 'EXIT_REVIEW':
      return {
        border: 'border-l-amber-500',
        icon: <AlertTriangle className={cn(iconClass, 'text-amber-400')} />,
        badge: 'EXIT',
        badgeColor: 'bg-amber-500/20 text-amber-400 border-amber-500/40',
      };
    case 'UPDATE_STOPS':
      return {
        border: 'border-l-blue-500',
        icon: <ShieldCheck className={cn(iconClass, 'text-blue-400')} />,
        badge: 'STOPS',
        badgeColor: 'bg-blue-500/20 text-blue-400 border-blue-500/40',
      };
    case 'MANAGE_EXISTING':
      return {
        border: 'border-l-blue-400',
        icon: <TrendingUp className={cn(iconClass, 'text-blue-400')} />,
        badge: 'MANAGE',
        badgeColor: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
      };
    case 'WATCH_CANDIDATES':
      return {
        border: 'border-l-amber-400',
        icon: <Eye className={cn(iconClass, 'text-amber-400')} />,
        badge: 'WATCH',
        badgeColor: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
      };
    case 'PREPARE_PLAN':
      return {
        border: 'border-l-violet-500',
        icon: <Clock className={cn(iconClass, 'text-violet-400')} />,
        badge: 'PLAN',
        badgeColor: 'bg-violet-500/20 text-violet-300 border-violet-500/40',
      };
    case 'NO_ACTION':
      return {
        border: 'border-l-gray-600',
        icon: <CheckCircle2 className={cn(iconClass, 'text-gray-400')} />,
        badge: 'CLEAR',
        badgeColor: 'bg-gray-500/20 text-gray-400 border-gray-500/40',
      };
    default:
      // A decision the API added but this card doesn't know yet must never crash the dashboard.
      return {
        border: 'border-l-gray-600',
        icon: <AlertTriangle className={cn(iconClass, 'text-gray-400')} />,
        badge: String(decision).replace(/_/g, ' '),
        badgeColor: 'bg-gray-500/20 text-gray-300 border-gray-500/40',
      };
  }
}

// ── Detail row helper ──
function DetailRow({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn(warn ? 'text-amber-400' : 'text-foreground')}>{value}</span>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────

export default function TodayDirectiveCard() {
  const [data, setData] = useState<DirectiveData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    apiRequest<DirectiveData>('/api/dashboard/today-directive')
      .then(setData)
      .catch((err) => console.error('[TodayDirective] Fetch error:', err))
      .finally(() => setLoading(false));
  }, []);

  // ── Skeleton loading ──
  if (loading) {
    return (
      <div className="w-full rounded-lg border-l-4 border-l-gray-600 bg-navy-800/60 border border-border/40 p-5 animate-pulse">
        <div className="flex items-center justify-between">
          <div className="space-y-2 flex-1">
            <div className="h-5 w-3/5 bg-navy-600 rounded" />
            <div className="h-3 w-2/5 bg-navy-700 rounded" />
          </div>
          <div className="h-9 w-32 bg-navy-600 rounded-lg" />
        </div>
      </div>
    );
  }

  if (!data) return null;

  const style = getDecisionStyle(data.decision);
  const ctx = data.context;
  const hasBlockers = data.blockers.length > 0;

  return (
    <div className={cn('w-full rounded-lg border-l-4 bg-navy-800/60 border border-border/40', style.border)}>
      {/* ── Primary: headline + action ── */}
      <div className="p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className="mt-0.5 flex-shrink-0">{style.icon}</div>
            <div className="min-w-0">
              {/* Badge row */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded border', style.badgeColor)}>
                  {style.badge}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-navy-700 text-muted-foreground border border-border/50">
                  {ctx.phase}
                </span>
                <span className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded border border-border/50',
                  ctx.regime === 'BULLISH' ? 'bg-emerald-500/15 text-emerald-400' :
                  ctx.regime === 'BEARISH' ? 'bg-red-500/15 text-red-400' :
                  'bg-amber-500/15 text-amber-400'
                )}>
                  {ctx.regime}
                </span>
              </div>

              {/* Headline */}
              <h2 className="text-lg font-semibold text-foreground mt-1.5 leading-snug">
                {data.headline}
              </h2>

              {/* Explanation */}
              <p className="text-sm text-muted-foreground mt-0.5">{data.explanation}</p>

              {/* Blockers (inline, compact) */}
              {hasBlockers && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {data.blockers.map((b) => (
                    <span
                      key={b.code}
                      className={cn(
                        'text-[10px] px-1.5 py-0.5 rounded',
                        b.severity === 'hard'
                          ? 'bg-red-500/15 text-red-400 border border-red-500/30'
                          : 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                      )}
                    >
                      {b.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Action button */}
          {data.action && (
            <a
              href={data.action.href}
              className={cn(
                'flex-shrink-0 inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg text-xs font-semibold transition-all',
                data.urgency === 'high'
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 hover:bg-emerald-500/30'
                  : data.urgency === 'medium'
                  ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30 hover:bg-blue-500/25'
                  : 'bg-primary/15 text-primary-400 border border-primary/30 hover:bg-primary/25'
              )}
            >
              {data.action.label}
              <ArrowRight className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
      </div>

      {/* ── Expandable details ── */}
      <div className="border-t border-border/30">
        <button
          type="button"
          onClick={() => setShowDetails(!showDetails)}
          className="w-full px-5 py-2 flex items-center justify-between text-xs text-muted-foreground hover:text-foreground transition-colors"
          title={showDetails ? 'Hide details' : 'Show details'}
        >
          <span>System Details</span>
          {showDetails ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>

        {showDetails && (
          <div className="px-5 pb-4 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1.5">
            <DetailRow label="Positions" value={`${ctx.openPositionCount} / ${ctx.maxPositions}`} warn={ctx.openPositionCount >= ctx.maxPositions} />
            <DetailRow label="Open Risk" value={`${ctx.openRiskPct}% / ${ctx.maxOpenRisk}%`} warn={ctx.openRiskPct >= ctx.maxOpenRisk * 0.8} />
            <DetailRow label="Risk Budget" value={`${ctx.riskBudgetUsedPct}% used`} warn={ctx.riskBudgetUsedPct >= 80} />
            <DetailRow label="READY" value={ctx.readyCandidateCount} />
            <DetailRow label="Triggered" value={ctx.triggerMetCount} />
            <DetailRow label="Stop Updates" value={ctx.stopsPending} warn={ctx.stopsPending > 0} />
            <DetailRow label="Laggards" value={ctx.laggardCount} warn={ctx.laggardCount > 0} />
            <DetailRow label="Pyramids" value={ctx.pyramidCount} />
            <DetailRow label="Health" value={ctx.healthOverall} warn={ctx.healthOverall !== 'GREEN'} />
            <DetailRow label="Scan Age" value={`${ctx.scanAgeHours}h`} warn={ctx.scanAgeHours > 12} />
            <DetailRow label="Auto-Trade" value={ctx.autoTradingEnabled ? 'ON' : 'OFF'} />
            <DetailRow label="T212" value={ctx.t212Connected ? 'Connected' : 'Not connected'} warn={!ctx.t212Connected} />
          </div>
        )}
      </div>
    </div>
  );
}
