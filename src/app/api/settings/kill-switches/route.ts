/**
 * DEPENDENCIES
 * Consumed by: src/components/settings/SafetyControlsPanel.tsx
 * Consumes: packages/workflow/src/index.ts, src/lib/api-response.ts, src/lib/request-validation.ts
 * Risk-sensitive: YES — updates live safety controls that can block scans and submissions
 * Last modified: 2026-03-09
 * Notes: Dedicated Phase 10 kill-switch API.
 */
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError } from '@/lib/api-response';
import { parseJsonBody } from '@/lib/request-validation';
import { getKillSwitchSettings, getMarketDataSafetyStatus, updateKillSwitchSettings } from '../../../../../packages/workflow/src';

const killSwitchPatchSchema = z.object({
  disableAllSubmissions: z.boolean().optional(),
  disableAutomatedSubmissions: z.boolean().optional(),
  disableScansWhenDataStale: z.boolean().optional(),
  enableAutoTrading: z.boolean().optional(),
  etfOnlyAutoTrading: z.boolean().optional(),
});

export async function GET() {
  try {
    const [settings, marketData] = await Promise.all([
      getKillSwitchSettings(),
      getMarketDataSafetyStatus(),
    ]);

    return NextResponse.json({ settings, marketData });
  } catch (error) {
    console.error('GET /api/settings/kill-switches error:', error);
    return apiError(500, 'KILL_SWITCH_FETCH_FAILED', 'Failed to fetch kill-switch settings', (error as Error).message, true);
  }
}

export async function PATCH(request: NextRequest) {
  const parsed = await parseJsonBody(request, killSwitchPatchSchema);
  if (!parsed.ok) {
    return parsed.response;
  }

  try {
    const settings = await updateKillSwitchSettings(parsed.data);
    const marketData = await getMarketDataSafetyStatus();
    return NextResponse.json({ settings, marketData });
  } catch (error) {
    console.error('PATCH /api/settings/kill-switches error:', error);
    return apiError(500, 'KILL_SWITCH_SAVE_FAILED', 'Failed to save kill-switch settings', (error as Error).message, true);
  }
}