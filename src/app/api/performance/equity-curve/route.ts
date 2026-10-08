/**
 * Equity curve API — returns broker-sourced equity snapshots for chart display.
 * Consumed by the EquityCurveChart dashboard component.
 *
 * Only `source = 'BROKER'` rows are returned. Nightly-sourced snapshots are
 * derived from User.equity and can be stale or contain the seed-default
 * £10000 before the user's first broker sync; they must not appear in the
 * user-facing curve. See migration 20260517120000_add_equity_snapshot_source.
 */
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { ensureDefaultUser } from '@/lib/default-user';
import { computeCapitalAdjustedDrawdown, fromFirstBrokerSnapshot, loadCapitalEvents } from '@/lib/capital-adjusted-drawdown';

export async function GET(request: NextRequest) {
  try {
    const userId = request.nextUrl.searchParams.get('userId') || await ensureDefaultUser();
    const days = parseInt(request.nextUrl.searchParams.get('days') || '90', 10);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [snapshots, history, capitalEvents] = await Promise.all([
      prisma.equitySnapshot.findMany({
        where: { userId, capturedAt: { gte: since }, source: 'BROKER' },
        orderBy: { capturedAt: 'asc' },
        select: { equity: true, openRiskPercent: true, capturedAt: true },
      }),
      // Full daily history for the drawdown index (BROKER rows alone are weeks apart,
      // which smears cash movements and hides recent losses).
      prisma.equitySnapshot.findMany({
        where: { userId },
        orderBy: { capturedAt: 'asc' },
        select: { equity: true, capturedAt: true, source: true },
      }),
      loadCapitalEvents(),
    ]);

    // Drawdown from the capital-adjusted performance peak (withdrawals are not losses).
    // Rows before the first broker sync can hold the seed-default equity, so start there.
    const indexed = fromFirstBrokerSnapshot(history);
    const { series } = computeCapitalAdjustedDrawdown(indexed, capitalEvents);
    const drawdownAt = (time: number) => {
      let value = 0;
      for (const point of series) {
        if (point.capturedAt.getTime() > time) break;
        value = point.drawdownPct;
      }
      return value;
    };
    const inWindow = series.filter(point => point.capturedAt >= since);
    const latest = series.at(-1);
    const data = snapshots.map(s => {
      const drawdownPct = drawdownAt(s.capturedAt.getTime());
      return {
        date: s.capturedAt.toISOString().split('T')[0],
        equity: Math.round(s.equity * 100) / 100,
        openRiskPct: s.openRiskPercent !== null ? Math.round(s.openRiskPercent * 10) / 10 : null,
        drawdownPct: Math.round(drawdownPct * 10) / 10,
      };
    });

    // Summary stats
    const first = data[0]?.equity ?? 0;
    const last = data[data.length - 1]?.equity ?? 0;
    const change = last - first;
    const changePct = first > 0 ? (change / first) * 100 : 0;
    const maxDrawdown = inWindow.length > 0 ? Math.max(...inWindow.map(point => point.drawdownPct)) : 0;
    // Split the equity change into cash moved in/out and the result of trading.
    const firstTime = snapshots[0]?.capturedAt.getTime() ?? 0;
    const lastTime = snapshots.at(-1)?.capturedAt.getTime() ?? 0;
    const netCashFlow = capitalEvents
      .filter(event => Date.parse(event.at) > firstTime && Date.parse(event.at) <= lastTime)
      .reduce((sum, event) => sum + event.amount, 0);
    const indexAt = (time: number) => {
      let value: number | null = null;
      for (const point of series) {
        if (point.capturedAt.getTime() > time) break;
        value = point.index;
      }
      return value;
    };
    const startIndex = indexAt(firstTime);
    const endIndex = indexAt(lastTime);
    const tradingChangePct = startIndex && endIndex ? (endIndex / startIndex - 1) * 100 : changePct;

    return NextResponse.json({
      data,
      summary: {
        startEquity: first,
        currentEquity: last,
        change: Math.round(change * 100) / 100,
        changePct: Math.round(changePct * 10) / 10,
        netCashFlow: Math.round(netCashFlow * 100) / 100,
        tradingChange: Math.round((change - netCashFlow) * 100) / 100,
        tradingChangePct: Math.round(tradingChangePct * 10) / 10,
        maxDrawdownPct: Math.round(maxDrawdown * 10) / 10,
        currentDrawdownPct: latest ? Math.round(latest.drawdownPct * 10) / 10 : 0,
        /** Equity change includes deposits and withdrawals; drawdown figures exclude them. */
        capitalEventsRecorded: capitalEvents.length,
        snapshotCount: data.length,
        days,
      },
    });
  } catch (error) {
    console.error('Equity curve error:', error);
    return NextResponse.json({ data: [], summary: null, error: (error as Error).message }, { status: 500 });
  }
}
