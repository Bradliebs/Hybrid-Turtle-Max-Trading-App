'use client';

import { useState, useEffect, useCallback } from 'react';
import Navbar from '@/components/shared/Navbar';
import RegimeBadge from '@/components/shared/RegimeBadge';
import PhaseTimeline from '@/components/plan/PhaseTimeline';
import ReadyCandidates from '@/components/plan/ReadyCandidates';
import PreTradeChecklist from '@/components/plan/PreTradeChecklist';

import PositionSizerWidget from '@/components/plan/PositionSizerWidget';
import SwapSuggestionsWidget from '@/components/plan/SwapSuggestionsWidget';
import LaggardAlertsWidget from '@/components/plan/LaggardAlertsWidget';
import AcceleratorWidget from '@/components/dashboard/AcceleratorWidget';
import ExitIntelligenceCard from '@/components/portfolio/ExitIntelligenceCard';
import EarlyBirdWidget from '@/components/plan/EarlyBirdWidget';
import TodayPanel from '@/components/plan/TodayPanel';
import SessionBriefingCard from '@/components/plan/SessionBriefingCard';
import { useStore } from '@/store/useStore';
import { apiRequest } from '@/lib/api-client';
import { fetchLivePrices as fetchLivePricesBatched } from '@/lib/live-prices-client';
import { ClipboardList, Calendar, Loader2, ChevronDown, ChevronUp, Shield } from 'lucide-react';

const ADVANCED_VIEW_KEY = 'hybridturtle_advanced_view';

const DEFAULT_USER_ID = 'default-user';

/** Shape of a position as returned by /api/positions */
interface PositionApiResponse {
  id: string;
  stock?: { ticker: string; name: string; sleeve: string };
  status: string;
  entryPrice: number;
  currentPrice?: number;
  currentStop?: number;
  stopLoss?: number;
  initialRisk?: number;
  protectionLevel?: string;
  rMultiple?: number;
  gainPercent?: number;
  shares: number;
  priceCurrency?: string;
}

/** Shape of a candidate for the ReadyCandidates widget */
interface ReadyCandidate {
  ticker: string;
  yahooTicker?: string;
  name: string;
  sleeve: string;
  status: string;
  price: number;
  entryTrigger: number;
  stopPrice: number;
  distancePercent: number;
  shares?: number;
  riskDollars?: number;
  priceCurrency?: string;
  matchType?: 'BOTH_RECOMMEND' | 'SCAN_ONLY' | 'DUAL_ONLY' | 'CONFLICT';
  agreementScore?: number;
  dualNCS?: number;
  dualBQS?: number;
  dualFWS?: number;
  dualAction?: string;
  scanRankScore?: number;
  scanPassesFilters?: boolean;
  // New fields for TodayPanel
  bps?: number | null;
  hurstExponent?: number | null;
  scanAdx?: number | null;
  scanAtrPercent?: number | null;
  // Earnings calendar data
  earningsInfo?: {
    daysUntilEarnings: number | null;
    nextEarningsDate: string | null;
    confidence: 'HIGH' | 'LOW' | 'NONE';
    action: 'AUTO_NO' | 'DEMOTE_WATCH' | null;
    reason: string | null;
  };
  // Allocation score breakdown (merged from /api/plan/allocation-score)
  allocationScore?: number | null;
  allocationRank?: number | null;
  qualityComponent?: number;
  expectancyComponent?: number;
  sleeveBalanceBonus?: number;
  clusterCrowdingPenalty?: number;
  sectorCrowdingPenalty?: number;
  earningsNearPenalty?: number;
  correlationPenalty?: number;
  capitalInefficiencyPenalty?: number;
  expectancyR?: number | null;
  correlatedHoldings?: string[];
}

/** Shape of a cross-ref ticker from /api/scan/cross-ref */
interface CrossRefTicker {
  ticker: string;
  yahooTicker?: string;
  name: string;
  sleeve: string;
  matchType: 'BOTH_RECOMMEND' | 'SCAN_ONLY' | 'DUAL_ONLY' | 'CONFLICT' | 'BOTH_REJECT';
  scanStatus?: string;
  scanPrice?: number;
  scanEntryTrigger?: number;
  scanStopPrice?: number;
  scanDistancePercent?: number;
  scanShares?: number;
  scanRiskDollars?: number;
  scanRankScore?: number;
  scanPassesFilters?: boolean;
  scanPassesRiskGates?: boolean;
  scanPassesAntiChase?: boolean;
  agreementScore?: number;
  dualNCS?: number;
  dualBQS?: number;
  dualFWS?: number;
  dualAction?: string;
  dualClose?: number;
  dualEntryTrigger?: number;
  dualStopLevel?: number;
  dualDistancePct?: number;
  // Per-ticker display currency (GBX for .L, USD for US, EUR etc.)
  priceCurrency?: string;
  // New fields for TodayPanel
  bps?: number | null;
  hurstExponent?: number | null;
  scanAdx?: number | null;
  scanAtrPercent?: number | null;
  // Earnings calendar data
  earningsInfo?: {
    daysUntilEarnings: number | null;
    nextEarningsDate: string | null;
    confidence: 'HIGH' | 'LOW' | 'NONE';
    action: 'AUTO_NO' | 'DEMOTE_WATCH' | null;
    reason: string | null;
  };
}

interface HealthReportData {
  overall: string;
  checks: Record<string, string>;
  results: { id: string; label: string; category: string; status: string; message: string }[];
}

interface RiskSummaryData {
  budget?: {
    maxRiskPercent: number;
    usedRiskPercent: number;
    maxPositions: number;
    usedPositions: number;
    sleeveUtilization: Record<string, { used: number; max: number }>;
  };
}

interface PositionData {
  id: string;
  ticker: string;
  name: string;
  sleeve: string;
  status: string;
  entryPrice: number;
  currentPrice: number;
  currentStop: number;
  initialRisk: number;
  protectionLevel: string;
  rMultiple: number;
  gainPercent: number;
  shares: number;
  priceCurrency?: string;
  stock?: { ticker: string; name: string; sleeve: string };
}

export default function PlanPage() {
  const { weeklyPhase, marketRegime } = useStore();
  const [positions, setPositions] = useState<PositionData[]>([]);
  const [scanCandidates, setScanCandidates] = useState<ReadyCandidate[]>([]);
  const [liveTickers, setLiveTickers] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [healthReport, setHealthReport] = useState<HealthReportData | null>(null);
  const [riskSummary, setRiskSummary] = useState<RiskSummaryData | null>(null);
  // EV modifier map: ticker → { modifier, dataQuality, tradeCount, expectancy }
  const [evModifiers, setEvModifiers] = useState<Record<string, { modifier: number; dataQuality: string; tradeCount: number; expectancy: number | null }>>({});

  const livePriceCandidateKey = scanCandidates
    .map((candidate) => `${candidate.ticker}:${candidate.yahooTicker || candidate.ticker}`)
    .join('|');

  // Advanced view toggle — persisted in localStorage
  const [advancedView, setAdvancedView] = useState(false);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(ADVANCED_VIEW_KEY);
      if (stored === 'true') setAdvancedView(true);
    } catch { /* localStorage not available */ }
  }, []);
  const toggleAdvanced = () => {
    setAdvancedView(prev => {
      const next = !prev;
      try { localStorage.setItem(ADVANCED_VIEW_KEY, String(next)); } catch { /* noop */ }
      return next;
    });
  };

  const fetchPositions = useCallback(async () => {
    try {
      // Fetch ALL OPEN positions (any source). Plan-side risk gates need the
      // full picture — filtering by source='trading212' would hide auto-traded
      // positions and under-count exposure when sizing/gating new buys.
      const data = await apiRequest<PositionApiResponse[]>(
        `/api/positions?userId=${DEFAULT_USER_ID}&status=OPEN`
      );
      const mapped: PositionData[] = data.map((p) => ({
        id: p.id,
        ticker: p.stock?.ticker || 'N/A',
        name: p.stock?.name || '',
        sleeve: p.stock?.sleeve || 'CORE',
        status: p.status,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice || p.entryPrice,
        currentStop: p.currentStop || p.stopLoss || 0,
        initialRisk: p.initialRisk || 0,
        protectionLevel: p.protectionLevel || 'INITIAL',
        rMultiple: p.rMultiple || 0,
        gainPercent: p.gainPercent || 0,
        shares: p.shares,
        priceCurrency: p.priceCurrency || 'GBP',
      }));

      setPositions(mapped);
    } catch (err) {
      console.error('Failed to fetch positions:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPositions();
  }, [fetchPositions]);

  useEffect(() => {
    const fetchHealthRiskAndScan = async () => {
      try {
        const [healthResult, riskResult, crossRefResult] = await Promise.allSettled([
          apiRequest<HealthReportData>(`/api/health-check?userId=${DEFAULT_USER_ID}`),
          apiRequest<RiskSummaryData>(`/api/risk?userId=${DEFAULT_USER_ID}`),
          apiRequest<{ tickers?: CrossRefTicker[] }>('/api/scan/cross-ref'),
        ]);

        if (healthResult.status === 'fulfilled') {
          setHealthReport(healthResult.value);
        }

        if (riskResult.status === 'fulfilled') {
          setRiskSummary(riskResult.value);
        }

        if (crossRefResult.status === 'fulfilled') {
          const crossRefData = crossRefResult.value;
          // Only show actionable candidates (not BOTH_REJECT)
          const actionable = (crossRefData.tickers || []).filter(
            (t) => t.matchType !== 'BOTH_REJECT'
          );
          // Map to ReadyCandidates shape with cross-ref enrichment
          const mapped = actionable
            .filter((t) => t.scanStatus === 'READY' || t.scanStatus === 'WATCH' || t.matchType === 'DUAL_ONLY')
            .map((t) => ({
              ticker: t.ticker,
              yahooTicker: t.yahooTicker,
              name: t.name,
              sleeve: t.sleeve,
              status: t.scanStatus || ((t.dualNCS ?? 0) >= 70 ? 'READY' : 'WATCH'),
              price: t.scanPrice || t.dualClose || 0,
              entryTrigger: t.scanEntryTrigger || t.dualEntryTrigger || 0,
              stopPrice: t.scanStopPrice || t.dualStopLevel || 0,
              distancePercent: t.scanDistancePercent ?? t.dualDistancePct ?? 0,
              shares: t.scanShares,
              riskDollars: t.scanRiskDollars ?? undefined,
              // Per-ticker display currency from cross-ref (GBX for .L, USD for US, etc.)
              priceCurrency: t.priceCurrency,
              // Cross-ref enrichment
              matchType: t.matchType === 'BOTH_REJECT' ? undefined : t.matchType,
              agreementScore: t.agreementScore,
              dualNCS: t.dualNCS,
              dualBQS: t.dualBQS,
              dualFWS: t.dualFWS,
              dualAction: t.dualAction,
              scanRankScore: t.scanRankScore,
              scanPassesFilters: t.scanPassesFilters,
              scanPassesRiskGates: t.scanPassesRiskGates,
              scanPassesAntiChase: t.scanPassesAntiChase,
              // TodayPanel fields
              bps: t.bps,
              hurstExponent: t.hurstExponent,
              scanAdx: t.scanAdx,
              scanAtrPercent: t.scanAtrPercent,
              // Earnings calendar data
              earningsInfo: t.earningsInfo,
            }));
          setScanCandidates(mapped);
        }
      } catch {
        // Silent fail
      }
    };

    fetchHealthRiskAndScan();
  }, []);

  // Fetch EV modifiers for candidates (separate effect — depends on marketRegime)
  useEffect(() => {
    const fetchEvModifiers = async () => {
      try {
        const regime = (marketRegime || 'UNKNOWN').toUpperCase();
        const data = await apiRequest<{ ok: boolean; modifiers: Record<string, { modifier: number; dataQuality: string; tradeCount: number; expectancy: number | null }> }>(
          `/api/ev-modifiers?regime=${regime}`
        );
        if (data.modifiers) {
          setEvModifiers(data.modifiers);
        }
      } catch {
        // Non-critical — EV modifiers enhance ranking but are not required
      }
    };

    fetchEvModifiers();
  }, [marketRegime]);

  // Fetch allocation scores and merge into candidates
  useEffect(() => {
    if (scanCandidates.length === 0) return;
    const fetchAllocationScores = async () => {
      try {
        const data = await apiRequest<{
          ok: boolean;
          entries: {
            ticker: string;
            allocationScore: number;
            rank: number;
            qualityComponent: number;
            expectancyComponent: number;
            sleeveBalanceBonus: number;
            clusterCrowdingPenalty: number;
            sectorCrowdingPenalty: number;
            earningsNearPenalty: number;
            correlationPenalty: number;
            capitalInefficiencyPenalty: number;
            expectancyR: number | null;
            correlatedHoldings: string[];
          }[];
        }>('/api/plan/allocation-score');
        if (data.ok && data.entries.length > 0) {
          const scoreMap = new Map(data.entries.map((e) => [e.ticker, e]));
          setScanCandidates((prev) =>
            prev.map((c) => {
              const s = scoreMap.get(c.ticker);
              if (!s) return c;
              return {
                ...c,
                allocationScore: s.allocationScore,
                allocationRank: s.rank,
                qualityComponent: s.qualityComponent,
                expectancyComponent: s.expectancyComponent,
                sleeveBalanceBonus: s.sleeveBalanceBonus,
                clusterCrowdingPenalty: s.clusterCrowdingPenalty,
                sectorCrowdingPenalty: s.sectorCrowdingPenalty,
                earningsNearPenalty: s.earningsNearPenalty,
                correlationPenalty: s.correlationPenalty,
                capitalInefficiencyPenalty: s.capitalInefficiencyPenalty,
                expectancyR: s.expectancyR,
                correlatedHoldings: s.correlatedHoldings,
              };
            })
          );
        }
      } catch {
        // Non-critical — allocation scores enhance ranking but are not required
      }
    };
    fetchAllocationScores();
  }, [scanCandidates.length]);

  // Fetch live prices for READY/WATCH candidates and update distance/price/status
  useEffect(() => {
    if (!livePriceCandidateKey) return;
    const fetchLivePrices = async () => {
      try {
        const candidateRefs = livePriceCandidateKey.split('|').map((item) => {
          const [ticker, yahooTicker] = item.split(':');
          return { ticker, yahooTicker };
        });
        const tickers = candidateRefs.map((c) => c.yahooTicker || c.ticker);
        if (tickers.length === 0) return;
        const data = await fetchLivePricesBatched(tickers);
        if (!data.prices) return;

        // Build a map from display ticker → live price
        const liveMap = new Map<string, number>();
        candidateRefs.forEach((c) => {
          const key = c.yahooTicker || c.ticker;
          if (data.prices[key]?.price) liveMap.set(c.ticker, data.prices[key].price);
        });

        if (liveMap.size === 0) return;

        // Track which tickers have live price data
        setLiveTickers(new Set(liveMap.keys()));

        // Update candidates with live prices and recalculated distances
        setScanCandidates((prev) =>
          prev.map((c) => {
            const livePrice = liveMap.get(c.ticker);
            if (!livePrice || !c.entryTrigger) return c;
            const liveDistance = ((c.entryTrigger - livePrice) / livePrice) * 100;
            // Promote WATCH → READY if live price has now triggered
            const liveStatus = liveDistance <= 0 && c.status === 'WATCH' ? 'READY' : c.status;
            return { ...c, price: livePrice, distancePercent: liveDistance, status: liveStatus };
          })
        );
      } catch {
        // Silent fail — scan-time prices still shown
      }
    };
    fetchLivePrices();
  }, [livePriceCandidateKey]);

  // Use cross-referenced scan candidates from 7-stage engine + dual scores
  const candidates = scanCandidates;

  const hasReadyCandidates = candidates.some((c) => c.status === 'READY');

  return (
    <div className="min-h-screen bg-background">
      <Navbar />

      <main className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-6 animate-fade-in">
        {/* ── Header: minimal in novice view, full in advanced ── */}
        {advancedView ? (
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-foreground flex items-center gap-3">
                <ClipboardList className="w-6 h-6 text-primary-400" />
                Execution Plan
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Think Sunday · Observe Monday · Act Tuesday · Manage Wed–Fri
              </p>
            </div>
            <div className="flex items-center gap-3">
              <RegimeBadge regime={marketRegime} />
              <div className="flex items-center gap-2 bg-navy-700/50 px-3 py-1.5 rounded-lg">
                <Calendar className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm text-foreground font-mono">
                  {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}
                </span>
              </div>
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="card-surface p-8 flex items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Loading...</span>
          </div>
        ) : (
          <>
          {/* ── Session Briefing Card ── */}
          <SessionBriefingCard candidates={candidates.filter(c => !positions.some(p => p.ticker === c.ticker)).map(c => ({ ticker: c.ticker, status: c.status }))} />

          {/* ── LAYER 1 + 2: TodayPanel (novice-first, always visible) ── */}
          <TodayPanel
            weeklyPhase={weeklyPhase}
            marketRegime={marketRegime}
            advancedView={advancedView}
            positions={positions.map(p => ({
              ticker: p.ticker,
              name: p.name,
              rMultiple: p.rMultiple,
              gainPercent: p.gainPercent,
              protectionLevel: p.protectionLevel,
              currentStop: p.currentStop,
              priceCurrency: p.priceCurrency,
            }))}
            candidates={candidates.map(c => ({
              ticker: c.ticker,
              name: c.name,
              price: c.price,
              entryTrigger: c.entryTrigger,
              stopPrice: c.stopPrice,
              distancePercent: c.distancePercent,
              shares: c.shares,
              riskDollars: c.riskDollars,
              priceCurrency: c.priceCurrency,
              dualNCS: c.dualNCS,
              dualBQS: c.dualBQS,
              dualFWS: c.dualFWS,
              bps: c.bps,
              hurstExponent: c.hurstExponent,
              scanAdx: c.scanAdx,
              sleeve: c.sleeve,
              atrPercent: c.scanAtrPercent,
              evModifier: evModifiers[c.ticker]?.modifier ?? null,
              earningsInfo: c.earningsInfo,
            }))}
            maxPositions={riskSummary?.budget?.maxPositions ?? 4}
            usedPositions={positions.length}
            usedRiskPercent={riskSummary?.budget?.usedRiskPercent ?? 0}
            maxRiskPercent={riskSummary?.budget?.maxRiskPercent ?? 10}
          />

          {/* ── LAYER 3 TOGGLE ── */}
          <div className="flex justify-center">
            <button
              onClick={toggleAdvanced}
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground bg-navy-800/50 hover:bg-navy-800/80 border border-border/30 px-4 py-2 rounded-lg transition-colors"
            >
              {advancedView ? (
                <>
                  Hide advanced view
                  <ChevronUp className="w-4 h-4" />
                </>
              ) : (
                <>
                  Show advanced view
                  <ChevronDown className="w-4 h-4" />
                </>
              )}
            </button>
          </div>

          {/* ── LAYER 3: Advanced View (all existing widgets) ── */}
          {advancedView && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Left Column */}
              <div className="space-y-6">
                <PhaseTimeline />
                <div className="card-surface p-4">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-primary-400" />
                    <span className="text-sm text-muted-foreground">
                      Stop queue managed in{' '}
                      <a href="/portfolio/positions" className="text-primary-400 hover:underline font-medium">
                        Positions →
                      </a>
                    </span>
                  </div>
                </div>
              </div>

              {/* Middle Column */}
              <div className="space-y-6">
                <ReadyCandidates candidates={candidates} heldTickers={new Set(positions.map(p => p.ticker))} liveTickers={liveTickers} />
                <PositionSizerWidget />
              </div>

              {/* Right Column */}
              <div className="space-y-6">
                <PreTradeChecklist
                  healthReport={healthReport}
                  riskBudget={riskSummary?.budget}
                  hasReadyCandidates={hasReadyCandidates}
                />
                <EarlyBirdWidget />
                <SwapSuggestionsWidget />
                <LaggardAlertsWidget />
                <AcceleratorWidget />
                <ExitIntelligenceCard />
              </div>
            </div>
          )}
          </>
        )}
      </main>
    </div>
  );
}
