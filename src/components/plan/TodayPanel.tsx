'use client';

/**
 * DEPENDENCIES
 * Consumed by: /plan page (page.tsx)
 * Consumes: signal-translations.ts, utils.ts
 * Risk-sensitive: NO — read-only display, no DB writes, no position creation
 * Last modified: 2026-02-28
 * Notes: "Novice-first" trading panel. One screen, one message, one action.
 *        Full-screen state card shows exactly what to do (or not do) today.
 *        Signal strip and technical details move to advanced view in page.tsx.
 */

import { useState } from 'react';
import { cn, formatPrice } from '@/lib/utils';
import {
  ncsToStars,
  hurstToLabel,
  adxToLabel,
  regimeToLabel,
  portfolioSpaceLabel,
  riskBudgetLabel,
  rMultipleToDescription,
  compositeScore,
  buildTradeReasons,
  statusColor,
  statusIcon,
  type SignalLabel,
} from '@/lib/signal-translations';
import type { MarketRegime, WeeklyPhase } from '@/types';
import { ChevronDown, ChevronUp, ExternalLink, Zap } from 'lucide-react';
import GlossaryTerm from '@/components/GlossaryTerm';
import VPINBadge, { useVPIN } from '@/components/VPINBadge';
import SentimentPanel, { useSentiment } from '@/components/SentimentPanel';
import LiveNCSTracker from '@/components/LiveNCSTracker';

// ── Approximate GBP value helper (display only) ──────────────
// Converts shares × price in native currency to approximate GBP.
// Uses hardcoded FX fallbacks — the ≈ symbol signals approximation.
const APPROX_FX_TO_GBP: Record<string, number> = {
  GBP: 1,
  GBX: 0.01,   // pence to pounds
  GBp: 0.01,
  USD: 0.79,
  EUR: 0.86,
};

function approxGbpValue(shares: number, price: number, currency?: string): number {
  const fx = APPROX_FX_TO_GBP[currency ?? 'USD'] ?? 0.79;
  return Math.round(shares * price * fx);
}

// ── Types ────────────────────────────────────────────────────

interface TodayCandidate {
  ticker: string;
  name: string;
  price: number;
  entryTrigger: number;
  stopPrice: number;
  distancePercent: number;
  shares?: number;
  riskDollars?: number;
  priceCurrency?: string;
  dualNCS?: number | null;
  dualBQS?: number | null;
  dualFWS?: number | null;
  bps?: number | null;
  hurstExponent?: number | null;
  scanAdx?: number | null;
  sleeve?: string;
  atrPercent?: number | null;
  /** EV modifier from historical expectancy (-10 to +5), passed in by TodayPanel */
  evModifier?: number | null;
  /** Earnings calendar data */
  earningsInfo?: {
    daysUntilEarnings: number | null;
    nextEarningsDate: string | null;
    confidence: 'HIGH' | 'LOW' | 'NONE';
    action: 'AUTO_NO' | 'DEMOTE_WATCH' | null;
    reason: string | null;
  };
}

interface TodayPosition {
  ticker: string;
  name: string;
  rMultiple: number;
  gainPercent: number;
  protectionLevel: string;
  currentStop: number;
  priceCurrency?: string;
}

interface TodayPanelProps {
  weeklyPhase: WeeklyPhase;
  marketRegime: MarketRegime;
  positions: TodayPosition[];
  candidates: TodayCandidate[];
  maxPositions: number;
  usedPositions: number;
  usedRiskPercent: number;
  maxRiskPercent: number;
  /** When true, show signal strip and technical details inline */
  advancedView?: boolean;
}

// ── State Determination ──────────────────────────────────────

type PanelState = 'NOT_TRADING_DAY' | 'MARKET_NOT_READY' | 'PORTFOLIO_FULL' | 'WATCHING' | 'TIME_TO_ACT';

function determinePanelState(props: TodayPanelProps): PanelState {
  if (props.weeklyPhase !== 'EXECUTION') return 'NOT_TRADING_DAY';

  const regime = props.marketRegime.toUpperCase();
  if (regime === 'BEARISH' || regime === 'SIDEWAYS') return 'MARKET_NOT_READY';

  if (props.usedPositions >= props.maxPositions) return 'PORTFOLIO_FULL';

  const triggered = props.candidates.filter(
    c => c.price > 0 && c.entryTrigger > 0 && c.price >= c.entryTrigger
  );
  if (triggered.length > 0) return 'TIME_TO_ACT';

  return 'WATCHING';
}

// ── Best Candidate Selection ─────────────────────────────────

function selectBestCandidate(candidates: TodayCandidate[]): TodayCandidate | null {
  const triggered = candidates.filter(
    c => c.price > 0 && c.entryTrigger > 0 && c.price >= c.entryTrigger
  );
  if (triggered.length === 0) return null;

  // Rank by composite score (includes EV modifier when available)
  return triggered.sort((a, b) => {
    const scoreA = compositeScore(a.dualNCS, a.bps, a.hurstExponent, a.evModifier);
    const scoreB = compositeScore(b.dualNCS, b.bps, b.hurstExponent, b.evModifier);
    return scoreB - scoreA;
  })[0];
}

// ── Top Candidate by Composite Score (all candidates, not just triggered) ────

function selectTopCandidate(candidates: TodayCandidate[]): TodayCandidate | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const scoreA = compositeScore(a.dualNCS, a.bps, a.hurstExponent, a.evModifier);
    const scoreB = compositeScore(b.dualNCS, b.bps, b.hurstExponent, b.evModifier);
    return scoreB - scoreA;
  })[0];
}

// ── Closest Candidate ────────────────────────────────────────

function findClosestCandidate(candidates: TodayCandidate[]): { ticker: string; distancePct: number } | null {
  const valid = candidates.filter(c => c.distancePercent > 0 && c.price > 0);
  if (valid.length === 0) return null;

  const closest = valid.reduce((best, c) =>
    c.distancePercent < best.distancePercent ? c : best
  , valid[0]);

  return { ticker: closest.ticker, distancePct: closest.distancePercent };
}

// ── Helper: Today's day name ─────────────────────────────────

function getTodayName(): string {
  return new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    timeZone: 'Europe/London',
  });
}

// ── Signal Summary Item (advanced view only) ─────────────────

function SignalItem({ emoji, label, signal }: { emoji: string; label: string; signal: SignalLabel }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 bg-navy-800/40 rounded-lg min-w-0">
      <span className="text-lg flex-shrink-0">{emoji}</span>
      <div className="min-w-0">
        <div className="text-[11px] text-muted-foreground truncate">{label}</div>
        <div className={cn('text-sm font-semibold flex items-center gap-1.5', statusColor(signal.status))}>
          {signal.text}
          <span className="text-xs">{statusIcon(signal.status)}</span>
        </div>
      </div>
    </div>
  );
}

// ── Technical Details Expandable ─────────────────────────────

function TechnicalDetails({ candidate }: { candidate: TodayCandidate }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
      >
        {open ? 'Hide' : 'Show'} technical details
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>
      {open && (
        <div className="mt-2 px-3 py-2 bg-navy-900/60 rounded-lg text-xs font-mono text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
          {candidate.dualNCS != null && (
            <span><GlossaryTerm term="NCS">NCS</GlossaryTerm>: <span className="text-foreground">{Math.round(candidate.dualNCS)}</span></span>
          )}
          {candidate.dualBQS != null && <span><GlossaryTerm term="BQS">BQS</GlossaryTerm>: <span className="text-foreground">{Math.round(candidate.dualBQS)}</span></span>}
          {candidate.dualFWS != null && <span><GlossaryTerm term="FWS">FWS</GlossaryTerm>: <span className="text-foreground">{Math.round(candidate.dualFWS)}</span></span>}
          {candidate.bps != null && <span><GlossaryTerm term="BPS">BPS</GlossaryTerm>: <span className="text-foreground">{candidate.bps}</span></span>}
          {candidate.hurstExponent != null && <span><GlossaryTerm term="Hurst">Hurst</GlossaryTerm>: <span className="text-foreground">{candidate.hurstExponent.toFixed(2)}</span></span>}
          {candidate.scanAdx != null && <span><GlossaryTerm term="ADX">ADX</GlossaryTerm>: <span className="text-foreground">{candidate.scanAdx.toFixed(1)}</span></span>}
          <span>Distance: <span className="text-foreground">{(candidate.distancePercent ?? 0).toFixed(2)}%</span></span>
          {candidate.evModifier != null && candidate.evModifier !== 0 && (
            <span>EV: <span className={candidate.evModifier > 0 ? 'text-emerald-400' : 'text-amber-400'}>{candidate.evModifier > 0 ? '+' : ''}{candidate.evModifier}</span></span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Expandable "See why" section ─────────────────────────────

function SeeWhySection({ children, label = 'See why' }: { children: React.ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition-colors mx-auto"
      >
        {open ? 'Hide details' : label}
        {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>
      {open && (
        <div className="mt-3 max-w-md mx-auto text-sm text-muted-foreground bg-navy-800/40 rounded-xl p-4">
          {children}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  STATE CARDS — Full-screen, novice-first design
// ══════════════════════════════════════════════════════════════

// ── STATE 1: Wrong day ───────────────────────────────────────

function NotTradingDayCard({ phase }: { phase: WeeklyPhase }) {
  const today = getTodayName();

  return (
    <div className="rounded-2xl bg-navy-800/60 border border-border/40 px-6 py-12 sm:py-16 min-h-[60vh] flex items-center justify-center">
      <div className="text-center space-y-4 max-w-md mx-auto">
        <div className="text-5xl">🌙</div>
        <h2 className="text-2xl sm:text-3xl font-bold text-foreground">
          Come back on Tuesday
        </h2>
        <p className="text-lg text-muted-foreground">
          Today is {today}.
          <br />
          Your trading day is Tuesday.
        </p>
        <p className="text-muted-foreground">
          The system is watching everything for you.
          <br />
          You don&apos;t need to do anything today.
        </p>
        {phase === 'OBSERVATION' && (
          <p className="text-xs text-muted-foreground/70 mt-2">
            Monday&apos;s anti-chase guard is active — this protects you from impulse buys.
          </p>
        )}
        <div className="pt-4">
          <a
            href="/portfolio"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4"
          >
            See my open positions
          </a>
        </div>
      </div>
    </div>
  );
}

// ── Best Candidate Selection ─────────────────────────────────

// ── STATE 2: Tuesday, nothing to buy ─────────────────────────

function WatchingCard({ closest }: { closest: { ticker: string; distancePct: number } | null }) {
  return (
    <div className="rounded-2xl bg-navy-800/60 border border-border/40 px-6 py-12 sm:py-16 min-h-[60vh] flex items-center justify-center">
      <div className="text-center space-y-4 max-w-md mx-auto">
        <div className="text-5xl">👀</div>
        <h2 className="text-2xl sm:text-3xl font-bold text-foreground">
          Nothing to buy today
        </h2>
        <p className="text-lg text-muted-foreground">
          The system checked everything.
          <br />
          No trade meets the required standard today.
        </p>
        <p className="text-muted-foreground">
          Your money is safe. Keep waiting.
        </p>

        <SeeWhySection>
          {closest ? (
            <p>
              The closest candidate is <span className="font-semibold text-foreground">{closest.ticker}</span>,
              but it&apos;s still {(closest.distancePct ?? 0).toFixed(1)}% away from its buy price.
              The system only buys when a stock hits its exact entry level.
            </p>
          ) : (
            <p>
              No stocks currently meet the system&apos;s quality standards.
              This is normal — the system is selective to protect your money.
            </p>
          )}
        </SeeWhySection>

        <div className="pt-2">
          <a
            href="/portfolio"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4"
          >
            See my open positions
          </a>
        </div>
      </div>
    </div>
  );
}

// ── STATE 3: Tuesday, something to buy ───────────────────────

function TimeToActCard({ candidate, regime, advancedView }: {
  candidate: TodayCandidate;
  regime: MarketRegime;
  advancedView: boolean;
}) {
  // VPIN / order flow for this candidate
  const vpinData = useVPIN(candidate.ticker);

  // Sentiment score for this candidate
  const sentimentData = useSentiment(candidate.ticker);

  // Determine trade classification for conditional rendering
  const tradeClassification = candidate.dualNCS != null && (candidate.dualNCS ?? 0) >= 70 && (candidate.dualFWS ?? 100) <= 30
    ? 'AUTO_YES'
    : (candidate.dualFWS ?? 0) > 65
      ? 'AUTO_NO'
      : 'CONDITIONAL';

  const stars = ncsToStars(candidate.dualNCS);
  const reasons = buildTradeReasons({
    adx: candidate.scanAdx,
    hurst: candidate.hurstExponent,
    bps: candidate.bps,
    fws: candidate.dualFWS,
    regime,
  });
  const currency = candidate.priceCurrency || 'USD';

  // Novice-friendly reasons: only show positive ones (green ticks)
  const positiveReasons = reasons.filter(r => r.status === 'positive');

  return (
    <div className={cn(
      "rounded-2xl bg-emerald-500/10 border border-emerald-500/40 px-6 py-12 sm:py-16 min-h-[60vh] flex items-center justify-center"
    )}>
      <div className="w-full max-w-lg mx-auto space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="text-5xl">🟢</div>
          <h2 className="text-2xl sm:text-3xl font-bold text-emerald-300">
            You have a trade today
          </h2>
          <p className="text-muted-foreground">
            The system found one that meets every requirement.
          </p>
        </div>

        {/* Trade Card */}
        <div className="bg-navy-800/80 border border-emerald-500/30 rounded-xl p-6 sm:p-8 space-y-5">
          {/* Ticker + Name */}
          <div className="text-center">
            <div className="text-2xl font-bold text-foreground">
              {candidate.ticker}
              <span className="text-muted-foreground font-normal text-base ml-2">
                · {candidate.name}
              </span>
            </div>
          </div>

          {/* Star Rating */}
          <div className="text-center">
            <div className="text-xs text-muted-foreground mb-1">The system rates this:</div>
            <div className={cn(
              'text-xl font-bold',
              stars.stars >= 4 ? 'text-emerald-400' :
              stars.stars >= 3 ? 'text-blue-400' :
              stars.stars >= 2 ? 'text-amber-400' : 'text-red-400'
            )}>
              {stars.display}
            </div>
          </div>

          {/* Key Details — plain English */}
          <div className="space-y-3 text-sm border-t border-border/30 pt-4">
            <div className="text-xs text-muted-foreground font-medium mb-2">If you buy today:</div>
            {candidate.shares != null && candidate.shares > 0 && (
              <div className="flex items-start gap-2">
                <span className="text-muted-foreground">·</span>
                <span className="text-foreground">
                  You will buy <span className="font-semibold">
                    {(candidate.shares ?? 0) < 1
                      ? (candidate.shares ?? 0).toFixed(2)
                      : (candidate.shares ?? 0).toFixed((candidate.shares ?? 0) % 1 > 0 ? 2 : 0)
                    } shares
                  </span>
                  {/* Approximate position value in GBP */}
                  <span className="text-muted-foreground">
                    {' '}(≈ £{approxGbpValue(candidate.shares, candidate.entryTrigger, currency)})
                  </span>
                </span>
              </div>
            )}
            {candidate.riskDollars != null && (
              <div className="flex items-start gap-2">
                <span className="text-muted-foreground">·</span>
                <span className="text-foreground">
                  The most you can lose is <span className="font-semibold">£{(candidate.riskDollars ?? 0).toFixed(2)}</span>
                </span>
              </div>
            )}
            <div className="flex items-start gap-2">
              <span className="text-muted-foreground">·</span>
              <span className="text-foreground">
                Your safety net is at <span className="font-semibold">{formatPrice(candidate.stopPrice, currency)}</span>
              </span>
            </div>
          </div>

          {/* Why the system likes this — novice-friendly */}
          {positiveReasons.length > 0 && (
            <div className="border-t border-border/30 pt-4">
              <div className="text-xs text-muted-foreground font-medium mb-2">
                Why does the system like this?
              </div>
              <div className="space-y-2">
                {positiveReasons.map((r, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm text-emerald-400">
                    <span className="flex-shrink-0 mt-0.5">✓</span>
                    <span>{r.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* EV History Note — only shown when modifier is non-zero */}
          {candidate.evModifier != null && candidate.evModifier !== 0 && (
            <div className={cn(
              'border-t border-border/30 pt-3 text-sm flex items-start gap-2',
              candidate.evModifier > 0 ? 'text-emerald-400' : 'text-amber-400'
            )}>
              <span className="flex-shrink-0 mt-0.5">{candidate.evModifier > 0 ? '📈' : '⚠'}</span>
              <span>
                {candidate.evModifier > 0
                  ? 'This type of setup has historically outperformed (+' + candidate.evModifier + ' score)'
                  : 'This type of setup has historically underperformed (' + candidate.evModifier + ' score)'}
              </span>
            </div>
          )}

          {/* Earnings Calendar Warning — amber note when earnings within 5 days */}
          {candidate.earningsInfo?.daysUntilEarnings != null && candidate.earningsInfo.daysUntilEarnings <= 5 && (
            <div className="border-t border-border/30 pt-3 text-sm">
              <div className={cn(
                'flex items-start gap-2 rounded-lg p-3',
                candidate.earningsInfo.action === 'AUTO_NO'
                  ? 'bg-red-500/10 text-red-400'
                  : 'bg-amber-500/10 text-amber-400'
              )}>
                <span className="flex-shrink-0 mt-0.5">⚠</span>
                <span>
                  {candidate.earningsInfo.action === 'AUTO_NO'
                    ? `${candidate.ticker} reports earnings in ${candidate.earningsInfo.daysUntilEarnings} day${candidate.earningsInfo.daysUntilEarnings === 1 ? '' : 's'}. The system has blocked this trade.`
                    : `Note: ${candidate.ticker} reports earnings in ${candidate.earningsInfo.daysUntilEarnings} days. Consider waiting until after the report.`
                  }
                  {candidate.earningsInfo.confidence === 'LOW' && (
                    <span className="block text-xs mt-1 opacity-80">
                      (Estimated date — not confirmed by the company)
                    </span>
                  )}
                </span>
              </div>
            </div>
          )}

          {/* CTA */}
          <div className="pt-3 border-t border-border/30 space-y-2">
            <a
              href="/portfolio"
              className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-3 px-4 rounded-lg transition-colors"
            >
              Go place this trade →
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>

          {/* Technical details — advanced only */}
          {advancedView && <TechnicalDetails candidate={candidate} />}

          {/* VPIN order flow — advanced only */}
          {advancedView && vpinData.hasResult && (
            <VPINBadge data={vpinData} />
          )}

          {/* Sentiment — advanced only, CONDITIONAL trades only */}
          {advancedView && (
            <SentimentPanel data={sentimentData} tradeClassification={tradeClassification} />
          )}

          {/* Live NCS tracker — advanced only, trading hours only */}
          {advancedView && candidate.dualNCS != null && (
            <LiveNCSTracker
              ticker={candidate.ticker}
              priorNCS={candidate.dualNCS}
              posteriorNCS={candidate.dualNCS}
              updateCount={0}
            />
          )}

        </div>

        {/* Secondary links */}
        <div className="flex items-center justify-center gap-6">
          <SeeWhySection label="See why the system chose this one">
            <div className="space-y-2">
              {reasons.map((r, i) => (
                <div key={i} className={cn('flex items-start gap-2 text-sm', statusColor(r.status))}>
                  <span className="flex-shrink-0 mt-0.5">{statusIcon(r.status)}</span>
                  <span>{r.text}</span>
                </div>
              ))}
            </div>
          </SeeWhySection>
        </div>
      </div>
    </div>
  );
}

// ── STATE 4: Tuesday, portfolio full ─────────────────────────

function PortfolioFullCard({ count, max }: { count: number; max: number }) {
  return (
    <div className="rounded-2xl bg-blue-500/10 border border-blue-500/30 px-6 py-12 sm:py-16 min-h-[60vh] flex items-center justify-center">
      <div className="text-center space-y-4 max-w-md mx-auto">
        <div className="text-5xl">✓</div>
        <h2 className="text-2xl sm:text-3xl font-bold text-blue-300">
          Your portfolio is full
        </h2>
        <p className="text-lg text-muted-foreground">
          You already have {count} open trade{count !== 1 ? 's' : ''}.
          <br />
          That is the maximum for your account size.
        </p>
        <p className="text-muted-foreground">
          Nothing to do today except watch.
        </p>
        <div className="pt-4">
          <a
            href="/portfolio"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4"
          >
            See my open positions
          </a>
        </div>
      </div>
    </div>
  );
}

// ── STATE 5: Market not ready ────────────────────────────────

function MarketNotReadyCard({ regime }: { regime: MarketRegime }) {
  return (
    <div className="rounded-2xl bg-amber-500/10 border border-amber-500/30 px-6 py-12 sm:py-16 min-h-[60vh] flex items-center justify-center">
      <div className="text-center space-y-4 max-w-md mx-auto">
        <div className="text-5xl">⚠️</div>
        <h2 className="text-2xl sm:text-3xl font-bold text-amber-300">
          The market isn&apos;t ready
        </h2>
        <p className="text-lg text-muted-foreground">
          Even though it&apos;s Tuesday,
          <br />
          conditions aren&apos;t right for new trades.
        </p>
        <p className="text-muted-foreground">
          The system is protecting your money.
          <br />
          Do not buy anything today.
        </p>

        <SeeWhySection>
          <p>
            {regime === 'BEARISH'
              ? 'The overall market is falling. Buying now would be fighting the trend, which dramatically increases your chance of losing money.'
              : 'The market is uncertain — not clearly going up or down. The system waits for a clear upward trend before recommending any buys.'
            }
          </p>
        </SeeWhySection>

        <div className="pt-2">
          <a
            href="/portfolio"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4"
          >
            See my open positions
          </a>
        </div>
      </div>
    </div>
  );
}

// ── Open Positions (Layer 2 — always below Layer 1) ──────────

function OpenPositions({ positions }: { positions: TodayPosition[] }) {
  if (positions.length === 0) return null;

  return (
    <div className="space-y-3 pt-4">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider px-1">
        Your Open Positions
      </h3>
      <div className="space-y-2">
        {positions.map((p) => {
          const desc = rMultipleToDescription(p.rMultiple);
          return (
            <div
              key={p.ticker}
              className={cn(
                'flex items-center justify-between p-4 rounded-xl border',
                desc.needsAttention
                  ? 'bg-amber-500/5 border-amber-500/20'
                  : 'bg-navy-800/40 border-border/30'
              )}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-lg flex-shrink-0">{desc.emoji}</span>
                <div className="min-w-0">
                  <span className="font-semibold text-foreground text-sm">{p.ticker}</span>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {/* Plain English status — no R-multiples, no ATR */}
                    {desc.summary}
                    {p.protectionLevel !== 'INITIAL' && (
                      <span className="text-emerald-400"> · Your entry is protected</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="text-right flex-shrink-0 ml-3">
                {desc.needsAttention ? (
                  <>
                    <div className="text-xs text-amber-400 mb-1">
                      Your safety net may need reviewing
                    </div>
                    <a
                      href="/portfolio"
                      className="inline-block text-xs bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 px-3 py-1 rounded-md transition-colors"
                    >
                      Review
                    </a>
                  </>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    No action needed
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  MAIN COMPONENT
// ══════════════════════════════════════════════════════════════

export default function TodayPanel(props: TodayPanelProps) {
  const state = determinePanelState(props);
  const bestCandidate = selectBestCandidate(props.candidates);
  const closest = findClosestCandidate(props.candidates);
  const advancedView = props.advancedView ?? false;

  // Compute signals for the summary strip (advanced view only)
  const representativeCandidate = bestCandidate || selectTopCandidate(props.candidates);
  const adxSignal = adxToLabel(representativeCandidate?.scanAdx);
  const hurstSignal = hurstToLabel(representativeCandidate?.hurstExponent);
  const regimeSignal = regimeToLabel(props.marketRegime);
  const spaceSignal = portfolioSpaceLabel(props.usedPositions, props.maxPositions);
  const budgetSignal = riskBudgetLabel(props.usedRiskPercent, props.maxRiskPercent);

  return (
    <div className="space-y-4">
      {/* ── LAYER 1: The Only Thing That Matters ── */}
      {state === 'NOT_TRADING_DAY' && <NotTradingDayCard phase={props.weeklyPhase} />}
      {state === 'MARKET_NOT_READY' && <MarketNotReadyCard regime={props.marketRegime} />}
      {state === 'PORTFOLIO_FULL' && <PortfolioFullCard count={props.usedPositions} max={props.maxPositions} />}
      {state === 'WATCHING' && <WatchingCard closest={closest} />}
      {state === 'TIME_TO_ACT' && bestCandidate && (
        <TimeToActCard candidate={bestCandidate} regime={props.marketRegime} advancedView={advancedView} />
      )}

      {/* ── Signal Summary Strip (advanced view only) ── */}
      {advancedView && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          <SignalItem emoji="🌍" label="Market mood" signal={regimeSignal} />
          <SignalItem emoji="📈" label="Trend strength" signal={adxSignal} />
          <SignalItem emoji="📊" label="Trend lasting" signal={hurstSignal} />
          <SignalItem emoji="💼" label="Portfolio space" signal={spaceSignal} />
          <SignalItem emoji="💰" label="Risk budget" signal={budgetSignal} />
        </div>
      )}

      {/* ── LAYER 2: Open Positions (always visible) ── */}
      <OpenPositions positions={props.positions} />
    </div>
  );
}
