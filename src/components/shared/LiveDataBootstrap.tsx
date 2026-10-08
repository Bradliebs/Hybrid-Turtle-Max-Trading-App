'use client';

import { useEffect } from 'react';
import { useStore } from '@/store/useStore';
import { apiRequest } from '@/lib/api-client';
import type { HealthStatus, MarketRegime, RiskProfileType } from '@/types';

const DEFAULT_USER_ID = 'default-user';

export default function LiveDataBootstrap() {
  const { setHealthStatus, setHeartbeat, setHeartbeatStatus, setMarketRegime, setRiskProfile, setEquity } = useStore();

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const data = await apiRequest<{ riskProfile?: RiskProfileType; equity?: number }>(`/api/settings?userId=${DEFAULT_USER_ID}`);
        if (data?.riskProfile) setRiskProfile(data.riskProfile);
        if (data?.equity) setEquity(data.equity);
      } catch {
        // Silent fail on bootstrap
      }
    };

    const fetchHealth = async () => {
      try {
        const data = await apiRequest<{ overall?: HealthStatus }>(`/api/health-check?userId=${DEFAULT_USER_ID}`);
        if (data?.overall) {
          setHealthStatus(data.overall);
        }
      } catch {
        // Silent fail on bootstrap
      }
    };

    const recordHeartbeat = async () => {
      try {
        const data = await apiRequest<{ lastHeartbeat?: string }>('/api/heartbeat', { method: 'POST' });
        if (data?.lastHeartbeat) {
          setHeartbeat(new Date(data.lastHeartbeat));
        }
      } catch {
        // Silent fail
      }
    };

    const fetchHeartbeat = async () => {
      try {
        const data = await apiRequest<{ lastHeartbeat?: string; status?: string }>('/api/heartbeat');
        if (data?.lastHeartbeat) {
          setHeartbeat(new Date(data.lastHeartbeat));
        }
        if (data?.status === 'SUCCESS' || data?.status === 'PARTIAL' || data?.status === 'FAILED') {
          setHeartbeatStatus(data.status);
        }
      } catch {
        // Silent fail on bootstrap
      }
    };

    const fetchRegime = async () => {
      try {
        const data = await apiRequest<{ regime?: MarketRegime }>('/api/market-data?action=regime');
        if (data?.regime) {
          setMarketRegime(data.regime);
        }
      } catch {
        // Silent fail on bootstrap
      }
    };

    // Fetch once on mount — no auto-polling (dashboard is checked 1-2× daily)
    fetchSettings();
    recordHeartbeat();
    fetchHealth();
    fetchRegime();
  }, [setHealthStatus, setHeartbeat, setHeartbeatStatus, setMarketRegime, setRiskProfile, setEquity]);

  return null;
}
