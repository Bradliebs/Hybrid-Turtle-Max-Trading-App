'use client';

/**
 * DEPENDENCIES
 * Consumed by: src/app/settings/page.tsx
 * Consumes: /api/settings/kill-switches, src/lib/api-client.ts, src/lib/utils.ts
 * Risk-sensitive: YES — edits live safety controls that block scans and submissions
 * Last modified: 2026-03-09
 * Notes: Phase 10 safety toggle panel.
 */
import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, Loader2 } from 'lucide-react';
import { apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import type { KillSwitchSettings, MarketDataSafetyStatus } from '../../../packages/workflow/src';

interface KillSwitchResponse {
  settings: KillSwitchSettings;
  marketData: MarketDataSafetyStatus;
}

function ToggleRow(props: {
  label: string;
  description: string;
  checked: boolean;
  saving: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-surface-2 p-4">
      <div>
        <div className="text-sm font-semibold text-foreground">{props.label}</div>
        <div className="mt-1 text-xs text-muted-foreground">{props.description}</div>
      </div>
      <button
        type="button"
        onClick={props.onToggle}
        disabled={props.saving}
        className={cn(
          'relative inline-flex h-7 w-12 items-center rounded-full border transition-colors',
          props.checked ? 'border-loss/40 bg-loss/25' : 'border-border bg-navy-700',
          props.saving && 'opacity-60 cursor-not-allowed',
        )}
      >
        <span
          className={cn(
            'inline-block h-5 w-5 transform rounded-full bg-white transition-transform',
            props.checked ? 'translate-x-6' : 'translate-x-1',
          )}
        />
      </button>
    </div>
  );
}

export default function SafetyControlsPanel() {
  const [settings, setSettings] = useState<KillSwitchSettings | null>(null);
  const [marketData, setMarketData] = useState<MarketDataSafetyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<keyof Omit<KillSwitchSettings, 'updatedAt'> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest<KillSwitchResponse>('/api/settings/kill-switches');
      setSettings(data.settings);
      setMarketData(data.marketData);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const updateSwitch = useCallback(async (key: keyof Omit<KillSwitchSettings, 'updatedAt'>) => {
    if (!settings) {
      return;
    }

    setSavingKey(key);
    try {
      const data = await apiRequest<KillSwitchResponse>('/api/settings/kill-switches', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: !settings[key] }),
      });
      setSettings(data.settings);
      setMarketData(data.marketData);
    } finally {
      setSavingKey(null);
    }
  }, [settings]);

  return (
    <div className="card-surface p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-loss" />
            Safety Controls
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Phase 10 kill switches. These block scans and submissions without changing any sacred trading logic.
          </p>
        </div>
        {loading ? <Loader2 className="w-4 h-4 animate-spin text-primary-400" /> : null}
      </div>

      {settings ? (
        <div className="space-y-3">
          <ToggleRow
            label="Disable all submissions"
            description="Hard stop on every order submission path, including manual execution and workflow-driven submission."
            checked={settings.disableAllSubmissions}
            saving={savingKey === 'disableAllSubmissions'}
            onToggle={() => updateSwitch('disableAllSubmissions')}
          />
          <ToggleRow
            label="Disable automated submissions only"
            description="Blocks workflow and script-driven submissions while leaving manual user execution available."
            checked={settings.disableAutomatedSubmissions}
            saving={savingKey === 'disableAutomatedSubmissions'}
            onToggle={() => updateSwitch('disableAutomatedSubmissions')}
          />
          <ToggleRow
            label="Disable scans when data is stale"
            description="Suppresses new scan runs whenever stale market data is detected, matching the safe-failure rule in the build order."
            checked={settings.disableScansWhenDataStale}
            saving={savingKey === 'disableScansWhenDataStale'}
            onToggle={() => updateSwitch('disableScansWhenDataStale')}
          />

          <div className="mt-4 pt-4 border-t border-border">
            <div className="mb-3 text-sm font-semibold text-foreground">Automated Trading</div>
            <ToggleRow
              label="Enable auto-trading"
              description="When ON, the system will automatically scan for candidates, place buy orders, and set protective stops on the scheduled session times. Requires Trading 212 to be connected."
              checked={settings.enableAutoTrading}
              saving={savingKey === 'enableAutoTrading'}
              onToggle={() => updateSwitch('enableAutoTrading')}
            />
            <div className="mt-3">
              <ToggleRow
                label="ETF-only auto-trading"
                description="When ON, scheduled sessions only buy ETFs. Stocks are still scanned and graded, and any A-grade stock that is skipped is listed as 'ETF-only mode' in the Telegram summary. Manual buys and existing positions are not affected."
                checked={settings.etfOnlyAutoTrading}
                saving={savingKey === 'etfOnlyAutoTrading'}
                onToggle={() => updateSwitch('etfOnlyAutoTrading')}
              />
            </div>
          </div>

          <div className="rounded-lg border border-border bg-navy-800/50 px-4 py-3 text-xs text-muted-foreground">
            <div>
              Market data status: <span className={cn(marketData?.isStale ? 'text-loss' : 'text-profit')}>{marketData?.isStale ? 'STALE' : 'FRESH'}</span>
            </div>
            <div>{marketData?.staleSymbolCount ?? 0} stale symbol(s) flagged</div>
            <div>Latest refresh: {marketData?.latestRefreshStatus ?? 'UNKNOWN'}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}