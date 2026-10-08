'use client';

/**
 * DEPENDENCIES
 * Consumed by: navigation
 * Consumes: src/components/dashboard/*, src/components/shared/*, src/store/useStore.ts, src/lib/api-client.ts, src/lib/utils.ts
 * Risk-sensitive: NO
 * Last modified: 2026-03-08
 * Notes: Main dashboard page, now including the Phase 9 evening-review summary widget.
 */

import { useEffect, useCallback, useState } from 'react';
import Navbar from '@/components/shared/Navbar';
import MarketIndicesBar from '@/components/dashboard/MarketIndicesBar';
import QuickActions from '@/components/dashboard/QuickActions';
import FearGreedGauge from '@/components/dashboard/FearGreedGauge';
import WeeklyPhaseIndicator from '@/components/dashboard/WeeklyPhaseIndicator';
import HealthTrafficLight from '@/components/dashboard/HealthTrafficLight';
import HeartbeatMonitor from '@/components/dashboard/HeartbeatMonitor';
import ScheduledTasksPanel from '@/components/dashboard/ScheduledTasksPanel';
import EquityCurveChart from '@/components/dashboard/EquityCurveChart';
import TradeHistoryChart from '@/components/dashboard/TradeHistoryChart';
import RegimeHistoryChart from '@/components/dashboard/RegimeHistoryChart';
import DataSourceTile from '@/components/dashboard/DataSourceTile';
import PriceAccuracyTile from '@/components/dashboard/PriceAccuracyTile';
import T212QuotaEventsPanel from '@/components/dashboard/T212QuotaEventsPanel';
import ModuleStatusPanel from '@/components/dashboard/ModuleStatusPanel';
import ActionCardWidget from '@/components/dashboard/ActionCardWidget';
import DualRegimeWidget from '@/components/dashboard/DualRegimeWidget';
import RiskModulesWidget from '@/components/dashboard/RiskModulesWidget';
import PyramidAlertsWidget from '@/components/dashboard/PyramidAlertsWidget';
import AcceleratorWidget from '@/components/dashboard/AcceleratorWidget';
import HedgeCard from '@/components/dashboard/HedgeCard';
import ScoringGuideWidget from '@/components/dashboard/ScoringGuideWidget';
import MigrationBanner from '@/components/dashboard/MigrationBanner';
import TodayDirectiveCard from '@/components/dashboard/TodayDirectiveCard';
import EveningReviewSummary from '@/components/dashboard/EveningReviewSummary';
import TonightWorkflowCard from '@/components/dashboard/TonightWorkflowCard';
import SafetyAlertsPanel from '@/components/dashboard/SafetyAlertsPanel';
import OnboardingBanner from '@/components/dashboard/OnboardingBanner';
import RegimeBadge from '@/components/shared/RegimeBadge';
import { useStore } from '@/store/useStore';
import { formatDate } from '@/lib/utils';
import {apiRequest, formatApiError } from '@/lib/api-client';
import type { FearGreedData, MarketRegime } from '@/types';
import { Bell, Play, FileText, Zap, RefreshCw, CheckCircle, XCircle, Loader2 } from 'lucide-react';

const DEFAULT_USER_ID = 'default-user';

interface PublicationItem {
  date: string;
  title: string;
  type: 'summary' | 'scan' | 'alert' | 'trade';
}

interface MarketIndex {
  ticker: string;
  name: string;
  value: number;
  change: number;
  changePercent: number;
}

interface ScanCandidateSummary {
  ticker: string;
  distancePercent: number;
  passesAllFilters: boolean;
}

interface ScanApiSummary {
  candidates?: ScanCandidateSummary[];
  cachedAt?: string;
  hasCache?: boolean;
}

export default function DashboardPage() {
  const {
    marketRegime,
    healthStatus,
    healthOverlayDismissed,
    dismissHealthOverlay,
    setMarketIndices,
    setFearGreed,
    setMarketRegime,
  } = useStore();
  const [publications, setPublications] = useState<PublicationItem[]>([]);
  const [triggerMetCount, setTriggerMetCount] = useState(0);
  const [triggerMetTickers, setTriggerMetTickers] = useState<string[]>([]);
  const [breakoutCount, setBreakoutCount] = useState(0);
  const [scanCachedAt, setScanCachedAt] = useState<string | null>(null);
  const nightlyRunning = useStore((s) => s.nightlyRunning);
  const nightlyResult = useStore((s) => s.nightlyResult);
  const setNightlyRunning = useStore((s) => s.setNightlyRunning);
  const setNightlyResult = useStore((s) => s.setNightlyResult);
  const [initialLoading, setInitialLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchLiveMarketData = useCallback(async () => {
    try {
      const [indicesResult, fgResult, regimeResult] = await Promise.allSettled([
        apiRequest<{ indices?: MarketIndex[] }>('/api/market-data?action=indices'),
        apiRequest<FearGreedData>('/api/market-data?action=fear-greed'),
        apiRequest<{ regime?: MarketRegime }>('/api/market-data?action=regime'),
      ]);

      if (indicesResult.status === 'fulfilled') {
        const indicesData = indicesResult.value;
        if (indicesData.indices) setMarketIndices(indicesData.indices);
      }
      if (fgResult.status === 'fulfilled') {
        const fgData = fgResult.value;
        if (fgData.value !== undefined) setFearGreed(fgData);
      }
      if (regimeResult.status === 'fulfilled') {
        const regimeData = regimeResult.value;
        if (regimeData.regime) setMarketRegime(regimeData.regime);
      }
      // Clear any previous error on successful fetch
      setFetchError(null);
    } catch (err) {
      console.error('Failed to fetch live market data:', err);
      setFetchError(formatApiError(err, 'Failed to load dashboard data'));
    }
  }, [setMarketIndices, setFearGreed, setMarketRegime]);

  const fetchPublications = useCallback(async () => {
    try {
      const data = await apiRequest<{ publications?: PublicationItem[] }>(`/api/publications?userId=${DEFAULT_USER_ID}`);
      const items = (data.publications || []).map((item: PublicationItem) => ({
        ...item,
        date: formatDate(item.date),
      }));
      setPublications(items);
    } catch {
      // Silent fail
    }
  }, []);

  const fetchTriggerStatus = useCallback(async () => {
    try {
      const data = await apiRequest<ScanApiSummary>('/api/scan');
      const candidates = data.candidates || [];
      const triggered = candidates.filter((candidate) => candidate.passesAllFilters && candidate.distancePercent <= 0);
      // Breakout count: candidates at or above their 20-day high (advisory context)
      const breakoutCandidates = candidates.filter((candidate) => candidate.distancePercent <= 0);

      setTriggerMetCount(triggered.length);
      setTriggerMetTickers(triggered.map((candidate) => candidate.ticker));
      setBreakoutCount(breakoutCandidates.length);
      setScanCachedAt(data.cachedAt || null);
    } catch {
      setTriggerMetCount(0);
      setTriggerMetTickers([]);
      setBreakoutCount(0);
      setScanCachedAt(null);
    }
  }, []);

  // Fetch market data + publications in parallel on mount (no auto-polling — manual refresh via MarketIndicesBar)
  useEffect(() => {
    Promise.allSettled([
      fetchLiveMarketData(),
      fetchPublications(),
      fetchTriggerStatus(),
    ]).finally(() => setInitialLoading(false));
  }, [fetchLiveMarketData, fetchPublications, fetchTriggerStatus]);

  return (
    <div className="min-h-screen bg-background">
      <Navbar />

      {initialLoading && (
        <div className="flex flex-col items-center justify-center py-32 gap-3 animate-fade-in">
          <Loader2 className="w-8 h-8 text-primary-400 animate-spin" />
          <p className="text-sm text-muted-foreground">Loading dashboard…</p>
        </div>
      )}

      {/* Database Migration Banner */}
      {!initialLoading && <MigrationBanner />}

      {/* Fetch Error Banner */}
      {!initialLoading && fetchError && (
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 pt-4">
          <div className="flex items-center gap-3 p-4 rounded-lg bg-red-500/10 border border-red-500/30">
            <XCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
            <p className="text-sm text-red-300 flex-1">{fetchError}</p>
            <button
              onClick={() => { setFetchError(null); setInitialLoading(true); Promise.allSettled([fetchLiveMarketData(), fetchPublications(), fetchTriggerStatus()]).finally(() => setInitialLoading(false)); }}
              className="px-3 py-1 text-xs font-medium rounded bg-red-500/20 text-red-300 hover:bg-red-500/30 transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* RED Health Warning Banner */}
      {!initialLoading && healthStatus === 'RED' && !healthOverlayDismissed && (
        <div className="health-overlay">
          <div className="text-center max-w-lg mx-auto p-8">
            <div className="w-20 h-20 rounded-full bg-warning/20 mx-auto mb-6 flex items-center justify-center animate-pulse-red">
              <span className="text-4xl">⚠️</span>
            </div>
            <h1 className="text-3xl font-bold text-warning mb-4">SYSTEM WARNING</h1>
            <p className="text-lg text-muted-foreground mb-6">
              Health check has issues. Review the report — trading is allowed but proceed with caution.
            </p>
            <div className="flex items-center justify-center gap-3">
              <a href="/risk" className="btn-danger inline-flex items-center gap-2">
                View Health Report
              </a>
              <button
                type="button"
                onClick={dismissHealthOverlay}
                className="btn-secondary inline-flex items-center gap-2"
              >
                Continue to Dashboard
              </button>
            </div>
          </div>
        </div>
      )}

      {!initialLoading && (
      <main className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-6 animate-fade-in">
        {/* Onboarding Guide — shown when setup is incomplete */}
        <OnboardingBanner />

        {/* Today's Directive — first element */}
        <TodayDirectiveCard />

        {/* Market Indices Row */}
        <MarketIndicesBar />

        {/* Weekly Phase Banner */}
        <WeeklyPhaseIndicator />

        {/* System Status Row */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <HealthTrafficLight />
          <div className="card-surface p-4">
            <h3 className="text-sm font-semibold text-foreground mb-3">Market Regime</h3>
            <div className="flex items-center gap-3">
              <RegimeBadge regime={marketRegime} size="lg" />
              <div className="text-xs text-muted-foreground">
                {marketRegime === 'BULLISH'
                  ? 'New positions allowed'
                  : 'Caution advised \u2014 market is not bullish'}
              </div>
            </div>
          </div>
          <HeartbeatMonitor />
          <DataSourceTile />
          <PriceAccuracyTile />
          <T212QuotaEventsPanel />
          <ScheduledTasksPanel />
        </div>

        <EquityCurveChart />

        <TradeHistoryChart />

        <RegimeHistoryChart />

        <EveningReviewSummary />

        <TonightWorkflowCard />

        <SafetyAlertsPanel />

        <div className="card-surface p-4">
          <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <Zap className="w-4 h-4 text-emerald-400" />
            Trigger Status
          </h3>
          {triggerMetCount > 0 ? (
            <div className="space-y-2">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 text-xs font-bold">
                {triggerMetCount} TRIGGERED — READY TO BUY
              </div>
              {breakoutCount > 0 && (
                <div className="inline-flex items-center gap-1.5 ml-2 px-3 py-1 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 text-xs font-semibold">
                  {breakoutCount} at breakout
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {triggerMetTickers.slice(0, 8).map((ticker) => (
                  <span
                    key={ticker}
                    className="px-2.5 py-1 rounded-lg bg-emerald-500/20 text-emerald-400 text-xs font-semibold border border-emerald-500/30"
                  >
                    {ticker}
                  </span>
                ))}
                {triggerMetTickers.length > 8 && (
                  <span className="px-2.5 py-1 rounded-lg bg-navy-700 text-muted-foreground text-xs font-semibold border border-border">
                    +{triggerMetTickers.length - 8} more
                  </span>
                )}
              </div>
              {scanCachedAt && (
                <div className="text-xs text-muted-foreground">
                  Based on latest scan cache: {new Date(scanCachedAt).toLocaleString()}
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              No trigger met in the latest scan cache.
              {breakoutCount > 0 && (
                <span className="ml-1 text-cyan-300">
                  ({breakoutCount} at breakout level)
                </span>
              )}
            </div>
          )}
        </div>

        {/* Run Nightly Snapshot */}
        <div className="card-surface p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="bg-primary/10 w-10 h-10 rounded-lg flex items-center justify-center">
                <RefreshCw className="w-5 h-5 text-primary-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Nightly Snapshot</h3>
                <p className="text-xs text-muted-foreground">
                  Run the full 9-step nightly pipeline — health check, live prices, stops, snapshot sync & Telegram alert
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {nightlyResult && (
                <div className={`flex items-center gap-1.5 text-xs font-medium ${
                  nightlyResult.ok ? 'text-profit' : 'text-loss'
                }`}>
                  {nightlyResult.ok ? (
                    <CheckCircle className="w-4 h-4" />
                  ) : (
                    <XCircle className="w-4 h-4" />
                  )}
                  {nightlyResult.message}
                </div>
              )}
              <button
                type="button"
                disabled={nightlyRunning}
                onClick={async () => {
                  setNightlyRunning(true);
                  setNightlyResult(null);
                  try {
                    // UI-only sibling of /api/nightly. The parent route is
                    // cron-only (CRON_SECRET); this one is session-gated and
                    // forwards to the same handler server-side.
                    const res = await fetch('/api/nightly/run-from-ui', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ userId: 'default-user' }),
                    });
                    const data = await res.json();
                    if (res.ok) {
                      setNightlyResult({ ok: true, message: `Done — ${data.summary?.snapshotSync?.tickerCount ?? '?'} tickers synced` });
                      // Refresh dashboard data after nightly completes
                      fetchLiveMarketData();
                      fetchTriggerStatus();
                    } else {
                      setNightlyResult({ ok: false, message: data?.error?.message || 'Nightly failed' });
                    }
                  } catch (err) {
                    setNightlyResult({ ok: false, message: (err as Error).message || 'Network error' });
                  } finally {
                    setNightlyRunning(false);
                  }
                }}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-primary/15 text-primary-400 border border-primary/30 hover:bg-primary/25 hover:border-primary/50"
              >
                {nightlyRunning ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
                {nightlyRunning ? 'Running...' : 'Run Nightly'}
              </button>
            </div>
          </div>
        </div>

        {/* Quick Actions */}
        <QuickActions />

        {/* Risk Signal Modules — Breadth, Momentum, Turnover, Whipsaw, Laggard, Climax */}
        <RiskModulesWidget />

        {/* Pyramid Add Alerts — Triggered and upcoming */}
        <PyramidAlertsWidget />

        {/* Capital Priority — Profit Acceleration Layer */}
        <AcceleratorWidget />

        {/* Module Status Panel — All 21 modules at a glance */}
        <ModuleStatusPanel />

        {/* Three Column Bottom */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Market Health / Fear & Greed */}
          <div>
            <FearGreedGauge />
          </div>

          {/* Center: Dual Benchmark Regime + Stability */}
          <div>
            <DualRegimeWidget />
          </div>

          {/* Right: Weekly Action Card */}
          <div>
            <ActionCardWidget />
          </div>
        </div>

        {/* Hedge Portfolio — Long-term holds with guidance */}
        <HedgeCard />

        {/* Scoring Guide — BPS interpretation + factor breakdown */}
        <ScoringGuideWidget />

        {/* Publications/Alerts Row */}
        <div className="grid grid-cols-1 lg:grid-cols-1 gap-6">
          <div className="card-surface p-4">
            <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
              <Bell className="w-4 h-4 text-warning" />
              Recent Alerts & Publications
            </h3>
            <div className="space-y-3">
              {publications.length === 0 && (
                <div className="text-xs text-muted-foreground text-center py-4">
                  No recent publications yet.
                </div>
              )}
              {publications.map((pub) => (
                <div
                  key={`${pub.date}-${pub.title}`}
                  className="flex items-center gap-3 p-3 rounded-lg hover:bg-navy-600/30 transition-colors cursor-pointer group"
                >
                  <div className="flex-shrink-0">
                    {pub.type === 'summary' ? (
                      <FileText className="w-4 h-4 text-primary-400" />
                    ) : pub.type === 'scan' ? (
                      <Play className="w-4 h-4 text-profit" />
                    ) : pub.type === 'alert' ? (
                      <Bell className="w-4 h-4 text-warning" />
                    ) : (
                      <FileText className="w-4 h-4 text-blue-400" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-foreground group-hover:text-primary-400 transition-colors truncate">
                      {pub.title}
                    </div>
                    <div className="text-xs text-muted-foreground">{pub.date}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
      )}
    </div>
  );
}
