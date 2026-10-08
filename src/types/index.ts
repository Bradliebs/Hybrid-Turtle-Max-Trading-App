// ============================================================
// HybridTurtle Trading System v5.11 — Type Definitions
// ============================================================

// ---- Risk Profiles ----
export type RiskProfileType = 'CONSERVATIVE' | 'BALANCED' | 'SMALL_ACCOUNT' | 'AGGRESSIVE';

export interface RiskProfileConfig {
  name: string;
  riskPerTrade: number; // percentage
  risk_cash_cap?: number;
  risk_cash_floor?: number;
  per_position_max_loss_pct?: number; // percentage
  single_name_cap_pct?: number; // percentage
  efficiency_min?: number;
  adx_min?: number;
  vol_ratio_min?: number;
  initial_stop_atr_mult?: number;
  maxPositions: number;
  maxOpenRisk: number; // percentage
  description: string;
}

export const RISK_PROFILES: Record<RiskProfileType, RiskProfileConfig> = {
  CONSERVATIVE: {
    name: 'Conservative',
    riskPerTrade: 0.75,
    maxPositions: 8,
    maxOpenRisk: 7.0,
    description: 'Lower risk per trade, more diversified positions',
  },
  BALANCED: {
    name: 'Balanced',
    riskPerTrade: 0.95,
    maxPositions: 5,
    maxOpenRisk: 5.5,
    description: 'Moderate risk with balanced position sizing',
  },
  SMALL_ACCOUNT: {
    name: 'Small Account',
    riskPerTrade: 2.0,
    maxPositions: 4,
    maxOpenRisk: 10.0,
    description: 'Higher risk per trade for smaller account growth',
  },
  AGGRESSIVE: {
    name: 'Aggressive',
    riskPerTrade: 3.0,
    initial_stop_atr_mult: 2.0,
    maxPositions: 3,
    maxOpenRisk: 12.0,
    description: 'High-conviction mode — 3% risk, 3 positions, wider concentration limits',
  },
};

// ---- Operating Mode ----
// Operating mode is independent of risk profile. It controls behaviour, selectivity,
// and what the dashboard shows — not position sizing or risk caps.
// Operating mode can make the system stricter but cannot bypass hard safety gates.

export type OperatingMode =
  | 'NORMAL'
  | 'AGGRESSIVE_QUALITY'
  | 'CAPITAL_PRESERVATION'
  | 'RESEARCH';

export interface OperatingModeConfig {
  name: string;
  canBuy: boolean;
  canPyramid: boolean;
  requiresAGrade: boolean;
  stricterEntry: boolean;
  description: string;
}

export const OPERATING_MODES: Record<OperatingMode, OperatingModeConfig> = {
  NORMAL: {
    name: 'Normal',
    canBuy: true,
    canPyramid: true,
    requiresAGrade: false,
    stricterEntry: false,
    description: 'Standard operation — all candidates visible, normal entry rules.',
  },
  AGGRESSIVE_QUALITY: {
    name: 'Aggressive Quality',
    canBuy: true,
    canPyramid: true,
    requiresAGrade: true,
    stricterEntry: true,
    description: 'Fewer but stronger trades — only A-grade candidates, tighter entries.',
  },
  CAPITAL_PRESERVATION: {
    name: 'Capital Preservation',
    canBuy: false,
    canPyramid: false,
    requiresAGrade: false,
    stricterEntry: false,
    description: 'Protect capital — no new entries, manage and exit only.',
  },
  RESEARCH: {
    name: 'Research',
    canBuy: false,
    canPyramid: false,
    requiresAGrade: false,
    stricterEntry: false,
    description: 'Read-only — scan and review candidates with no execution.',
  },
};

// ---- Equity Review Thresholds ----
// Advisory only — never auto-changes risk profile
export const EQUITY_REVIEW_THRESHOLDS = [
  { equity: 1000, message: 'Account passed £1,000 — consider whether SMALL_ACCOUNT 4-position limit is still optimal' },
  { equity: 2000, message: 'Account passed £2,000 — BALANCED profile (5 positions, 0.95% risk) may now be appropriate' },
  { equity: 5000, message: 'Account passed £5,000 — review all profile options for better diversification' },
];

// ---- Gap Guard Config ----
export type GapGuardMode = 'ALL' | 'MONDAY_ONLY';

export interface GapGuardConfig {
  /** Which days the gap guard runs: 'ALL' (every trading day) or 'MONDAY_ONLY' (legacy) */
  enabledDays: GapGuardMode;
  /** ATR multiple threshold for Monday/weekend gaps (3-day gap) */
  weekendThresholdATR: number;
  /** Percent-above-trigger threshold for Monday/weekend gaps */
  weekendThresholdPct: number;
  /** ATR multiple threshold for Tuesday–Friday gaps (1-day gap) */
  dailyThresholdATR: number;
  /** Percent-above-trigger threshold for Tuesday–Friday gaps */
  dailyThresholdPct: number;
}

export const DEFAULT_GAP_GUARD_CONFIG: GapGuardConfig = {
  enabledDays: 'ALL',
  weekendThresholdATR: 0.75,
  weekendThresholdPct: 3.0,
  dailyThresholdATR: 1.0,
  dailyThresholdPct: 4.0,
};

// ---- Sleeve Caps ----
export const SLEEVE_CAPS = {
  CORE: 0.80,
  ETF: 0.80,
  HIGH_RISK: 0.40,
  HEDGE: 1.00, // No cap — long-term holds outside normal rules
} as const;

export const POSITION_SIZE_CAPS = {
  CORE: 0.16,
  ETF: 0.16,
  HIGH_RISK: 0.12,
  HEDGE: 0.20, // Flexible sizing for long-term conviction
} as const;

export const CLUSTER_CAP = 0.20;
export const SECTOR_CAP = 0.25;
export const SUPER_CLUSTER_CAP = 0.50; // Module 12: Super-Cluster Risk Cap
export const ATR_VOLATILITY_CAP_ALL = 8; // ATR% cap for Sleep-Well filter
export const ATR_VOLATILITY_CAP_HIGH_RISK = 7; // Stricter cap for HIGH_RISK

// Initial stop distance: entry minus ATR × this multiplier
export const ATR_STOP_MULTIPLIER = 1.5;
// Trailing stop distance: highestClose minus ATR × this multiplier (used by stop-manager)
export const ATR_TRAILING_MULTIPLIER = 1.5;

// ---- Snapshot Early-Warning Thresholds ----
// Looser thresholds used in snapshot rows to flag exposure *before*
// it reaches the hard trading-gate caps above. These are display/
// warning values only — not enforced by risk gates or position sizer.
export const SNAPSHOT_CLUSTER_WARNING = 0.35;
export const SNAPSHOT_SUPER_CLUSTER_WARNING = 0.60;

// ---- Profile-Aware Cap Overrides ----
// Per-profile overrides for concentration & position size caps.
// Profiles not listed here use the default constants above.
export interface ProfileCapOverrides {
  clusterCap: number;
  sectorCap: number;
  positionSizeCaps: Record<string, number>;
}

const PROFILE_CAP_OVERRIDES: Partial<Record<RiskProfileType, Partial<ProfileCapOverrides>>> = {
  SMALL_ACCOUNT: {
    clusterCap: 0.25,
    sectorCap: 0.30,
    positionSizeCaps: { CORE: 0.20 },
  },
  BALANCED: {
    positionSizeCaps: { CORE: 0.18 },
  },
  AGGRESSIVE: {
    clusterCap: 0.35,
    sectorCap: 0.45,
    positionSizeCaps: {
      CORE: 0.40,
      ETF: 0.40,
      HIGH_RISK: 0.20,
      HEDGE: 0.20,
    },
  },
};

/**
 * Get effective caps for a given risk profile.
 * Returns default constants merged with any per-profile overrides.
 * Makes it easy to add overrides for other profiles later.
 */
export function getProfileCaps(profile: RiskProfileType): {
  clusterCap: number;
  sectorCap: number;
  positionSizeCaps: Record<string, number>;
} {
  const overrides = PROFILE_CAP_OVERRIDES[profile];
  return {
    clusterCap: overrides?.clusterCap ?? CLUSTER_CAP,
    sectorCap: overrides?.sectorCap ?? SECTOR_CAP,
    positionSizeCaps: {
      ...POSITION_SIZE_CAPS,
      ...(overrides?.positionSizeCaps ?? {}),
    },
  };
}

// ---- Enums ----
export type Sleeve = 'CORE' | 'HIGH_RISK' | 'ETF' | 'HEDGE';
export type PositionStatus = 'OPEN' | 'CLOSED';
/** Historical naming: LOCK_08R originally used a +0.8R formula. Actual formula is entry + 0.5 × initialRisk. Name kept for DB compatibility. */
export type ProtectionLevel = 'INITIAL' | 'BREAKEVEN' | 'LOCK_08R' | 'LOCK_1R_TRAIL' | 'TRAILING_ATR';
export type MarketRegime = 'BULLISH' | 'SIDEWAYS' | 'BEARISH' | 'NEUTRAL';
export type VolRegime = 'LOW_VOL' | 'NORMAL_VOL' | 'HIGH_VOL';

/**
 * Normalise a raw regime string from the DB or API into a canonical MarketRegime.
 * 'NEUTRAL' (used as a DB default) is treated as 'SIDEWAYS' for logic/display.
 * Unknown values also map to 'SIDEWAYS'.
 */
export function normaliseRegime(raw: string | null | undefined): MarketRegime {
  if (!raw) return 'SIDEWAYS';
  const upper = raw.toUpperCase();
  if (upper === 'BULLISH') return 'BULLISH';
  if (upper === 'BEARISH') return 'BEARISH';
  if (upper === 'NEUTRAL' || upper === 'SIDEWAYS') return upper as MarketRegime;
  return 'SIDEWAYS';
}
export type CandidateStatus = 'READY' | 'WATCH' | 'WAIT_PULLBACK' | 'COOLDOWN' | 'FAR' | 'EARNINGS_BLOCK';
export type WeeklyPhase = 'PLANNING' | 'OBSERVATION' | 'EXECUTION' | 'MAINTENANCE';
export type HealthStatus = 'GREEN' | 'YELLOW' | 'RED';

// ---- Execution Mode (phase + regime → what entries are allowed) ----
export type ExecutionMode = 'PLANNED' | 'PLANNING';

// ---- Weekly Phase Helpers ----
export function getCurrentWeeklyPhase(): WeeklyPhase {
  // Use UK time (Europe/London) to match the trading calendar
  const ukDay = new Date().toLocaleDateString('en-GB', {
    weekday: 'short',
    timeZone: 'Europe/London',
  });
  switch (ukDay) {
    case 'Sun': return 'PLANNING';
    case 'Sat': return 'MAINTENANCE';
    default:    return 'EXECUTION';   // Mon-Fri
  }
}

export const PHASE_CONFIG: Record<WeeklyPhase, {
  label: string;
  dayLabel: string;
  color: string;
  bgColor: string;
  icon: string;
  description: string;
}> = {
  PLANNING: {
    label: 'Planning Phase',
    dayLabel: 'Sunday',
    color: '#8b5cf6',
    bgColor: 'rgba(139, 92, 246, 0.15)',
    icon: '📋',
    description: 'Review health checks, run scans, prepare execution plan',
  },
  OBSERVATION: {
    label: 'Execution Phase',
    dayLabel: 'Mon–Fri',
    color: '#22c55e',
    bgColor: 'rgba(34, 197, 94, 0.15)',
    icon: '⚡',
    description: 'Execute trades when candidates are ready (regime-gated)',
  },
  EXECUTION: {
    label: 'Execution Phase',
    dayLabel: 'Mon–Fri',
    color: '#22c55e',
    bgColor: 'rgba(34, 197, 94, 0.15)',
    icon: '⚡',
    description: 'Execute trades when candidates are ready (regime-gated)',
  },
  MAINTENANCE: {
    label: 'Maintenance Phase',
    dayLabel: 'Saturday',
    color: '#3b82f6',
    bgColor: 'rgba(59, 130, 246, 0.15)',
    icon: '🔧',
    description: 'Markets closed — review positions and prepare',
  },
};

// ---- Protection Level Config ----
export const PROTECTION_LEVELS: Record<ProtectionLevel, {
  label: string;
  threshold: number;
  stopFormula: string;
  color: string;
}> = {
  INITIAL: {
    label: 'Initial Stop',
    threshold: 0,
    stopFormula: 'Original stop price',
    color: '#ef4444',
  },
  BREAKEVEN: {
    label: 'Breakeven',
    threshold: 1.5,
    stopFormula: 'Entry price (break even)',
    color: '#f59e0b',
  },
  // Historical naming: "08R" refers to an earlier +0.8R formula.
  // Actual stop = entry + 0.5 × initialRisk. Persisted in Position.protectionLevel and StopHistory.level — do not rename without a DB migration.
  LOCK_08R: {
    label: 'Lock +0.5R',
    threshold: 2.5,
    stopFormula: 'Entry + 0.5 × Initial Risk',
    color: '#3b82f6',
  },
  LOCK_1R_TRAIL: {
    label: 'Lock +1R Trail',
    threshold: 3.0,
    stopFormula: 'Entry + 1.0 × Initial Risk',
    color: '#22c55e',
  },
  TRAILING_ATR: {
    label: 'Trailing ATR',
    threshold: 0,
    stopFormula: 'Highest Close − 1.5 × ATR(14)',
    color: '#8b5cf6',
  },
};

// ---- Health Check Types ----
export interface HealthCheckResult {
  id: string;
  label: string;
  category: string;
  status: HealthStatus;
  message: string;
}

export const HEALTH_CHECK_ITEMS: { id: string; label: string; category: string }[] = [
  { id: 'A1', label: 'Data Freshness', category: 'Data' },
  { id: 'A2', label: 'Duplicate Tickers', category: 'Data' },
  { id: 'A3', label: 'Column Population', category: 'Data' },
  { id: 'A4', label: 'Open Position Uniqueness', category: 'Data' },
  { id: 'A5', label: 'T212 Ticker Mappings', category: 'Data' },
  { id: 'A6', label: 'Yahoo Ticker Mappings', category: 'Data' },
  { id: 'A7', label: 'Sector Coverage', category: 'Data' },
  { id: 'C1', label: 'Equity > £0', category: 'Risk' },
  { id: 'C2', label: 'Open Risk Within Cap', category: 'Risk' },
  { id: 'C3', label: 'Valid Position Sizes', category: 'Risk' },
  { id: 'D', label: 'Stop Monotonicity', category: 'Logic' },
  { id: 'D2', label: 'Stop Integrity', category: 'Logic' },
  { id: 'E', label: 'State File Currency', category: 'Logic' },
  { id: 'F', label: 'Config Coherence', category: 'Logic' },
  // Extended checks for robustness
  { id: 'G1', label: 'Sleeve Limits', category: 'Allocation' },
  { id: 'G2', label: 'Cluster Concentration', category: 'Allocation' },
  { id: 'G3', label: 'Sector Concentration', category: 'Allocation' },
  { id: 'H1', label: 'Heartbeat Recent', category: 'System' },
  { id: 'H2', label: 'API Connectivity', category: 'System' },
  { id: 'H3', label: 'Database Integrity', category: 'System' },
  { id: 'H4', label: 'Cron Job Active', category: 'System' },
  { id: 'H5', label: 'Data Source', category: 'System' },
];

// ---- Stock Data ----
export interface StockQuote {
  ticker: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  previousClose: number;
  high: number;
  low: number;
  open: number;
}

export interface TechnicalData {
  currentPrice: number;
  ma200: number;
  ema20?: number;
  adx: number;
  plusDI: number;
  minusDI: number;
  atr: number;
  dayLow?: number;
  atr20DayAgo: number;
  atrSpiking: boolean;
  medianAtr14: number;     // Median of last 14 daily ATR values — used for spike detection
  atrPercent: number;
  twentyDayHigh: number;
  priorTwentyDayHigh?: number;
  efficiency: number;
  relativeStrength: number;
  volumeRatio: number;
  failedBreakoutAt: Date | null;  // Timestamp of most recent failed breakout (high crossed trigger, close fell back within 3 candles)
  weeklyAdx?: number;             // ADX computed on weekly candles (undefined if < 28 weeks of data)
  bis?: number;                   // Breakout Integrity Score (0–15) from latest candle OHLCV
}

// ---- Entry Quality ----
export type EntryWindowStatus =
  | 'BUY_ALLOWED'
  | 'WAIT_PULLBACK'
  | 'WAIT_SPREAD'
  | 'MISSED_DO_NOT_CHASE'
  | 'WATCH'
  | 'READY';

export type EntryDecision = 'BUY_NOW' | 'WAIT' | 'MISSED';

export type EntryQualityColor = 'GREEN' | 'YELLOW' | 'RED';

export interface EntryQuality {
  idealEntry: number;
  maxAllowedEntry: number;
  noChasePrice: number;
  entryWindowStatus: EntryWindowStatus;
  triggerDistancePct: number;
  extensionATR: number;
  slippageAdjustedLimit: number;
  suggestedOrderType: 'LIMIT' | 'MARKET' | 'STOP';
  decision: EntryDecision;
  reason: string;
  quality: EntryQualityColor;
}

// ---- Scan Candidate ----
export interface ScanCandidate {
  id: string;
  ticker: string;
  yahooTicker?: string;  // Exchange-qualified symbol for online lookup (e.g. TTE.PA, GSK.L)
  name: string;
  sleeve: Sleeve;
  sector: string;
  cluster: string;
  price: number;
  priceCurrency?: string;
  technicals: TechnicalData;
  entryTrigger: number;
  stopPrice: number;
  distancePercent: number;
  status: CandidateStatus;
  rankScore: number;
  passesAllFilters: boolean;
  // Risk gate results (Stage 5)
  riskGateResults?: { passed: boolean; gate: string; message: string; current: number; limit: number }[];
  passesRiskGates?: boolean;
  // Anti-chase result (Stage 6)
  antiChaseResult?: { passed: boolean; reason: string };
  pullbackSignal?: {
    triggered: boolean;
    mode: 'BREAKOUT' | 'PULLBACK_CONTINUATION';
    anchor: number;
    zoneLow: number;
    zoneHigh: number;
    entryPrice?: number;
    stopPrice?: number;
    reason: string;
  };
  passesAntiChase?: boolean;
  shares?: number;
  riskDollars?: number;
  riskPercent?: number;
  totalCost?: number;
  modelOverlay?: {
    enabled: boolean;
    baseSystemScore: number;
    modelScore: number;
    blendedScore: number;
    breakoutProbability: number;
    confidence: number;
    uncertainty: number;
    predictedRegime: MarketRegime;
    recommendation: 'PROMOTE' | 'NEUTRAL' | 'SUPPRESS';
    version: string;
    featureTimestamp: string;
  };
  // Earnings calendar info (from EarningsCache)
  earningsInfo?: {
    daysUntilEarnings: number | null;
    nextEarningsDate: string | null;  // ISO string for JSON serialisation
    confidence: 'HIGH' | 'LOW' | 'NONE';
    action: 'AUTO_NO' | 'DEMOTE_WATCH' | null;
    reason: string | null;
  };
  filterResults: {
    priceAboveMa200: boolean;
    adxAbove20: boolean;
    plusDIAboveMinusDI: boolean;
    atrPercentBelow8: boolean;
    efficiencyAbove30: boolean;
    dataQuality: boolean;
    atrSpiking?: boolean;
    atrSpikeAction?: 'NONE' | 'SOFT_CAP' | 'HARD_BLOCK';
    hurstExponent?: number | null;  // Hurst Exponent (0–1), null if insufficient data
    hurstWarn?: boolean;            // true when H < 0.5 (mean-reverting — trend signal may be noise)
  };
  // Entry Quality assessment (from entry-quality-engine)
  entryQuality?: EntryQuality;
}

// ---- Position Sizing ----
export interface PositionSizingResult {
  shares: number;
  totalCost: number;
  riskDollars: number;
  riskPercent: number;
  entryPrice: number;
  stopPrice: number;
  rPerShare: number;
}

// ---- Profit Acceleration ----

export type AcceleratorAction =
  | 'BUY_NEW_A_GRADE'
  | 'PYRAMID_WINNER'
  | 'HOLD'
  | 'TIGHTEN_STOP'
  | 'EXIT_LAGGARD'
  | 'SWAP_WEAK_FOR_STRONG'
  | 'NO_ACTION';

export type AcceleratorUrgency = 'HIGH' | 'MEDIUM' | 'LOW';

export interface AcceleratorRecommendation {
  action: AcceleratorAction;
  ticker: string;
  /** Second ticker for swaps (the stronger replacement) */
  replacementTicker?: string;
  urgency: AcceleratorUrgency;
  expectedBenefit: string;
  riskImpact: string;
  reason: string;
  requiresApproval: boolean;
  /** Score 0-100 for ranking actions */
  priority: number;
}

export interface OpportunityCostResult {
  blockedTicker: string;
  blockedNCS: number;
  holdingTicker: string;
  holdingNCS: number;
  holdingRMultiple: number;
  holdingDaysHeld: number;
  ncsGap: number;
  reason: string;
  swapRecommended: boolean;
}

export interface WinnerExpansionResult {
  ticker: string;
  allowed: boolean;
  rMultiple: number;
  addNumber: number;
  triggerPrice: number | null;
  riskScalar: number;
  reason: string;
  /** Risk gates that would fail if pyramid attempted */
  gateFailures: string[];
}

export interface DeadMoneyReviewResult {
  ticker: string;
  positionId: string;
  daysHeld: number;
  rMultiple: number;
  lossPct: number;
  /** Existing flag from laggard-detector */
  flag: 'TRIM_LAGGARD' | 'DEAD_MONEY' | 'NONE';
  /** New enrichments */
  opportunityCostScore: number;
  rsDecay: boolean;
  ncsDeterioration: boolean;
  trendDeteriorating: boolean;
  reason: string;
  exitUrgency: AcceleratorUrgency;
}

// ---- Exit Intelligence ----

export type ExitAction =
  | 'HOLD'
  | 'HOLD_AND_TRAIL'
  | 'TIGHTEN_STOP'
  | 'REVIEW_EXIT'
  | 'TRIM_REVIEW'
  | 'EXIT_REVIEW'
  | 'DO_NOT_TOUCH';

export interface ExitScoreBreakdown {
  /** 0-100: ADX strength + DI spread + MA20 position + NCS */
  trendHealth: number;
  /** 0-100: R-multiple + protection level + days held + momentum */
  winnerHold: number;
  /** 0-100: ADX decline + RS decay + NCS drop + MA20 loss */
  weakeningTrend: number;
  /** 0-100: composite of all factors — higher = stronger exit signal */
  exitReview: number;
  /** 0-100: A-grade candidates blocked × capital tied up */
  opportunityCost: number;
  /** 0-100: price above MA20 + volume spike */
  climaxRisk: number;
  /** 0-100: overnight gap magnitude vs ATR */
  gapRisk: number;
  /** 0-100: RS decay rate vs prior sessions */
  rsDecay: number;
}

export interface ExitIntelligenceResult {
  ticker: string;
  positionId: string;
  action: ExitAction;
  scores: ExitScoreBreakdown;
  /** Current R-multiple */
  rMultiple: number;
  /** Distance from current price to stop as % */
  stopDistancePct: number;
  /** Estimated giveback from current level to stop in R */
  givebackRiskR: number;
  /** Current protection level */
  protectionLevel: string;
  /** Plain English explanation */
  explanation: string;
  /** Detailed reasons for each active signal */
  signals: string[];
  /** Advisory-only flag */
  requiresApproval: boolean;
}

// ---- Market Index ----
export interface MarketIndex {
  name: string;
  ticker: string;
  value: number;
  change: number;
  changePercent: number;
}

// ---- Fear & Greed ----
export interface FearGreedData {
  value: number;
  label: string;
  previousClose: number;
  oneWeekAgo: number;
  oneMonthAgo: number;
}

// ---- Nightly Summary ----
export interface NightlySummary {
  id: string;
  date: Date;
  healthStatus: HealthStatus;
  regime: MarketRegime;
  positionsCount: number;
  stopsUpdated: number;
  alertsTriggered: string[];
  candidatesFound: number;
  heartbeatOk: boolean;
}

// ---- Navigation ----
export interface NavItem {
  label: string;
  href: string;
  icon?: string;
}

export interface NavGroup {
  label: string;
  icon?: string;
  children: NavItem[];
}

export type NavEntry = NavItem | NavGroup;

export function isNavGroup(entry: NavEntry): entry is NavGroup {
  return 'children' in entry;
}

/**
 * DEPENDENCIES
 * Consumed by: src/components/shared/Navbar.tsx and multiple app pages/components across the dashboard
 * Consumes: none
 * Risk-sensitive: NO
 * Last modified: 2026-03-08
 * Notes: Shared app types and navigation configuration.
 */
export const MAIN_NAV_ITEMS: NavEntry[] = [
  { label: 'Dashboard', href: '/dashboard' },
  { label: 'Portfolio', href: '/portfolio/positions' },
  { label: 'Scan', href: '/scan' },
  { label: 'Plan', href: '/plan' },
  { label: 'Risk', href: '/risk' },
  {
    label: 'Analysis',
    children: [
      { label: 'Price Accuracy', href: '/price-accuracy' },
    ],
  },
  {
    label: 'System',
    children: [
      { label: 'Alerts', href: '/alerts' },
      { label: 'Planned Trades', href: '/planned-trades' },
      { label: 'Stops', href: '/stops' },
      { label: 'Orders', href: '/orders' },
      { label: 'Jobs', href: '/jobs' },
      { label: 'Trade Log', href: '/trade-log' },
      { label: 'Journal', href: '/journal' },
      { label: 'Settings', href: '/settings' },
    ],
  },
];

export const PORTFOLIO_SUB_NAV: NavItem[] = [
  { label: 'Positions', href: '/portfolio/positions' },
  { label: 'Distribution', href: '/portfolio/positions?tab=distribution' },
  { label: 'Performance', href: '/portfolio/positions?tab=performance' },
];

// ============================================================
// Module Types — Python Parity
// ============================================================

// Module 2: Early Bird Entry
export interface EarlyBirdSignal {
  ticker: string;
  name: string;
  price: number;
  fiftyFiveDayHigh: number;
  rangePctile: number; // percentile in 55d range
  volumeRatio: number;
  regime: MarketRegime;
  eligible: boolean;
  reason: string;
  // Graduation Probability & Risk Efficiency (populated by scanEarlyBirds)
  adx: number;               // raw ADX value
  atrPercent: number;         // ATR as % of price
  ma200Distance: number;      // % above MA200
  graduationProbability: number; // 0–100 weighted score
  riskEfficiency: number;     // (entryTrigger - stop) / ATR — lower is better
  entryTrigger: number;       // 20d high + 0.1×ATR
  candidateStop: number;      // entryTrigger - 1.5×ATR
  priceCurrency?: string;     // display currency (GBX for .L tickers, USD for US, etc.)
  bps: number | null;         // Breakout Probability Score (0–19, higher = better)
}

// Module 3: Laggard Purge
export interface LaggardFlag {
  ticker: string;
  positionId: string;
  daysHeld: number;
  gainPercent: number;
  rMultiple: number;
  action: 'TRIM_LAGGARD' | 'TRIM' | 'WATCH';
  reason: string;
}

// Module 5 + 14: Climax Top Exit / Trim/Tighten
export interface ClimaxSignal {
  ticker: string;
  positionId: string;
  price: number;
  ma20: number;
  priceAboveMa20Pct: number;
  volumeRatio: number;
  isClimax: boolean;
  action: 'TRIM' | 'TIGHTEN' | 'NONE';
  reason: string;
}

// Module 7: Heat-Map Swap Logic
export interface SwapSuggestion {
  cluster: string;
  weakTicker: string;
  weakRMultiple: number;
  strongTicker: string;
  strongRankScore: number;
  reason: string;
}

// Module 8: Heat Check
export interface HeatCheckResult {
  cluster: string;
  positionsInCluster: number;
  avgMomentum: number;
  candidateTicker?: string;
  candidateMomentum?: number;
  blocked: boolean;
  reason: string;
}

// Module 10: Market Breadth Safety Valve
export interface BreadthSafetyResult {
  breadthPct: number; // % of universe above 50DMA
  threshold: number;  // 40%
  maxPositionsOverride: number | null; // null = no override
  isRestricted: boolean;
  reason: string;
}

// Module 11: Whipsaw Kill Switch
export interface WhipsawBlock {
  ticker: string;
  stopsInLast30Days: number;
  blocked: boolean;
  reason: string;
}

// Module 15: Trades Log / Slippage
export interface TradeLogEntry {
  id: string;
  ticker: string;
  action: 'BUY' | 'SELL' | 'TRIM';
  expectedPrice: number;
  actualPrice: number | null;
  slippagePercent: number | null;
  shares: number;
  reason: string;
  createdAt: string;
}

// Module 16: Turnover Monitor
export interface TurnoverMetrics {
  tradesLast30Days: number;
  avgHoldingPeriod: number; // days
  oldestPositionAge: number; // days
  closedPositionsLast30: number;
}

// Trigger-Met Candidate (price crossed above entry trigger)
export interface TriggerMetCandidate {
  ticker: string;
  name: string;
  sleeve: string;
  close: number;
  entryTrigger: number;
  stopLevel: number;
  distancePct: number;
  atr14: number;
  adx14: number;
  currency: string;
}

// Module 17: Weekly Action Card
export interface WeeklyActionCard {
  weekOf: string;
  regime: MarketRegime;
  breadthPct: number;
  readyCandidates: { ticker: string; status: string }[];
  triggerMet: TriggerMetCandidate[];
  stopUpdates: { ticker: string; from: number; to: number }[];
  riskBudgetPct: number;
  // Rich detail objects for drill-down
  laggardDetails: LaggardFlag[];
  climaxDetails: ClimaxSignal[];
  whipsawDetails: WhipsawBlock[];
  swapDetails: SwapSuggestion[];
  reentryDetails: ReEntrySignal[];
  maxPositions: number;
  notes: string[];
  // Backward-compat string arrays (used by markdown renderer)
  laggardFlags: string[];
  climaxFlags: string[];
  whipsawBlocks: string[];
  swapSuggestions: string[];
  reentrySignals: string[];
}

// Module 18: Stale Data Protection
export interface DataValidationResult {
  ticker: string;
  isValid: boolean;
  issues: string[];
  lastPriceDate?: string;
  daysSinceUpdate?: number;
  hasSpikeAnomaly?: boolean;
}

// Module 19: Dual Benchmark
export type BenchmarkTicker = 'SPY' | 'VWRL';

export interface DualRegimeResult {
  spy: { regime: MarketRegime; price: number; ma200: number };
  vwrl: { regime: MarketRegime; price: number; ma200: number };
  combined: MarketRegime;
  chopDetected: boolean;
  consecutiveDays: number;
}

// Module 20: Re-Entry Logic
export interface ReEntrySignal {
  ticker: string;
  exitDate: string;
  exitProfitR: number;
  daysSinceExit: number;
  cooldownComplete: boolean;
  reclaimedTwentyDayHigh: boolean;
  eligible: boolean;
  reason: string;
}

// Module 9 Regime Stability
export interface RegimeStabilityResult {
  currentRegime: MarketRegime | 'CHOP';
  consecutiveDays: number;
  isStable: boolean; // 3+ days
  band: { upper: number; lower: number; inBand: boolean };
  reason: string;
}

// Pyramid Add Alert
export interface PyramidAlert {
  ticker: string;
  positionId: string;
  entryPrice: number;
  currentPrice: number;
  initialRisk: number;
  atr: number | null;
  rMultiple: number;
  addsUsed: number;
  maxAdds: number;
  nextAddNumber: number;
  triggerPrice: number | null;
  allowed: boolean;
  message: string;
  priceCurrency: string;
  // Pyramid add sizing (scaled-down risk)
  riskScalar: number; // 0.5 for add #1, 0.25 for add #2, 0 if not allowed
  addShares: number; // Shares to buy for this add
  addRiskAmount: number; // Risk £ for this add (GBP)
  scaledRiskPercent: number; // Scaled risk % used for sizing
}

// Adaptive ATR Buffer (Module 11)
export interface AdaptiveBufferResult {
  ticker: string;
  atrPercent: number;
  bufferPercent: number; // 5-20% scaled
  adjustedEntryTrigger: number;
  volRegimeMultiplier: number; // 0.8 / 1.0 / 1.3 based on SPY vol regime
}

// Combined Module Dashboard Status
export interface ModuleStatus {
  id: number;
  name: string;
  status: 'GREEN' | 'YELLOW' | 'RED' | 'INACTIVE' | 'DISABLED';
  summary: string;
  details?: unknown;
}

export interface AllModulesResult {
  timestamp: string;
  earlyBirds: EarlyBirdSignal[];
  laggards: LaggardFlag[];
  climaxSignals: ClimaxSignal[];
  swapSuggestions: SwapSuggestion[];
  heatChecks: HeatCheckResult[];
  breadthSafety: BreadthSafetyResult;
  whipsawBlocks: WhipsawBlock[];
  regimeStability: RegimeStabilityResult;
  dualRegime: DualRegimeResult;
  turnover: TurnoverMetrics;
  dataValidation: DataValidationResult[];
  reentrySignals: ReEntrySignal[];
  pyramidAlerts: PyramidAlert[];
  actionCard: WeeklyActionCard;
  moduleStatuses: ModuleStatus[];
}

// ============================================================
// Analytics Types — Research & Measurement System
// ============================================================

/** Per-candidate filter attribution record — captures every filter pass/fail */
export interface FilterAttributionRecord {
  ticker: string;
  scanId: string;
  regime: string;
  sleeve: string;
  status: string;
  // Stage 2: Technical filters
  priceAboveMa200: boolean;
  ma200Value: number;
  adxAbove20: boolean;
  adxValue: number;
  plusDIAboveMinusDI: boolean;
  plusDIValue: number;
  minusDIValue: number;
  atrPctBelow8: boolean;
  atrPctValue: number;
  dataQuality: boolean;
  efficiencyAbove30: boolean;
  efficiencyValue: number;
  hurstExponent: number | null;
  hurstWarn: boolean;
  atrSpiking: boolean;
  atrSpikeAction: string | null;
  // Stage 3
  distancePct: number;
  // Stage 5
  passesRiskGates: boolean;
  riskGatesFailed: string | null;
  // Stage 6
  passesAntiChase: boolean;
  antiChaseReason: string | null;
  // Earnings
  earningsAction: string | null;
  daysToEarnings: number | null;
  // Composite
  passesAllFilters: boolean;
  rankScore: number;
  // Outcome (backfilled)
  tradeLogId?: string | null;
  outcomeR?: number | null;
}

/** Score breakdown — all BQS/FWS/NCS sub-component values for one ticker */
export interface ScoreBreakdownRecord {
  ticker: string;
  snapshotId: string;
  regime: string;
  sleeve: string | null;
  // BQS (10 components)
  bqsTrend: number;
  bqsDirection: number;
  bqsVolatility: number;
  bqsProximity: number;
  bqsTailwind: number;
  bqsRs: number;
  bqsVolBonus: number;
  bqsWeeklyAdx: number;
  bqsBis: number;
  bqsHurst: number;
  bqsTotal: number;
  // FWS (5 components)
  fwsVolume: number;
  fwsExtension: number;
  fwsMarginalTrend: number;
  fwsVolShock: number;
  fwsRegimeInstability: number;
  fwsTotal: number;
  // Penalties (3)
  penaltyEarnings: number;
  penaltyCluster: number;
  penaltySuperCluster: number;
  // NCS
  baseNcs: number;
  ncsTotal: number;
  actionNote: string | null;
  // Outcome (backfilled)
  tradeLogId?: string | null;
  outcomeR?: number | null;
}

/** Execution drag — model vs. actual for one trade */
export type ExecutionFillEvidenceStatus = 'LEGACY_UNVERIFIED' | 'INVALID_EVIDENCE'
  | 'PLANNED_ENTRY_FALLBACK' | 'ORDER_VALUE_OVER_QUANTITY' | 'HISTORY_HELPER' | 'TIMEOUT_RECOVERY';

export interface ExecutionDragRecord {
  tradeLogId: string;
  ticker: string;
  tradeDate: string;
  // Entry drag
  modelEntry: number;
  actualEntry: number | null;
  fillEvidenceStatus: ExecutionFillEvidenceStatus;
  entrySlippagePct: number | null;
  entryGapR: number | null;
  // Stop drag (planned initial vs what was actually set)
  modelStop: number | null;
  actualStop: number | null;
  // R-multiple drag
  modelR: number | null;
  actualR: number | null;
  rDrag: number | null;  // actualR - modelR
  // Timing cost: days between scan-ready and actual entry
  daysToFill: number | null;
}

/** Aggregated execution drag stats */
export interface ExecutionDragSummary {
  measurement: 'PLANNED_TRIGGER_TO_FILL';
  eligibleEntryLogs: number;
  totalTrades: number;
  withFills: number;
  fillEvidenceCounts: Record<ExecutionFillEvidenceStatus, number>;
  withEntryGapPct: number;
  withEntryGapR: number;
  distinctMeasuredEntryDays: number;
  avgEntrySlippagePct: number | null;
  medianEntrySlippagePct: number | null;
  p90EntrySlippagePct: number | null;
  avgEntryGapR: number | null;
  avgRDrag: number | null;
  medianRDrag: number | null;
  avgDaysToFill: number | null;
  totalSlippageCostGbp: number | null;
  limitations: string[];
}

/** Capital allocation ranking — one entry per recommended position */
export interface AllocationEntry {
  rank: number;
  ticker: string;
  name: string;
  sleeve: Sleeve;
  ncs: number;
  fws: number;
  bqs: number;
  entryTrigger: number;
  stopPrice: number;
  shares: number;
  positionSizeGbp: number;
  riskGbp: number;
  riskPct: number;
  tier: 'RECOMMENDED' | 'IF_BUDGET_ALLOWS';
  cumulativeRiskPct: number;
  riskGatesPassed: boolean;
}

/** Rule overlap pair — two rules that co-fire frequently */
export interface RuleOverlapPair {
  ruleA: string;
  ruleB: string;
  coOccurrenceRate: number;   // 0–1: how often both fire together
  sampleSize: number;
  aAloneAvgR: number | null;  // avg R when only A fires (not B)
  bAloneAvgR: number | null;  // avg R when only B fires (not A)
  bothAvgR: number | null;    // avg R when both fire
  redundancyScore: number;    // 0–1: 1 = fully redundant
}

/** Scan mode: FULL (production), BENCHMARK (MA200-only), CORE_LITE (minimal trend-following) */
export type ScanMode = 'FULL' | 'BENCHMARK' | 'CORE_LITE';

/** Which pipeline stage a candidate reached before stopping */
export type CandidateStage =
  | 'UNIVERSE'       // loaded from DB but no data fetched yet
  | 'TECH_FILTER'    // stage 2 filters evaluated (may have failed)
  | 'CLASSIFIED'     // stage 3 status assigned (READY/WATCH/FAR)
  | 'RANKED'         // stage 4 rank score computed
  | 'RISK_GATED'     // stage 5 risk gates evaluated
  | 'ANTI_CHASE'     // stage 6 anti-chase guard evaluated
  | 'SIZED';         // stage 7 position sizing computed

/** Research-grade record: one per candidate per scan run */
export interface CandidateOutcomeRecord {
  // ── Identity ──
  scanId: string;
  ticker: string;
  name: string | null;
  sleeve: string;
  sector: string | null;
  cluster: string | null;

  // ── Pipeline result ──
  status: string;
  stageReached: CandidateStage;
  passedTechFilter: boolean;
  passedRiskGates: boolean;
  passedAntiChase: boolean;
  blockedByRegime: boolean;
  blockedReasons: string | null;

  // ── Regime ──
  regime: string;

  // ── Technicals at scan time ──
  price: number;
  ma200: number;
  adx: number;
  plusDI: number;
  minusDI: number;
  atrPct: number;
  atr: number;
  efficiency: number;
  volumeRatio: number;
  relativeStrength: number;
  hurstExponent: number | null;
  hurstWarn: boolean;
  atrSpiking: boolean;
  atrSpikeAction: string | null;

  // ── Scores ──
  bqs: number | null;
  fws: number | null;
  ncs: number | null;
  rankScore: number;
  dualScoreAction: string | null;  // Auto-Yes / Auto-No (fragile) / Conditional

  // ── Entry / Stop ──
  entryTrigger: number;
  stopPrice: number;
  distancePct: number;
  entryMode: string | null;

  // ── Suggested sizing ──
  suggestedShares: number | null;
  suggestedRiskGbp: number | null;
  suggestedRiskPct: number | null;
  suggestedCostGbp: number | null;

  // ── Anti-chase / earnings ──
  antiChaseReason: string | null;
  earningsAction: string | null;
  daysToEarnings: number | null;

  // ── Risk gate detail ──
  riskGatesFailed: string | null;

  // ── Data quality ──
  dataFreshness: string | null;
  dataSource: string | null;
  dataAgeMinutes: number | null;
  dataAsOf: Date | null;

  // ── Trade linkage ──
  tradePlaced: boolean;
  tradeLogId: string | null;
  actualFill: number | null;

  // ── Forward outcome enrichment (null until populated) ──
  priceAtScan: number | null;
  fwdReturn5d: number | null;
  fwdReturn10d: number | null;
  fwdReturn20d: number | null;
  mfeR: number | null;
  maeR: number | null;
  reached1R: boolean | null;
  reached2R: boolean | null;
  reached3R: boolean | null;
  stopHit: boolean | null;
  enrichedAt: Date | null;
}
