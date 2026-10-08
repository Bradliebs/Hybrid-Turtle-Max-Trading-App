'use client';

import { cn } from '@/lib/utils';
import { formatCurrency, formatPrice, formatPercent, formatR } from '@/lib/utils';
import StatusBadge from '@/components/shared/StatusBadge';
import EntryQualityBadge from './EntryQualityBadge';
import type { EntryQuality } from '@/types';
import WhyCardPopover, { WhyCardProvider, type WhyCardData, type WhyCardSection } from '@/components/shared/WhyCardPopover';
import {
  SCAN_STATUS_EXPLANATIONS,
  FILTER_EXPLANATIONS,
  RISK_GATE_EXPLANATIONS,
} from '@/lib/why-explanations';
import { Zap } from 'lucide-react';

interface Candidate {
  ticker: string;
  yahooTicker?: string;
  name: string;
  sleeve: string;
  status: string;
  price: number;
  priceCurrency?: string;
  entryTrigger: number;
  stopPrice: number;
  rankScore: number;
  distancePercent: number;
  shares?: number;
  riskDollars?: number;
  totalCost?: number;
  passesAllFilters: boolean;
  pullbackSignal?: {
    triggered: boolean;
    mode: 'BREAKOUT' | 'PULLBACK_CONTINUATION';
    reason: string;
  };
  // Filter results for Why Card
  filterResults?: {
    priceAboveMa200: boolean;
    adxAbove20: boolean;
    plusDIAboveMinusDI: boolean;
    atrPercentBelow8: boolean;
    efficiencyAbove30: boolean;
    dataQuality: boolean;
  };
  // Risk gate results for Why Card
  riskGateResults?: { passed: boolean; gate: string; message: string; current: number; limit: number }[];
  passesRiskGates?: boolean;
  antiChaseResult?: { passed: boolean; reason: string };
  passesAntiChase?: boolean;
  modelOverlay?: {
    enabled: boolean;
    baseSystemScore: number;
    modelScore: number;
    blendedScore: number;
    breakoutProbability: number;
    confidence: number;
    uncertainty: number;
    predictedRegime: 'BULLISH' | 'SIDEWAYS' | 'BEARISH' | 'NEUTRAL';
    recommendation: 'PROMOTE' | 'NEUTRAL' | 'SUPPRESS';
    version: string;
    featureTimestamp: string;
  };
  entryQuality?: EntryQuality;
}

interface CandidateTableProps {
  candidates: Candidate[];
  showSizing?: boolean;
}

export default function CandidateTable({ candidates, showSizing = false }: CandidateTableProps) {
  const triggered = candidates.filter(c => c.passesAllFilters && c.distancePercent <= 0);
  const hasModelOverlay = candidates.some((candidate) => candidate.modelOverlay);

  return (
    <WhyCardProvider>
    <div className="card-surface overflow-x-auto">
      <div className="p-4 border-b border-border flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          Candidates ({candidates.length})
        </h3>
        {triggered.length > 0 && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 text-xs font-bold animate-pulse">
            <Zap className="w-3.5 h-3.5" />
            {triggered.length} TRIGGERED — READY TO BUY
          </span>
        )}
        {hasModelOverlay && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/30 text-xs font-semibold">
            Model Overlay
          </span>
        )}
      </div>
      <table className={cn('data-table', hasModelOverlay ? 'min-w-[1400px]' : showSizing ? 'min-w-[1200px]' : 'min-w-[900px]')}>
        <thead>
          <tr>
            <th className="whitespace-nowrap w-10">#</th>
            <th className="whitespace-nowrap">Ticker</th>
            <th className="whitespace-nowrap w-20">Sleeve</th>
            <th className="whitespace-nowrap w-24">Status</th>
            <th className="text-right whitespace-nowrap w-28">Price</th>
            <th className="text-right whitespace-nowrap w-28">Entry Trigger</th>
            <th className="text-right whitespace-nowrap w-28">Stop Price</th>
            <th className="text-right whitespace-nowrap w-20">Distance%</th>
            <th className="text-right whitespace-nowrap w-16">Base</th>
            <th className="text-center whitespace-nowrap w-20">Entry</th>
            {hasModelOverlay && <th className="text-right whitespace-nowrap">Model</th>}
            {hasModelOverlay && <th className="text-right whitespace-nowrap">Blended</th>}
            {hasModelOverlay && <th className="text-right whitespace-nowrap">Conf</th>}
            {hasModelOverlay && <th className="text-right whitespace-nowrap">Unc</th>}
            <th className="text-center whitespace-nowrap w-8"></th>
            {showSizing && (
              <>
                <th className="text-right whitespace-nowrap w-20">Shares</th>
                <th className="text-right whitespace-nowrap w-28">Total Cost</th>
                <th className="text-right whitespace-nowrap w-24">Risk $</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {candidates.map((c, i) => {
            const isTriggered = c.passesAllFilters && c.distancePercent <= 0;
            const recommendationClass = c.modelOverlay?.recommendation === 'PROMOTE'
              ? 'text-profit'
              : c.modelOverlay?.recommendation === 'SUPPRESS'
                ? 'text-loss'
                : 'text-foreground';
            return (
              <tr
                key={c.ticker}
                className={cn(
                  !c.passesAllFilters && 'opacity-40',
                  isTriggered && 'bg-emerald-500/10 border-l-2 border-l-emerald-400'
                )}
              >
                <td className="text-muted-foreground font-mono text-sm">{i + 1}</td>
                <td>
                  <div className="flex items-center gap-2">
                    <div>
                      <span className={cn(
                        'font-semibold',
                        isTriggered ? 'text-emerald-400' : 'text-primary-400'
                      )}>
                        {c.ticker}
                      </span>
                      {c.yahooTicker && c.yahooTicker !== c.ticker && (
                        <span className="text-muted-foreground text-[10px] ml-1">({c.yahooTicker})</span>
                      )}
                      <div className="text-xs text-muted-foreground">{c.name}</div>
                    </div>
                    {isTriggered && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 text-[10px] font-bold border border-emerald-500/30">
                        <Zap className="w-3 h-3" />
                        BUY
                      </span>
                    )}
                  </div>
                </td>
                <td>
                  <StatusBadge status={c.sleeve} />
                </td>
                <td>
                  <div className="flex items-center gap-2">
                    {isTriggered ? (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                        TRIGGERED
                      </span>
                    ) : (
                      <StatusBadge status={c.status} />
                    )}
                    {c.pullbackSignal?.triggered && c.pullbackSignal.mode === 'PULLBACK_CONTINUATION' && (
                      <span
                        title={c.pullbackSignal.reason}
                        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30"
                      >
                        MODE B
                      </span>
                    )}
                    {/* Breakout badge: shown when price is at/above 20-day high (advisory context) */}
                    {c.distancePercent <= 0 && !isTriggered && (
                      <span
                        title="Price at or above 20-day high — breakout in progress"
                        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                      >
                        BO
                      </span>
                    )}
                  </div>
                </td>
                <td className="text-right font-mono text-sm whitespace-nowrap">{formatPrice(c.price, c.priceCurrency)}</td>
                <td className="text-right font-mono text-sm text-primary-400 whitespace-nowrap">
                  {formatPrice(c.entryTrigger, c.priceCurrency)}
                </td>
                <td className="text-right font-mono text-sm text-loss whitespace-nowrap">
                  {formatPrice(c.stopPrice, c.priceCurrency)}
                </td>
                <td className="text-right">
                  {isTriggered ? (
                    <span className="inline-flex items-center gap-1 font-mono text-sm font-bold text-emerald-400">
                      ABOVE
                    </span>
                  ) : (
                    <span
                      className={cn(
                        'font-mono text-sm',
                        c.distancePercent <= 2 ? 'text-profit' :
                        c.distancePercent <= 5 ? 'text-warning' :
                        'text-loss'
                      )}
                    >
                      {formatPercent(c.distancePercent, 1)}
                    </span>
                  )}
                </td>
                <td className="text-right font-mono text-sm text-foreground whitespace-nowrap">
                  {c.rankScore.toFixed(1)}
                </td>
                <td className="text-center">
                  {c.entryQuality ? (
                    <EntryQualityBadge entryQuality={c.entryQuality} priceCurrency={c.priceCurrency} compact />
                  ) : (
                    <span className="text-muted-foreground text-xs">—</span>
                  )}
                </td>
                {hasModelOverlay && (
                  <td className={cn('text-right font-mono text-sm whitespace-nowrap', recommendationClass)}>
                    {c.modelOverlay ? c.modelOverlay.modelScore.toFixed(1) : '—'}
                  </td>
                )}
                {hasModelOverlay && (
                  <td className={cn('text-right font-mono text-sm whitespace-nowrap', recommendationClass)}>
                    {c.modelOverlay ? c.modelOverlay.blendedScore.toFixed(1) : '—'}
                  </td>
                )}
                {hasModelOverlay && (
                  <td className="text-right font-mono text-sm whitespace-nowrap">
                    {c.modelOverlay ? `${c.modelOverlay.confidence.toFixed(0)}%` : '—'}
                  </td>
                )}
                {hasModelOverlay && (
                  <td className="text-right font-mono text-sm text-muted-foreground whitespace-nowrap">
                    {c.modelOverlay ? `${c.modelOverlay.uncertainty.toFixed(0)}%` : '—'}
                  </td>
                )}
                <td className="text-center">
                  <div className="flex items-center justify-center gap-1">
                    {!isTriggered && c.status !== 'READY' && (
                      <WhyCardPopover data={buildCandidateWhyData(c)} />
                    )}
                  </div>
                </td>
                {showSizing && (
                  <>
                    <td className="text-right font-mono text-sm whitespace-nowrap">{c.shares ?? '—'}</td>
                    <td className="text-right font-mono text-sm whitespace-nowrap">
                      {c.totalCost != null ? formatPrice(c.totalCost, c.priceCurrency) : '—'}
                    </td>
                    <td className="text-right font-mono text-sm text-loss whitespace-nowrap">
                      {c.riskDollars != null ? formatPrice(c.riskDollars, c.priceCurrency) : '—'}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </WhyCardProvider>
  );
}

/** Build Why Card data for a scan candidate */
function buildCandidateWhyData(c: Candidate): WhyCardData {
  const statusInfo = SCAN_STATUS_EXPLANATIONS[c.status];
  const sections: WhyCardSection[] = [];

  // Add filter results if available
  if (c.filterResults) {
    for (const [key, passed] of Object.entries(c.filterResults)) {
      const explanation = FILTER_EXPLANATIONS[key];
      if (!explanation) continue;
      sections.push({
        label: explanation.label,
        value: passed ? explanation.passText : explanation.failText,
        status: passed ? 'pass' : 'fail',
      });
    }
  }

  // Add risk gate results if available
  if (c.riskGateResults) {
    for (const gate of c.riskGateResults) {
      const explanation = RISK_GATE_EXPLANATIONS[gate.gate];
      sections.push({
        label: gate.gate,
        value: gate.message,
        status: gate.passed ? 'pass' : 'fail',
      });
    }
  }

  // Add anti-chase result if available and failed
  if (c.antiChaseResult && !c.antiChaseResult.passed) {
    sections.push({
      label: 'Anti-Chase Guard',
      value: c.antiChaseResult.reason,
      status: 'fail',
    });
  }

  // Add entry quality info if available
  if (c.entryQuality) {
    sections.push({
      label: 'Entry Quality',
      value: c.entryQuality.reason,
      status: c.entryQuality.quality === 'GREEN' ? 'pass' : c.entryQuality.quality === 'RED' ? 'fail' : 'info',
    });
  }

  return {
    title: statusInfo?.title ?? c.status,
    description: statusInfo?.description ?? `Status: ${c.status}. Distance to trigger: ${c.distancePercent.toFixed(1)}%`,
    tip: statusInfo?.tip,
    sections: sections.length > 0 ? sections : undefined,
  };
}
