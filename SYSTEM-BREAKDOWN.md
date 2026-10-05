# HybridTurtle — System Breakdown

> Complete technical reference for the HybridTurtle systematic trading dashboard.  
> Every number in this document is counted from actual code — not estimated.

---

## 1. What It Is

A systematic trading dashboard for momentum trend-following across ~268 tickers (US, UK, European markets). Built to turn discretionary stock trading into a repeatable, risk-first workflow.

- **Stack:** Next.js 14 App Router + React 18 + TypeScript + TailwindCSS + Prisma ORM + SQLite
- **Data:** Yahoo Finance (free, no API key — intentional)
- **Notifications:** Telegram Bot API
- **Broker:** Trading 212 (dual-account: Invest + ISA)
- **Account:** Small account (SMALL_ACCOUNT risk profile)
- **Testing:** Vitest + Zod validation
- **Auth:** NextAuth JWT (optional — single-user local app)
- **Pages:** 28 content pages + 5 redirects
- **API Routes:** 46 route groups (~109 endpoints)
- **DB Tables:** 40 (24 core + 16 prediction engine)
- **Prediction Engine:** 17 phases + Phase 6 prediction model (conformal, failure modes, signal weighting, stress test, MI audit, immune system, lead-lag, GNN, Bayesian, Kelly, Meta-RL, VPIN, sentiment, TDA, execution quality, TradePulse, causal invariance, Phase 6 Ridge regression)

---

## 2. Screens (24 Pages)

### `/dashboard` — Command Centre
Health status, market indices bar, Fear & Greed gauge, weekly phase indicator, heartbeat monitor, module status panels, action directives, dual regime widget, risk modules, pyramid alerts, hedge card, scoring guide.
**Components:** `Navbar`, `MarketIndicesBar`, `QuickActions`, `FearGreedGauge`, `WeeklyPhaseIndicator`, `HealthTrafficLight`, `HeartbeatMonitor`, `DataSourceTile`, `ModuleStatusPanel`, `ActionCardWidget`, `DualRegimeWidget`, `RiskModulesWidget`, `PyramidAlertsWidget`, `HedgeCard`, `ScoringGuideWidget`, `MigrationBanner`, `TodayDirectiveCard`, `EveningReviewSummary`, `TonightWorkflowCard`, `SafetyAlertsPanel`, `OnboardingBanner`, `RegimeBadge`

### `/scan` — 7-Stage Scanner
Technical filter grid, stage funnel visualisation, candidate table with real-time price overlays, position sizer, chart view. Lazy-loaded tabs for scores and cross-ref analysis.
**Components:** `Navbar`, `StageFunnel`, `TechnicalFilterGrid`, `CandidateTable`, `PositionSizer`, `TickerChart`, `ScoresTab`, `CrossRefTab`, `StatusBadge`, `RegimeBadge`

### `/plan` — Weekly Execution Board
Phase timeline, ready candidates, pre-trade checklist, position sizing widget, swap suggestions, laggard alerts, early bird scan, today's directive panel (TodayPanel — novice-first actionable card).
**Components:** `Navbar`, `RegimeBadge`, `PhaseTimeline`, `ReadyCandidates`, `PreTradeChecklist`, `PositionSizerWidget`, `SwapSuggestionsWidget`, `LaggardAlertsWidget`, `EarlyBirdWidget`, `TodayPanel`

### `/portfolio/positions` — Position Management
KPI banner, positions table with inline RL trade advisor badges, T212 sync panel, stop update queue, journal drawer, ready-to-buy panel, breakout failure panel. Lazy tabs for distribution and performance.
**Components:** `Navbar`, `KPIBanner`, `PositionsTable`, `T212SyncPanel`, `PositionSyncButton`, `StopUpdateQueue`, `JournalDrawer`, `ReadyToBuyPanel`, `BreakoutFailurePanel`, `DistributionTab`, `PerformanceTab`

### `/risk` — Risk Dashboard
Risk profile selector, stop-loss panel, trailing stop recommendations, protection progress meter, risk budget visualisation, correlation analysis panel.
**Components:** `Navbar`, `RiskProfileSelector`, `StopLossPanel`, `TrailingStopPanel`, `ProtectionProgress`, `RiskBudgetMeter`, `CorrelationPanel`

### `/settings` — Configuration
Account settings, broker API credentials, notifications, data sources, system preferences, prediction engine toggles (intraday NCS, Kelly multiplier, RL shadow mode).
**Components:** `Navbar`, `AccountPanel`, `BrokerPanel`, `NotificationsPanel`, `DataPanel`, `SystemPanel`, `PredictionPanel`

### `/trade-log` — Trade Journal
Filterable trade history, summary statistics (win rate, expectancy, regime breakdown), monthly trends. Record past trades with decision reasons and lessons learned.
**Components:** `Navbar`, `RecordPastTradeModal`

### `/journal` — Position Journal
Per-position timeline for entry notes, confidence levels, close notes, and post-trade lessons learned.
**Components:** `Navbar`

### `/backtest` — Signal Replay
Historical trigger hits with forward R-multiples, stop ladder simulation, performance analysis. Read-only audit of past signals.
**Components:** `Navbar`, `RegimeBadge`

### `/notifications` — Notification Centre
System notifications with filtering by read status, notification type badges, mark-read actions.
**Components:** `Navbar`

### `/signal-audit` — Signal Pruning Audit *(added)*
7×7 MI heatmap, conditional MI bars with KEEP/INVESTIGATE/REDUNDANT recommendations, CSV export, manual "Run Analysis" button.
**Components:** `Navbar`, `ConditionalMIBar`, `MIHeatmap`

### `/causal-audit` — Causal Invariance Audit *(added)*
IRM analysis showing which signals are causally stable vs regime-dependent. Invariance scores per signal, beta-per-environment charts.
**Components:** `Navbar`, `InvarianceBar`, `BetaChart`

### `/execution-quality` — Execution Quality *(added)*
Summary cards (avg slippage, P90 slippage, total cost), slippage by hour bar chart, slippage trend line chart, timing recommendations by market cap tier, worst 10 fills table.
**Components:** `Navbar`, `SummaryCard`, `SlippageByHourChart`, `SlippageTrendChart`

### `/execution-audit` — Execution Audit
Entry slippage, stop placement accuracy, position sizing accuracy, risk drift, anti-chase compliance.
**Components:** `Navbar`

### `/filter-scorecard` — Filter Scorecard
Forward outcomes (5d/10d/20d returns, 1R/2R hit rates) of candidates passed vs blocked by each pipeline rule.
**Components:** `Navbar`

### `/score-validation` — Score Validation
NCS/FWS/BQS band prediction validation, auto-action classification effectiveness, monotonicity checks.
**Components:** `Navbar`, `BandTable`

### `/trade-pulse` — TradePulse Landing *(added)*
Recent READY/WATCH candidates ranked by NCS with grade pills, linking to individual analysis pages.
**Components:** `Navbar`, `TradePulseGradePill`

### `/trade-pulse/[ticker]` — TradePulse Dashboard *(added)*
Full unified confidence dashboard: hero score dial, decision bar, signal contribution grid (12+ signals), concerns (risks first), opportunities, Kelly sizing advisory, RL recommendation badge, stale data indicator.
**Components:** `Navbar`, `TradePulseDial`, `SignalCard`, `KellySizePanel`, `TradeAdvisorPanel`

### `/breakout-evidence` — Breakout Evidence *(added)*
Breakout vs non-breakout performance comparison, shadow stats for breakout + low entropy and breakout + high isolation, detail table with novel signal values (entropy, isolation, smart money, fractal dimension, complexity).
**Components:** `Navbar`, `StatsCard`

### `/prediction-status` — Prediction Engine Status *(added)*
Phase 6 Ridge regression model dashboard: model status, training metrics (R², MAE, RMSE), feature importance bars, READY candidates ranked by predicted R-multiple, manual training trigger. Advisory only.
**Components:** `Navbar`

### `/login` — Sign In
Email/password authentication via NextAuth.

### `/register` — Registration
Account creation with password validation.

### Redirect Pages
| Route | Redirects To |
|-------|-------------|
| `/` | `/dashboard` |
| `/scan/scores` | `/scan?tab=scores` |
| `/scan/cross-ref` | `/scan?tab=cross-ref` |
| `/portfolio/distribution` | `/portfolio/positions?tab=distribution` |
| `/performance` | `/portfolio/positions?tab=performance` |

---

## 3. API Routes (46 Route Groups)

### Core Routes

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/scan` | GET, POST | 7-stage scan pipeline (filters, ranking, risk gates, anti-chase, sizing) |
| `/api/scan/snapshots` | GET | Parse snapshot data for READY/WATCH/FAR candidates |
| `/api/scan/snapshots/sync` | POST | Sync full universe snapshot (triggers Yahoo fetch) |
| `/api/scan/scores` | GET | Fetch scored ticker data (BQS, FWS, NCS) |
| `/api/scan/progress` | GET | Poll scan progress (stage, processed/total) |
| `/api/scan/live-prices` | POST | Live Yahoo quotes for READY/WATCH candidates |
| `/api/scan/cross-ref` | GET | Cross-reference candidates vs DB positions |
| `/api/scan/benchmark` | GET | Benchmark FULL vs CORE_LITE mode |
| `/api/positions` | GET, POST | Fetch/create positions (dual-account ISA/Invest) |
| `/api/positions/execute` | POST | 4-phase T212 execution (buy → poll → stop → DB) via SSE |
| `/api/positions/sync` | POST | Sync closed positions from T212 |
| `/api/positions/hedge` | GET | HEDGE positions with live prices and stop guidance |
| `/api/positions/sync-account-types` | POST | Sync ISA vs Invest metadata from T212 |
| `/api/positions/reset-from-t212` | POST | Reset entry price/stop from T212 ground truth |
| `/api/stops` | GET, PUT | R-based + trailing ATR stop recommendations; apply updates |
| `/api/stops/apply` | POST | One-click apply: DB write + T212 order |
| `/api/stops/sync` | GET, POST, PUT | CSV import; trailing recommendations; apply |
| `/api/stops/t212` | GET, POST, DELETE, PUT | T212 stop orders: list, set, remove, bulk sync |
| `/api/risk` | GET | Open risk per position, total vs limit, utilisation % |
| `/api/risk/correlation-scalar` | POST | Correlation-based position size reduction |
| `/api/risk/correlation` | GET | Correlation matrix flags between positions |
| `/api/plan` | GET | Weekly execution plan and current phase |
| `/api/plan/allocation` | GET | Rank READY/WATCH for capital allocation |
| `/api/plan/allocation-score` | GET | Score candidates with EV expectations |
| `/api/portfolio/summary` | GET | Distributions by sector/cluster/sleeve; total P&L |
| `/api/market-data` | GET | Multi-action: quotes, indices, fear-greed, regime, prices |
| `/api/modules` | GET | Unified module results: laggards, climax, swaps, breadth |
| `/api/modules/early-bird` | GET | Alternative/early entry scanner |
| `/api/nightly` | POST | 9-step nightly automation pipeline |
| `/api/health-check` | GET, POST | 16-point system health audit |
| `/api/heartbeat` | GET, POST | Fetch/record nightly completion status |
| `/api/trade-log` | GET | Query trade log with filters |
| `/api/trade-log/summary` | GET | Stats: top/worst trades, tags, regime breakdowns |
| `/api/journal` | GET | List trade journal entries |
| `/api/journal/[positionId]/entry` | POST | Add/update entry note |
| `/api/journal/[positionId]/close` | POST | Add/update close note |
| `/api/dashboard/today-directive` | GET | Lightweight directive: phase, mode, stops, laggards |
| `/api/notifications` | GET, POST | Fetch notifications; create client-side alerts |
| `/api/notifications/[id]/read` | POST | Mark notification as read |
| `/api/notifications/read-all` | POST | Mark all as read |
| `/api/settings` | GET, PUT | Fetch/update user settings |
| `/api/settings/dismiss-equity-milestone` | POST | Dismiss equity milestone notifications |
| `/api/settings/telegram-test` | POST | Test Telegram integration |
| `/api/stocks` | GET, POST, PATCH | List/filter/create/update stock records |
| `/api/trading212/sync` | POST | Sync positions from T212 Invest + ISA |
| `/api/trading212/connect` | POST | Test T212 connection; save credentials |
| `/api/t212-import` | POST | Import T212 historical trades |
| `/api/telegram/webhook` | POST | Receive inbound Telegram messages |
| `/api/telegram/test-command` | POST | Test command without webhook |
| `/api/telegram/register-webhook` | GET, POST | Register/retrieve Telegram webhook URL |
| `/api/auth/[...nextauth]` | GET, POST | NextAuth authentication handler |
| `/api/auth/register` | POST | User registration |
| `/api/performance/summary` | GET | Equity curve, PnL, win rate |
| `/api/publications` | GET | Recent events timeline |
| `/api/onboarding` | GET, POST | Onboarding step completion |
| `/api/backup` | GET, POST | List/create database backups |
| `/api/backup/restore` | POST | Restore named backup |
| `/api/cache-status` | GET, POST | Cache status; clear persisted caches |
| `/api/data-source` | GET | Data source health and freshness |
| `/api/db-status` | GET, POST | Pending migrations; auto-migrate |
| `/api/ev-modifiers` | GET | Expectancy modifiers by regime/sleeve/ATR |
| `/api/ev-stats` | GET | Expectancy stats sliced by dimensions |
| `/api/feature-flags` | GET | Active feature flags |
| `/api/backtest` | GET | Signal replay backtest |
| `/api/backtest/compare` | GET | FULL vs CORE_LITE comparison |

### Analytics Routes

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/analytics/score-validation` | GET, POST | Score prediction validation; backfill |
| `/api/analytics/score-contribution` | GET | Score component correlation vs outcomes |
| `/api/analytics/rule-overlap` | GET | Filter co-occurrence / redundancy |
| `/api/analytics/filter-scorecard` | GET | Filter effectiveness audit |
| `/api/analytics/filter-attribution` | GET | Filter contribution to winners vs losers |
| `/api/analytics/execution-drag` | GET | Slippage vs planned entries |
| `/api/analytics/execution-audit` | GET | Execution quality: timing, fills, conditions |
| `/api/analytics/candidate-outcomes` | GET | Scan candidates matched to trade outcomes |
| `/api/analytics/breakout-evidence` | GET | Breakout vs non-breakout performance + novel signal stats |

### Prediction Engine Routes *(added)*

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/prediction/interval` | GET | NCS prediction interval (conformal bands) |
| `/api/prediction/calibrate` | GET, POST | Conformal calibration status; trigger recalibration |
| `/api/prediction/failure-modes` | GET, POST | 5 failure mode scores; compute FM results |
| `/api/prediction/signal-weights` | GET, POST | Dynamic signal weights; meta-model retraining |
| `/api/prediction/stress-test` | POST | Adversarial Monte Carlo stop-hit simulation |
| `/api/prediction/signal-audit` | GET, POST | Mutual information analysis |
| `/api/prediction/danger-level` | GET, POST | Market danger assessment; seed threat library |
| `/api/prediction/lead-lag` | GET, POST | Lead-lag upstream signals; recompute graph |
| `/api/prediction/gnn-score` | GET, POST | GraphSAGE score; trigger GNN training |
| `/api/prediction/beliefs` | GET, POST | Bayesian belief states; process closures |
| `/api/prediction/kelly-size` | GET | Kelly-adjusted sizing suggestion (advisory) |
| `/api/prediction/trade-recommendation` | GET, POST | Meta-RL policy action; MAML training |
| `/api/prediction/trade-pulse` | GET | Unified confidence dashboard aggregation |
| `/api/prediction/invariance` | GET, POST | IRM causal invariance scores |
| `/api/prediction/phase6` | GET, POST | Phase 6 Ridge model: status + ranked candidates; trigger training |

### Signal Routes *(added)*

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/signals/vpin` | GET | VPIN / DOFI order flow signal (24h cache) |
| `/api/signals/sentiment` | GET | Sentiment Composite Score (6h cache) |
| `/api/signals/runs/[id]` | GET | Signal run detail by ID with candidates |

### Workflow / Admin Routes *(added)*

| Route | Methods | Purpose |
|-------|---------|--------|
| `/api/workflow/tonight` | GET, POST | Tonight’s workflow card data; run 7-step evening workflow |
| `/api/risk/evaluate-plan` | POST | Standalone risk evaluation for candidate batches |
| `/api/plans/[id]` | PATCH | Update planned trade status/fields with transition validation |
| `/api/broker/orders` | GET | Broker order listing with pagination and filters |
| `/api/audit-events` | GET | Generic audit event log with pagination and filters |

---

## 4. Core Lib Modules (The Brain)

### 🔴 Sacred Files (changes affect real money)

| File | Purpose |
|------|---------|
| `stop-manager.ts` | Monotonic stop protection ladder. Stops NEVER decrease. |
| `position-sizer.ts` | Share calculation using `floorShares()`. FX conversion before sizing. |
| `risk-gates.ts` | 6 hard risk gates. All must pass. No bypass, no override. |
| `regime-detector.ts` | Market regime detection. 3 consecutive days for BULLISH confirmation. |
| `dual-score.ts` | BQS/FWS/NCS scoring system. Weights are intentional. |
| `scan-engine.ts` | 7-stage pipeline. Stages cannot be added/removed/reordered casually. |

### Important Support Modules

| File | Purpose |
|------|---------|
| `market-data.ts` | Yahoo Finance wrapper. 30-min cache. Adjusted closes. |
| `fetch-retry.ts` | Retry with exponential backoff (3 attempts: 1s→2s→4s). |
| `data-provider.ts` | Abstraction layer over Yahoo/EODHD data sources. |
| `scan-guards.ts` | Pre/post-scan validation guards. |
| `scan-cache.ts` | In-memory scan result caching. |
| `scan-progress.ts` | Real-time scan progress tracking (SSE). |
| `scan-pass-flags.ts` | Pass/fail flag computation per filter stage. |
| `scan-db-reconstruction.ts` | Reconstruct scan results from DB snapshots. |
| `correlation-matrix.ts` | Pairwise correlation computation. |
| `correlation-scalar.ts` | Position size reduction for correlated assets. |
| `slippage-tracker.ts` | Track execution slippage for timing analysis. |
| `equity-snapshot.ts` | Rate-limited equity snapshots (once per 6 hours). |
| `snapshot-sync.ts` | Full universe snapshot sync with Yahoo Finance. |
| `trading212.ts` | Trading 212 API wrapper. |
| `trading212-dual.ts` | Dual-account (Invest + ISA) T212 operations. |
| `position-sync.ts` | Auto-detect T212 position closures. |
| `telegram.ts` | Telegram Bot API wrapper. |
| `telegram-commands.ts` | Inbound Telegram command handlers. |
| `alert-service.ts` | 3-layer alert delivery: DB → Telegram → Email (placeholder). |
| `health-check.ts` | 16-point system health audit. |
| `laggard-detector.ts` | Detect underperforming positions for review. |
| `breakout-failure-detector.ts` | Detect failed breakouts within 5 days. |
| `breakout-integrity.ts` | Breakout Integrity Score (BIS) — candle quality. |
| `breakout-probability.ts` | Breakout probability estimation. |
| `hurst.ts` | Hurst exponent calculation for trend persistence. |
| `capital-ranker.ts` | Rank candidates for capital allocation. |
| `allocation-score.ts` | EV-weighted allocation scoring. |
| `ready-to-buy.ts` | Pre-trade readiness checks and buy button state. |
| `execution-mode.ts` | Determine execution mode from phase + regime. |
| `execution-audit.ts` | Measure plan-vs-execution gaps. |
| `execution-drag.ts` | Quantify slippage drag on returns. |
| `ev-modifier.ts` | Expected value modifiers per regime/sleeve/ATR. |
| `ev-tracker.ts` | Track completed trade outcomes for EV analysis. |
| `candidate-outcome.ts` | Candidate outcome dataset builder. |
| `candidate-outcome-enrichment.ts` | Forward price return enrichment. |
| `filter-attribution.ts` | Per-filter pass/fail recording for analytics. |
| `filter-scorecard.ts` | Filter effectiveness scoring. |
| `score-tracker.ts` | BQS/FWS/NCS breakdown recording. |
| `score-validation.ts` | Score band prediction validation. |
| `score-backfill.ts` | Backfill score breakdowns from snapshots. |
| `signal-translations.ts` | Human-friendly signal descriptions for UI. |
| `why-explanations.ts` | "Why" card text for risk gate results. |
| `glossary.ts` | Trading term glossary definitions. |
| `pre-trade-checklist-items.ts` | Pre-trade checklist item definitions. |
| `onboarding-steps.ts` | Onboarding flow step definitions. |
| `rule-overlap.ts` | Detection of overlapping/redundant rules. |
| `benchmark-scan.ts` | Benchmark CORE_LITE vs FULL scan mode. |
| `opportunistic-filter.ts` | Mid-week opportunistic trade filtering. |
| `nightly-guard.ts` | Guards against concurrent nightly runs. |
| `earnings-calendar.ts` | Earnings date lookup and caching. |
| `sector-etf-cache.ts` | Sector ETF mapping cache. |
| `t212-history-importer.ts` | Import historical T212 trades. |
| `db-backup.ts` | SQLite database backup utility. |
| `market-data-eodhd.ts` | EODHD alternative data source wrapper. |
| `api-client.ts` | Client-side API request helper with error handling. |
| `api-response.ts` | Standardised API response builder. |
| `request-validation.ts` | Request validation utilities. |
| `prisma.ts` | Prisma client singleton. |
| `auth.ts` | NextAuth configuration. |
| `secrets.ts` | Secret management. |
| `env.ts` | Environment variable loading. |
| `default-user.ts` | Default user bootstrap. |
| `utils.ts` | General utilities (formatting, FX, dates). |
| `feature-flags.ts` | Feature flag management. |
| `cache-keys.ts` | Cache key constants. |
| `cache-init.ts` | In-memory cache initialisation. |
| `cache-persistence.ts` | Cache persistence to disk. |
| `cache-warmup.ts` | Cache pre-warming on startup. |
| `module-buckets.ts` | Module result grouping. |
| `modules-cache.ts` | Module result caching (10-min TTL). |
| `risk-fields.ts` | Risk field computations. |

---

## 5. Trading Modules

| # | Module | File | Purpose |
|---|--------|------|---------|
| 2 | Early Bird | `early-bird.ts` | Alternative entry logic, on-demand scan from Plan page |
| 3 | Laggard Purge | `laggard-purge.ts` | Flags underperformers (TRIM_LAGGARD / DEAD_MONEY) |
| 5/14 | Climax Detector | `climax-detector.ts` | Detects blow-off tops and climax patterns |
| 7 | Heatmap Swap | `heatmap-swap.ts` | Suggests swapping weak positions for stronger candidates |
| 8 | Heat Check | `heat-check.ts` | Cluster position concentration logic |
| 9 | Fast-Follower | `fast-follower.ts` | Re-entry logic for missed breakouts |
| 10 | Breadth Safety | `breadth-safety.ts` | Caps max positions at 4 based on market breadth |
| 11 | Whipsaw Guard | `whipsaw-guard.ts` | Blocks re-entry after stop-out (cooldown period) |
| 11b | Adaptive ATR Buffer | `adaptive-atr-buffer.ts` | Entry buffer scaling based on ATR conditions |
| 12 | Super-Cluster | `super-cluster.ts` | 50% aggregate cluster cap enforcement |
| 13 | Momentum Expansion | `momentum-expansion.ts` | Expands risk limit in strong momentum environments |
| 15 | Trade Logger | `trade-logger.ts` | Logging only — no risk impact |
| 16 | Turnover Monitor | `turnover-monitor.ts` | Monitoring only — tracks portfolio turnover |
| 17 | Weekly Action Card | `weekly-action-card.ts` | Reporting only — weekly summary card |
| 18 | Data Validator | `data-validator.ts` | Indirect risk — data quality gate |
| 20 | Re-Entry Logic | `re-entry-logic.ts` | Re-entry conditions after previous exit |

> Module numbers are intentionally non-sequential. Gaps (1, 4, 6, 19, 21) are reserved or not yet built.

---

## 6. Nightly Automation (9-Step Pipeline)

Runs via `nightly-task.bat` / Windows Task Scheduler. Runs unattended.

| # | Step | Key Functions | Details |
|---|------|---------------|---------|
| 0 | Pre-cache | `preCacheHistoricalData()` | Pre-fetch daily bars for all active tickers |
| 0b | DB Backup | `backupDatabase()` | SQLite backup to `/prisma/backups/` |
| 1 | Health Check | `runHealthCheck()` | 16-point audit → RED/YELLOW/GREEN |
| 2 | Live Prices + Sync | `fetchWithFallback()` | **2b**: T212 position auto-closure detection |
| 3 | Stop Management | `generateStopRecommendations()` | **3a**: R-based stops. **3b**: Trailing ATR. **3c**: Gap risk (HIGH_RISK). **3d**: Stop-hit alerts. **3e**: Breakout failure detection |
| 4 | Laggard Detection | `detectLaggards()` | TRIM_LAGGARD / DEAD_MONEY flags |
| 5 | Risk Modules | Climax, Swap, Whipsaw, Breadth, Correlation | Module-level risk signals |
| 6 | Equity Snapshot | `recordEquitySnapshot()` | Rate-limited (6h). **6b**: Equity milestones (£1K/£2K/£5K) |
| 7 | Snapshot Sync | `syncSnapshot()` | **7a**: Full universe + score breakdowns. **7b**: Conformal recalibration. **7c** (Sun): Meta-model training + earnings cache. **7d** (Sun): Lead-lag graph. **7e** (Sun): GNN training |
| 8 | Telegram Alert | `sendNightlySummary()` | Consolidated report with all alerts |
| 9 | Heartbeat | `prisma.heartbeat.create()` | SUCCESS / PARTIAL / FAILED |

**Step-level tracking:** Each step is timed via `startStep()`/`finalizeSteps()`. Failed steps are recorded individually.

**Heartbeat status is ternary:**
- **SUCCESS** — all steps completed without error
- **PARTIAL** — some steps failed but pipeline completed
- **FAILED** — critical failure

**If any step fails: log the error, continue remaining steps. Never let one step abort the whole run.**

### Midday Sync (`midday-sync.ts`)
Runs every 2–3 hours during market hours. Single step: detect T212 position auto-closures (stop-outs, manual closes). Skips weekends. Non-blocking.

### Watchdog (`watchdog.ts`)
Runs daily at 10:00 AM UK time. Checks if nightly heartbeat is >26 hours stale. Sends Telegram alert if nightly missed.

---

## 7. Database Schema (40 Tables)

### Core Tables (24)

| Table | Purpose |
|-------|---------|
| `User` | User account, equity, risk profile, broker keys, prediction settings |
| `Stock` | Ticker universe (~268 stocks) with sleeve/sector/cluster/region |
| `Position` | Open/closed positions with entry, stop, shares, protection level |
| `StopHistory` | Audit trail of every stop-loss change |
| `Scan` | Scan run metadata (date, regime) |
| `ScanResult` | Per-ticker scan results (filters, ranking, sizing) |
| `ExecutionPlan` | Weekly execution plans |
| `HealthCheck` | 16-point health audit results |
| `Heartbeat` | Nightly pipeline completion status |
| `TradeLog` | Trade journal with execution quality metrics |
| `TradeTag` | Tag taxonomy for trade classification |
| `EquitySnapshot` | Point-in-time equity readings (rate-limited) |
| `RegimeHistory` | Historical regime readings with dual-benchmark data |
| `Snapshot` | Universe snapshot metadata |
| `SnapshotTicker` | Per-ticker snapshot data (60+ technical/fundamental fields) |
| `EvRecord` | Expected value records per regime/sleeve/ATR |
| `CorrelationFlag` | Pairwise correlation flags between tickers |
| `ExecutionLog` | T212 execution request/response audit trail |
| `Notification` | In-app notification centre records |
| `EarningsCache` | Cached earnings dates per ticker |
| `TradeJournal` | Entry/close notes per position |
| `FilterAttribution` | Per-filter pass/fail for every scan candidate |
| `ScoreBreakdown` | Full BQS/FWS/NCS component decomposition |
| `CandidateOutcome` | Full pipeline journey + forward price returns |

### Prediction Engine Tables (16) *(added)*

| Table | Purpose |
|-------|---------|
| `ConformalCalibration` | Calibrated quantile thresholds for NCS intervals |
| `FailureModeScore` | Per-ticker failure mode score breakdowns (FM1–FM5) |
| `SignalWeightRecord` | Dynamic signal weight snapshots per regime |
| `StressTestResult` | Cached adversarial Monte Carlo results (4h TTL) |
| `SignalAuditResult` | MI matrix + per-signal recommendations (JSON) |
| `ThreatLibraryEntry` | Dangerous market environment fingerprints |
| `LeadLagEdge` | Statistically significant lead-lag relationships |
| `LeadLagSignal` | Weekly lead-lag computation audit records |
| `GNNModelWeights` | Trained GraphSAGE weight snapshots (~200 params) |
| `GNNInferenceLog` | Per-ticker GNN score audit trail |
| `SignalBeliefState` | Beta(α,β) distributions — 7 signals × 4 regimes = 28 rows |
| `TradeEpisode` | (observation, action, reward) sequences for MAML |
| `PolicyVersion` | Trained MAML policy weight snapshots |
| `VPINHistory` | VPIN/DOFI computations per ticker per day |
| `SentimentHistory` | Sentiment Composite Scores with source breakdown |
| `InvarianceAuditResult` | IRM analysis: per-signal invariance + β values |

---

## 8. Data Flow Summary

```
                    Yahoo Finance (free, no API key)
                              │
                              ▼
                    ┌──────────────────┐
                    │  market-data.ts  │ ← 30-min TTL cache
                    │  fetch-retry.ts  │ ← 3× retry, exponential backoff
                    └────────┬─────────┘
                             │
                ┌────────────┼────────────────┐
                ▼            ▼                ▼
         ┌────────────┐ ┌──────────┐  ┌──────────────┐
         │scan-engine │ │snapshot- │  │ regime-      │
         │  (7-stage) │ │ sync.ts  │  │ detector.ts  │
         └─────┬──────┘ └────┬─────┘  └──────┬───────┘
               │             │               │
               ▼             ▼               ▼
        ┌────────────┐ ┌──────────┐  ┌──────────────┐
        │dual-score  │ │ Snapshot │  │ RegimeHistory│
        │ BQS/FWS/NCS│ │ Ticker   │  │    (DB)      │
        └─────┬──────┘ │  (DB)    │  └──────────────┘
              │        └────┬─────┘
              ▼             │
       ┌─────────────┐     │     ┌───────────────────────┐
       │ risk-gates  │     ├────►│  Prediction Engine     │
       │ (6 gates)   │     │     │  ├─ conformal intervals│
       └──────┬──────┘     │     │  ├─ failure modes      │
              │            │     │  ├─ signal weights      │
              ▼            │     │  ├─ stress test         │
       ┌─────────────┐    │     │  ├─ danger/immune       │
       │ stop-manager│    │     │  ├─ lead-lag + GNN      │
       │ (monotonic) │    │     │  ├─ Bayesian beliefs    │
       └──────┬──────┘    │     │  ├─ Kelly sizing        │
              │           │     │  ├─ Meta-RL advisor     │
              ▼           │     │  ├─ VPIN/sentiment      │
       ┌─────────────┐   │     │  └─ TradePulse (F9)     │
       │position-sizer│  │     └───────────────────────┘
       │ floorShares()│  │
       └──────┬──────┘   │
              │          │
              ▼          ▼
       ┌────────────────────┐
       │   Trading 212 API  │ ← buy / stop / sync
       │   (Invest + ISA)   │
       └────────┬───────────┘
                │
                ▼
       ┌────────────────────┐
       │   Telegram Alerts  │ ← nightly + stop-hit + trade trigger
       └────────────────────┘
```

---

## 9. Weekly Workflow

| Day | Phase | Rules |
|-----|-------|-------|
| Sunday | PLANNING | Full scan, draft trade plan, prediction engine recalibration |
| Monday–Friday | EXECUTION | Pre-trade checklist, execute only when regime, health, risk, and anti-chase gates pass |
| Saturday | MAINTENANCE | Stop review, risk monitoring, laggard detection |

The weekday execution gates and weekend no-entry blocks are **behavioural guardrails**, not bugs.

---

## 10. Risk Profiles

| Profile | Risk/Trade | Max Positions | Max Open Risk |
|---------|-----------|--------------|--------------|
| CONSERVATIVE | 0.75% | 8 | 7.0% |
| BALANCED | 0.95% | 5 | 5.5% |
| **SMALL_ACCOUNT** | **2.00%** | **4** | **10.0%** |
| AGGRESSIVE | 3.00% | 3 | 12.0% |

**Active profile is SMALL_ACCOUNT.** Max 4 positions.

---

## 11. Stop Manager — Monotonic Ladder

| Level | Triggers At | Stop Moves To |
|-------|------------|--------------|
| INITIAL | Entry | Entry − InitialRisk |
| BREAKEVEN | ≥ 1.5R | Entry price |
| LOCK_08R | ≥ 2.5R | Entry + 0.5 × InitialRisk |
| LOCK_1R_TRAIL | ≥ 3.0R | max(Entry + 1R, Close − 1.5×ATR) |

**Stops ratchet up only. A function that could lower a stop is a bug, not a feature.**

---

## 12. The 6 Risk Gates (all must pass)

1. **Total Open Risk** — Current + new risk ≤ 10.0% (SMALL_ACCOUNT). HEDGE excluded.
2. **Max Positions** — Open count < 4 (SMALL_ACCOUNT). HEDGE excluded.
3. **Sleeve Limit** — CORE ≤ 80%, HIGH_RISK ≤ 40%, ETF ≤ 80%, HEDGE uncapped.
4. **Cluster Concentration** — ≤ 25% of portfolio (SMALL_ACCOUNT override; normally 20%).
5. **Sector Concentration** — ≤ 30% of portfolio (SMALL_ACCOUNT override; normally 25%).
6. **Position Size Cap** — CORE ≤ 20%, HIGH_RISK ≤ 12%, ETF ≤ 16%, HEDGE ≤ 20%.

HEDGE positions excluded from open risk and position counting.

---

## 13. Dual Score System

**BQS (Breakout Quality Score, 0–100)** — Higher is better:

| Component | Range | Key Thresholds |
|-----------|-------|----------------|
| Trend Strength | 0–25 | ADX ≥ 35 = max |
| Direction Dominance | 0–10 | +DI − −DI > 25 |
| Volatility Health | 0–15 | ATR% 1–4% optimal |
| Proximity to Breakout | 0–15 | < 3% to high |
| Dual Regime Score | −10 to +20 | BEARISH = −10, BULL+BULL = +20 |
| Relative Strength | 0–15 | RS% > 15 |
| Volume Bonus | 0–5 | vol_ratio > 1.2 |
| Weekly ADX Bonus | −5 to +10 | wADX ≥ 30 = +10 |
| BIS (Breakout Integrity) | 0–15 | Candle OHLCV quality |
| Hurst Bonus | 0–8 | H ≥ 0.7 = +8 |

**FWS (Fatal Weakness Score, 0–95 achievable)** — Higher is WORSE:

| Component | Max | Trigger |
|-----------|-----|---------|
| Volume Risk | 30 | vol_ratio < 0.6 |
| Extension Risk | 25 | Chasing near highs |
| Marginal Trend | 10 | ADX < 20 |
| Vol Shock | 10 | ATR spiking or collapsing |
| Regime Instability | 10 | SPY/VWRL disagreement |

**NCS (Net Composite Score):**
```
BaseNCS = clamp(BQS − 0.8 × FWS + 10, 0, 100)
NCS = clamp(BaseNCS − min(Penalties, 40), 0, 100)
```

**Auto-actions:**
- NCS ≥ 70 AND FWS ≤ 30 → **Auto-Yes**
- FWS > 65 → **Auto-No**
- Otherwise → **Conditional**

---

## 14. Prediction Engine (17 Phases)

### Phase 1: Conformal Prediction Intervals
Wraps NCS in statistically calibrated confidence bands using split-conformal prediction. Bootstrap calibration from historical score-vs-outcome data, transitioning to live trades as outcomes accumulate. Nightly recalibration when sample size grows by ≥20 or >30 days since last run. Narrow band (width < 8) = high conviction; wide band (> 15) = high uncertainty → forces Conditional.
**Files:** `conformal-calibrator.ts`, `conformal-store.ts`, `bootstrap-calibration.ts`

### Phase 2: Failure Mode Scoring (5 FMs)
Scores each candidate on 5 independent failure modes: FM1 Breakout Failure Risk, FM2 Liquidity Trap Risk, FM3 Correlation Cascade Risk, FM4 Regime Flip Risk, FM5 Event Gap Risk. Each scored 0–100 with PASS/WARN/BLOCK thresholds. Any BLOCK → Auto-Yes suppressed. Advisory layer — does not modify NCS directly.
**Files:** `failure-mode-scorer.ts`, `failure-mode-thresholds.ts`

### Phase 3: Dynamic Signal Weighting
Meta-model that adjusts BQS signal weights based on market regime + VIX context. 7 weights (ADX, DI, Hurst, BIS, DRS, wADX, BPS) shift from static defaults to learned values. Rule-based initially, transitions to trained model as signal belief data accumulates. Retrained Sunday nights.
**Files:** `signal-weight-meta-model.ts`, `meta-model-trainer.ts`

### Phase 4: Adversarial Stress Test
Monte Carlo simulation with adversarial bias: generates N price paths with regime-aware drift and vol, measures fraction that hit the stop-loss within horizon. PASS/FAIL gate at configurable threshold. Runs on-demand (not automatic) with 4-hour result caching.
**Files:** `adversarial-simulator.ts`

### Phase 5: Signal Pruning / MI Analysis
Pairwise mutual information between all BQS signal layers, plus conditional MI per signal against outcomes. Identifies KEEP / INVESTIGATE / REDUNDANT signals. Results stored as JSON in DB. Manual trigger with CSV export on the `/signal-audit` page.
**Files:** `mutual-information.ts`

### Phase 6: Immune System / Danger Memory
Threat library of dangerous market environment fingerprints (VIX, breadth, regime, momentum). Current environment encoded and cosine-matched against library. dangerScore > 75 → 24h cooldown alert. Pre-populated with historical crises; expanded with real losses.
**Files:** `threat-library.ts`, `danger-matcher.ts`, `environment-encoder.ts`

### Phase 7: Lead-Lag Cross-Asset Graph
Computes lagged cross-correlations between top tickers to find statistically significant lead-lag relationships (p-value filtered). Edges stored in DB. Used by downstream GNN and NCS adjustment layer. Recomputed weekly (Sunday).
**Files:** `lead-lag-analyser.ts`, `lead-lag-graph.ts`

### F1: GNN on Lead-Lag Graph
2-layer GraphSAGE operating on the lead-lag graph. Message passing aggregates upstream movement signals. Produces per-ticker GNN score (0–1) and NCS adjustment. UNVALIDATED when weights >7 days stale. Trained Sunday after lead-lag refresh.
**Files:** `gnn/graph-builder.ts`, `gnn/message-passing.ts`, `gnn/gnn-trainer.ts`, `gnn/gnn-inference.ts`

### F2: Online Bayesian NCS
Beta(α,β) distributions per (signal, regime) pair — 7 signals × 4 regimes = 28 belief states. Updated after each trade closes based on whether the signal's prediction was correct. Produces posterior belief-informed weight adjustments that feed back into signal weighting.
**Files:** `bayesian/belief-state.ts`, `bayesian/bayesian-updater.ts`, `bayesian/belief-informed-weights.ts`

### F3: Fractional Kelly Sizing
Kelly criterion calculator with fractional scaling. Estimates edge from NCS, applies uncertainty penalty from conformal width + GNN confidence + belief divergence. Output is advisory only (default OFF) — shows Kelly-suggested risk % vs profile fixed risk %. Controlled by settings toggle.
**Files:** `kelly/kelly-calculator.ts`, `kelly/portfolio-kelly.ts`, `kelly/uncertainty-penalty.ts`

### F4: Meta-RL Trade Management
MAML-based policy network for trade lifecycle recommendations: HOLD, TIGHTEN_STOP, TRAIL_STOP_ATR, PYRAMID_ADD, PARTIAL_EXIT, FULL_EXIT. Encodes trade state (R-multiple, days held, ATR distance, regime) as observation vector. Shadow mode (default ON) = advisory only. Trained on trade episodes stored in DB.
**Files:** `meta-rl/policy-network.ts`, `meta-rl/maml-trainer.ts`, `meta-rl/trade-state-encoder.ts`, `meta-rl/episode-memory.ts`

### F5: VPIN / Order Flow
Volume-synchronised Probability of Informed Trading. Bulk-classifies volume bars as buy/sell using tick rule approximation. Produces VPIN (0–1) and DOFI (−1 to +1). INFORMED_BUYING → green signal; INFORMED_SELLING → NCS −15 adjustment. 24h cache per ticker.
**Files:** `signals/vpin-calculator.ts`, `signals/order-flow-imbalance.ts`

### F6: Sentiment Fusion
Composite sentiment from multiple sources: news RSS keyword scoring (via lexicon), analyst revision proxy (52-week range position), short interest proxy (volume spike detection). Fused into SCS (0–100). Divergence detection: falling sentiment + rising price = false breakout risk. 6h cache.
**Files:** `signals/sentiment/news-sentiment.ts`, `signals/sentiment/analyst-revision.ts`, `signals/sentiment/sentiment-fusion.ts`, `signals/sentiment/sentiment-lexicon.ts`

### F7: TDA Regime Detector
Topological Data Analysis approximation using Takens embedding of SPY returns. Estimates topological complexity as proxy for regime stability. STABLE / TRANSITIONING / TURBULENT states. When diverging from primary regime detector → transition warning badge with early-warning banner. Fires TDA_DIVERGENCE alert. Prop-based component — no dedicated API route.
**Files:** Component: `TDARegimeBadge.tsx`

### F8: Execution Quality Loop
Analyses historical trade fills: planned entry vs actual fill, slippage by hour of day, slippage trend over time, timing recommendations by market cap tier. Feeds back into pre-trade screen with effective risk display.
**Files:** `execution-audit.ts`, `execution-drag.ts`, `slippage-tracker.ts`

### F9: TradePulse Dashboard
Unified synthesis layer aggregating all prediction phases into a single per-ticker confidence dashboard. Computes composite score (0–100), grade (A+ through D), and decision (AUTO_YES/CONDITIONAL/AUTO_NO). Signal grid shows each contributing layer's score and weight.
**Files:** `prediction/trade-pulse.ts`

### Bonus: Causal Invariance (IRM)
Invariant Risk Minimisation identifies which signals are causally stable across regime environments vs regime-dependent. Partitions data by environment, trains per-environment models, measures β-variance. High invariance = signal works everywhere; low = regime-dependent (less trustworthy).
**Files:** `prediction/causal/irm-trainer.ts`, `prediction/causal/invariance-scores.ts`, `prediction/causal/invariant-ncs.ts`, `prediction/causal/environment-partitioner.ts`

---

## 15. State Management

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Server/DB** | Prisma + SQLite | Source of truth for all persistent data |
| **Client State** | Zustand (`useStore`) | Ephemeral UI state: health, regime, phase, positions, modules |
| **Persistence** | localStorage | Only `riskProfile` + `equity` survive page reload |
| **Caching** | In-memory TTL | Scan/modules 5min, quotes 30min, modules 10min |
| **API** | REST + Zod | All external data validated with Zod schemas |
| **Auth** | NextAuth JWT | Enforced by default; `DISABLE_API_AUTH=true` is development-only |

### Zustand Store Sections
- **System:** healthStatus, marketRegime, weeklyPhase, heartbeat status
- **User:** riskProfile, equity, userId
- **Market Data:** marketIndices, fearGreed
- **Portfolio:** positions, totalValue, totalGain, cash
- **UI:** isLoading, error, healthOverlayDismissed
- **Cache:** modulesData (10-min TTL), nightlyRunning state

---

## 16. Shared Components

| Component | File | Purpose |
|-----------|------|---------|
| Navbar | `shared/Navbar.tsx` | Top navigation with dropdowns for Analysis/Performance/System groups, danger badge |
| RegimeBadge | `shared/RegimeBadge.tsx` | Colour-coded market regime pill |
| StatusBadge | `shared/StatusBadge.tsx` | Generic status pill (READY/WATCH/FAR/etc.) |
| TrafficLight | `shared/TrafficLight.tsx` | 3-state health indicator |
| LiveDataBootstrap | `shared/LiveDataBootstrap.tsx` | Init-time data fetch (regime, heartbeat, indices) |
| GlossaryTerm | `GlossaryTerm.tsx` | Hoverable glossary term with tooltip definition |
| WhyCardPopover | `shared/WhyCardPopover.tsx` | "Why?" explanation popover for risk gate results |
| JournalDrawer | `shared/JournalDrawer.tsx` | Slide-out panel for position journal notes |
| StopUpdateQueue | `shared/StopUpdateQueue.tsx` | Batch stop update queue manager |

### Prediction Engine Components *(added)*

| Component | File | Purpose |
|-----------|------|---------|
| NCSIntervalBadge | `NCSIntervalBadge.tsx` | NCS score + conformal interval + lead-lag adjustment |
| FailureModePanel | `FailureModePanel.tsx` | Collapsible FM1–FM5 results with PASS/WARN/BLOCK |
| SignalWeightPanel | `SignalWeightPanel.tsx` | Collapsible bar chart of dynamic signal weights |
| StressTestGauge | `StressTestGauge.tsx` | Semi-circular gauge with on-demand stress test button |
| DangerLevelIndicator | `DangerLevelIndicator.tsx` | 5-segment danger indicator with threat drawer |
| LeadLagPanel | `LeadLagPanel.tsx` | Upstream asset lead-lag signals per ticker |
| GraphScorePanel | `GraphScorePanel.tsx` | GNN score + top influencers display |
| LiveNCSTracker | `LiveNCSTracker.tsx` | Intraday NCS drift tracking (trading hours only) |
| VPINBadge | `VPINBadge.tsx` | Order flow direction badge (Informed Buying/Selling) |
| SentimentPanel | `SentimentPanel.tsx` | Sentiment breakdown by source (news/analyst/short) |
| TDARegimeBadge | `TDARegimeBadge.tsx` | TDA topology regime badge with transition warning |
| BeliefStatePanel | `BeliefStatePanel.tsx` | Bayesian belief state display |
| KellySizePanel | `KellySizePanel.tsx` | Kelly-suggested sizing vs profile fixed risk |
| TradeAdvisorPanel | `TradeAdvisorPanel.tsx` | RL trade recommendation with approve/override |
| TradePulseGrade | `TradePulseGrade.tsx` | Grade pill (A+ through D) + score dial |

---

## 17. Testing

**Framework:** Vitest. Co-located `.test.ts` files alongside source.

**45 test files covering:**

| Area | Test Files |
|------|-----------|
| Core Sacred | `stop-manager.test.ts`, `position-sizer.test.ts`, `risk-gates.test.ts`, `dual-score.test.ts`, `regime-detector.test.ts` |
| Scan Pipeline | `scan-guards.test.ts`, `scan-pass-flags.test.ts`, `scan-engine-core-lite.test.ts`, `scan-db-reconstruction.test.ts` |
| Risk & Sizing | `risk-fields.test.ts`, `correlation-scalar.test.ts`, `ready-to-buy.test.ts` |
| Indicators | `hurst.test.ts`, `breakout-integrity.test.ts`, `breakout-probability.test.ts`, `breakout-failure-detector.test.ts` |
| Analytics | `filter-attribution.test.ts`, `filter-scorecard.test.ts`, `score-tracker.test.ts`, `score-validation.test.ts`, `allocation-score.test.ts`, `execution-audit.test.ts`, `execution-drag.test.ts` |
| Data & Research | `candidate-outcome.test.ts`, `candidate-outcome-enrichment.test.ts`, `research-loop.test.ts`, `audit-harness.test.ts`, `ev-modifier.test.ts` |
| Infrastructure | `fetch-retry.test.ts`, `market-data.trigger-window.test.ts`, `trading212-dual.test.ts`, `laggard-detector.test.ts` |
| Modules | `adaptive-atr-buffer.test.ts` |
| Signals | `breakout-signals.test.ts`, `entropy-signal.test.ts`, `network-isolation.test.ts`, `novel-signals.test.ts` |
| Prediction (Phase 6) | `prediction/phase6/ridge-model.test.ts`, `prediction/phase6/feature-extract.test.ts` |
| API Routes | `api/risk/route.test.ts`, `api/positions/route.test.ts`, `api/positions/execute/route.test.ts` |
| Workflow | `packages/workflow/src/execution.test.ts` |

All external data responses validated with Zod schemas.

---

## 18. Deployment & Scripts

| Script | Purpose |
|--------|---------|
| `start.bat` | Launch dashboard (runs `prisma migrate deploy` then `npm run dev`) |
| `install.bat` | First-time setup (npm install, prisma generate, migrate, seed) |
| `update.bat` | Pull changes, install deps, migrate, restart |
| `nightly-task.bat` | Nightly automation entry point (Task Scheduler) |
| `nightly.bat` | Manual nightly trigger |
| `midday-sync-task.bat` | Midday position sync (Task Scheduler) |
| `watchdog-task.bat` | Heartbeat watchdog (Task Scheduler, 10 AM) |
| `register-nightly-task.bat` | Register nightly Task Scheduler job |
| `register-midday-sync.bat` | Register midday sync Task Scheduler job |
| `register-watchdog-task.bat` | Register watchdog Task Scheduler job |
| `research-refresh-task.bat` | Research data refresh (candidate outcomes) |
| `seed-tickers.bat` | Seed ticker universe from CSV |
| `restore-backup.bat` | Restore SQLite backup |
| `fix-account-types.bat` | Fix ISA/Invest account type metadata |
| `run-dashboard.bat` | Quick dashboard launcher |
| `package-for-distribution.bat` | Package project for distribution |

Self-hosted on Windows. Single-user. No cloud deployment.

---

## 19. File Structure Overview

```
prisma/
  schema.prisma              40 tables
  seed.ts                    Ticker universe seeding
  migrations/                Migration history
  backups/                   SQLite backups
  cache/                     Persistent cache files

src/
  middleware.ts              API auth (NextAuth JWT, opt-in)
  
  app/
    layout.tsx               Root layout + LiveDataBootstrap
    page.tsx                 Redirect → /dashboard
    error.tsx                Global error boundary
    globals.css              Tailwind + custom tokens
    
    dashboard/               Command centre
    scan/                    7-stage scanner + scores + cross-ref tabs
    plan/                    Weekly execution board + TodayPanel
    portfolio/
      positions/             Position management + distribution + performance tabs
      distribution/          Redirect → positions?tab=distribution
    risk/                    Risk dashboard
    settings/                Configuration + prediction toggles
    trade-log/               Trade journal
    journal/                 Position notes
    performance/             Redirect → positions?tab=performance
    backtest/                Signal replay
    notifications/           Notification centre
    login/                   Authentication
    register/                Registration
    signal-audit/            MI heatmap *(added)*
    causal-audit/            IRM invariance *(added)*
    execution-audit/         Execution quality audit
    execution-quality/       Slippage analysis *(added)*
    filter-scorecard/        Filter effectiveness
    score-validation/        Score prediction validation
    trade-pulse/             TradePulse landing *(added)*
      [ticker]/              Per-ticker analysis *(added)*
    
    api/
      scan/                  7-stage pipeline + snapshots + scores
      positions/             CRUD + T212 execution + sync
      stops/                 R-based + trailing + T212 orders
      risk/                  Budget + correlation
      plan/                  Execution plans + allocation
      portfolio/             Distribution summary
      market-data/           Yahoo Finance multi-action
      modules/               Trading modules + early bird
      nightly/               9-step automation
      health-check/          16-point audit
      heartbeat/             Pipeline status
      dashboard/             Today directive
      notifications/         CRUD + read tracking
      settings/              User config + Telegram test
      trade-log/             Query + summary
      journal/               Position notes CRUD
      trading212/            Sync + connect
      t212-import/           Historical import
      telegram/              Webhook + commands
      stocks/                Ticker CRUD
      auth/                  NextAuth + register
      backtest/              Signal replay + compare
      backup/                DB backup/restore
      analytics/             8 analytics endpoints
      prediction/            14 prediction endpoints *(added)*
      signals/               VPIN + sentiment *(added)*
      performance/           Equity curve summary
      publications/          Events timeline
      onboarding/            Setup wizard
      feature-flags/         Feature toggles
      cache-status/          Cache management
      data-source/           Data freshness
      db-status/             Migration check
      ev-modifiers/          EV adjustments
      ev-stats/              EV statistics
  
  lib/
    # Sacred (6)
    stop-manager.ts          Monotonic stop ladder
    position-sizer.ts        Share calculation
    risk-gates.ts            6 hard gates
    regime-detector.ts       Market regime
    dual-score.ts            BQS/FWS/NCS
    scan-engine.ts           7-stage pipeline
    
    # Support (~65 files)
    market-data.ts           Yahoo wrapper
    fetch-retry.ts           Retry logic
    # ... (see Section 4 for complete list)
    
    modules/                 16 trading modules + index
    
    prediction/              Prediction engine core
      conformal-calibrator.ts
      conformal-store.ts
      bootstrap-calibration.ts
      failure-mode-scorer.ts
      failure-mode-thresholds.ts
      signal-weight-meta-model.ts
      meta-model-trainer.ts
      adversarial-simulator.ts
      mutual-information.ts
      threat-library.ts
      danger-matcher.ts
      environment-encoder.ts
      lead-lag-analyser.ts
      lead-lag-graph.ts
      trade-pulse.ts
      bayesian/              3 files (beliefs, updater, weights)
      gnn/                   4 files (builder, passing, trainer, inference)
      kelly/                 3 files (calculator, portfolio, penalty)
      meta-rl/               4 files (policy, MAML, encoder, memory)
      causal/                4 files (IRM, invariance, partitioner, invariant-NCS)
    
    signals/
      vpin-calculator.ts     VPIN computation
      order-flow-imbalance.ts  DOFI signal
      sentiment/             4 files (news, analyst, fusion, lexicon)
  
  components/
    shared/                  9 shared components
    dashboard/               Dashboard-specific panels
    plan/                    TodayPanel + plan widgets
    portfolio/               PositionsTable, BuyConfirmationModal, etc.
    scan/                    Scanner components
    risk/                    Risk dashboard components
    settings/                Settings panels
    trade-log/               Trade log components
    # Prediction components (15 files at root level)
    NCSIntervalBadge.tsx     ... through TradePulseGrade.tsx

  cron/
    nightly.ts               9-step nightly pipeline
    midday-sync.ts           Position sync
    watchdog.ts              Heartbeat monitor

  hooks/                     Custom React hooks
  store/                     Zustand store
  types/                     TypeScript types + constants
  test/                      Test utilities
```

### Summary Counts

| Category | Count |
|----------|-------|
| Content Pages | 26 |
| Redirect Pages | 5 |
| API Route Groups | 44 |
| API Endpoints | ~105 |
| DB Tables | 40 (24 core + 16 prediction) |
| Sacred Files | 6 |
| Lib Modules | ~75 |
| Trading Modules | 16 |
| Prediction Engine Files | ~30 |
| Components | ~60 |
| Test Files | 36 |
| Scripts (.bat) | 16 |

---

*Last updated: 9 March 2026*
