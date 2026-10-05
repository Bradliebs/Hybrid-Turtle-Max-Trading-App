'use client';

import { useState } from 'react';
import { cn, formatCurrency, formatPrice } from '@/lib/utils';
import { apiRequest, formatApiError } from '@/lib/api-client';
import { ATR_TRAILING_MULTIPLIER } from '@/types';
import {
  TrendingUp,
  RefreshCw,
  Upload,
  Check,
  AlertTriangle,
  ArrowUp,
  Loader2,
  Activity,
} from 'lucide-react';

interface TrailingStopRec {
  positionId: string;
  ticker: string;
  currentStop: number;
  trailingStop: number;
  highestClose: number;
  currentATR: number;
  reason: string;
  priceCurrency?: string;
}

interface SyncResult {
  ticker: string;
  action: string;
  oldStop: number;
  newStop: number;
}

const DEFAULT_USER_ID = 'default-user';

export default function TrailingStopPanel() {
  const [recommendations, setRecommendations] = useState<TrailingStopRec[]>([]);
  const [syncResults, setSyncResults] = useState<SyncResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [importing, setImporting] = useState(false);
  const [lastAction, setLastAction] = useState<string | null>(null);

  const fetchRecommendations = async () => {
    setLoading(true);
    setLastAction(null);
    try {
      const data = await apiRequest<{ recommendations: TrailingStopRec[] }>(`/api/stops/sync?userId=${DEFAULT_USER_ID}`);
      setRecommendations(data.recommendations || []);
      setSyncResults([]);
      setLastAction(
        data.recommendations.length === 0
          ? 'All stops are up to date — no trailing adjustments needed'
          : `Found ${data.recommendations.length} trailing stop update(s)`
      );
    } catch (error) {
      setLastAction(formatApiError(error, 'Failed to calculate trailing stops'));
    } finally {
      setLoading(false);
    }
  };

  const applyRecommendations = async () => {
    setApplying(true);
    setLastAction(null);
    try {
      const data = await apiRequest<{ results: SyncResult[]; applied: number; blocked: number }>(`/api/stops/sync?userId=${DEFAULT_USER_ID}`, {
        method: 'PUT',
      });
      setSyncResults(data.results || []);
      setRecommendations([]);
      setLastAction(
        `Applied ${data.applied} trailing stop update(s)${data.blocked > 0 ? `, ${data.blocked} blocked` : ''}`
      );
    } catch (error) {
      setLastAction(formatApiError(error, 'Failed to apply trailing stops'));
    } finally {
      setApplying(false);
    }
  };

  const importFromCSV = async () => {
    setImporting(true);
    setLastAction(null);
    try {
      const data = await apiRequest<{ results?: SyncResult[]; matchedPositions: number }>(`/api/stops/sync?userId=${DEFAULT_USER_ID}`, {
        method: 'POST',
      });
      setSyncResults(data.results || []);
      setRecommendations([]);
      setLastAction(
        `Imported from CSV: ${data.results?.filter((r: SyncResult) => r.action === 'UPDATED').length || 0} updated, ${data.matchedPositions} matched`
      );
    } catch (error) {
      setLastAction(formatApiError(error, 'Failed to import from CSV — ensure positions_state.csv exists in Planning/'));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="card-surface p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Activity className="w-4 h-4 text-primary-400" />
          Trailing ATR Stops
        </h3>
        <span className="text-[10px] text-muted-foreground font-mono">{ATR_TRAILING_MULTIPLIER}× ATR(14)</span>
      </div>

      {/* Action Buttons */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        <button
          onClick={fetchRecommendations}
          disabled={loading}
          className={cn(
            'flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all',
            'bg-primary-500/20 text-primary-400 hover:bg-primary-500/30',
            loading && 'opacity-50 cursor-not-allowed'
          )}
        >
          {loading ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          Calculate
        </button>
        <button
          onClick={applyRecommendations}
          disabled={applying || recommendations.length === 0}
          className={cn(
            'flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all',
            'bg-profit/20 text-profit hover:bg-profit/30',
            (applying || recommendations.length === 0) && 'opacity-50 cursor-not-allowed'
          )}
        >
          {applying ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <ArrowUp className="w-3 h-3" />
          )}
          Apply
        </button>
        <button
          onClick={importFromCSV}
          disabled={importing}
          className={cn(
            'flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all',
            'bg-warning/20 text-warning hover:bg-warning/30',
            importing && 'opacity-50 cursor-not-allowed'
          )}
        >
          {importing ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Upload className="w-3 h-3" />
          )}
          CSV Import
        </button>
      </div>

      {/* Status Message */}
      {lastAction && (
        <div
          className={cn(
            'text-xs px-3 py-2 rounded-lg mb-3 flex items-center gap-2',
            lastAction.includes('Failed')
              ? 'bg-loss/10 text-loss'
              : lastAction.includes('no trailing')
                ? 'bg-profit/10 text-profit'
                : 'bg-primary-500/10 text-primary-400'
          )}
        >
          {lastAction.includes('Failed') ? (
            <AlertTriangle className="w-3 h-3 flex-shrink-0" />
          ) : (
            <Check className="w-3 h-3 flex-shrink-0" />
          )}
          {lastAction}
        </div>
      )}

      {/* Recommendations List */}
      {recommendations.length > 0 && (
        <div className="space-y-2 mb-3">
          <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
            Pending Updates
          </div>
          {recommendations.map((rec) => (
            <div
              key={rec.positionId}
              className="bg-navy-800 rounded-lg p-3 space-y-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-foreground">{rec.ticker}</span>
                <div className="flex items-center gap-1 text-profit text-xs">
                  <TrendingUp className="w-3 h-3" />
                  Raise Stop
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div>
                  <span className="text-muted-foreground block">Current</span>
                  <span className="font-mono text-loss">
                    {formatPrice(rec.currentStop, rec.priceCurrency)}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground block">Trailing</span>
                  <span className="font-mono text-profit font-bold">
                    {formatPrice(rec.trailingStop, rec.priceCurrency)}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground block">ATR(14)</span>
                  <span className="font-mono text-foreground">
                    {rec.currentATR.toFixed(2)}
                  </span>
                </div>
              </div>
              <div className="text-[10px] text-muted-foreground">
                Highest close: {formatPrice(rec.highestClose, rec.priceCurrency)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Sync Results */}
      {syncResults.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mb-2">
            Sync Results
          </div>
          {syncResults.map((result) => (
            <div
              key={result.ticker}
              className={cn(
                'flex items-center justify-between text-xs px-3 py-2 rounded-lg',
                result.action === 'UPDATED'
                  ? 'bg-profit/10'
                  : result.action === 'NO_CHANGE'
                    ? 'bg-navy-800'
                    : result.action === 'SKIPPED_LOWER'
                      ? 'bg-warning/10'
                      : 'bg-loss/10'
              )}
            >
              <span className="font-bold text-foreground">{result.ticker}</span>
              <div className="flex items-center gap-3">
                <span className="font-mono text-muted-foreground">
                  {formatCurrency(result.oldStop)}
                </span>
                {result.action === 'UPDATED' && (
                  <>
                    <span className="text-muted-foreground">→</span>
                    <span className="font-mono text-profit font-bold">
                      {formatCurrency(result.newStop)}
                    </span>
                    <Check className="w-3 h-3 text-profit" />
                  </>
                )}
                {result.action === 'NO_CHANGE' && (
                  <span className="text-muted-foreground">No change</span>
                )}
                {result.action === 'SKIPPED_LOWER' && (
                  <span className="text-warning">Skipped (lower)</span>
                )}
                {result.action.startsWith('BLOCKED') && (
                  <span className="text-loss text-[10px]">Blocked</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {recommendations.length === 0 && syncResults.length === 0 && !lastAction && (
        <div className="text-xs text-muted-foreground text-center py-4 space-y-1">
          <p>Click <strong>Calculate</strong> to check for trailing ATR stop updates</p>
          <p>or <strong>CSV Import</strong> to sync from your external system</p>
        </div>
      )}

      {/* Info box */}
      <div className="mt-4 bg-navy-800/50 rounded-lg p-3 text-[10px] text-muted-foreground space-y-1">
        <p className="font-semibold text-primary-400">How Trailing ATR Stops Work</p>
        <p>
          Stop = Highest Close Since Entry − {ATR_TRAILING_MULTIPLIER} × ATR(14), from the entry day. The stop
          ratchets up as price rises but <strong>never</strong> goes down (monotonic enforcement).
        </p>
      </div>
    </div>
  );
}
