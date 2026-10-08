/**
 * DEPENDENCIES
 * Consumed by: src/components/portfolio/ReadyToBuyPanel.tsx
 * Consumes: src/lib/ready-to-buy.ts, src/lib/api-client.ts, src/lib/utils.ts,
 *           src/hooks/useWeeklyPhase.ts, src/lib/correlation-scalar.ts,
 *           /api/risk/correlation-scalar (fetch)
 * Risk-sensitive: YES (calls POST /api/positions/execute which places live T212 orders;
 *                 applies correlation scalar to reduce position size for correlated tickers)
 * Last modified: 2026-03-01
 * Notes: Two modes:
 *        1. T212 Execute: SSE-streamed 3-phase (buy → fill → stop) with full audit logging
 *        2. Manual fallback: Creates DB position only (no broker order)
 *        Modal is NOT dismissable during execution. Stop failures show a red alert
 *        that requires explicit acknowledgement.
 */

'use client';

import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import {apiRequest, formatApiError } from '@/lib/api-client';
import { formatPrice, formatCurrency, cn } from '@/lib/utils';
import { getBuyButtonState } from '@/lib/ready-to-buy';
import { getDayOfWeek } from '@/lib/utils';
import type { TriggerMetCandidate } from '@/lib/ready-to-buy';
import type { PositionSizingResult } from '@/types';
import type { ExecutionMode } from '@/types';
import type { CorrelationScalarResult } from '@/lib/correlation-scalar';
import { applyCorrelationScalar } from '@/lib/correlation-scalar';
import { useStore } from '@/store/useStore';
import WhyCardPopover, { WhyCardProvider } from '@/components/shared/WhyCardPopover';
import { RISK_GATE_EXPLANATIONS } from '@/lib/why-explanations';
import {
  MANUAL_CHECKLIST_ITEMS,
  AUTO_CHECKLIST_ITEMS,
  CATEGORY_LABELS,
  type ChecklistCategory,
} from '@/lib/pre-trade-checklist-items';
import {
  X,
  ShoppingCart,
  AlertTriangle,
  Shield,
  Info,
  CheckCircle2,
  Loader2,
  Zap,
  AlertOctagon,
  Link2,
  Lock,
  ArrowLeft,
  ArrowRight,
  CheckSquare,
} from 'lucide-react';

const DEFAULT_USER_ID = 'default-user';

// ── Types ────────────────────────────────────────────────────

interface RiskBudgetData {
  usedRiskPercent: number;
  availableRiskPercent: number;
  maxRiskPercent: number;
  usedPositions: number;
  maxPositions: number;
}

/** SSE phase update from /api/positions/execute */
interface ExecutionPhase {
  phase: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  message?: string;
  orderId?: number;
  filledQuantity?: number;
  filledPrice?: number;
}

interface BuyConfirmationModalProps {
  candidate: TriggerMetCandidate;
  riskBudget: RiskBudgetData | null;
  equity: number;
  investConnected: boolean;
  isaConnected: boolean;
  /** Position sizer from useRiskProfile().sizePosition */
  sizePosition: (entryPrice: number, stopPrice: number) => PositionSizingResult;
  /** Tickers of currently open positions — used for correlation scalar lookup */
  openPositionTickers: string[];
  isOpen: boolean;
  executionMode?: ExecutionMode;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

// ── Execution Phase Labels (novice-friendly) ─────────────────

const PHASE_LABELS: Record<string, string> = {
  BUY_PLACED: 'Placing buy order',
  BUY_POLLING: 'Waiting for fill',
  STOP_PLACED: 'Setting stop-loss',
  DB_POSITION: 'Saving position',
};

// ── Component ────────────────────────────────────────────────

export default function BuyConfirmationModal({
  candidate,
  riskBudget,
  equity,
  investConnected,
  isaConnected,
  sizePosition,
  openPositionTickers,
  isOpen,
  executionMode,
  onConfirm,
  onCancel,
}: BuyConfirmationModalProps) {
  const [accountType, setAccountType] = useState<'invest' | 'isa'>(
    investConnected ? 'invest' : isaConnected ? 'isa' : 'invest'
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const operationIdRef = useRef<{ storageKey: string; operationId: string } | null>(null);

  // ── Checklist Gate State ──
  // Phase 1 = checklist, Phase 2 = confirmation (existing trade details)
  const [modalPhase, setModalPhase] = useState<'checklist' | 'confirm'>('checklist');
  const [checkedItems, setCheckedItems] = useState<Set<string>>(new Set());

  // Read regime from global store
  const { marketRegime } = useStore();

  // Auto-verified checks — system determines these, user cannot toggle
  const autoChecks = useMemo(() => {
    const regimeOk = marketRegime !== 'BEARISH';
    const riskGatesPass = candidate.scanPassesRiskGates === true;
    const openRiskOk = riskBudget ? riskBudget.usedRiskPercent < riskBudget.maxRiskPercent : false;
    const positionCountOk = riskBudget ? riskBudget.usedPositions < riskBudget.maxPositions : false;

    return new Map<string, boolean>([
      ['regime-bullish', regimeOk],
      ['fear-greed-ok', true], // Display-only — not blocking; market data may be stale
      ['spy-above-ma200', marketRegime !== 'BEARISH'],
      ['risk-gates-pass', riskGatesPass],
      ['open-risk-ok', openRiskOk],
      ['position-count-ok', positionCountOk],
      ['sleeve-caps-ok', true], // Checked server-side — can't easily verify client-side, default pass
    ]);
  }, [marketRegime, candidate.scanPassesRiskGates, riskBudget]);

  // Blocking auto-checks: regime must not be BEARISH, risk gates must pass
  const autoBlockers = useMemo(() => {
    const blockers: string[] = [];
    if (marketRegime === 'BEARISH') blockers.push('Market regime is BEARISH — new entries blocked');
    if (candidate.scanPassesRiskGates === false) blockers.push('Risk gates failed for this candidate');
    if (riskBudget && riskBudget.usedPositions >= riskBudget.maxPositions) blockers.push('Maximum position count reached');
    if (riskBudget && riskBudget.usedRiskPercent >= riskBudget.maxRiskPercent) blockers.push('Open risk at limit');
    return blockers;
  }, [marketRegime, candidate.scanPassesRiskGates, riskBudget]);

  const isAutoBlocked = autoBlockers.length > 0;
  const allManualChecked = MANUAL_CHECKLIST_ITEMS.every((item) => checkedItems.has(item.id));
  const canProceedToConfirm = allManualChecked && !isAutoBlocked;
  const manualCheckedCount = MANUAL_CHECKLIST_ITEMS.filter((item) => checkedItems.has(item.id)).length;

  // Reset checklist when modal closes/opens
  useEffect(() => {
    if (!isOpen) {
      setModalPhase('checklist');
      setCheckedItems(new Set());
    }
  }, [isOpen]);

  // ── T212 Execution State ──
  const [executing, setExecuting] = useState(false);
  const [phases, setPhases] = useState<ExecutionPhase[]>([]);
  const [currentPhaseIdx, setCurrentPhaseIdx] = useState(-1);
  const [criticalWarning, setCriticalWarning] = useState<string | null>(null);
  const [criticalAcknowledged, setCriticalAcknowledged] = useState(false);
  const [executionResult, setExecutionResult] = useState<{
    orderId?: number;
    filledQuantity?: number;
    filledPrice?: number;
    stopFailed?: boolean;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  // Synchronous guard against double-click race condition — useRef updates
  // in the same tick as the click, before React re-renders.
  const isExecutingRef = useRef(false);

  const dayOfWeek = getDayOfWeek();
  const buttonState = getBuyButtonState(dayOfWeek);

  // ── Correlation scalar state ──
  const [corrScalar, setCorrScalar] = useState<CorrelationScalarResult>({
    scalar: 1.0, reason: null, correlatedTicker: null, maxCorrelation: null,
  });
  const [corrLoading, setCorrLoading] = useState(false);

  // Position sizing (before correlation adjustment)
  const sizing = useMemo<PositionSizingResult | null>(() => {
    try {
      if (!candidate.scanPrice || !candidate.scanStopPrice) return null;
      if (candidate.scanStopPrice >= candidate.scanPrice) return null;
      return sizePosition(candidate.scanPrice, candidate.scanStopPrice);
    } catch {
      return null;
    }
  }, [candidate.scanPrice, candidate.scanStopPrice, sizePosition]);

  // Adjusted shares after correlation scalar
  const adjustedShares = useMemo(() => {
    if (!sizing) return 0;
    return applyCorrelationScalar(sizing.shares, corrScalar.scalar);
  }, [sizing, corrScalar.scalar]);

  // Adjusted risk (proportional to share reduction)
  const adjustedRisk = useMemo(() => {
    if (!sizing || sizing.shares === 0) return 0;
    return sizing.riskDollars * (adjustedShares / sizing.shares);
  }, [sizing, adjustedShares]);

  // Fetch correlation scalar when modal opens with a candidate
  useEffect(() => {
    if (!isOpen || !candidate.ticker || openPositionTickers.length === 0) {
      setCorrScalar({ scalar: 1.0, reason: null, correlatedTicker: null, maxCorrelation: null });
      return;
    }
    let cancelled = false;
    setCorrLoading(true);
    fetch('/api/risk/correlation-scalar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker: candidate.ticker, openTickers: openPositionTickers }),
    })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!cancelled && data) setCorrScalar(data);
      })
      .catch(() => {
        // Fail-safe: no correlation data → no reduction
        if (!cancelled) setCorrScalar({ scalar: 1.0, reason: null, correlatedTicker: null, maxCorrelation: null });
      })
      .finally(() => { if (!cancelled) setCorrLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, candidate.ticker, openPositionTickers]);

  // UK ticker detection for ISA hint
  const isUKTicker = candidate.ticker.endsWith('.L');
  const showISAHint = isUKTicker && accountType === 'invest' && isaConnected;
  // Neither account connected
  const neitherConnected = !investConnected && !isaConnected;

  // Can we do T212 auto-execute? Need connected account + t212 ticker data
  // For now we always have t212Ticker from the cross-ref data if T212 is connected
  const canAutoExecute = (accountType === 'invest' ? investConnected : isaConnected);

  // Modal is not dismissable during execution
  const canDismiss = !executing || (executing && success && !criticalWarning) || (criticalWarning && criticalAcknowledged);

  // Clean up SSE on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // ── T212 Auto-Execute (SSE 3-phase) ──
  // useCallback must live above the early return to satisfy Rules of Hooks
  const handleAutoExecute = useCallback(async () => {
    if (!sizing || !candidate.scanPrice || !candidate.scanStopPrice) return;
    // Synchronous ref guard — closes the race window before React re-renders
    if (isExecutingRef.current) return;
    isExecutingRef.current = true;
    setExecuting(true);
    setError(null);
    setCriticalWarning(null);
    setCriticalAcknowledged(false);
    setExecutionResult(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const operationStorageKey = [
        'hybridturtle:execution',
        candidate.ticker,
        accountType,
        adjustedShares,
        candidate.scanStopPrice,
      ].join(':');
      if (operationIdRef.current?.storageKey !== operationStorageKey) {
        const persistedOperationId = sessionStorage.getItem(operationStorageKey);
        const operationId = persistedOperationId ?? crypto.randomUUID();
        sessionStorage.setItem(operationStorageKey, operationId);
        operationIdRef.current = { storageKey: operationStorageKey, operationId };
      }
      const response = await fetch('/api/positions/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: operationIdRef.current.operationId,
          userId: DEFAULT_USER_ID,
          stockId: candidate.ticker,                              // Yahoo ticker — resolved to stockId in execute route
          ticker: candidate.yahooTicker || candidate.ticker,      // Yahoo format for logging
          t212Ticker: candidate.ticker,                            // Will be resolved from DB by t212Ticker field
          quantity: adjustedShares, // correlation-adjusted (scalar applied to position-sizer output)
          stopPrice: candidate.scanStopPrice,
          entryPrice: candidate.scanPrice,
          currentPrice: candidate.scanPrice,
          entryTrigger: candidate.scanEntryTrigger,
          accountType,
          bqsScore: candidate.dualBQS,
          fwsScore: candidate.dualFWS,
          ncsScore: candidate.dualNCS,
          dualScoreAction: candidate.dualAction,
          scanStatus: candidate.scanStatus,
          rankScore: candidate.scanRankScore,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errData = await response.json();
        setError(errData.error || `Server error ${response.status}`);
        setExecuting(false);
        return;
      }

      // Read SSE stream
      const reader = response.body?.getReader();
      if (!reader) {
        setError('No response stream');
        setExecuting(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // keep incomplete line

        let eventType = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ') && eventType) {
            try {
              const data = JSON.parse(line.slice(6));

              if (eventType === 'phase') {
                setPhases(data.phases || []);
                setCurrentPhaseIdx(data.currentPhase ?? -1);
                if (data.critical && data.warning) {
                  setCriticalWarning(data.warning);
                }
              } else if (eventType === 'complete') {
                if (operationIdRef.current) {
                  sessionStorage.removeItem(operationIdRef.current.storageKey);
                  operationIdRef.current = null;
                }
                setPhases(data.phases || []);
                setExecutionResult({
                  orderId: data.position?.orderId,
                  filledQuantity: data.position?.filledQuantity,
                  filledPrice: data.position?.filledPrice,
                  stopFailed: data.stopFailed,
                });
                if (data.stopFailed) {
                  setCriticalWarning(
                    `CRITICAL: Stop-loss was NOT placed on T212. You must set a stop at ${candidate.scanStopPrice?.toFixed(4)} IMMEDIATELY in the T212 app.`
                  );
                }
                setSuccess(true);
              } else if (eventType === 'error') {
                if (data.retainOperationId && data.operationId && operationIdRef.current) {
                  sessionStorage.setItem(operationIdRef.current.storageKey, data.operationId);
                  operationIdRef.current = {
                    storageKey: operationIdRef.current.storageKey,
                    operationId: data.operationId,
                  };
                } else if (!data.critical && operationIdRef.current) {
                  sessionStorage.removeItem(operationIdRef.current.storageKey);
                  operationIdRef.current = null;
                }
                if (data.critical) {
                  setCriticalWarning(data.error);
                } else {
                  setError(data.error);
                }
                // Update phases if available
                if (data.phases) setPhases(data.phases);
              }
            } catch {
              // Ignore JSON parse errors in stream
            }
            eventType = '';
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError((err as Error).message || 'Execution failed');
      }
    } finally {
      setExecuting(false);
      isExecutingRef.current = false;
      abortRef.current = null;
    }
  }, [sizing, candidate, accountType, adjustedShares]);

  if (!isOpen) return null;

  // ── Manual Buy (existing legacy path — DB position only) ──

  const handleManualConfirm = async () => {
    if (!sizing || !candidate.scanPrice || !candidate.scanStopPrice) return;
    setSubmitting(true);
    setError(null);

    try {
      await apiRequest('/api/positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: DEFAULT_USER_ID,
          stockId: candidate.ticker, // resolved server-side
          entryPrice: candidate.scanPrice,
          stopLoss: candidate.scanStopPrice,
          shares: adjustedShares, // correlation-adjusted (scalar applied to position-sizer output)
          accountType,
          source: 'manual',
          sleeve: candidate.sleeve || 'CORE',
          bqsScore: candidate.dualBQS,
          fwsScore: candidate.dualFWS,
          ncsScore: candidate.dualNCS,
          dualScoreAction: candidate.dualAction,
          scanStatus: candidate.scanStatus,
          rankScore: candidate.scanRankScore,
        }),
      });

      setSuccess(true);
      setTimeout(async () => {
        await onConfirm();
      }, 800);
    } catch (err) {
      const message = formatApiError(err, 'Failed to create position');
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Close handler (respects dismissal rules) ──

  const handleClose = () => {
    if (!canDismiss) return;
    if (success) {
      onConfirm();
    } else {
      onCancel();
    }
  };

  // ── Phase Step UI ──

  const PhaseStep = ({ phase, index }: { phase: ExecutionPhase; index: number }) => {
    const label = PHASE_LABELS[phase.phase] || phase.phase;
    const stepNum = index + 1;

    return (
      <div className={cn(
        'flex items-center gap-3 p-3 rounded-lg transition-all',
        phase.status === 'running' && 'bg-primary-400/10 border border-primary-400/30',
        phase.status === 'success' && 'bg-profit/10 border border-profit/30',
        phase.status === 'failed' && 'bg-loss/10 border border-loss/30',
        phase.status === 'skipped' && 'bg-navy-800/30 border border-border/20 opacity-60',
        phase.status === 'pending' && 'bg-navy-800/30 border border-border/20',
      )}>
        {/* Step indicator */}
        <div className={cn(
          'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0',
          phase.status === 'running' && 'bg-primary-400/20 text-primary-400',
          phase.status === 'success' && 'bg-profit/20 text-profit',
          phase.status === 'failed' && 'bg-loss/20 text-loss',
          phase.status === 'skipped' && 'bg-navy-700/50 text-muted-foreground',
          phase.status === 'pending' && 'bg-navy-700/50 text-muted-foreground',
        )}>
          {phase.status === 'running' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : phase.status === 'success' ? (
            <CheckCircle2 className="w-4 h-4" />
          ) : phase.status === 'failed' ? (
            <AlertTriangle className="w-4 h-4" />
          ) : (
            stepNum
          )}
        </div>

        {/* Label and message */}
        <div className="min-w-0 flex-1">
          <div className={cn(
            'text-sm font-medium',
            phase.status === 'running' && 'text-primary-400',
            phase.status === 'success' && 'text-profit',
            phase.status === 'failed' && 'text-loss',
            (phase.status === 'pending' || phase.status === 'skipped') && 'text-muted-foreground',
          )}>
            Step {stepNum} of {phases.length}: {label}
            {phase.status === 'running' && '...'}
          </div>
          {phase.message && phase.status !== 'pending' && (
            <div className="text-xs text-muted-foreground mt-0.5 truncate">
              {phase.message}
            </div>
          )}
        </div>

        {/* Status icon */}
        <div className="flex-shrink-0">
          {phase.status === 'running' && <span className="text-xs text-primary-400">⏳</span>}
          {phase.status === 'success' && <span className="text-xs text-profit">✓</span>}
          {phase.status === 'failed' && <span className="text-xs text-loss">✗</span>}
          {phase.status === 'skipped' && <span className="text-xs text-muted-foreground">—</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop — not clickable during execution */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={canDismiss ? handleClose : undefined}
      />

      {/* Modal */}
      <div className="relative bg-navy-900 border border-border rounded-xl shadow-2xl w-full max-w-lg mx-4 animate-fade-in max-h-[90vh] overflow-y-auto">
        {/* Header — changes based on modal phase */}
        <div className="flex items-center justify-between p-5 border-b border-border sticky top-0 bg-navy-900 z-10">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            {executing ? (
              <Zap className="w-5 h-5 text-primary-400" />
            ) : modalPhase === 'checklist' ? (
              <CheckSquare className="w-5 h-5 text-primary-400" />
            ) : (
              <ShoppingCart className="w-5 h-5 text-primary-400" />
            )}
            {executing
              ? 'Executing Trade'
              : modalPhase === 'checklist'
              ? 'Pre-Trade Checklist'
              : 'Confirm Buy'}{' '}
            — {candidate.ticker}
          </h2>
          <div className="flex items-center gap-2">
            {/* Checklist completed badge on Phase 2 */}
            {modalPhase === 'confirm' && !executing && (
              <span className="text-[10px] px-2 py-0.5 rounded bg-profit/15 text-profit font-medium flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Checklist done
              </span>
            )}
            {canDismiss && (
              <button
                onClick={handleClose}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>

        <div className="p-5 space-y-4">
          {/* ══════════════════════════════════════════════════
              PHASE 1: PRE-TRADE CHECKLIST GATE
             ══════════════════════════════════════════════════ */}
          {modalPhase === 'checklist' ? (
            <WhyCardProvider>
            <div className="space-y-4">
              {/* Auto-verified items (system checks) */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Shield className="w-3 h-3 text-muted-foreground" />
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    System Verified
                  </span>
                </div>
                <div className="space-y-1.5">
                  {AUTO_CHECKLIST_ITEMS.map((item) => {
                    const pass = autoChecks.get(item.id) ?? true;
                    return (
                      <div
                        key={item.id}
                        className={cn(
                          'flex items-center gap-2 p-2 rounded',
                          pass ? 'bg-navy-800/50' : 'bg-loss/10 border border-loss/20'
                        )}
                      >
                        {pass ? (
                          <Lock className="w-3.5 h-3.5 text-profit flex-shrink-0" />
                        ) : (
                          <AlertOctagon className="w-3.5 h-3.5 text-loss flex-shrink-0" />
                        )}
                        <span className={cn('text-xs flex-1', pass ? 'text-muted-foreground' : 'text-loss')}>
                          {item.label}
                        </span>
                        <span className={cn('text-[10px] font-mono', pass ? 'text-profit' : 'text-loss')}>
                          {pass ? '✓ Verified' : '✗ Failed'}
                        </span>
                        {!pass && (
                          <WhyCardPopover
                            data={{
                              title: item.label,
                              description: item.description ?? 'This system check failed.',
                              tip: RISK_GATE_EXPLANATIONS[item.label]?.tip,
                              sections: candidate.scanPassesRiskGates === false && item.category === 'RISK'
                                ? (candidate as unknown as { riskGateResults?: { passed: boolean; gate: string; message: string }[] })
                                    .riskGateResults?.filter(g => !g.passed).map(g => ({
                                      label: g.gate,
                                      value: g.message,
                                      status: 'fail' as const,
                                    }))
                                : undefined,
                            }}
                            triggerClassName="ml-0.5"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Blocking auto-check failure — prevents continuation entirely */}
              {isAutoBlocked && (
                <div className="p-3 bg-loss/10 border-2 border-loss/40 rounded-lg">
                  <div className="flex items-center gap-2 text-loss text-sm font-semibold mb-1.5">
                    <AlertOctagon className="w-4 h-4" />
                    Trade Blocked
                  </div>
                  <ul className="space-y-1">
                    {autoBlockers.map((msg) => (
                      <li key={msg} className="text-xs text-loss/80">• {msg}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Manual checklist items — user must check each one */}
              {!isAutoBlocked && (
                <>
                  {(['SETUP', 'EXECUTION'] as ChecklistCategory[]).map((cat) => {
                    const items = MANUAL_CHECKLIST_ITEMS.filter((i) => i.category === cat);
                    if (items.length === 0) return null;
                    return (
                      <div key={cat}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                            {CATEGORY_LABELS[cat]}
                          </span>
                        </div>
                        <div className="space-y-1.5">
                          {items.map((item) => {
                            const isChecked = checkedItems.has(item.id);
                            return (
                              <label
                                key={item.id}
                                className={cn(
                                  'flex items-center gap-2.5 p-2 rounded cursor-pointer transition-colors',
                                  isChecked
                                    ? 'bg-navy-800/50'
                                    : 'bg-navy-800/30 hover:bg-navy-800/50'
                                )}
                              >
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => {
                                    setCheckedItems((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(item.id)) next.delete(item.id);
                                      else next.add(item.id);
                                      return next;
                                    });
                                  }}
                                  className="rounded border-border bg-navy-700 text-primary-400 w-3.5 h-3.5 flex-shrink-0"
                                />
                                <div className="flex-1 min-w-0">
                                  <span className={cn('text-xs', isChecked ? 'text-foreground' : 'text-muted-foreground')}>
                                    {item.label}
                                  </span>
                                  {item.description && (
                                    <p className="text-[10px] text-muted-foreground/60 mt-0.5">{item.description}</p>
                                  )}
                                </div>
                                {isChecked && <CheckCircle2 className="w-3.5 h-3.5 text-profit flex-shrink-0" />}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}

                  {/* Progress + Continue */}
                  <div className="pt-3 border-t border-border space-y-3">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{manualCheckedCount} of {MANUAL_CHECKLIST_ITEMS.length} checks completed</span>
                      <div className="w-24 h-1.5 bg-navy-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-profit transition-all duration-300 rounded-full"
                          style={{ width: `${(manualCheckedCount / MANUAL_CHECKLIST_ITEMS.length) * 100}%` }}
                        />
                      </div>
                    </div>

                    <button
                      onClick={() => setModalPhase('confirm')}
                      disabled={!canProceedToConfirm}
                      className="w-full px-4 py-2.5 text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2 bg-primary/15 text-primary-400 border border-primary/30 hover:bg-primary/25 hover:border-primary/50 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Continue to Trade
                      <ArrowRight className="w-4 h-4" />
                    </button>

                    {/* De-emphasised bypass for experienced users */}
                    {!canProceedToConfirm && !isAutoBlocked && (
                      <button
                        onClick={() => {
                          // Check all manual items at once
                          setCheckedItems(new Set(MANUAL_CHECKLIST_ITEMS.map((i) => i.id)));
                        }}
                        className="w-full text-center text-[10px] text-muted-foreground/50 hover:text-muted-foreground/80 transition-colors py-1"
                      >
                        I&apos;ve already completed this today — skip
                      </button>
                    )}
                  </div>
                </>
              )}

              {/* Cancel button when auto-blocked */}
              {isAutoBlocked && (
                <div className="pt-3 border-t border-border">
                  <button
                    onClick={onCancel}
                    className="w-full px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Close
                  </button>
                </div>
              )}
            </div>
            </WhyCardProvider>
          ) : (executing || executionResult) && phases.length > 0 ? (
          /* ══════════════════════════════════════════════════
              EXECUTION VIEW — 3-step progress
             ══════════════════════════════════════════════════ */
            <div className="space-y-3">
              {phases.map((phase, i) => (
                <PhaseStep key={phase.phase} phase={phase} index={i} />
              ))}

              {/* Critical warning — cannot be dismissed without acknowledgement */}
              {criticalWarning && (
                <div className="p-4 bg-loss/15 border-2 border-loss rounded-lg space-y-3">
                  <div className="flex items-start gap-2 text-loss">
                    <AlertOctagon className="w-5 h-5 flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="font-bold text-sm">CRITICAL — Manual Action Required</div>
                      <p className="text-xs mt-1">{criticalWarning}</p>
                    </div>
                  </div>
                  {!criticalAcknowledged && (
                    <button
                      onClick={() => setCriticalAcknowledged(true)}
                      className="w-full py-2 bg-loss/20 hover:bg-loss/30 text-loss text-sm font-semibold rounded-lg border border-loss/40 transition-colors"
                    >
                      I understand — I will set the stop manually
                    </button>
                  )}
                </div>
              )}

              {/* Success summary */}
              {success && executionResult && !criticalWarning && (
                <div className="p-4 bg-profit/10 border border-profit/30 rounded-lg">
                  <div className="flex items-center gap-2 text-profit text-sm font-semibold">
                    <CheckCircle2 className="w-4 h-4" />
                    Trade Executed Successfully
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-2 text-xs">
                    <div>
                      <span className="text-muted-foreground">Filled:</span>{' '}
                      <span className="text-foreground font-mono">
                        {executionResult.filledQuantity} shares
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Price:</span>{' '}
                      <span className="text-foreground font-mono">
                        {executionResult.filledPrice?.toFixed(4)}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Order ID:</span>{' '}
                      <span className="text-foreground font-mono">{executionResult.orderId}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Error during execution */}
              {error && !criticalWarning && (
                <div className="p-3 bg-loss/10 border border-loss/30 rounded-lg text-sm text-loss flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <div>{error}</div>
                </div>
              )}

              {/* Close button after execution completes */}
              {!executing && canDismiss && (
                <div className="pt-2 border-t border-border">
                  <button
                    onClick={handleClose}
                    className={cn(
                      'w-full py-2.5 text-sm font-medium rounded-lg transition-colors',
                      success && !criticalWarning
                        ? 'bg-profit/15 text-profit hover:bg-profit/20'
                        : 'bg-navy-800 text-foreground hover:bg-navy-700'
                    )}
                  >
                    {success ? 'Done — Close' : 'Close'}
                  </button>
                </div>
              )}
            </div>
          ) : (
            /* ══════════════════════════════════════════════════
               CONFIRMATION VIEW — Pre-trade details
              ══════════════════════════════════════════════════ */
            <>
              {/* Back to checklist — only when not submitting/executing */}
              {!submitting && !success && (
                <button
                  onClick={() => setModalPhase('checklist')}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors -mt-1 mb-1"
                >
                  <ArrowLeft className="w-3 h-3" />
                  Back to Checklist
                </button>
              )}

              {/* Error display */}
              {error && (
                <div className="p-3 bg-loss/10 border border-loss/30 rounded-lg text-sm text-loss flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <div>{error}</div>
                </div>
              )}

              {/* Success display (manual mode) */}
              {success && !executionResult && (
                <div className="p-3 bg-profit/10 border border-profit/30 rounded-lg text-sm text-profit flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4" />
                  Position created successfully
                </div>
              )}

              {/* Candidate details */}
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div>
                  <span className="text-muted-foreground text-xs">Ticker</span>
                  <div className="font-mono font-semibold text-foreground">{candidate.ticker}</div>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Name</span>
                  <div className="text-foreground truncate">{candidate.name}</div>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Entry Price</span>
                  <div className="font-mono text-foreground">
                    {formatPrice(candidate.scanPrice ?? 0, candidate.priceCurrency)}
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Stop Level</span>
                  <div className="font-mono text-loss">
                    {formatPrice(candidate.scanStopPrice ?? 0, candidate.priceCurrency)}
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Risk/Share</span>
                  <div className="font-mono text-foreground">
                    {candidate.scanPrice && candidate.scanStopPrice
                      ? formatPrice(candidate.scanPrice - candidate.scanStopPrice, candidate.priceCurrency)
                      : '—'}
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Sleeve</span>
                  <div className="text-foreground">{candidate.sleeve || 'CORE'}</div>
                </div>
              </div>

              {/* Scores */}
              <div className="flex gap-4 text-xs font-mono py-2 px-3 bg-navy-800/50 rounded-lg">
                <span>
                  BQS <span className="text-foreground">{candidate.dualBQS?.toFixed(0) ?? '—'}</span>
                </span>
                <span>
                  FWS{' '}
                  <span className={cn(
                    candidate.dualFWS != null && candidate.dualFWS <= 30 ? 'text-profit' :
                    candidate.dualFWS != null && candidate.dualFWS <= 50 ? 'text-amber-400' :
                    candidate.dualFWS != null ? 'text-loss' : 'text-muted-foreground'
                  )}>
                    {candidate.dualFWS?.toFixed(0) ?? '—'}
                  </span>
                </span>
                <span>
                  NCS{' '}
                  <span className={cn(
                    candidate.dualNCS != null && candidate.dualNCS >= 70 ? 'text-profit' :
                    candidate.dualNCS != null && candidate.dualNCS >= 50 ? 'text-amber-400' :
                    candidate.dualNCS != null ? 'text-loss' : 'text-muted-foreground'
                  )}>
                    {candidate.dualNCS?.toFixed(0) ?? '—'}
                  </span>
                </span>
              </div>

              {/* Correlation reduction warning — shown above sizing when scalar < 1.0 */}
              {corrScalar.scalar < 1.0 && sizing && !corrLoading && (
                <div className="p-4 bg-amber-500/10 border-2 border-amber-500/40 rounded-lg space-y-2">
                  <div className="flex items-start gap-2 text-amber-400">
                    <Link2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="text-sm font-semibold">Position reduced — correlation risk</div>
                      <p className="text-xs mt-1 text-amber-300/80">
                        {candidate.ticker} is {corrScalar.maxCorrelation != null ? Math.round(corrScalar.maxCorrelation * 100) : '?'}% correlated with {corrScalar.correlatedTicker} (currently open)
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs font-mono ml-6">
                    <div>
                      <span className="text-muted-foreground">Full size:</span>{' '}
                      <span className="text-foreground">{sizing.shares} shares</span>
                      <span className="text-muted-foreground"> (risk {formatCurrency(sizing.riskDollars)})</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Adjusted:</span>{' '}
                      <span className="text-amber-400 font-semibold">{adjustedShares} shares</span>
                      <span className="text-muted-foreground"> (risk {formatCurrency(adjustedRisk)})</span>
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground ml-6">
                    The system has {corrScalar.scalar === 0.75 ? 'reduced this position by 25%' : corrScalar.scalar === 0.50 ? 'halved this position' : 'reduced this position by 75%'} to protect against hidden leverage.
                  </p>
                </div>
              )}

              {/* Position sizing summary */}
              {sizing ? (
                <div className="bg-navy-800/70 border border-border rounded-lg p-4 space-y-2">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <Shield className="w-3 h-3" />
                    Position Sizing
                  </h3>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground text-xs">Shares</span>
                      <span className="font-mono text-foreground">
                        {corrScalar.scalar < 1.0 ? (
                          <>
                            <span className="line-through text-muted-foreground mr-1">{sizing.shares}</span>
                            <span className="text-amber-400">{adjustedShares}</span>
                          </>
                        ) : (
                          <>{sizing.shares} shares</>
                        )}
                      </span>
                    </div>
                    {/* Approximate GBP position value — totalCost is already in GBP (shares × price × fxToGbp) */}
                    <div className="flex justify-between col-span-2">
                      <span />
                      <span className="text-xs text-muted-foreground font-mono">
                        ≈ £{corrScalar.scalar < 1.0
                          ? Math.round(adjustedShares * (sizing.totalCost / sizing.shares))
                          : Math.round(sizing.totalCost)
                        } position
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground text-xs">Total cost</span>
                      <span className="font-mono text-foreground">
                        {formatCurrency(corrScalar.scalar < 1.0
                          ? adjustedShares * (sizing.totalCost / sizing.shares)
                          : sizing.totalCost
                        )}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground text-xs">Risk (£)</span>
                      <span className="font-mono text-loss">
                        {formatCurrency(corrScalar.scalar < 1.0 ? adjustedRisk : sizing.riskDollars)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground text-xs">Risk (%)</span>
                      <span className="font-mono text-foreground">
                        {corrScalar.scalar < 1.0
                          ? ((adjustedRisk / equity) * 100).toFixed(2)
                          : sizing.riskPercent.toFixed(2)
                        }%
                      </span>
                    </div>
                  </div>

                  {/* Educational info — explains why the system chose this share count */}
                  <div className="flex items-start gap-2 mt-3 pt-3 border-t border-border/30 text-xs text-muted-foreground">
                    <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-primary-400" />
                    <span>
                      {corrScalar.scalar < 1.0
                        ? `Base size risks ${formatCurrency(sizing.riskDollars)} (${sizing.riskPercent.toFixed(1)}%). Reduced to ${formatCurrency(adjustedRisk)} due to correlation with ${corrScalar.correlatedTicker}.`
                        : `The number of shares is calculated to risk exactly ${formatCurrency(sizing.riskDollars)} (${sizing.riskPercent.toFixed(1)}% of your account) if the stop-loss triggers.`
                      }
                    </span>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-amber-400 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" />
                  Could not calculate position size — check entry/stop values
                </div>
              )}

              {/* Risk budget context */}
              {riskBudget && (
                <div className="text-xs text-muted-foreground flex flex-wrap gap-3">
                  <span>
                    Slots: {riskBudget.usedPositions}/{riskBudget.maxPositions}
                  </span>
                  <span>
                    Risk: {riskBudget.usedRiskPercent.toFixed(1)}% of {riskBudget.maxRiskPercent}% used
                  </span>
                  <span>
                    Equity: {formatCurrency(equity)}
                  </span>
                </div>
              )}

              {/* Account selection */}
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  T212 Account
                </h3>

                {neitherConnected ? (
                  <div className="p-3 bg-loss/10 border border-loss/30 rounded-lg text-sm text-loss flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4" />
                    No Trading 212 account connected — go to Settings to connect.
                  </div>
                ) : (
                  <div className="flex gap-3">
                    {/* Invest radio */}
                    <label
                      className={cn(
                        'flex-1 flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all',
                        accountType === 'invest'
                          ? 'border-primary-400 bg-primary-400/10'
                          : 'border-border bg-navy-800/30',
                        !investConnected && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      <input
                        type="radio"
                        name="accountType"
                        value="invest"
                        checked={accountType === 'invest'}
                        onChange={() => setAccountType('invest')}
                        disabled={!investConnected}
                        className="sr-only"
                      />
                      <div
                        className={cn(
                          'w-3 h-3 rounded-full border-2',
                          accountType === 'invest'
                            ? 'border-primary-400 bg-primary-400'
                            : 'border-muted-foreground'
                        )}
                      />
                      <div>
                        <div className="text-sm font-medium text-foreground flex items-center gap-2">
                          Invest
                          <span
                            className={cn(
                              'w-2 h-2 rounded-full',
                              investConnected ? 'bg-profit' : 'bg-loss'
                            )}
                          />
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {investConnected ? 'Connected' : 'Not connected'}
                        </div>
                      </div>
                    </label>

                    {/* ISA radio */}
                    <label
                      className={cn(
                        'flex-1 flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all',
                        accountType === 'isa'
                          ? 'border-primary-400 bg-primary-400/10'
                          : 'border-border bg-navy-800/30',
                        !isaConnected && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      <input
                        type="radio"
                        name="accountType"
                        value="isa"
                        checked={accountType === 'isa'}
                        onChange={() => setAccountType('isa')}
                        disabled={!isaConnected}
                        className="sr-only"
                      />
                      <div
                        className={cn(
                          'w-3 h-3 rounded-full border-2',
                          accountType === 'isa'
                            ? 'border-primary-400 bg-primary-400'
                            : 'border-muted-foreground'
                        )}
                      />
                      <div>
                        <div className="text-sm font-medium text-foreground flex items-center gap-2">
                          ISA
                          <span
                            className={cn(
                              'w-2 h-2 rounded-full',
                              isaConnected ? 'bg-profit' : 'bg-loss'
                            )}
                          />
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {isaConnected ? 'Connected' : 'Not connected'}
                        </div>
                      </div>
                    </label>
                  </div>
                )}

                {/* ISA allowance note */}
                {accountType === 'isa' && isaConnected && (
                  <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <Info className="w-3 h-3" />
                    Counts towards ISA allowance
                  </p>
                )}

                {/* UK ticker in Invest mismatch warning */}
                {showISAHint && (
                  <div className="p-2 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-400 flex items-center gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                    UK stocks are typically held in ISA for tax efficiency
                  </div>
                )}
              </div>

              {/* Mid-week advisory */}
              {buttonState.color === 'amber' && (
                <div className="p-2 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-400 flex items-center gap-2">
                  <Info className="w-3.5 h-3.5 flex-shrink-0" />
                  {buttonState.tooltip}
                </div>
              )}

              {/* Actions — two buttons: Auto Execute + Manual Record */}
              <div className="flex flex-col gap-3 pt-2 border-t border-border">
                {/* Primary: Auto Execute on T212 */}
                {canAutoExecute && (
                  <button
                    onClick={handleAutoExecute}
                    disabled={submitting || executing || isExecutingRef.current || success || !sizing || neitherConnected}
                    className="w-full px-4 py-3 text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white"
                  >
                    <Zap className="w-4 h-4" />
                    Execute on T212 — {corrScalar.scalar < 1.0 ? adjustedShares : (sizing?.shares ?? '?')} shares in {accountType.toUpperCase()}
                  </button>
                )}

                {/* Secondary: Manual record only */}
                <div className="flex justify-between gap-3">
                  <button
                    type="button"
                    onClick={onCancel}
                    disabled={submitting}
                    className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleManualConfirm}
                    disabled={submitting || success || !sizing || neitherConnected}
                    className={cn(
                      'px-4 py-2 text-sm font-medium rounded-lg transition-all flex items-center gap-2',
                      success
                        ? 'bg-profit/15 text-profit border border-profit/30'
                        : 'bg-navy-800 hover:bg-navy-700 text-foreground border border-border'
                    )}
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Saving...
                      </>
                    ) : success ? (
                      <>
                        <CheckCircle2 className="w-4 h-4" />
                        Created
                      </>
                    ) : (
                      <>
                        <ShoppingCart className="w-4 h-4" />
                        Record Only (manual buy)
                      </>
                    )}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
