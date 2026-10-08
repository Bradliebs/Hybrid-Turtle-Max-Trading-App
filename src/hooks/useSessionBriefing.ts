'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiRequest, formatApiError } from '@/lib/api-client';

const DEFAULT_USER_ID = 'default-user';

export interface SessionBriefingData {
  session: 'pre-UK' | 'UK' | 'US' | 'post-market';
  regime: string;
  health: string;
  operatingMode: string;
  equity: number;
  usedRiskPct: number;
  maxRiskPct: number;
  availableRiskPct: number;
  usedPositions: number;
  maxPositions: number;
  openPositionCount: number;
  isHoliday: boolean;
  holidayLabel?: string;
  earlyClose?: string;
}

export function currentBriefingSession(now: Date = new Date()): SessionBriefingData['session'] {
  const ukHour = parseInt(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }).format(now),
    10
  );
  return ukHour < 8 ? 'pre-UK' : ukHour < 14 ? 'UK' : ukHour < 20 ? 'US' : 'post-market';
}

/**
 * Hook that provides session briefing data for the current trading session.
 * Regime and health come from /api/dashboard/today-directive, the risk budget
 * from /api/risk (same numbers as the Risk page), and operating mode and equity
 * from /api/system-status. Candidates are supplied by the caller.
 */
export function useSessionBriefing(): {
  data: SessionBriefingData | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [data, setData] = useState<SessionBriefingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBriefing = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [directive, risk, status] = await Promise.all([
        apiRequest<{ context?: { regime?: string; healthOverall?: string } }>('/api/dashboard/today-directive'),
        apiRequest<{
          equity?: number;
          budget?: { usedRiskPercent: number; maxRiskPercent: number; availableRiskPercent: number; usedPositions: number; maxPositions: number };
        }>(`/api/risk?userId=${DEFAULT_USER_ID}`),
        apiRequest<{ operatingMode?: string }>('/api/system-status'),
      ]);

      setData({
        session: currentBriefingSession(),
        regime: directive.context?.regime ?? 'UNKNOWN',
        health: directive.context?.healthOverall ?? 'UNKNOWN',
        operatingMode: status.operatingMode ?? 'NORMAL',
        equity: risk.equity ?? 0,
        usedRiskPct: risk.budget?.usedRiskPercent ?? 0,
        maxRiskPct: risk.budget?.maxRiskPercent ?? 0,
        availableRiskPct: risk.budget?.availableRiskPercent ?? 0,
        usedPositions: risk.budget?.usedPositions ?? 0,
        maxPositions: risk.budget?.maxPositions ?? 0,
        openPositionCount: risk.budget?.usedPositions ?? 0,
        isHoliday: false, // Would need market-holidays import — keep simple for now
      });
    } catch (err) {
      setError(formatApiError(err, 'Failed to load briefing'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchBriefing(); }, [fetchBriefing]);

  return { data, loading, error, refresh: fetchBriefing };
}
