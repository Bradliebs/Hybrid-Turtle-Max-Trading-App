'use client';

import { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Navbar from '@/components/shared/Navbar';
import StageFunnel from '@/components/scan/StageFunnel';
import TechnicalFilterGrid from '@/components/scan/TechnicalFilterGrid';
import CandidateTable from '@/components/scan/CandidateTable';
import CandidateEvidenceReview from '@/components/scan/CandidateEvidenceReview';
import PositionSizer from '@/components/scan/PositionSizer';
import dynamic from 'next/dynamic';

// Dynamic import: lightweight-charts (~45KB) only loaded when scan page is visited
const TickerChart = dynamic(() => import('@/components/scan/TickerChart'), { ssr: false });
// Lazy tabs — code-split so Scores/CrossRef only load on first click
const ScoresTab = lazy(() => import('@/components/scan/ScoresTab'));
const CrossRefTab = lazy(() => import('@/components/scan/CrossRefTab'));
import StatusBadge from '@/components/shared/StatusBadge';
import RegimeBadge from '@/components/shared/RegimeBadge';
import { cn, formatPrice } from '@/lib/utils';
import { apiRequest, ApiClientError, formatApiError } from '@/lib/api-client';
import { useStore } from '@/store/useStore';
import { Search, Play, Filter, Check, X, AlertTriangle, BarChart3, GitMerge, RefreshCw, XCircle } from 'lucide-react';

// Tab definitions
const TABS = [
  { id: 'pipeline', label: 'Pipeline', icon: Search },
  { id: 'scores', label: 'Scores', icon: BarChart3 },
  { id: 'cross-ref', label: 'Cross-Ref', icon: GitMerge },
] as const;
type TabId = (typeof TABS)[number]['id'];

/** Skeleton placeholder for lazy-loaded tabs */
function TabSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-8 w-64 bg-navy-800 rounded" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 bg-navy-800 rounded-lg" />
        ))}
      </div>
      <div className="h-64 bg-navy-800 rounded-lg" />
    </div>
  );
}

/** Live price data returned by /api/scan/live-prices */
interface LivePriceData {
  price: number;
  change: number;
  changePercent: number;
}

const DEFAULT_USER_ID = 'default-user';

/** Shape of the /api/scan response */
interface ScanApiResult {
  scanId?: string | null;
  candidates: ScanCandidate[];
  totalScanned?: number;
  passedFilters?: number;
  passedRiskGates?: number;
  passedAntiChase?: number;
  cachedAt?: string;
  hasCache?: boolean;
  source?: string;
}

/** Shape of the /api/risk response budget */
interface RiskBudgetSummary {
  budget?: {
    maxRiskPercent: number;
    usedRiskPercent: number;
    maxPositions: number;
    usedPositions: number;
    sleeveUtilization: Record<string, { used: number; max: number }>;
  };
}

import type { ScanCandidate } from '@/types';

/** Show yahoo ticker suffix when it differs from display ticker (e.g. TTE → TTE.PA) */
function YahooSuffix({ candidate }: { candidate: { ticker: string; yahooTicker?: string } }) {
  const yt = candidate.yahooTicker;
  if (!yt || yt === candidate.ticker) return null;
  return <span className="text-muted-foreground text-[10px] font-normal ml-1">({yt})</span>;
}

export default function ScanPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Search className="w-8 h-8 text-primary-400 animate-pulse" />
          <p className="text-sm text-muted-foreground">Loading scan...</p>
        </div>
      </div>
    }>
      <ScanPageInner />
    </Suspense>
  );
}

function ScanPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const activeTab = (searchParams.get('tab') ?? 'pipeline') as TabId;

  function handleTabChange(tab: TabId) {
    router.replace(`/scan?tab=${tab}`, { scroll: false });
  }

  const [activeStage, setActiveStage] = useState(1);
  const [isRunning, setIsRunning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ stage: string; processed: number; total: number } | null>(null);
  const [scanResult, setScanResult] = useState<ScanApiResult | null>(null);
  const [riskSummary, setRiskSummary] = useState<RiskBudgetSummary | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  // Live price overlay — fetched separately from scan-time prices
  const [livePrices, setLivePrices] = useState<Record<string, LivePriceData>>({});
  const [livePricesFetchedAt, setLivePricesFetchedAt] = useState<string | null>(null);
  const [isLoadingLive, setIsLoadingLive] = useState(false);
  const { marketRegime, riskProfile, equity } = useStore();
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isStaleError, setIsStaleError] = useState(false);
  const [isFixingStale, setIsFixingStale] = useState(false);

  const stages = [
    { num: 1, label: 'Universe' },
    { num: 2, label: 'Technical Filters' },
    { num: 3, label: 'Classification' },
    { num: 4, label: 'Ranking' },
    { num: 5, label: 'Risk Gates' },
    { num: 6, label: 'Anti-Chase' },
    { num: 7, label: 'Position Sizing' },
  ];

  const candidates = useMemo(() => scanResult?.candidates ?? [], [scanResult]);
  const passesAll = useMemo(() => candidates.filter((c) => c.passesAllFilters), [candidates]);
  const readyCandidates = useMemo(() => passesAll.filter((c) => c.status === 'READY'), [passesAll]);
  const watchCandidates = useMemo(() => passesAll.filter((c) => c.status === 'WATCH' || c.status === 'WAIT_PULLBACK'), [passesAll]);
  const farCandidates = useMemo(() => candidates.filter((c) => c.status === 'FAR'), [candidates]);

  const filterResults = useMemo(() => {
    return candidates.slice(0, 12).map((c) => ({
      ticker: c.ticker,
      name: c.name,
      ...c.filterResults,
      passesAll: c.passesAllFilters,
    }));
  }, [candidates]);

  const antiChaseResults = useMemo(() => {
    return passesAll.map((c) => ({
      ...c,
      guard: c.antiChaseResult,
      antiChasePassed: c.passesAntiChase ?? c.antiChaseResult?.passed,
    }));
  }, [passesAll]);

  const funnelStages = useMemo(() => {
    const sizedCount = passesAll.filter((c) => (c.shares || 0) > 0).length;
    const riskGateCount = scanResult?.passedRiskGates ?? passesAll.filter((c) => c.passesRiskGates === true).length;
    const antiChaseCount = scanResult?.passedAntiChase ?? antiChaseResults.filter((c) => c.antiChasePassed === true).length;
    return [
      { label: 'Stage 1: Universe', count: scanResult?.totalScanned || 0, color: '#7c3aed' },
      { label: 'Stage 2: Technical', count: scanResult?.passedFilters || 0, color: '#3b82f6' },
      { label: 'Stage 3: Classified', count: candidates.length, color: '#06b6d4' },
      { label: 'Stage 4: Ranked', count: candidates.length, color: '#22c55e' },
      { label: 'Stage 5: Risk Gates', count: riskGateCount, color: '#84cc16' },
      { label: 'Stage 6: Anti-Chase', count: antiChaseCount, color: '#f59e0b' },
      { label: 'Stage 7: Sized', count: sizedCount, color: '#ef4444' },
    ];
  }, [scanResult, candidates.length, passesAll, antiChaseResults]);

  const sleeveCounts = useMemo(() => {
    const counts = { CORE: 0, ETF: 0, HIGH_RISK: 0 };
    candidates.forEach((c) => {
      counts[c.sleeve as keyof typeof counts] += 1;
    });
    return counts;
  }, [candidates]);

  const riskCapChecks = useMemo(() => {
    if (!riskSummary?.budget) return [];
    const budget = riskSummary.budget;
    return [
      {
        label: `Total Open Risk ≤ ${budget.maxRiskPercent.toFixed(1)}%`,
        passed: budget.usedRiskPercent <= budget.maxRiskPercent,
        current: `${budget.usedRiskPercent.toFixed(1)}%`,
        limit: `${budget.maxRiskPercent.toFixed(1)}%`,
      },
      {
        label: `Max Positions (${budget.maxPositions})`,
        passed: budget.usedPositions < budget.maxPositions,
        current: String(budget.usedPositions),
        limit: String(budget.maxPositions),
      },
      {
        label: `Core Sleeve ≤ ${budget.sleeveUtilization.CORE.max.toFixed(0)}%`,
        passed: budget.sleeveUtilization.CORE.used <= budget.sleeveUtilization.CORE.max,
        current: `${budget.sleeveUtilization.CORE.used.toFixed(1)}%`,
        limit: `${budget.sleeveUtilization.CORE.max.toFixed(0)}%`,
      },
      {
        label: `ETF Sleeve ≤ ${budget.sleeveUtilization.ETF.max.toFixed(0)}%`,
        passed: budget.sleeveUtilization.ETF.used <= budget.sleeveUtilization.ETF.max,
        current: `${budget.sleeveUtilization.ETF.used.toFixed(1)}%`,
        limit: `${budget.sleeveUtilization.ETF.max.toFixed(0)}%`,
      },
      {
        label: `High-Risk Sleeve ≤ ${budget.sleeveUtilization.HIGH_RISK.max.toFixed(0)}%`,
        passed: budget.sleeveUtilization.HIGH_RISK.used <= budget.sleeveUtilization.HIGH_RISK.max,
        current: `${budget.sleeveUtilization.HIGH_RISK.used.toFixed(1)}%`,
        limit: `${budget.sleeveUtilization.HIGH_RISK.max.toFixed(0)}%`,
      },
    ];
  }, [riskSummary]);

  // Restore from sessionStorage immediately on mount (no flash of empty)
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem('scanResult');
      if (stored) {
        const parsed = JSON.parse(stored);
        setScanResult(parsed);
        setCachedAt(parsed.cachedAt || null);
      }
    } catch {
      // ignore corrupt sessionStorage
    }
  }, []);

  useEffect(() => {
    const fetchRisk = async () => {
      try {
        const data = await apiRequest<RiskBudgetSummary>(`/api/risk?userId=${DEFAULT_USER_ID}`);
        setRiskSummary(data);
      } catch {
        // Silent fail
      }
    };

    const fetchCachedScan = async () => {
      try {
        const data = await apiRequest<ScanApiResult>('/api/scan');
        if (data.hasCache) {
          setScanResult(data);
          setCachedAt(data.cachedAt || null);
          // Persist to sessionStorage for instant recovery on navigation
          try { sessionStorage.setItem('scanResult', JSON.stringify(data)); } catch {}
        }
      } catch {
        // Silent fail — no cache yet
      }
    };

    fetchRisk();
    fetchCachedScan();
  }, []);

  const runScan = async () => {
    setIsRunning(true);
    setScanProgress(null);
    setLivePrices({}); // Clear stale live prices when re-scanning

    // Poll /api/scan/progress every 800ms for real-time stage updates.
    // Polling is more reliable than SSE in Next.js dev mode where
    // module-level state can diverge between request handlers.
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/scan/progress');
        if (res.ok) {
          const data = await res.json();
          if (data && data.stage) setScanProgress(data);
        }
      } catch {
        // Poll failed — not critical, progress is cosmetic
      }
    }, 800);

    try {
      const data = await apiRequest<ScanApiResult>('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: DEFAULT_USER_ID,
          riskProfile,
          equity,
        }),
      });
      setScanResult(data);
      setCachedAt(data.cachedAt || new Date().toISOString());
      // Persist to sessionStorage for instant recovery on navigation
      try { sessionStorage.setItem('scanResult', JSON.stringify(data)); } catch {}
      setFetchError(null);
    } catch (err) {
      const isStale = err instanceof ApiClientError && err.code === 'SCANS_DISABLED_STALE_DATA';
      const isYahooRL = err instanceof ApiClientError && err.code === 'YAHOO_RATE_LIMITED';
      setIsStaleError(isStale);
      setFetchError(isStale
        ? 'Market data needs to be downloaded before your first scan.'
        : isYahooRL
        ? 'Yahoo Finance rate limit hit. Wait 2–3 minutes for the limit to reset, then retry.'
        : formatApiError(err, 'Scan failed. Check your connection and try again.'));
    } finally {
      clearInterval(pollInterval);
      setScanProgress(null);
      setIsRunning(false);
    }
  };

  // Fetch live prices for READY/WATCH candidates so the user sees
  // current market prices alongside the scan-time snapshot price.
  const fetchLivePrices = async () => {
    const actionable = [...readyCandidates, ...watchCandidates];
    if (actionable.length === 0) return;

    // Use yahooTicker if available, else ticker
    const tickers = actionable.map((c) => c.yahooTicker || c.ticker);
    setIsLoadingLive(true);
    try {
      const data = await apiRequest<{
        prices: Record<string, LivePriceData>;
        fetchedAt: string;
      }>('/api/scan/live-prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers }),
      });
      // Map back to display ticker (some tickers use yahooTicker like TTE.PA)
      const mapped: Record<string, LivePriceData> = {};
      actionable.forEach((c) => {
        const key = c.yahooTicker || c.ticker;
        if (data.prices[key]) {
          mapped[c.ticker] = data.prices[key];
        }
      });
      setLivePrices(mapped);
      setLivePricesFetchedAt(data.fetchedAt);
    } catch {
      // Silent fail — scan-time prices still shown
    } finally {
      setIsLoadingLive(false);
    }
  };

  // Auto-fetch live prices when READY/WATCH candidates are loaded
  useEffect(() => {
    if (readyCandidates.length + watchCandidates.length > 0) {
      fetchLivePrices();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyCandidates.length, watchCandidates.length]);

  return (
    <div className="min-h-screen bg-background">
      <Navbar />

      <main className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-6 animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-3">
              <Search className="w-6 h-6 text-primary-400" />
              7-Stage Scan Engine
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Systematic screening pipeline for trade candidates
              {cachedAt && (
                <span className="ml-2 text-xs text-primary-400/60">
                  Cached {new Date(cachedAt).toLocaleString()}
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <RegimeBadge regime={marketRegime} />
            <button
              onClick={runScan}
              className="btn-primary flex items-center gap-2"
              disabled={isRunning}
            >
              <Play className="w-4 h-4" />
              {isRunning ? 'Running Scan...' : 'Run Full Scan'}
            </button>
          </div>
        </div>

        <CandidateEvidenceReview key={scanResult?.scanId ?? 'no-scan'} scanId={scanResult?.scanId} />

        {/* Tab Bar */}
        {/* Fetch Error Banner */}
        {fetchError && isStaleError && (
          <div className="rounded-xl border border-warning/40 bg-warning/10 p-5 space-y-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
              <div className="space-y-1 flex-1">
                <p className="font-semibold text-warning">First-time setup: Market data needed</p>
                <p className="text-sm text-foreground/80">
                  Before the scan engine can run, it needs to download price data from Yahoo Finance.
                  This is a one-time step that takes 1–2 minutes. After this, the nightly task keeps data fresh automatically.
                </p>
              </div>
            </div>
            <button
              onClick={async () => {
                setIsFixingStale(true);
                try {
                  await apiRequest('/api/market-data/refresh-stale', { method: 'POST' });
                  setFetchError(null);
                  setIsStaleError(false);
                  runScan();
                } catch (fixErr) {
                  setFetchError(fixErr instanceof Error ? fixErr.message : 'Refresh failed. Try again or check your internet connection.');
                  setIsStaleError(false);
                } finally {
                  setIsFixingStale(false);
                }
              }}
              disabled={isFixingStale}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-warning text-navy-950 font-semibold disabled:opacity-60 hover:bg-warning/90 transition-colors"
            >
              <RefreshCw className={cn('w-4 h-4', isFixingStale && 'animate-spin')} />
              {isFixingStale ? 'Downloading data...' : 'Download Market Data'}
            </button>
          </div>
        )}
        {fetchError && !isStaleError && (
          <div className="flex items-center gap-3 p-4 rounded-lg bg-red-500/10 border border-red-500/30">
            <XCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
            <p className="text-sm text-red-300 flex-1">{fetchError}</p>
            <button
              onClick={() => { setFetchError(null); runScan(); }}
              className="px-3 py-1 text-xs font-medium rounded bg-red-500/20 text-red-300 hover:bg-red-500/30 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        <div className="card-surface p-1 flex gap-1">
          {TABS.map((tab) => {
            const TabIcon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={cn(
                  'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all',
                  isActive
                    ? 'bg-primary/15 text-primary-400 border border-primary/30'
                    : 'text-muted-foreground hover:text-foreground hover:bg-navy-800/50'
                )}
              >
                <TabIcon className="w-4 h-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* ══════════════════════════════════════════════════
            TAB: Scores
           ══════════════════════════════════════════════════ */}
        {activeTab === 'scores' && (
          <Suspense fallback={<TabSkeleton />}>
            <ScoresTab />
          </Suspense>
        )}

        {/* ══════════════════════════════════════════════════
            TAB: Cross-Reference
           ══════════════════════════════════════════════════ */}
        {activeTab === 'cross-ref' && (
          <Suspense fallback={<TabSkeleton />}>
            <CrossRefTab />
          </Suspense>
        )}

        {/* ══════════════════════════════════════════════════
            TAB: Pipeline (existing scan content)
           ══════════════════════════════════════════════════ */}
        {activeTab === 'pipeline' && (<>

        {/* Scan Progress Bar — sticky so it stays visible while scrolling */}
        {isRunning && (
          <div className="sticky top-0 z-30 card-surface p-4 border border-primary/30 shadow-lg shadow-primary/10">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-foreground flex items-center gap-2">
                <RefreshCw className="w-4 h-4 animate-spin text-primary-400" />
                {scanProgress?.stage || 'Starting scan...'}
              </span>
              {scanProgress && scanProgress.total > 0 && (
                <span className="text-xs text-muted-foreground font-mono">
                  {scanProgress.processed} / {scanProgress.total}
                  {' · '}
                  {Math.round((scanProgress.processed / scanProgress.total) * 100)}%
                </span>
              )}
            </div>
            <div className="w-full bg-navy-700 rounded-full h-2.5 overflow-hidden">
              <div
                className="bg-primary h-2.5 rounded-full transition-all duration-500 ease-out"
                style={{
                  width: scanProgress && scanProgress.total > 0
                    ? `${Math.round((scanProgress.processed / scanProgress.total) * 100)}%`
                    : '5%',
                }}
              />
            </div>
          </div>
        )}

        {/* Stage Selector */}
        <div className="card-surface p-2">
          <div className="flex gap-1 overflow-x-auto">
            {stages.map((stage) => (
              <button
                key={stage.num}
                onClick={() => setActiveStage(stage.num)}
                className={cn(
                  'flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-all',
                  activeStage === stage.num
                    ? 'bg-primary/20 text-primary-400 border border-primary/30'
                    : 'text-muted-foreground hover:text-foreground hover:bg-navy-600/30'
                )}
              >
                <span className="w-6 h-6 rounded-full bg-navy-700 flex items-center justify-center text-xs font-bold">
                  {stage.num}
                </span>
                {stage.label}
              </button>
            ))}
          </div>
        </div>

        {/* Compact sidebar for wide/short stages (1, 4, 7) */}
        {(activeStage === 1 || activeStage === 4 || activeStage === 7) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <StageFunnel stages={funnelStages} />
            <PositionSizer />
          </div>
        )}

        <div className={cn('grid gap-6', (activeStage === 1 || activeStage === 4 || activeStage === 7) ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-3')}>
          {/* Left: Funnel + Stage Content */}
          <div className={cn((activeStage === 1 || activeStage === 4 || activeStage === 7) ? '' : 'lg:col-span-2', 'space-y-6')}>
            {/* Stage 1: Universe */}
            {activeStage === 1 && (
              <div className="card-surface p-4">
                <h3 className="text-sm font-semibold text-foreground mb-4">Stock Universe</h3>
                <div className="grid grid-cols-3 gap-4">
                  <div className="bg-navy-800 p-4 rounded-lg text-center">
                    <div className="text-2xl font-bold text-primary-400 font-mono">{sleeveCounts.CORE}</div>
                    <div className="text-xs text-muted-foreground mt-1">Core Stocks</div>
                  </div>
                  <div className="bg-navy-800 p-4 rounded-lg text-center">
                    <div className="text-2xl font-bold text-warning font-mono">{sleeveCounts.HIGH_RISK}</div>
                    <div className="text-xs text-muted-foreground mt-1">High-Risk</div>
                  </div>
                  <div className="bg-navy-800 p-4 rounded-lg text-center">
                    <div className="text-2xl font-bold text-blue-400 font-mono">{sleeveCounts.ETF}</div>
                    <div className="text-xs text-muted-foreground mt-1">Core ETFs</div>
                  </div>
                </div>
              </div>
            )}

            {/* Stage 2: Technical Filters */}
            {activeStage === 2 && (
              <TechnicalFilterGrid results={filterResults} />
            )}

            {/* Stage 3: Classification */}
            {activeStage === 3 && (
              <div className="space-y-4">
                {/* Triggered Banner — compact */}
                {(() => {
                  const triggeredCandidates = passesAll.filter((c) => c.distancePercent <= 0);
                  if (triggeredCandidates.length === 0) return null;
                  return (
                    <div className="bg-emerald-500/10 border-2 border-emerald-500/40 rounded-xl px-5 py-3 animate-pulse">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center">
                            <span className="text-lg">⚡</span>
                          </div>
                          <div>
                            <div className="text-base font-bold text-emerald-400">
                              {triggeredCandidates.length} TRIGGERED — READY TO BUY
                            </div>
                            <div className="text-xs text-emerald-400/70">
                              Price is at or above entry trigger
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap justify-end">
                          {triggeredCandidates.map((c) => (
                            <span
                              key={c.ticker}
                              className="px-3 py-1 rounded-lg bg-emerald-500/20 text-emerald-400 text-sm font-bold border border-emerald-500/30"
                            >
                              {c.ticker}<YahooSuffix candidate={c} />
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Status summary cards + sleeve breakdown in a single row */}
                <div className="grid grid-cols-4 gap-4">
                  <div className="card-surface p-4 text-center border-profit/30 border">
                    <div className="text-3xl font-bold text-profit font-mono">{readyCandidates.length}</div>
                    <StatusBadge status="READY" className="mt-2" />
                    <div className="text-xs text-muted-foreground mt-1">≤ 2% from breakout</div>
                  </div>
                  <div className="card-surface p-4 text-center border-warning/30 border">
                    <div className="text-3xl font-bold text-warning font-mono">{watchCandidates.length}</div>
                    <StatusBadge status="WATCH" className="mt-2" />
                    <div className="text-xs text-muted-foreground mt-1">≤ 3% from breakout</div>
                  </div>
                  <div className="card-surface p-4 text-center border-loss/30 border">
                    <div className="text-3xl font-bold text-loss font-mono">{farCandidates.length}</div>
                    <StatusBadge status="FAR" className="mt-2" />
                    <div className="text-xs text-muted-foreground mt-1">&gt; 3% away — ignore</div>
                  </div>
                  {/* Sleeve breakdown card */}
                  <div className="card-surface p-4 border-primary/20 border">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">By Sleeve</div>
                    {(() => {
                      const sleeveMap: Record<string, { ready: number; watch: number; far: number }> = {};
                      candidates.forEach((c) => {
                        const s = c.sleeve || 'UNKNOWN';
                        if (!sleeveMap[s]) sleeveMap[s] = { ready: 0, watch: 0, far: 0 };
                        if (c.status === 'READY') sleeveMap[s].ready++;
                        else if (c.status === 'WATCH') sleeveMap[s].watch++;
                        else sleeveMap[s].far++;
                      });
                      return Object.entries(sleeveMap).map(([sleeve, counts]) => (
                        <div key={sleeve} className="flex items-center justify-between text-xs mb-1.5">
                          <span className="text-foreground font-medium">{sleeve.replace('_', ' ')}</span>
                          <div className="flex items-center gap-2 font-mono">
                            <span className="text-profit">{counts.ready}</span>
                            <span className="text-muted-foreground">/</span>
                            <span className="text-warning">{counts.watch}</span>
                            <span className="text-muted-foreground">/</span>
                            <span className="text-loss">{counts.far}</span>
                          </div>
                        </div>
                      ));
                    })()}
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-2 pt-2 border-t border-border">
                      <span className="text-profit">R</span> / <span className="text-warning">W</span> / <span className="text-loss">F</span>
                    </div>
                  </div>
                </div>

                <div className="text-xs text-muted-foreground px-1" title="WAIT_PULLBACK can be triggered by volatility expansion (extATR > 0.8) or gap anti-chase rules on any trading day.">
                  WAIT_PULLBACK can be triggered by volatility expansion (extATR &gt; 0.8) or gap anti-chase rules.
                </div>

                {/* Entry formula — inline compact */}
                <div className="flex items-center gap-3 px-4 py-2 bg-navy-800/50 rounded-lg text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">Entry Trigger:</span>
                  <span className="font-mono">20-day High + (10% × ATR buffer)</span>
                </div>

                {/* READY + WATCH candidates table — actionable detail */}
                {passesAll.length > 0 && (
                  <div className="card-surface overflow-x-auto">
                    <div className="p-3 border-b border-border flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-foreground">
                        READY & WATCH Candidates ({readyCandidates.length + watchCandidates.length})
                      </h3>
                      <div className="flex items-center gap-3">
                        {livePricesFetchedAt && (
                          <span className="text-[10px] text-muted-foreground">
                            Live: {new Date(livePricesFetchedAt).toLocaleTimeString()}
                          </span>
                        )}
                        <button
                          onClick={fetchLivePrices}
                          disabled={isLoadingLive}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-primary-400 hover:bg-primary/10 transition-colors disabled:opacity-50"
                          title="Refresh live prices"
                        >
                          <RefreshCw className={cn('w-3 h-3', isLoadingLive && 'animate-spin')} />
                          {isLoadingLive ? 'Loading…' : 'Live'}
                        </button>
                        <span className="text-xs text-muted-foreground">
                          Sorted by distance to entry trigger
                        </span>
                      </div>
                    </div>
                    <table className="data-table min-w-[800px]">
                      <thead>
                        <tr>
                          <th className="whitespace-nowrap">#</th>
                          <th className="whitespace-nowrap">Ticker</th>
                          <th className="whitespace-nowrap">Sleeve</th>
                          <th className="whitespace-nowrap">Status</th>
                          <th className="text-right whitespace-nowrap">Scan Price</th>
                          <th className="text-right whitespace-nowrap">
                            <span className="text-cyan-400">Live</span>
                          </th>
                          <th className="text-right whitespace-nowrap">Entry</th>
                          <th className="text-right whitespace-nowrap">Stop</th>
                          <th className="text-right whitespace-nowrap">Distance</th>
                          <th className="text-right whitespace-nowrap">Rank</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...readyCandidates, ...watchCandidates]
                          .sort((a, b) => a.distancePercent - b.distancePercent)
                          .map((c, i: number) => {
                            const live = livePrices[c.ticker];
                            // Recalculate distance from live price to entry trigger
                            const liveDistance = live && c.entryTrigger
                              ? ((c.entryTrigger - live.price) / live.price) * 100
                              : null;
                            const isTriggered = c.distancePercent <= 0;
                            // Check if live price has now triggered (crossed above entry)
                            const liveTriggered = liveDistance !== null && liveDistance <= 0;
                            return (
                              <tr
                                key={c.ticker}
                                className={cn(
                                  isTriggered && 'bg-emerald-500/10 border-l-2 border-l-emerald-400',
                                  !isTriggered && liveTriggered && 'bg-cyan-500/10 border-l-2 border-l-cyan-400'
                                )}
                              >
                                <td className="text-muted-foreground font-mono text-sm">{i + 1}</td>
                                <td>
                                  <div className="flex items-center gap-2">
                                    <span className={cn('font-semibold', isTriggered ? 'text-emerald-400' : 'text-primary-400')}>
                                      {c.ticker}<YahooSuffix candidate={c} />
                                    </span>
                                    {isTriggered && (
                                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 text-[10px] font-bold border border-emerald-500/30">
                                        ⚡ BUY
                                      </span>
                                    )}
                                    {!isTriggered && liveTriggered && (
                                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-400 text-[10px] font-bold border border-cyan-500/30">
                                        ⚡ LIVE
                                      </span>
                                    )}
                                  </div>
                                </td>
                                <td><StatusBadge status={c.sleeve} /></td>
                                <td>
                                  {isTriggered ? (
                                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                                      TRIGGERED
                                    </span>
                                  ) : (
                                    <StatusBadge status={c.status} />
                                  )}
                                </td>
                                {/* Scan-time price (from last scan run) */}
                                <td className="text-right font-mono text-sm text-muted-foreground">{formatPrice(c.price, c.priceCurrency)}</td>
                                {/* Live price from Yahoo quote API */}
                                <td className="text-right font-mono text-sm">
                                  {live ? (
                                    <div className="flex flex-col items-end">
                                      <span className="text-cyan-400 font-semibold">{formatPrice(live.price, c.priceCurrency)}</span>
                                      <span className={cn(
                                        'text-[10px]',
                                        live.changePercent >= 0 ? 'text-profit' : 'text-loss'
                                      )}>
                                        {live.changePercent >= 0 ? '+' : ''}{live.changePercent.toFixed(2)}%
                                      </span>
                                    </div>
                                  ) : (
                                    <span className="text-muted-foreground/40">—</span>
                                  )}
                                </td>
                                <td className="text-right font-mono text-sm text-primary-400">{formatPrice(c.entryTrigger, c.priceCurrency)}</td>
                                <td className="text-right font-mono text-sm text-loss">{formatPrice(c.stopPrice, c.priceCurrency)}</td>
                                <td className="text-right">
                                  {/* Show live distance if available, else scan-time distance */}
                                  {liveDistance !== null ? (
                                    liveTriggered ? (
                                      <span className="font-mono text-sm font-bold text-cyan-400">ABOVE</span>
                                    ) : (
                                      <span className={cn('font-mono text-sm', liveDistance <= 2 ? 'text-profit' : 'text-warning')}>
                                        {liveDistance.toFixed(1)}%
                                        {/* Show scan distance as subscript if different */}
                                        {Math.abs(liveDistance - c.distancePercent) > 0.1 && (
                                          <span className="text-[10px] text-muted-foreground ml-1">
                                            ({c.distancePercent.toFixed(1)}%)
                                          </span>
                                        )}
                                      </span>
                                    )
                                  ) : isTriggered ? (
                                    <span className="font-mono text-sm font-bold text-emerald-400">ABOVE</span>
                                  ) : (
                                    <span className={cn('font-mono text-sm', c.distancePercent <= 2 ? 'text-profit' : 'text-warning')}>
                                      {c.distancePercent?.toFixed(1)}%
                                    </span>
                                  )}
                                </td>
                                <td className="text-right font-mono text-sm text-foreground">{c.rankScore?.toFixed(1)}</td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* FAR candidates — collapsed summary */}
                {farCandidates.length > 0 && (
                  <details className="card-surface">
                    <summary className="p-3 cursor-pointer text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors flex items-center gap-2">
                      <Filter className="w-4 h-4" />
                      FAR Candidates ({farCandidates.length}) — too far from entry
                    </summary>
                    <div className="px-3 pb-3">
                      <div className="flex flex-wrap gap-2">
                        {farCandidates
                          .sort((a, b) => a.distancePercent - b.distancePercent)
                          .map((c) => (
                            <span
                              key={c.ticker}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-navy-800 text-xs"
                            >
                              <span className="text-muted-foreground font-semibold">{c.ticker}<YahooSuffix candidate={c} /></span>
                              <span className="text-loss font-mono">{c.distancePercent?.toFixed(1)}%</span>
                            </span>
                          ))}
                      </div>
                    </div>
                  </details>
                )}
              </div>
            )}

            {/* Stage 4: Ranking — rendered full-width below grid */}

            {/* Stage 5: Risk Cap Gates */}
            {activeStage === 5 && (
              <div className="card-surface p-4">
                <h3 className="text-sm font-semibold text-foreground mb-4">Risk Cap Gate Checks</h3>
                {/* Portfolio-level gates */}
                <div className="space-y-3 mb-6">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Portfolio-Level Gates</h4>
                  {riskCapChecks.length === 0 && (
                    <div className="text-xs text-muted-foreground text-center py-4">
                      No portfolio data available to evaluate risk gates.
                    </div>
                  )}
                  {riskCapChecks.map((check) => (
                    <div
                      key={check.label}
                      className="flex items-center gap-3 p-3 bg-navy-800 rounded-lg"
                    >
                      {check.passed ? (
                        <Check className="w-5 h-5 text-profit flex-shrink-0" />
                      ) : (
                        <X className="w-5 h-5 text-loss flex-shrink-0" />
                      )}
                      <span className="text-sm text-foreground flex-1">{check.label}</span>
                      <span className="text-sm font-mono text-muted-foreground">
                        {check.current} / {check.limit}
                      </span>
                    </div>
                  ))}
                </div>
                {/* Per-candidate gate results */}
                {passesAll.length > 0 && (
                  <div className="space-y-3">
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Per-Candidate Gate Results</h4>
                    {passesAll.map((c) => {
                      const failed = c.riskGateResults?.filter((g) => !g.passed) ?? [];
                      const gateStatus = c.passesRiskGates;
                      const icon = gateStatus === true
                        ? <Check className="w-4 h-4 text-profit flex-shrink-0" />
                        : gateStatus === false
                          ? <X className="w-4 h-4 text-loss flex-shrink-0" />
                          : <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0" />;
                      const message = c.riskGateResults
                        ? (failed.length === 0
                          ? `All ${c.riskGateResults.length} gates passed`
                          : failed.map((g) => g.message).join(' | '))
                        : gateStatus === true
                          ? 'Passed'
                          : gateStatus === false
                            ? 'Failed'
                            : 'Unknown';
                      return (
                        <div key={c.ticker} className="flex items-center gap-3 p-3 bg-navy-800 rounded-lg">
                          {icon}
                          <span className="text-primary-400 font-semibold w-16">{c.ticker}<YahooSuffix candidate={c} /></span>
                          <span className="text-sm text-muted-foreground flex-1">
                            {message}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Stage 6: Anti-Chasing Guard */}
            {activeStage === 6 && (
              <div className="card-surface p-4">
                <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-warning" />
                  Execution Guard (Anti-Chase)
                </h3>
                <div className="bg-warning/10 border border-warning/30 rounded-lg p-4 mb-4">
                  <p className="text-sm text-warning font-semibold">
                    Flags candidates where price gapped above trigger. Monday: (Price - Entry) / ATR &le; 0.75 AND &le; 3.0%. Tue–Fri: &le; 1.0 ATR AND &le; 4.0%. Configurable in Settings.
                  </p>
                </div>
                <div className="space-y-2">
                  {antiChaseResults.length === 0 && (
                    <div className="text-xs text-muted-foreground text-center py-4">
                      Run a scan to evaluate anti-chase checks.
                    </div>
                  )}
                  {antiChaseResults.map((c) => (
                    <div key={c.ticker} className="flex items-center gap-3 p-3 bg-navy-800 rounded-lg">
                      {c.antiChasePassed === true ? (
                        <Check className="w-4 h-4 text-profit" />
                      ) : c.antiChasePassed === false ? (
                        <X className="w-4 h-4 text-loss" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-warning" />
                      )}
                      <span className="text-primary-400 font-semibold">{c.ticker}<YahooSuffix candidate={c} /></span>
                      <span className="text-sm text-muted-foreground">— {c.guard?.reason ?? 'Unknown'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Stage 7: Position Sizing — rendered full-width below grid */}
          </div>

          {/* Right Sidebar: Funnel + Position Sizer (hidden on compact stages — shown above) */}
          {activeStage !== 1 && activeStage !== 4 && activeStage !== 7 && (
            <div className="space-y-6">
              <StageFunnel stages={funnelStages} />
              <PositionSizer />
            </div>
          )}
        </div>

        {/* Stage 4 & 7: Full-width candidate tables */}
        {activeStage === 4 && (
          <CandidateTable candidates={candidates} />
        )}
        {activeStage === 7 && (
          <CandidateTable candidates={passesAll} showSizing />
        )}

        {/* Technical Chart — select a candidate ticker to see price + indicators */}
        {candidates.length > 0 && (
          <TickerChart
            tickers={candidates.map((c) => ({
              ticker: c.ticker,
              sleeve: c.sleeve,
              status: c.status,
            }))}
            initialTicker={candidates[0]?.ticker}
          />
        )}

        </>)}
      </main>
    </div>
  );
}
