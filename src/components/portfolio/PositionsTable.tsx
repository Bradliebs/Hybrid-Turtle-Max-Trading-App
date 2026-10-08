'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { formatCurrency, formatPrice, formatPercent, formatR, formatDate } from '@/lib/utils';
import StatusBadge from '@/components/shared/StatusBadge';
import { canPyramid, PYRAMID_CONFIG } from '@/lib/risk-gates';
import {apiRequest, formatApiError } from '@/lib/api-client';
import { Bell, BellOff, Lock, Plus, ArrowUpDown, ChevronDown, X, AlertTriangle, TrendingUp, LogOut, Send, Loader2, CheckCircle, XCircle, RefreshCw, Layers, BookOpen } from 'lucide-react';

interface Position {
  id: string;
  ticker: string;
  name: string;
  sleeve: string;
  status: string;
  source?: string;
  entryPrice: number;
  entryDate: string;
  shares: number;
  currentStop: number;
  initialRisk: number;
  protectionLevel: string;
  currentPrice: number;
  rMultiple: number;
  gainPercent: number;
  gainDollars: number;
  value: number;
  initialRiskGBP?: number;
  // @deprecated Use initialRiskGBP instead.
  riskGBP?: number;
  priceCurrency?: string;
  rating?: string;
  candidateStatus?: string;
  entryTrigger?: number;
  alerts?: number;
  pyramidAdds?: number;
  gapRisk?: { gapPercent: number; atrPercent: number; threshold: number } | null;
  priceFreshness?: { source: string; ageSeconds: number } | null;
  priceSource?: 'T212' | 'YAHOO' | null;
  t212Price?: { price: number; yahooPrice: number; ageMinutes: number; diffPercent: number; mismatch: boolean } | null;
}

interface PositionsTableProps {
  positions: Position[];
  onUpdateStop?: (positionId: string, newStop: number, reason: string) => Promise<boolean>;
  onExitPosition?: (positionId: string, exitPrice: number, exitReason?: string, closeNote?: string) => Promise<boolean>;
  onJournalClick?: (positionId: string) => void;
}

export default function PositionsTable({ positions, onUpdateStop, onExitPosition, onJournalClick }: PositionsTableProps) {
  const [tab, setTab] = useState<'all' | 'open' | 'closed'>('open');
  const [sortField, setSortField] = useState<string>('ticker');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Stop modal state
  const [stopModal, setStopModal] = useState<Position | null>(null);
  const [stopInput, setStopInput] = useState('');
  const [stopError, setStopError] = useState<string | null>(null);
  const [stopSubmitting, setStopSubmitting] = useState(false);
  const [pushToT212, setPushToT212] = useState(true);
  const [t212PushStatus, setT212PushStatus] = useState<'idle' | 'pushing' | 'success' | 'error'>('idle');
  const [t212PushMessage, setT212PushMessage] = useState<string | null>(null);
  const [t212CurrentStop, setT212CurrentStop] = useState<number | null>(null);
  const [t212Loading, setT212Loading] = useState(false);

  // One-click recommended stop apply state
  const [recApplying, setRecApplying] = useState(false);
  const [recApplyError, setRecApplyError] = useState<string | null>(null);

  // T212 bulk sync state
  const [bulkSyncing, setBulkSyncing] = useState(false);
  const [bulkSyncResult, setBulkSyncResult] = useState<{ placed: number; failed: number; skipped: number; priceTooFar: number; notOwned: number; total: number; failedDetails?: string[] } | null>(null);

  // Exit modal state
  const [exitModal, setExitModal] = useState<Position | null>(null);
  const [exitInput, setExitInput] = useState('');
  const [exitError, setExitError] = useState<string | null>(null);
  const [exitSubmitting, setExitSubmitting] = useState(false);
  const [exitConfirmStep, setExitConfirmStep] = useState(false); // Two-step exit confirmation
  const [exitReasonInput, setExitReasonInput] = useState('');
  const [exitNoteInput, setExitNoteInput] = useState('');

  // Reset from T212 state
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [resetResult, setResetResult] = useState<{ id: string; message: string; success: boolean } | null>(null);

  const filtered = positions.filter((p) => {
    if (tab === 'all') return true;
    if (tab === 'open') return p.status === 'OPEN';
    return p.status === 'CLOSED';
  });

  const sorted = [...filtered].sort((a, b) => {
    const aVal = a[sortField as keyof Position];
    const bVal = b[sortField as keyof Position];

    if (typeof aVal === 'string' || typeof bVal === 'string') {
      const aString = typeof aVal === 'string' ? aVal : '';
      const bString = typeof bVal === 'string' ? bVal : '';
      return sortDir === 'asc'
        ? aString.localeCompare(bString)
        : bString.localeCompare(aString);
    }

    const aNumber = typeof aVal === 'number' ? aVal : 0;
    const bNumber = typeof bVal === 'number' ? bVal : 0;
    return sortDir === 'asc' ? aNumber - bNumber : bNumber - aNumber;
  });

  const toggleSort = (field: string) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  return (
    <div className="card-surface">
      {/* Header */}
      <div className="p-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-3">
          {(['all', 'open', 'closed'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'px-3 py-1.5 text-sm font-medium rounded-lg transition-colors capitalize',
                tab === t
                  ? 'bg-primary/20 text-primary-400'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t} {t !== 'all' && `(${positions.filter((p) => t === 'open' ? p.status === 'OPEN' : p.status === 'CLOSED').length})`}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {filtered.length} position{filtered.length !== 1 ? 's' : ''}
          </span>
          <button
          disabled={bulkSyncing}
          onClick={async () => {
            setBulkSyncing(true);
            setBulkSyncResult(null);
            try {
              const data = await apiRequest<{ placed: number; failed: number; skipped: number; priceTooFar: number; notOwned: number; total: number; results?: { ticker: string; action: string }[] }>('/api/stops/t212', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              });
              // Extract failure details for display (include price-too-far)
              const failedDetails = (data.results ?? [])
                .filter((r) => r.action.startsWith('FAILED') || r.action === 'SKIPPED_PRICE_TOO_FAR' || r.action === 'SKIPPED_NOT_OWNED')
                .map((r) => `${r.ticker}: ${r.action.replace('FAILED: ', '').replace('SKIPPED_PRICE_TOO_FAR', 'Stop too far from market price').replace('SKIPPED_NOT_OWNED', 'Not found on T212 account (wrong ISA/Invest?)')}`);
              setBulkSyncResult({
                placed: data.placed,
                failed: data.failed,
                skipped: data.skipped ?? 0,
                priceTooFar: data.priceTooFar ?? 0,
                notOwned: data.notOwned ?? 0,
                total: data.total,
                failedDetails,
              });
              // Keep result visible longer for large portfolios
              setTimeout(() => setBulkSyncResult(null), failedDetails.length > 3 ? 15000 : 8000);
            } catch { /* ignore */ }
            setBulkSyncing(false);
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary/20 text-primary-400 rounded-lg hover:bg-primary/30 transition-colors disabled:opacity-50"
          title="Push all DB stop prices to Trading 212 as pending stop orders"
        >
          {bulkSyncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
          Push Stops to T212
        </button>
        {bulkSyncResult && (
          <span className="text-xs text-profit flex items-center gap-1">
            <CheckCircle className="w-3 h-3" />
            {bulkSyncResult.placed}/{bulkSyncResult.total} placed
            {bulkSyncResult.skipped > 0 && <span className="text-muted-foreground">({bulkSyncResult.skipped} skipped)</span>}
            {bulkSyncResult.priceTooFar > 0 && <span className="text-warning">({bulkSyncResult.priceTooFar} price too far)</span>}
            {bulkSyncResult.notOwned > 0 && <span className="text-warning">({bulkSyncResult.notOwned} not on T212)</span>}
            {(bulkSyncResult.failed - bulkSyncResult.priceTooFar) > 0 && <span className="text-loss">({bulkSyncResult.failed - bulkSyncResult.priceTooFar} failed)</span>}
          </span>
        )}
        {bulkSyncResult?.failedDetails && bulkSyncResult.failedDetails.length > 0 && (
          <div className="text-xs text-loss mt-1">
            {bulkSyncResult.failedDetails.map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>
        )}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th className="w-8">
                <input type="checkbox" className="rounded border-border bg-navy-800" aria-label="Select all positions" />
              </th>
              <th className="w-8"></th>
              <th className="w-8"></th>
              <th className="cursor-pointer" onClick={() => toggleSort('ticker')}>
                <span className="flex items-center gap-1">
                  Ticker <ArrowUpDown className="w-3 h-3" />
                </span>
              </th>
              <th>Status</th>
              <th>Rating</th>
              <th className="cursor-pointer text-right" onClick={() => toggleSort('rMultiple')}>
                <span className="flex items-center gap-1 justify-end">
                  R-Multiple <ArrowUpDown className="w-3 h-3" />
                </span>
              </th>
              <th className="text-right">Entry</th>
              <th className="text-right">Current</th>
              <th className="text-right">Stop-Loss</th>
              <th className="text-right">Protection</th>
              <th className="text-right">Shares</th>
              <th className="cursor-pointer text-right" onClick={() => toggleSort('gainPercent')}>
                <span className="flex items-center gap-1 justify-end">
                  Gain% <ArrowUpDown className="w-3 h-3" />
                </span>
              </th>
              <th className="cursor-pointer text-right" onClick={() => toggleSort('value')}>
                <span className="flex items-center gap-1 justify-end">
                  Value <ArrowUpDown className="w-3 h-3" />
                </span>
              </th>
              <th className="text-right">Initial Risk (Entry → Stop)</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((pos) => (
              <tr key={pos.id} className="group">
                <td>
                  <input type="checkbox" className="rounded border-border bg-navy-800" aria-label="Select position" />
                </td>
                <td>
                  <div
                    className={cn(
                      'w-2 h-2 rounded-full',
                      pos.status === 'OPEN' ? 'bg-profit' : 'bg-muted-foreground'
                    )}
                  />
                </td>
                <td>
                  {(pos.alerts || 0) > 0 ? (
                    <div className="relative">
                      <Bell className="w-4 h-4 text-warning" />
                      <span className="absolute -top-1 -right-1 w-3 h-3 bg-warning text-[8px] text-black rounded-full flex items-center justify-center font-bold">
                        {pos.alerts}
                      </span>
                    </div>
                  ) : (
                    <BellOff className="w-4 h-4 text-muted-foreground/30" />
                  )}
                </td>
                <td>
                  <div>
                    <span className="text-primary-400 font-semibold">{pos.ticker}</span>
                    <div className="text-xs text-muted-foreground">{pos.name}</div>
                  </div>
                </td>
                <td>
                  <StatusBadge status={pos.candidateStatus || pos.status} />
                </td>
                <td>
                  <StatusBadge status={pos.rating || 'N/A'} />
                </td>
                <td className="text-right">
                  <span
                    className={cn(
                      'font-mono font-semibold',
                      pos.rMultiple >= 0 ? 'text-profit' : 'text-loss'
                    )}
                  >
                    {formatR(pos.rMultiple)}
                  </span>
                  {/* Pyramid add indicator */}
                  {pos.status === 'OPEN' && (() => {
                    const pc = canPyramid(pos.currentPrice, pos.entryPrice, pos.initialRisk, undefined, pos.pyramidAdds ?? 0);
                    if (pc.allowed) {
                      return (
                        <div className="flex items-center justify-end gap-1 mt-0.5">
                          <Layers className="w-3 h-3 text-profit" />
                          <span className="text-[10px] text-profit font-medium">Add #{pc.addNumber}</span>
                        </div>
                      );
                    }
                    return null;
                  })()}
                </td>
                <td className="text-right font-mono text-sm">{formatPrice(pos.entryPrice, pos.priceCurrency)}</td>
                <td className="text-right font-mono text-sm">
                  <span className="inline-flex items-center gap-1 justify-end">
                    {formatPrice(pos.currentPrice, pos.priceCurrency)}
                    {pos.priceSource && (
                      <span
                        className={cn(
                          'text-[9px] font-semibold px-1 py-px rounded',
                          pos.priceSource === 'T212'
                            ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                            : 'bg-blue-500/15 text-blue-400 border border-blue-500/30'
                        )}
                        title={pos.priceSource === 'T212' ? 'Real-time from Trading 212' : 'From Yahoo Finance (may be delayed)'}
                      >
                        {pos.priceSource === 'T212' ? 'T212' : 'YF'}
                      </span>
                    )}
                    {pos.priceFreshness && (() => {
                      const age = pos.priceFreshness.ageSeconds;
                      const src = pos.priceFreshness.source;
                      const provider = pos.priceSource ?? 'YAHOO';
                      const isLive = src === 'LIVE';
                      const isStale = src === 'STALE_CACHE' || age > 300;
                      const color = isLive ? 'bg-emerald-400' : isStale ? 'bg-red-400' : 'bg-amber-400';
                      const ageLabel = isLive ? 'Live'
                        : age < 60 ? `${age}s ago`
                        : `${Math.round(age / 60)}m ago`;
                      return (
                        <span
                          title={`${provider}: ${ageLabel}`}
                          className={cn('inline-block w-1.5 h-1.5 rounded-full flex-shrink-0', color, isLive && 'animate-pulse')}
                        />
                      );
                    })()}
                  </span>
                  {pos.t212Price?.mismatch && (
                    <div className="flex items-center justify-end gap-1 mt-0.5" title={`Yahoo: ${formatPrice(pos.t212Price.yahooPrice, pos.priceCurrency)} vs T212: ${formatPrice(pos.t212Price.price, pos.priceCurrency)} — ${pos.t212Price.diffPercent}% diff`}>
                      <AlertTriangle className="w-3 h-3 text-amber-400" />
                      <span className="text-[10px] text-amber-400 font-medium">Yahoo: {formatPrice(pos.t212Price.yahooPrice, pos.priceCurrency)}</span>
                    </div>
                  )}
                </td>
                <td className="text-right">
                  <span className="font-mono text-sm flex items-center justify-end gap-1">
                    {pos.protectionLevel !== 'INITIAL' && (
                      <Lock className="w-3 h-3 text-profit" />
                    )}
                    {formatPrice(pos.currentStop, pos.priceCurrency)}
                  </span>
                </td>
                <td className="text-right">
                  <StatusBadge status={pos.protectionLevel} />
                  {pos.gapRisk && (
                    <div className="mt-1" title={`Gap: ${pos.gapRisk.gapPercent >= 0 ? '+' : ''}${pos.gapRisk.gapPercent.toFixed(2)}% (threshold: ±${pos.gapRisk.threshold.toFixed(2)}%)`}>
                      <StatusBadge status="GAP_RISK" />
                    </div>
                  )}
                </td>
                <td className="text-right font-mono text-sm">{pos.shares}</td>
                <td className="text-right">
                  <span
                    className={cn(
                      'font-mono text-sm',
                      pos.gainPercent >= 0 ? 'text-profit' : 'text-loss'
                    )}
                  >
                    {formatPercent(pos.gainPercent)}
                  </span>
                </td>
                <td className="text-right font-mono text-sm">{formatCurrency(pos.value)}</td>
                <td className="text-right">
                  <span
                    className={cn(
                      'font-mono text-sm',
                      pos.rMultiple >= 0 ? 'text-profit' : 'text-loss'
                    )}
                  >
                    {formatCurrency(pos.initialRiskGBP ?? pos.riskGBP ?? 0)}
                  </span>
                </td>
                <td>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {pos.status === 'OPEN' && (
                      <>
                        <button
                          onClick={async () => {
                            setStopModal(pos);
                            // Pre-fill with the recommended stop if the ladder has an upgrade,
                            // otherwise fall back to the current stop.
                            const _entry = pos.entryPrice;
                            const _R = pos.initialRisk;
                            const _r = pos.rMultiple;
                            const _cur = pos.currentStop;
                            let _recommended = _cur;
                            if (_r >= 3.0 && _entry + 1.0 * _R > _cur) _recommended = _entry + 1.0 * _R;
                            else if (_r >= 2.5 && _entry + 0.5 * _R > _cur) _recommended = _entry + 0.5 * _R;
                            else if (_r >= 1.5 && _entry > _cur) _recommended = _entry;
                            setStopInput(_recommended.toFixed(2));
                            setStopError(null);
                            setT212PushStatus('idle');
                            setT212PushMessage(null);
                            setT212CurrentStop(null);
                            setRecApplying(false);
                            setRecApplyError(null);

                            // Fetch merged recommendation (R-based + trailing ATR) from server
                            // and override pre-fill if the server recommends a higher stop
                            try {
                              const stopRecs = await apiRequest<Array<{
                                positionId: string;
                                newStop: number;
                              }>>('/api/stops?userId=default-user');
                              const serverRec = stopRecs.find((r) => r.positionId === pos.id);
                              if (serverRec && serverRec.newStop > _recommended) {
                                _recommended = serverRec.newStop;
                                setStopInput(_recommended.toFixed(2));
                              }
                            } catch { /* best-effort — ladder pre-fill still applies */ }

                            // Fetch T212 stop status in background
                            setT212Loading(true);
                            try {
                              const data = await apiRequest<{
                                positions?: Array<{
                                  positionId: string;
                                  currentStop: number;
                                  dbSyncedUp: boolean;
                                  t212StopOrder?: { stopPrice?: number };
                                }>;
                              }>('/api/stops/t212');
                              const match = data.positions?.find((p) => p.positionId === pos.id);
                              if (match?.t212StopOrder?.stopPrice) {
                                setT212CurrentStop(match.t212StopOrder.stopPrice);
                                // If T212 has a higher stop, update the pre-fill and modal display
                                if (match.t212StopOrder.stopPrice > pos.currentStop) {
                                  setStopInput(match.t212StopOrder.stopPrice.toFixed(2));
                                }
                                // Sync: if the GET route corrected the DB, update modal
                                if (match.dbSyncedUp && match.currentStop > pos.currentStop) {
                                  pos.currentStop = match.currentStop;
                                }
                              }
                            } catch { /* ignore */ }
                            setT212Loading(false);
                          }}
                          className="px-2 py-1 text-xs bg-primary/20 text-primary-400 rounded hover:bg-primary/30 transition-colors"
                        >
                          Update Stop
                        </button>
                        <button
                          onClick={() => {
                            setExitModal(pos);
                            setExitInput(pos.currentPrice.toFixed(2));
                            setExitError(null);
                            setExitConfirmStep(false);
                          }}
                          className="px-2 py-1 text-xs bg-loss/20 text-loss rounded hover:bg-loss/30 transition-colors"
                        >
                          Exit
                        </button>
                        {onJournalClick && (
                          <button
                            onClick={() => onJournalClick(pos.id)}
                            className="px-2 py-1 text-xs bg-navy-700 text-muted-foreground rounded hover:bg-navy-600 hover:text-foreground transition-colors flex items-center gap-1"
                            title="Open journal"
                          >
                            <BookOpen className="w-3 h-3" />
                            Journal
                          </button>
                        )}
                        {pos.source === 'trading212' && (
                          <button
                            disabled={resettingId === pos.id}
                            onClick={async () => {
                              if (!confirm(`Reset ${pos.ticker} entry price & stop from T212? This overwrites current values.`)) return;
                              setResettingId(pos.id);
                              setResetResult(null);
                              try {
                                const data = await apiRequest<{ success: boolean; message: string }>('/api/positions/reset-from-t212', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ positionId: pos.id }),
                                });
                                setResetResult({ id: pos.id, message: data.message, success: true });
                                setTimeout(() => setResetResult(null), 8000);
                              } catch (err) {
                                setResetResult({ id: pos.id, message: (err as Error).message || 'Reset failed', success: false });
                                setTimeout(() => setResetResult(null), 8000);
                              }
                              setResettingId(null);
                            }}
                            className="px-2 py-1 text-xs bg-warning/20 text-warning rounded hover:bg-warning/30 transition-colors disabled:opacity-50"
                            title="Pull entry price from T212 and recalculate stops"
                          >
                            {resettingId === pos.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                          </button>
                        )}
                        {resetResult?.id === pos.id && (
                          <span className={cn('text-[10px]', resetResult.success ? 'text-profit' : 'text-loss')}>
                            {resetResult.message}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={16} className="text-center py-12 text-muted-foreground">
                  No positions found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Update Stop Modal ── */}
      {stopModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-navy-800 border border-border rounded-xl shadow-2xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-primary-400" />
                <h3 className="font-semibold">Update Stop — {stopModal.ticker}</h3>
              </div>
              <button onClick={() => setStopModal(null)} className="text-muted-foreground hover:text-foreground" title="Close">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              {/* Position context */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="bg-navy-900 rounded-lg p-2.5">
                  <span className="text-muted-foreground text-xs">Entry</span>
                  <p className="font-mono font-medium">{formatPrice(stopModal.entryPrice, stopModal.priceCurrency)}</p>
                </div>
                <div className="bg-navy-900 rounded-lg p-2.5">
                  <span className="text-muted-foreground text-xs">Current Price</span>
                  <p className="font-mono font-medium">{formatPrice(stopModal.currentPrice, stopModal.priceCurrency)}</p>
                </div>
                <div className="bg-navy-900 rounded-lg p-2.5">
                  <span className="text-muted-foreground text-xs">Current Stop (DB)</span>
                  <p className="font-mono font-medium text-warning">{formatPrice(stopModal.currentStop, stopModal.priceCurrency)}</p>
                </div>
                <div className="bg-navy-900 rounded-lg p-2.5">
                  <span className="text-muted-foreground text-xs">T212 Stop</span>
                  <p className="font-mono font-medium">
                    {t212Loading ? (
                      <span className="text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Checking…</span>
                    ) : t212CurrentStop !== null ? (
                      <span className={cn(
                        t212CurrentStop > stopModal.currentStop ? 'text-profit' : 
                        t212CurrentStop < stopModal.currentStop ? 'text-loss' : 'text-warning'
                      )}>
                        {formatPrice(t212CurrentStop, stopModal.priceCurrency)}
                        {t212CurrentStop > stopModal.currentStop && (
                          <span className="text-xs ml-1">(higher)</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </p>
                </div>
              </div>

              {/* Warning if T212 stop is higher than DB */}
              {t212CurrentStop !== null && t212CurrentStop > stopModal.currentStop && (
                <div className="flex items-start gap-2 p-3 bg-profit/10 border border-profit/20 rounded-lg text-sm">
                  <TrendingUp className="w-4 h-4 text-profit shrink-0 mt-0.5" />
                  <span className="text-profit/90">
                    T212 already has a higher stop at <strong>{formatPrice(t212CurrentStop, stopModal.priceCurrency)}</strong>. 
                    New stop must be above this level.
                  </span>
                </div>
              )}

              {/* ── Stop Ladder Recommendation ── */}
              {(() => {
                const R = stopModal.initialRisk;
                const entry = stopModal.entryPrice;
                const rMul = stopModal.rMultiple;
                const curStop = stopModal.currentStop;

                // Build the ladder
                const ladder: { level: string; trigger: string; stopPrice: number; formula: string; active: boolean; reached: boolean }[] = [
                  {
                    level: 'Breakeven',
                    trigger: '≥ +1.5R',
                    stopPrice: entry,
                    formula: 'Entry Price',
                    active: false,
                    reached: rMul >= 1.5,
                  },
                  {
                    level: 'Partial Lock',
                    trigger: '≥ +2.5R',
                    stopPrice: entry + 0.5 * R,
                    formula: 'Entry + 0.5 × R',
                    active: false,
                    reached: rMul >= 2.5,
                  },
                  {
                    level: 'Trail + Lock',
                    trigger: '≥ +3.0R',
                    stopPrice: entry + 1.0 * R,
                    formula: 'Entry + 1.0 × R (floor)',
                    active: false,
                    reached: rMul >= 3.0,
                  },
                ];

                // Mark the highest reached level as active (if its stop is above current)
                for (let i = ladder.length - 1; i >= 0; i--) {
                  if (ladder[i].reached && ladder[i].stopPrice > curStop) {
                    ladder[i].active = true;
                    break;
                  }
                }

                const recommended = ladder.find(l => l.active);

                return (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Stop Ladder</p>
                    <div className="bg-navy-900 rounded-lg overflow-hidden">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border/50 text-muted-foreground">
                            <th className="text-left px-3 py-1.5 font-medium">Level</th>
                            <th className="text-left px-3 py-1.5 font-medium">Trigger</th>
                            <th className="text-right px-3 py-1.5 font-medium">Stop →</th>
                            <th className="text-right px-3 py-1.5 font-medium"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {ladder.map((row) => (
                            <tr
                              key={row.level}
                              className={cn(
                                'border-b border-border/30 transition-colors',
                                row.active ? 'bg-profit/10' : row.reached ? 'bg-navy-800/50' : ''
                              )}
                            >
                              <td className="px-3 py-1.5">
                                <span className={cn(
                                  'flex items-center gap-1.5',
                                  row.active ? 'text-profit font-semibold' : row.reached ? 'text-foreground' : 'text-muted-foreground'
                                )}>
                                  {row.reached && <span className="text-[10px]">✓</span>}
                                  {row.level}
                                </span>
                              </td>
                              <td className={cn('px-3 py-1.5 font-mono', row.reached ? 'text-foreground' : 'text-muted-foreground')}>
                                {row.trigger}
                              </td>
                              <td className={cn('px-3 py-1.5 font-mono text-right', row.active ? 'text-profit font-semibold' : '')}>
                                {formatPrice(row.stopPrice, stopModal.priceCurrency)}
                              </td>
                              <td className="px-3 py-1.5 text-right">
                                {row.reached && row.stopPrice > curStop && (
                                  <button
                                    onClick={() => { setStopInput(row.stopPrice.toFixed(2)); setStopError(null); }}
                                    className="text-[10px] px-1.5 py-0.5 bg-primary/20 text-primary-400 rounded hover:bg-primary/30 transition-colors"
                                  >
                                    Use
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {recommended ? (
                      <div className="space-y-2">
                        <p className="text-xs text-profit flex items-center gap-1">
                          <TrendingUp className="w-3 h-3" />
                          Recommended: move stop to{' '}
                          <strong>{formatPrice(recommended.stopPrice, stopModal.priceCurrency)}</strong>
                          {' '}({recommended.level})
                        </p>
                        <button
                          disabled={recApplying || stopSubmitting}
                          onClick={async () => {
                            if (!onUpdateStop) return;
                            setRecApplying(true);
                            setRecApplyError(null);
                            setT212PushStatus('idle');
                            setT212PushMessage(null);
                            const reason = `Stop ladder upgrade \u2192 ${recommended.level}: ${formatPrice(stopModal.currentStop, stopModal.priceCurrency)} \u2192 ${formatPrice(recommended.stopPrice, stopModal.priceCurrency)}`;
                            const ok = await onUpdateStop(stopModal.id, recommended.stopPrice, reason);
                            if (!ok) {
                              setRecApplyError('Failed to apply — check monotonic rule');
                              setRecApplying(false);
                              return;
                            }
                            if (pushToT212) {
                              setT212PushStatus('pushing');
                              try {
                                const t212Data = await apiRequest<{ message?: string }>('/api/stops/t212', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ positionId: stopModal.id, stopPrice: recommended.stopPrice }),
                                });
                                setT212PushStatus('success');
                                setT212PushMessage(t212Data.message || 'Stop placed on Trading 212');
                              } catch (err) {
                                setT212PushStatus('error');
                                const msg = formatApiError(err, 'Unknown error');
                                setT212PushMessage(`T212 push failed: ${msg}`);
                              }
                            }
                            setRecApplying(false);
                            setTimeout(() => setStopModal(null), pushToT212 ? 2000 : 0);
                          }}
                          className="w-full py-2 text-sm rounded-lg bg-profit/20 text-profit font-semibold hover:bg-profit/30 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                          {recApplying ? (
                            <><Loader2 className="w-4 h-4 animate-spin" /> Applying…</>
                          ) : (
                            <><TrendingUp className="w-4 h-4" /> Apply Recommended: {formatPrice(recommended.stopPrice, stopModal.priceCurrency)}</>
                          )}
                        </button>
                        {recApplyError && (
                          <p className="text-xs text-loss flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" /> {recApplyError}
                          </p>
                        )}
                      </div>
                    ) : rMul < 1.5 ? (
                      <p className="text-xs text-muted-foreground">
                        No upgrade yet — profit needs to reach +1.5R ({formatR(1.5)}) for breakeven. Currently at {formatR(rMul)}.
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Stop is already at or above the recommended level.
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* Pyramid Add Triggers — only shown when position is above +1R */}
              {(() => {
                const R = stopModal.initialRisk;
                const entry = stopModal.entryPrice;
                const rMul = stopModal.rMultiple;

                // Don't show pyramid info for positions below +1R — too early, creates noise
                if (rMul < 1.0) return null;

                const pc = canPyramid(stopModal.currentPrice, entry, R, undefined, stopModal.pyramidAdds ?? 0);
                const triggers = PYRAMID_CONFIG.addTriggers.map((mult, idx) => {
                  // Without ATR, use R-based approximation: entry + mult * R (roughly)
                  const approxTrigger = entry + (idx + 1) * R;
                  const reached = stopModal.currentPrice >= approxTrigger;
                  return {
                    addNumber: idx + 1,
                    triggerLabel: `+${(idx + 1).toFixed(0)}R`,
                    approxPrice: approxTrigger,
                    atrMultiplier: mult,
                    reached,
                  };
                });

                return (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                      <Layers className="w-3 h-3" />
                      Pyramid Add Triggers
                    </p>
                    <div className="bg-navy-900 rounded-lg overflow-hidden">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border/50 text-muted-foreground">
                            <th className="text-left px-3 py-1.5 font-medium">Add</th>
                            <th className="text-left px-3 py-1.5 font-medium">ATR Trigger</th>
                            <th className="text-right px-3 py-1.5 font-medium">≈ Price</th>
                            <th className="text-right px-3 py-1.5 font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {triggers.map((t) => (
                            <tr
                              key={t.addNumber}
                              className={cn(
                                'border-b border-border/30',
                                t.reached ? 'bg-profit/10' : ''
                              )}
                            >
                              <td className="px-3 py-1.5">
                                <span className={cn(
                                  'font-medium',
                                  t.reached ? 'text-profit' : 'text-muted-foreground'
                                )}>
                                  #{t.addNumber}
                                </span>
                              </td>
                              <td className="px-3 py-1.5 text-muted-foreground">
                                Entry + {t.atrMultiplier}×ATR
                              </td>
                              <td className={cn(
                                'px-3 py-1.5 font-mono text-right',
                                t.reached ? 'text-profit font-semibold' : ''
                              )}>
                                {formatPrice(t.approxPrice, stopModal.priceCurrency)}
                              </td>
                              <td className="px-3 py-1.5 text-right">
                                {t.reached ? (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-profit/20 text-profit font-medium">
                                    TRIGGERED
                                  </span>
                                ) : (
                                  <span className="text-[10px] text-muted-foreground">
                                    Pending
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {pc.allowed ? (
                      <p className="text-xs text-profit flex items-center gap-1">
                        <TrendingUp className="w-3 h-3" />
                        Pyramid add #{pc.addNumber} is available at {formatR(pc.rMultiple)}
                      </p>
                    ) : rMul > 0 ? (
                      <p className="text-xs text-muted-foreground">
                        Next add triggers at approx. {formatPrice(triggers.find(t => !t.reached)?.approxPrice ?? 0, stopModal.priceCurrency)}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Position not in profit — no pyramid adds available
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* Safety warning */}
              <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg text-sm">
                <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                <span className="text-warning/90">Stops can only move <strong>UP</strong> (monotonic enforcement).{!t212CurrentStop && pushToT212 ? ' Enter the same value to push existing stop to T212.' : ` The new stop must be above ${formatPrice(Math.max(stopModal.currentStop, t212CurrentStop ?? 0), stopModal.priceCurrency)}.`}</span>
              </div>

              {/* Input */}
              <div>
                {(() => {
                  // Compute the recommended stop for this position (same ladder as onClick pre-fill)
                  const _r = stopModal.rMultiple;
                  const _entry = stopModal.entryPrice;
                  const _R = stopModal.initialRisk;
                  const _cur = stopModal.currentStop;
                  let _rec: number | null = null;
                  if (_r >= 3.0 && _entry + 1.0 * _R > _cur) _rec = _entry + 1.0 * _R;
                  else if (_r >= 2.5 && _entry + 0.5 * _R > _cur) _rec = _entry + 0.5 * _R;
                  else if (_r >= 1.5 && _entry > _cur) _rec = _entry;
                  const inputMatchesRec = _rec !== null &&
                    parseFloat(stopInput) === parseFloat(_rec.toFixed(2));
                  return (
                    <label className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                      New Stop Price
                      {_rec !== null && (
                        <span className={cn(
                          'text-[10px] px-1.5 py-0.5 rounded font-medium',
                          inputMatchesRec
                            ? 'bg-profit/20 text-profit'
                            : 'bg-navy-700 text-muted-foreground'
                        )}>
                          {inputMatchesRec
                            ? '✓ recommended'
                            : `recommended: ${formatPrice(_rec, stopModal.priceCurrency)}`}
                        </span>
                      )}
                    </label>
                  );
                })()}
                <input
                  type="number"
                  step="0.01"
                  value={stopInput}
                  onChange={(e) => { setStopInput(e.target.value); setStopError(null); }}
                  className="w-full px-3 py-2 bg-navy-900 border border-border rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  aria-label="New stop price"
                  autoFocus
                />
              </div>

              {stopError && (
                <p className="text-sm text-loss flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" /> {stopError}
                </p>
              )}

              {/* T212 Push toggle */}
              <div className="flex items-center gap-2 p-3 bg-navy-900 border border-border/50 rounded-lg">
                <input
                  type="checkbox"
                  id="pushToT212"
                  checked={pushToT212}
                  onChange={(e) => setPushToT212(e.target.checked)}
                  className="rounded border-border bg-navy-800"
                />
                <label htmlFor="pushToT212" className="text-sm cursor-pointer flex items-center gap-1.5">
                  <Send className="w-3.5 h-3.5 text-primary-400" />
                  Also set stop on Trading 212
                </label>
              </div>

              {t212PushStatus === 'pushing' && (
                <p className="text-xs text-primary-400 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> Placing stop order on Trading 212…
                </p>
              )}
              {t212PushStatus === 'success' && t212PushMessage && (
                <p className="text-xs text-profit flex items-center gap-1">
                  <CheckCircle className="w-3 h-3" /> {t212PushMessage}
                </p>
              )}
              {t212PushStatus === 'error' && t212PushMessage && (
                <p className="text-xs text-loss flex items-center gap-1">
                  <XCircle className="w-3 h-3" /> {t212PushMessage}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-border">
              <button
                onClick={() => setStopModal(null)}
                className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                disabled={stopSubmitting}
                onClick={async () => {
                  const newStop = parseFloat(stopInput);
                  if (isNaN(newStop) || newStop <= 0) {
                    setStopError('Enter a valid price');
                    return;
                  }
                  // Monotonic rule: use the HIGHER of DB stop and T212 stop as the floor
                  const effectiveFloor = Math.max(stopModal.currentStop, t212CurrentStop ?? 0);
                  // Block if trying to LOWER the stop
                  if (newStop < effectiveFloor) {
                    setStopError(`New stop must be at or above ${formatPrice(effectiveFloor, stopModal.priceCurrency)} (${t212CurrentStop && t212CurrentStop > stopModal.currentStop ? 'T212 stop' : 'current stop'})`);
                    return;
                  }
                  // Same as current and not pushing to T212 → nothing to do
                  if (newStop === stopModal.currentStop && !pushToT212) {
                    setStopError('Stop is already at this price — check "Also set stop on Trading 212" to push it to your broker.');
                    return;
                  }
                  if (newStop >= stopModal.currentPrice) {
                    setStopError('Stop cannot be at or above current price');
                    return;
                  }
                  if (!onUpdateStop) {
                    setStopError('Stop update not available');
                    return;
                  }
                  setStopSubmitting(true);
                  setT212PushStatus('idle');
                  setT212PushMessage(null);

                  // Skip DB update if stop hasn't changed (push-only to T212)
                  let ok = true;
                  if (newStop !== stopModal.currentStop) {
                    const reason = `Manual stop update: ${formatPrice(stopModal.currentStop, stopModal.priceCurrency)} → ${formatPrice(newStop, stopModal.priceCurrency)}`;
                    ok = await onUpdateStop(stopModal.id, newStop, reason);
                  }

                  if (!ok) {
                    setStopSubmitting(false);
                    setStopError('Failed to update stop — check monotonic rule');
                    return;
                  }

                  // Push to T212 if checkbox is checked
                  if (pushToT212) {
                    setT212PushStatus('pushing');
                    try {
                      const t212Data = await apiRequest<{ message?: string }>('/api/stops/t212', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          positionId: stopModal.id,
                          stopPrice: newStop,
                        }),
                      });
                      setT212PushStatus('success');
                      setT212PushMessage(t212Data.message || 'Stop placed on Trading 212');
                    } catch (err) {
                      setT212PushStatus('error');
                      const msg = formatApiError(err, 'Unknown error');
                      setT212PushMessage(`T212 push failed: ${msg}`);
                    }
                  }

                  setStopSubmitting(false);

                  // Auto-close after short delay if T212 push succeeded or wasn't requested
                  if (!pushToT212) {
                    setStopModal(null);
                  } else {
                    setTimeout(() => {
                      setStopModal(null);
                      setT212PushStatus('idle');
                      setT212PushMessage(null);
                    }, 2000);
                  }
                }}
                className="px-4 py-2 text-sm bg-primary/20 text-primary-400 rounded-lg hover:bg-primary/30 transition-colors disabled:opacity-50"
              >
                {stopSubmitting ? 'Saving…' : pushToT212 ? 'Update & Push to T212' : 'Confirm Update'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Exit Position Modal ── */}
      {exitModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-navy-800 border border-border rounded-xl shadow-2xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div className="flex items-center gap-2">
                <LogOut className="w-5 h-5 text-loss" />
                <h3 className="font-semibold">Exit Position — {exitModal.ticker}</h3>
              </div>
              <button onClick={() => setExitModal(null)} className="text-muted-foreground hover:text-foreground" title="Close">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              {/* Position summary */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="bg-navy-900 rounded-lg p-2.5">
                  <span className="text-muted-foreground text-xs">Entry</span>
                  <p className="font-mono font-medium">{formatPrice(exitModal.entryPrice, exitModal.priceCurrency)}</p>
                </div>
                <div className="bg-navy-900 rounded-lg p-2.5">
                  <span className="text-muted-foreground text-xs">Shares</span>
                  <p className="font-mono font-medium">{exitModal.shares}</p>
                </div>
                <div className="bg-navy-900 rounded-lg p-2.5">
                  <span className="text-muted-foreground text-xs">Current Price</span>
                  <p className="font-mono font-medium">{formatPrice(exitModal.currentPrice, exitModal.priceCurrency)}</p>
                </div>
                <div className="bg-navy-900 rounded-lg p-2.5">
                  <span className="text-muted-foreground text-xs">P&L</span>
                  <p className={cn('font-mono font-medium', exitModal.gainPercent >= 0 ? 'text-profit' : 'text-loss')}>
                    {formatPercent(exitModal.gainPercent)}
                  </p>
                </div>
              </div>

              {/* Exit price input */}
              <div>
                <label className="block text-sm text-muted-foreground mb-1">Exit Price</label>
                <input
                  type="number"
                  step="0.01"
                  value={exitInput}
                  onChange={(e) => { setExitInput(e.target.value); setExitError(null); }}
                  className="w-full px-3 py-2 bg-navy-900 border border-border rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-loss/50"
                  autoFocus
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Pre-filled with current market price. Adjust if you sold at a different price.
                </p>
              </div>

              {/* Exit reason dropdown */}
              <div>
                <label className="block text-sm text-muted-foreground mb-1">Exit Reason</label>
                <select
                  value={exitReasonInput}
                  onChange={(e) => setExitReasonInput(e.target.value)}
                  className="w-full px-3 py-2 bg-navy-900 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-loss/50"
                  title="Exit reason"
                >
                  <option value="">Auto-detect from price</option>
                  <option value="STOP_HIT">Stop-loss triggered</option>
                  <option value="MANUAL_PROFIT">Sold manually — profit</option>
                  <option value="MANUAL_LOSS">Sold manually — cutting loss</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>

              {/* Close note */}
              <div>
                <label className="block text-sm text-muted-foreground mb-1">Close Note (optional)</label>
                <textarea
                  value={exitNoteInput}
                  onChange={(e) => setExitNoteInput(e.target.value)}
                  placeholder="Why did you close? What did you learn?"
                  rows={2}
                  className="w-full px-3 py-2 bg-navy-900 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-loss/50 resize-none"
                />
              </div>

              {/* Preview realised P&L */}
              {!isNaN(parseFloat(exitInput)) && parseFloat(exitInput) > 0 && (
                <div className="bg-navy-900 rounded-lg p-3">
                  <span className="text-muted-foreground text-xs">Estimated Realised P&L ({exitModal.priceCurrency || 'GBP'})</span>
                  <p className={cn(
                    'font-mono font-semibold text-lg',
                    (parseFloat(exitInput) - exitModal.entryPrice) >= 0 ? 'text-profit' : 'text-loss'
                  )}>
                    {formatPrice((parseFloat(exitInput) - exitModal.entryPrice) * exitModal.shares, exitModal.priceCurrency)}
                  </p>
                </div>
              )}

              {exitError && (
                <p className="text-sm text-loss flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" /> {exitError}
                </p>
              )}

              {/* ── Step 2: Final confirmation warning ── */}
              {exitConfirmStep && (
                <div className="border-2 border-loss rounded-lg p-4 bg-loss/10 space-y-3 animate-fade-in">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5 text-loss" />
                    <span className="text-loss font-bold text-sm uppercase tracking-wider">Final Warning</span>
                    <AlertTriangle className="w-5 h-5 text-loss" />
                  </div>
                  <p className="text-sm text-loss/90 font-medium">
                    You are about to permanently close <strong>{exitModal.ticker}</strong> ({exitModal.shares} shares) at <strong>{formatPrice(parseFloat(exitInput), exitModal.priceCurrency)}</strong>.
                  </p>
                  <p className="text-sm text-loss/90">
                    This action <strong>cannot be undone</strong>. The position will be marked as CLOSED in the database.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Make sure you have already sold this position on your broker before confirming.
                  </p>
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => setExitConfirmStep(false)}
                      className="flex-1 px-4 py-2 text-sm text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors"
                    >
                      Go Back
                    </button>
                    <button
                      disabled={exitSubmitting}
                      onClick={async () => {
                        const price = parseFloat(exitInput);
                        if (!onExitPosition) {
                          setExitError('Exit not available');
                          return;
                        }
                        setExitSubmitting(true);
                        const ok = await onExitPosition(
                          exitModal.id,
                          price,
                          exitReasonInput || undefined,
                          exitNoteInput || undefined
                        );
                        setExitSubmitting(false);
                        if (ok) {
                          setExitModal(null);
                          setExitConfirmStep(false);
                        } else {
                          setExitError('Failed to close position');
                        }
                      }}
                      className="flex-1 px-4 py-2 text-sm bg-loss text-white font-bold rounded-lg hover:bg-red-600 transition-colors disabled:opacity-50"
                    >
                      {exitSubmitting ? 'Closing…' : 'I Understand — Close Position'}
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-border">
              <button
                onClick={() => { setExitModal(null); setExitConfirmStep(false); }}
                className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              {!exitConfirmStep && (
                <button
                  onClick={() => {
                    const price = parseFloat(exitInput);
                    if (isNaN(price) || price <= 0) {
                      setExitError('Enter a valid exit price');
                      return;
                    }
                    // Step 1 passed — show the final warning
                    setExitConfirmStep(true);
                  }}
                  className="px-4 py-2 text-sm bg-loss/20 text-loss rounded-lg hover:bg-loss/30 transition-colors"
                >
                  Confirm Exit
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
