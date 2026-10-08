'use client';

import { useState, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { TrendingUp, TrendingDown, BarChart3, RefreshCw } from 'lucide-react';
import { apiRequest } from '@/lib/api-client';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';

interface EquityPoint {
  date: string;
  equity: number;
  drawdownPct: number;
  openRiskPct: number | null;
}

interface EquitySummary {
  startEquity: number;
  currentEquity: number;
  change: number;
  changePct: number;
  /** Deposits minus withdrawals inside the window (GBP) */
  netCashFlow?: number;
  /** Equity change excluding deposits and withdrawals */
  tradingChange?: number;
  tradingChangePct?: number;
  maxDrawdownPct: number;
  snapshotCount: number;
  days: number;
}

export default function EquityCurveChart() {
  const [data, setData] = useState<EquityPoint[]>([]);
  const [summary, setSummary] = useState<EquitySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(90);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiRequest<{ data: EquityPoint[]; summary: EquitySummary }>(`/api/performance/equity-curve?days=${days}`);
      setData(result.data);
      setSummary(result.summary);
    } catch {
      // Silent fail
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) {
    return (
      <div className="card-surface p-4">
        <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-primary-400 animate-pulse" />
          Equity Curve
        </h3>
        <div className="h-48 flex items-center justify-center text-xs text-muted-foreground animate-pulse">Loading...</div>
      </div>
    );
  }

  if (data.length < 2) {
    return (
      <div className="card-surface p-4">
        <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-primary-400" />
          Equity Curve
        </h3>
        <div className="h-32 flex items-center justify-center text-xs text-muted-foreground">
          Not enough data yet — equity snapshots will appear after nightly runs.
        </div>
      </div>
    );
  }

  const tradingChange = summary?.tradingChange ?? summary?.change ?? 0;
  const tradingChangePct = summary?.tradingChangePct ?? summary?.changePct ?? 0;
  const isPositive = tradingChange >= 0;
  const cashFlow = summary?.netCashFlow ?? 0;

  return (
    <div className="card-surface p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-primary-400" />
          Equity Curve
        </h3>
        <div className="flex items-center gap-2">
          {[30, 90, 180].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={cn(
                'text-[10px] px-2 py-0.5 rounded transition-colors',
                days === d ? 'bg-primary-400/20 text-primary-400 font-medium' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {d}d
            </button>
          ))}
          <button onClick={fetchData} className="text-muted-foreground hover:text-foreground transition-colors ml-1" title="Refresh">
            <RefreshCw className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Summary stats */}
      {summary && (
        <div className="grid grid-cols-3 gap-3 mb-3">
          <div>
            <div className="text-[10px] text-muted-foreground">Current</div>
            <div className="text-sm font-mono font-semibold">£{summary.currentEquity.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground">Trading change</div>
            <div className={cn('text-sm font-mono font-semibold flex items-center gap-1', isPositive ? 'text-profit' : 'text-loss')}>
              {isPositive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {isPositive ? '+' : '−'}£{Math.abs(tradingChange).toFixed(2)} ({tradingChangePct >= 0 ? '+' : ''}{tradingChangePct.toFixed(1)}%)
            </div>
            {Math.abs(cashFlow) >= 0.01 && (
              <div className="text-[10px] text-muted-foreground">
                {cashFlow < 0 ? 'Withdrawn' : 'Deposited'} £{Math.abs(cashFlow).toFixed(2)} (not counted)
              </div>
            )}
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground">Max DD</div>
            <div className="text-sm font-mono text-warning">{summary.maxDrawdownPct.toFixed(1)}%</div>
          </div>
        </div>
      )}

      {/* Chart */}
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
            <defs>
              <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={isPositive ? '#22c55e' : '#ef4444'} stopOpacity={0.3} />
                <stop offset="95%" stopColor={isPositive ? '#22c55e' : '#ef4444'} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: '#6b7280' }}
              tickFormatter={(v: string) => v.slice(5)} // Show MM-DD
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 10, fill: '#6b7280' }}
              tickFormatter={(v: number) => `£${v.toFixed(0)}`}
              domain={['dataMin - 50', 'dataMax + 50']}
              width={55}
            />
            <Tooltip
              contentStyle={{ backgroundColor: '#1a1f36', border: '1px solid #2d3348', borderRadius: 8, fontSize: 11 }}
              labelStyle={{ color: '#9ca3af' }}
              formatter={(value: number) => [`£${value.toFixed(2)}`, 'Equity']}
              labelFormatter={(label: string) => label}
            />
            <Area
              type="monotone"
              dataKey="equity"
              stroke={isPositive ? '#22c55e' : '#ef4444'}
              strokeWidth={2}
              fill="url(#equityGradient)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
