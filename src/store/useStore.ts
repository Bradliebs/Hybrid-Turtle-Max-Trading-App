import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  HealthStatus,
  MarketRegime,
  WeeklyPhase,
  RiskProfileType,
  OperatingMode,
  MarketIndex,
  FearGreedData,
  NightlySummary,
  AllModulesResult,
} from '@/types';
import { getCurrentWeeklyPhase } from '@/types';

// ── Cache staleness window (ms) ──
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes — avoids re-fetch when navigating between pages

// ---- Store Types ----
interface Position {
  id: string;
  ticker: string;
  name: string;
  sleeve: string;
  status: 'OPEN' | 'CLOSED';
  entryPrice: number;
  entryDate: string;
  shares: number;
  stopLoss: number;
  initialRisk: number;
  currentStop: number;
  protectionLevel: string;
  exitPrice?: number;
  exitDate?: string;
  exitReason?: string;
  currentPrice?: number;
  rMultiple?: number;
  gainPercent?: number;
  gainDollars?: number;
  value?: number;
  sector?: string;
  cluster?: string;
}

interface AppState {
  // System State
  healthStatus: HealthStatus;
  marketRegime: MarketRegime;
  weeklyPhase: WeeklyPhase;
  lastHeartbeat: Date | null;
  heartbeatOk: boolean;
  heartbeatStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED' | null;

  // User State
  riskProfile: RiskProfileType;
  operatingMode: OperatingMode;
  equity: number;
  userId: string | null;

  // Market Data
  marketIndices: MarketIndex[];
  fearGreed: FearGreedData | null;

  // Portfolio State
  positions: Position[];
  totalValue: number;
  totalGain: number;
  totalGainPercent: number;
  dailyGain: number;
  dailyGainPercent: number;
  cash: number;

  // UI State
  isLoading: boolean;
  error: string | null;
  healthOverlayDismissed: boolean;

  // Cached API Data
  modulesData: AllModulesResult | null;
  modulesFetchedAt: number; // timestamp ms
  modulesFetching: boolean;
  marketDataFetchedAt: number;

  // Nightly run state (survives tab navigation)
  nightlyRunning: boolean;
  nightlyResult: { ok: boolean; message: string } | null;

  // Actions
  setHealthStatus: (status: HealthStatus) => void;
  setMarketRegime: (regime: MarketRegime) => void;
  setWeeklyPhase: (phase: WeeklyPhase) => void;
  setHeartbeat: (timestamp: Date) => void;
  setHeartbeatStatus: (status: 'SUCCESS' | 'PARTIAL' | 'FAILED') => void;
  setRiskProfile: (profile: RiskProfileType) => void;
  setOperatingMode: (mode: OperatingMode) => void;
  setEquity: (equity: number) => void;
  setUserId: (id: string) => void;
  setMarketIndices: (indices: MarketIndex[]) => void;
  setFearGreed: (data: FearGreedData) => void;
  setPositions: (positions: Position[]) => void;
  updatePosition: (id: string, updates: Partial<Position>) => void;
  setPortfolioMetrics: (metrics: {
    totalValue: number;
    totalGain: number;
    totalGainPercent: number;
    dailyGain: number;
    dailyGainPercent: number;
    cash: number;
  }) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  dismissHealthOverlay: () => void;

  // Cache actions
  setModulesData: (data: AllModulesResult) => void;
  setModulesFetching: (fetching: boolean) => void;
  isModulesStale: () => boolean;
  setMarketDataFetchedAt: (ts: number) => void;
  isMarketDataStale: () => boolean;

  // Nightly actions
  setNightlyRunning: (running: boolean) => void;
  setNightlyResult: (result: { ok: boolean; message: string } | null) => void;
}

export const useStore = create<AppState>()(persist((set, get) => ({
  // System State
  healthStatus: 'YELLOW',
  marketRegime: 'SIDEWAYS',
  weeklyPhase: getCurrentWeeklyPhase(),
  lastHeartbeat: null,
  heartbeatOk: false,
  heartbeatStatus: null,

  // User State
  riskProfile: 'BALANCED',
  operatingMode: 'NORMAL',
  equity: 10000,
  userId: null,

  // Market Data
  marketIndices: [],
  fearGreed: null,

  // Portfolio State (demo data)
  positions: [],
  totalValue: 0,
  totalGain: 0,
  totalGainPercent: 0,
  dailyGain: 0,
  dailyGainPercent: 0,
  cash: 10000,

  // UI State
  isLoading: false,
  error: null,
  healthOverlayDismissed: false,

  // Cached API Data
  modulesData: null,
  modulesFetchedAt: 0,
  modulesFetching: false,
  marketDataFetchedAt: 0,

  // Nightly run state
  nightlyRunning: false,
  nightlyResult: null,

  // Actions
  setHealthStatus: (status) =>
    set((state) => ({
      healthStatus: status,
      healthOverlayDismissed:
        status === 'RED' && state.healthStatus !== 'RED'
          ? false
          : state.healthOverlayDismissed,
    })),
  setMarketRegime: (regime) => set({ marketRegime: regime }),
  setWeeklyPhase: (phase) => set({ weeklyPhase: phase }),
  setHeartbeat: (timestamp) =>
    set({
      lastHeartbeat: timestamp,
      heartbeatOk: Date.now() - timestamp.getTime() < 25 * 60 * 60 * 1000, // 25 hours
    }),
  setHeartbeatStatus: (status: 'SUCCESS' | 'PARTIAL' | 'FAILED') => set({ heartbeatStatus: status }),
  setRiskProfile: (profile) => set({ riskProfile: profile }),
  setOperatingMode: (mode) => set({ operatingMode: mode }),
  setEquity: (equity) => set({ equity }),
  setUserId: (id) => set({ userId: id }),
  setMarketIndices: (indices) => set({ marketIndices: indices }),
  setFearGreed: (data) => set({ fearGreed: data }),
  setPositions: (positions) => set({ positions }),
  updatePosition: (id, updates) =>
    set((state) => ({
      positions: state.positions.map((p) =>
        p.id === id ? { ...p, ...updates } : p
      ),
    })),
  setPortfolioMetrics: (metrics) => set(metrics),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  dismissHealthOverlay: () => set({ healthOverlayDismissed: true }),

  // Cache actions
  setModulesData: (data) => set({ modulesData: data, modulesFetchedAt: Date.now(), modulesFetching: false }),
  setModulesFetching: (fetching) => set({ modulesFetching: fetching }),
  isModulesStale: () => {
    const state = get();
    return !state.modulesData || Date.now() - state.modulesFetchedAt > CACHE_TTL;
  },
  setMarketDataFetchedAt: (ts) => set({ marketDataFetchedAt: ts }),
  isMarketDataStale: () => {
    const state = get();
    return Date.now() - state.marketDataFetchedAt > CACHE_TTL;
  },

  // Nightly actions
  setNightlyRunning: (running) => set({ nightlyRunning: running }),
  setNightlyResult: (result) => set({ nightlyResult: result }),
}), {
  name: 'hybrid-turtle-settings',
  partialize: (state) => ({
    riskProfile: state.riskProfile,
    operatingMode: state.operatingMode,
    equity: state.equity,
  }),
}));
