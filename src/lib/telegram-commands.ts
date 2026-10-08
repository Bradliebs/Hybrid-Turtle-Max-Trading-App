/**
 * DEPENDENCIES
 * Consumed by: /api/telegram/webhook/route.ts, /api/telegram/test-command/route.ts
 * Consumes: prisma.ts, market-data.ts, position-sizer.ts, risk-gates.ts, stop-manager.ts
 * Risk-sensitive: NO (read-only queries — never writes to DB or places orders)
 * Last modified: 2026-03-03
 * Notes: Inbound Telegram command handler. Completely separate from telegram.ts
 *        which handles outbound messages only. All responses use HTML parse mode.
 */

import prisma from '@/lib/prisma';
import { getBatchPrices, normalizeBatchPricesToGBP, getMarketRegime } from '@/lib/market-data';
import { calculateRMultiple } from '@/lib/position-sizer';
import { getRiskBudget } from '@/lib/risk-gates';
import { generateStopRecommendations, generateTrailingStopRecommendations } from '@/lib/stop-manager';
import type { RiskProfileType, Sleeve } from '@/types';

// ── Types ──

export type TelegramCommand =
  | '/status'
  | '/positions'
  | '/stopsdue'
  | '/regime'
  | '/risk'
  | '/candidates'
  | '/earnings'
  | '/briefing'
  | '/backtest'
  | '/equity'
  | '/summary'
  | '/help'
  | 'unknown';

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number };
    chat: { id: number };
    text?: string;
    date: number;
  };
}

export interface CommandResponse {
  text: string;
  parseMode: 'HTML';
}

// ── Helpers ──

const DEFAULT_USER_ID = 'default-user';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function currencySymbol(currency: string | null): string {
  const c = (currency ?? 'USD').toUpperCase();
  if (c === 'GBP' || c === 'GBX') return '£';
  if (c === 'EUR') return '€';
  return '$';
}

function getPhaseForDay(day: number): string {
  switch (day) {
    case 0: return 'PLANNING';
    case 1: return 'OBSERVATION';
    case 2: return 'EXECUTION';
    default: return 'MAINTENANCE';
  }
}

// ── Command parsing ──

export function parseCommand(text: string): TelegramCommand {
  const cmd = text.trim().toLowerCase().split(/\s+/)[0];
  switch (cmd) {
    case '/status': return '/status';
    case '/positions': return '/positions';
    case '/stopsdue': case '/stops': return '/stopsdue';
    case '/regime': return '/regime';
    case '/risk': return '/risk';
    case '/candidates': return '/candidates';
    case '/earnings': return '/earnings';
    case '/briefing': return '/briefing';
    case '/backtest': return '/backtest';
    case '/equity': return '/equity';
    case '/summary': case '/portfolio': return '/summary';
    case '/help': case '/start': return '/help';
    default: return 'unknown';
  }
}

// ── Main handler ──

export async function handleCommand(command: TelegramCommand, rawText?: string): Promise<CommandResponse> {
  try {
    switch (command) {
      case '/status': return await cmdStatus();
      case '/positions': return await cmdPositions();
      case '/stopsdue': return await cmdStopsDue();
      case '/regime': return await cmdRegime();
      case '/risk': return await cmdRisk();
      case '/candidates': return await cmdCandidates();
      case '/earnings': return await cmdEarnings();
      case '/briefing': return await cmdBriefing();
      case '/backtest': return await cmdBacktest();
      case '/equity': return await cmdEquity();
      case '/summary': return await cmdSummary();
      case '/help': return cmdHelp();
      case 'unknown':
      default:
        return { text: '❓ Unknown command. Send /help for available commands.', parseMode: 'HTML' };
    }
  } catch (err) {
    console.error(`[telegram-commands] Error handling ${command}:`, err);
    return {
      text: '⚠️ Internal error processing command. Check the dashboard logs.',
      parseMode: 'HTML',
    };
  }
}

// ── /status ──

async function cmdStatus(): Promise<CommandResponse> {
  const now = new Date();
  const phase = getPhaseForDay(now.getDay());

  const [heartbeat, healthCheck, regime, posCount, scanResult] = await Promise.all([
    prisma.heartbeat.findFirst({ orderBy: { timestamp: 'desc' } }),
    prisma.healthCheck.findFirst({
      where: { userId: DEFAULT_USER_ID },
      orderBy: { runDate: 'desc' },
      select: { overall: true },
    }),
    getMarketRegime().catch(() => 'SIDEWAYS' as const),
    prisma.position.count({ where: { userId: DEFAULT_USER_ID, status: 'OPEN' } }),
    prisma.scan.findFirst({
      where: { userId: DEFAULT_USER_ID },
      orderBy: { runDate: 'desc' },
      include: { results: { where: { status: 'READY' }, select: { id: true } } },
    }),
  ]);

  const healthEmoji = healthCheck?.overall === 'GREEN' ? '🟢'
    : healthCheck?.overall === 'YELLOW' ? '🟡' : '🔴';
  const heartbeatAge = heartbeat
    ? Math.round((now.getTime() - heartbeat.timestamp.getTime()) / (1000 * 60 * 60))
    : null;
  const heartbeatStr = heartbeatAge !== null
    ? `${heartbeatAge}h ago ${heartbeat?.status === 'OK' ? '✓' : '⚠️'}`
    : 'Never';

  // Quick stop count
  let stopsCount = 0;
  try {
    const positions = await prisma.position.findMany({
      where: { userId: DEFAULT_USER_ID, status: 'OPEN' },
      include: { stock: { select: { ticker: true } } },
    });
    const tickers = positions.map((p) => p.stock.ticker);
    if (tickers.length > 0) {
      const livePrices = await getBatchPrices(tickers);
      const priceMap = new Map(Object.entries(livePrices));
      const recs = await generateStopRecommendations(DEFAULT_USER_ID, priceMap).catch(() => []);
      const trailing = await generateTrailingStopRecommendations(DEFAULT_USER_ID).catch(() => []);
      // Merge — same logic as /api/stops
      const merged = new Map<string, number>();
      for (const r of recs) merged.set(r.positionId, r.newStop);
      for (const r of trailing) {
        const existing = merged.get(r.positionId);
        if (!existing || r.trailingStop > existing) merged.set(r.positionId, r.trailingStop);
      }
      stopsCount = merged.size;
    }
  } catch { /* best-effort */ }

  const readyCount = scanResult?.results.length ?? 0;

  const text = `${healthEmoji} <b>HybridTurtle Status</b>
Phase: ${phase}
Regime: <b>${regime}</b>
Last nightly: ${heartbeatStr}
Health: ${healthCheck?.overall ?? 'UNKNOWN'}
Open positions: ${posCount}
Stops pending: ${stopsCount}
Ready candidates: ${readyCount}`;

  return { text, parseMode: 'HTML' };
}

// ── /positions ──

async function cmdPositions(): Promise<CommandResponse> {
  const positions = await prisma.position.findMany({
    where: { userId: DEFAULT_USER_ID, status: 'OPEN' },
    include: { stock: { select: { ticker: true, currency: true, sleeve: true } } },
  });

  if (positions.length === 0) {
    return { text: '📊 <b>Open Positions</b>\nNo open positions.', parseMode: 'HTML' };
  }

  const tickers = positions.map((p) => p.stock.ticker);
  const livePrices = await getBatchPrices(tickers);

  // Fetch earnings dates (best-effort, cached)
  let earningsMap = new Map<string, number | null>();
  try {
    const { fetchBatchNewsContext } = await import('@/lib/news-fetcher');
    const newsResults = await fetchBatchNewsContext(tickers, 0);
    for (const n of newsResults) {
      earningsMap.set(n.ticker, n.earnings.daysUntil);
    }
  } catch { /* best-effort */ }

  const lines = positions.map((p) => {
    const price = livePrices[p.stock.ticker] ?? p.entryPrice;
    const rMul = calculateRMultiple(price, p.entryPrice, p.initialRisk);
    const rLabel = rMul >= 0 ? `+${rMul.toFixed(1)}R` : `${rMul.toFixed(1)}R`;
    const pnl = (price - p.entryPrice) * p.shares;
    const pnlPct = p.entryPrice > 0 ? ((price - p.entryPrice) / p.entryPrice * 100) : 0;
    const pnlStr = `${pnl >= 0 ? '+' : ''}${currencySymbol(p.stock.currency)}${Math.abs(pnl).toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`;
    const levelEmoji = p.protectionLevel === 'LOCK_1R_TRAIL' ? '🟢'
      : p.protectionLevel === 'LOCK_08R' ? '🔵'
      : p.protectionLevel === 'TRAILING_ATR' ? '🟣'
      : p.protectionLevel === 'BREAKEVEN' ? '🟡' : '⚪';
    const sym = currencySymbol(p.stock.currency);
    const earningsDays = earningsMap.get(p.stock.ticker);
    const earningsTag = earningsDays != null && earningsDays <= 10
      ? ` 📅${earningsDays}d${earningsDays <= 5 ? '⚠️' : ''}`
      : '';
    return `${levelEmoji} <b>${escapeHtml(p.stock.ticker)}</b>  ${rLabel}  ${pnlStr}\n   Stop: ${sym}${p.currentStop.toFixed(2)} | ${p.protectionLevel ?? 'INITIAL'}${earningsTag}`;
  });

  // Total open risk
  const user = await prisma.user.findUnique({
    where: { id: DEFAULT_USER_ID },
    select: { equity: true, riskProfile: true },
  });
  let riskLine = '';
  if (user) {
    const stockCurrencies: Record<string, string | null> = {};
    for (const p of positions) { stockCurrencies[p.stock.ticker] = p.stock.currency; }
    const gbpPrices = await normalizeBatchPricesToGBP(livePrices, stockCurrencies);
    const enriched = positions.map((p) => {
      const rawPrice = livePrices[p.stock.ticker] ?? p.entryPrice;
      const gbpPrice = gbpPrices[p.stock.ticker] ?? rawPrice;
      const fxRatio = rawPrice > 0 ? gbpPrice / rawPrice : 1;
      return {
        id: p.id, ticker: p.stock.ticker, sleeve: p.stock.sleeve as Sleeve,
        sector: 'X', cluster: 'X', value: gbpPrice * p.shares,
        riskDollars: Math.max(0, (gbpPrice - p.currentStop * fxRatio) * p.shares),
        shares: p.shares, entryPrice: p.entryPrice, currentStop: p.currentStop, currentPrice: rawPrice,
      };
    });
    const budget = getRiskBudget(enriched, user.equity, user.riskProfile as RiskProfileType);
    riskLine = `\nTotal open risk: ${budget.usedRiskPercent.toFixed(1)}%`;
  }

  return {
    text: `📊 <b>Open Positions (${positions.length})</b>\n${lines.join('\n')}${riskLine}`,
    parseMode: 'HTML',
  };
}

// ── /stopsdue ──

async function cmdStopsDue(): Promise<CommandResponse> {
  const positions = await prisma.position.findMany({
    where: { userId: DEFAULT_USER_ID, status: 'OPEN' },
    include: { stock: { select: { ticker: true, currency: true } } },
  });

  if (positions.length === 0) {
    return { text: '🔔 <b>Stops Due</b>\nNo open positions.', parseMode: 'HTML' };
  }

  const tickers = positions.map((p) => p.stock.ticker);
  const livePrices = await getBatchPrices(tickers);
  const priceMap = new Map(Object.entries(livePrices));

  const rBasedRecs = await generateStopRecommendations(DEFAULT_USER_ID, priceMap).catch(() => []);
  const trailingRecs = await generateTrailingStopRecommendations(DEFAULT_USER_ID).catch(() => []);

  // Merge — keep highest per position
  const merged = new Map<string, { ticker: string; currentStop: number; newStop: number; level: string; currency: string }>();
  for (const r of rBasedRecs) {
    const pos = positions.find((p) => p.id === r.positionId);
    merged.set(r.positionId, {
      ticker: r.ticker, currentStop: r.currentStop, newStop: r.newStop,
      level: r.newLevel, currency: pos?.stock.currency ?? 'USD',
    });
  }
  for (const r of trailingRecs) {
    const existing = merged.get(r.positionId);
    if (!existing || r.trailingStop > existing.newStop) {
      merged.set(r.positionId, {
        ticker: r.ticker, currentStop: r.currentStop, newStop: r.trailingStop,
        level: 'TRAILING_ATR', currency: r.priceCurrency,
      });
    }
  }

  // Filter out same-value recs (floating-point edge cases)
  const filtered = new Map(
    Array.from(merged.entries()).filter(([, r]) => {
      const roundedNew = Math.round(r.newStop * 100) / 100;
      const roundedCurrent = Math.round(r.currentStop * 100) / 100;
      return roundedNew > roundedCurrent;
    })
  );

  if (filtered.size === 0) {
    return { text: '🔔 <b>Stops Due</b>\n✅ All stops up to date.', parseMode: 'HTML' };
  }

  const lines = Array.from(filtered.values()).map((r) => {
    const sym = currencySymbol(r.currency);
    return `${escapeHtml(r.ticker)}: Move stop ${sym}${r.currentStop.toFixed(2)} → ${sym}${r.newStop.toFixed(2)} (${r.level})`;
  });

  return {
    text: `🔔 <b>Stops Due (${filtered.size})</b>\n${lines.join('\n')}\n\n<i>Apply stops in the dashboard → /portfolio/positions</i>`,
    parseMode: 'HTML',
  };
}

// ── /regime ──

async function cmdRegime(): Promise<CommandResponse> {
  const regime = await getMarketRegime().catch(() => 'SIDEWAYS' as const);

  // Fear & Greed — best-effort from last known store value
  // (Not easily available server-side without an extra fetch, so omit if not cached)

  const text = `📈 <b>Market Regime</b>
Overall: <b>${regime}</b>

<i>Dual benchmark: SPY + VWRL must both be bullish for BULLISH confirmation. 3-day stability required.</i>`;

  return { text, parseMode: 'HTML' };
}

// ── /risk ──

async function cmdRisk(): Promise<CommandResponse> {
  const user = await prisma.user.findUnique({
    where: { id: DEFAULT_USER_ID },
    select: { equity: true, riskProfile: true },
  });

  if (!user) {
    return { text: '💰 <b>Risk Budget</b>\nUser not found.', parseMode: 'HTML' };
  }

  const positions = await prisma.position.findMany({
    where: { userId: DEFAULT_USER_ID, status: 'OPEN' },
    include: { stock: true },
  });

  const tickers = positions.map((p) => p.stock.ticker);
  const livePrices = tickers.length > 0 ? await getBatchPrices(tickers) : {};
  const stockCurrencies: Record<string, string | null> = {};
  for (const p of positions) { stockCurrencies[p.stock.ticker] = p.stock.currency; }
  const gbpPrices = tickers.length > 0
    ? await normalizeBatchPricesToGBP(livePrices, stockCurrencies)
    : {};

  const enriched = positions.map((p) => {
    const rawPrice = livePrices[p.stock.ticker] ?? p.entryPrice;
    const gbpPrice = gbpPrices[p.stock.ticker] ?? rawPrice;
    const fxRatio = rawPrice > 0 ? gbpPrice / rawPrice : 1;
    return {
      id: p.id, ticker: p.stock.ticker, sleeve: p.stock.sleeve as Sleeve,
      sector: p.stock.sector ?? 'X', cluster: p.stock.cluster ?? 'X',
      value: gbpPrice * p.shares,
      riskDollars: Math.max(0, (gbpPrice - p.currentStop * fxRatio) * p.shares),
      shares: p.shares, entryPrice: p.entryPrice, currentStop: p.currentStop, currentPrice: rawPrice,
    };
  });

  const budget = getRiskBudget(enriched, user.equity, user.riskProfile as RiskProfileType);

  const sleeveLines = Object.entries(budget.sleeveUtilization)
    .filter(([sleeve]) => sleeve !== 'HEDGE')
    .map(([sleeve, { used, max }]) => `  ${sleeve}: ${used.toFixed(0)}% / ${max.toFixed(0)}%`)
    .join('\n');

  const text = `💰 <b>Risk Budget</b>
Profile: ${user.riskProfile}
Open risk: ${budget.usedRiskPercent.toFixed(1)}% / ${budget.maxRiskPercent.toFixed(1)}%
Positions: ${budget.usedPositions} / ${budget.maxPositions} max
Sleeve usage:
${sleeveLines}`;

  return { text, parseMode: 'HTML' };
}

// ── /candidates ──

async function cmdCandidates(): Promise<CommandResponse> {
  // Use snapshot data for candidates (same source as cross-ref)
  const latestSnapshot = await prisma.snapshot.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true },
  });

  if (!latestSnapshot) {
    return { text: '🎯 <b>Ready Candidates</b>\nNo snapshot data. Run the nightly pipeline first.', parseMode: 'HTML' };
  }

  const heldTickers = new Set(
    (await prisma.position.findMany({
      where: { userId: DEFAULT_USER_ID, status: 'OPEN' },
      select: { stock: { select: { ticker: true } } },
    })).map((p) => p.stock.ticker)
  );

  const candidates = await prisma.snapshotTicker.findMany({
    where: {
      snapshotId: latestSnapshot.id,
      status: { in: ['READY', 'WATCH'] },
    },
    orderBy: { distanceTo20dHighPct: 'asc' },
    take: 20,
  });

  // Filter: not held, trigger met, ADX ok
  const ready = candidates
    .filter((r) => !heldTickers.has(r.ticker) && r.close >= r.entryTrigger && r.entryTrigger > 0 && r.adx14 >= 20)
    .slice(0, 5);

  if (ready.length === 0) {
    const ageHours = Math.round((Date.now() - latestSnapshot.createdAt.getTime()) / (1000 * 60 * 60));
    return {
      text: `🎯 <b>Ready Candidates</b>\nNo trigger-met candidates.\nLast snapshot: ${ageHours}h ago`,
      parseMode: 'HTML',
    };
  }

  const lines = ready.map((r) => {
    const sym = currencySymbol(r.currency);
    return `<b>${escapeHtml(r.ticker)}</b>  ${sym}${r.close.toFixed(2)}  ADX: ${r.adx14.toFixed(0)}  Stop: ${sym}${r.stopLevel.toFixed(2)}`;
  });

  const ageHours = Math.round((Date.now() - latestSnapshot.createdAt.getTime()) / (1000 * 60 * 60));

  return {
    text: `🎯 <b>Ready Candidates (${ready.length})</b>\n${lines.join('\n')}\nLast snapshot: ${ageHours}h ago`,
    parseMode: 'HTML',
  };
}

// ── /briefing — on-demand session briefing ──

async function cmdBriefing(): Promise<CommandResponse> {
  try {
    const { getUKHour } = await import('@/lib/uk-time');
    const { isTodayMarketHoliday, isEarlyCloseDay } = await import('@/lib/market-holidays');

    const ukHour = getUKHour();
    const { isHoliday, holiday } = isTodayMarketHoliday();
    const earlyClose = isEarlyCloseDay();

    // Determine which session we're in
    const session = ukHour < 8 ? 'pre-UK' : ukHour < 14 ? 'UK' : ukHour < 20 ? 'US' : 'post-market';

    const [regime, user, positions, latestScan] = await Promise.all([
      getMarketRegime().catch(() => 'UNKNOWN' as const),
      prisma.user.findUnique({
        where: { id: DEFAULT_USER_ID },
        select: { riskProfile: true, equity: true, operatingMode: true },
      }),
      prisma.position.findMany({
        where: { userId: DEFAULT_USER_ID, status: 'OPEN' },
        include: { stock: { select: { ticker: true, sleeve: true } } },
      }),
      prisma.scan.findFirst({
        where: { userId: DEFAULT_USER_ID },
        orderBy: { runDate: 'desc' },
        select: { id: true },
      }),
    ]);

    const equity = user?.equity || 0;
    const riskProfile = (user?.riskProfile || 'BALANCED') as RiskProfileType;

    const budget = getRiskBudget(
      positions.map(p => ({
        id: p.id,
        ticker: p.stock.ticker,
        sleeve: (p.stock.sleeve || 'CORE') as Sleeve,
        sector: 'Unknown',
        cluster: 'General',
        value: p.shares * p.entryPrice,
        riskDollars: p.shares * (p.entryPrice - p.currentStop),
        shares: p.shares,
        entryPrice: p.entryPrice,
        currentStop: p.currentStop,
        currentPrice: p.entryPrice,
      })),
      equity,
      riskProfile
    );

    // Get session-appropriate candidates
    const isUKSession = session === 'pre-UK' || session === 'UK';
    const candidates = latestScan
      ? await prisma.scanResult.findMany({
          where: {
            status: 'READY',
            scanId: latestScan.id,
            stock: { ticker: isUKSession ? { endsWith: '.L' } : { not: { endsWith: '.L' } } },
          },
          select: { entryTrigger: true, price: true, stock: { select: { ticker: true, sleeve: true } } },
          orderBy: { rankScore: 'desc' },
          take: 5,
        })
      : [];

    const regimeEmoji = regime === 'BULLISH' ? '🟢' : regime === 'SIDEWAYS' ? '🟡' : regime === 'BEARISH' ? '🔴' : '⚪';
    const flag = isUKSession ? '🇬🇧' : '🇺🇸';

    const lines = [
      `${flag} <b>${session} Session Briefing</b>`,
      '',
    ];

    if (isHoliday) lines.push(`🚫 Market Holiday: ${holiday?.label}`, '');
    if (earlyClose) lines.push(`📅 Early close: ${earlyClose} ET`, '');

    lines.push(`${regimeEmoji} Regime: ${regime} | Risk: ${budget.usedRiskPercent.toFixed(1)}%/${budget.maxRiskPercent}%`);
    lines.push(`Positions: ${budget.usedPositions}/${budget.maxPositions} | Mode: ${user?.operatingMode || 'NORMAL'}`);
    lines.push('');

    if (candidates.length > 0) {
      lines.push(`<b>READY (${candidates.length})</b>`);
      for (const c of candidates) {
        lines.push(`  📌 ${c.stock.ticker} — ${c.price.toFixed(2)} → ${c.entryTrigger.toFixed(2)}`);
      }
    } else {
      lines.push(`No ${isUKSession ? 'UK' : 'US'} READY candidates.`);
    }

    if (regime !== 'BULLISH') lines.push('', '⚠ Regime not BULLISH — buying blocked.');
    if (budget.availableRiskPercent <= 0) lines.push('⚠ Risk budget full.');

    return { text: lines.join('\n'), parseMode: 'HTML' };
  } catch (err) {
    return { text: `❌ Briefing failed: ${(err as Error).message}`, parseMode: 'HTML' };
  }
}

// ── /backtest — latest backtest results ──

async function cmdBacktest(): Promise<CommandResponse> {
  try {
    const scoreboard = await (await import('@/lib/profit-scoreboard')).computeProfitScoreboard();

    const lines = [
      `📈 <b>System Performance</b>`,
      '',
      `Evidence: <b>${scoreboard.verdict}</b> — ${scoreboard.verdictReason}`,
      `Trades: ${scoreboard.totalClosedTrades} closed`,
      '',
    ];

    if (scoreboard.totalClosedTrades > 0) {
      lines.push(`Win rate: ${scoreboard.winRate.toFixed(0)}%`);
      lines.push(`Avg win: +${scoreboard.avgWinR.toFixed(1)}R | Avg loss: ${scoreboard.avgLossR.toFixed(1)}R`);
      lines.push(`Expectancy: ${scoreboard.expectancyPerTrade >= 0 ? '+' : ''}${scoreboard.expectancyPerTrade.toFixed(2)}R/trade`);
      if (scoreboard.profitFactor) lines.push(`Profit factor: ${scoreboard.profitFactor.toFixed(2)}`);
      lines.push(`Max drawdown: ${scoreboard.maxDrawdownPct.toFixed(1)}%`);
      if (scoreboard.avgHoldDays) lines.push(`Avg hold: ${scoreboard.avgHoldDays.toFixed(0)} days`);
    } else {
      lines.push('No closed trades yet — performance data will appear after your first exit.');
    }

    if (scoreboard.sampleSizeWarning) {
      lines.push('', `⚠ ${scoreboard.sampleSizeWarning}`);
    }

    // Equity trend (last 7 snapshots)
    const snapshots = await prisma.equitySnapshot.findMany({
      orderBy: { capturedAt: 'desc' },
      take: 7,
      select: { equity: true, capturedAt: true },
    });

    if (snapshots.length >= 2) {
      const latest = snapshots[0].equity;
      const oldest = snapshots[snapshots.length - 1].equity;
      const change = latest - oldest;
      const changePct = oldest > 0 ? (change / oldest) * 100 : 0;
      lines.push('', `<b>Equity (${snapshots.length}d)</b>`);
      lines.push(`£${latest.toFixed(2)} (${change >= 0 ? '+' : ''}£${change.toFixed(2)}, ${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%)`);
    }

    return { text: lines.join('\n'), parseMode: 'HTML' };
  } catch (err) {
    return { text: `❌ Backtest failed: ${(err as Error).message}`, parseMode: 'HTML' };
  }
}

// ── /equity — quick equity + trend ──

async function cmdEquity(): Promise<CommandResponse> {
  try {
    const snapshots = await prisma.equitySnapshot.findMany({
      orderBy: { capturedAt: 'desc' },
      take: 14,
      select: { equity: true, capturedAt: true, openRiskPercent: true },
    });

    if (snapshots.length === 0) {
      return { text: '💰 <b>Equity</b>\nNo equity snapshots recorded yet.', parseMode: 'HTML' };
    }

    const current = snapshots[0];
    const weekAgo = snapshots.find(s =>
      (Date.now() - s.capturedAt.getTime()) >= 6 * 24 * 60 * 60 * 1000
    );

    const lines = [
      `💰 <b>Equity — £${current.equity.toFixed(2)}</b>`,
      '',
    ];

    if (current.openRiskPercent !== null) {
      lines.push(`Open risk: ${current.openRiskPercent.toFixed(1)}%`);
    }

    if (weekAgo) {
      const change = current.equity - weekAgo.equity;
      const pct = weekAgo.equity > 0 ? (change / weekAgo.equity) * 100 : 0;
      lines.push(`7d change: ${change >= 0 ? '+' : '-'}£${Math.abs(change).toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`);
    }

    // Mini sparkline: last 7 values
    const recent = snapshots.slice(0, 7).reverse();
    if (recent.length >= 3) {
      const min = Math.min(...recent.map(s => s.equity));
      const max = Math.max(...recent.map(s => s.equity));
      const range = max - min || 1;
      const bars = recent.map(s => {
        const level = Math.round(((s.equity - min) / range) * 4);
        return ['▁', '▂', '▃', '▅', '█'][level] || '▃';
      });
      lines.push(`Trend: ${bars.join('')}`);
    }

    lines.push('', `<i>Last snapshot: ${current.capturedAt.toISOString().split('T')[0]}</i>`);

    return { text: lines.join('\n'), parseMode: 'HTML' };
  } catch (err) {
    return { text: `❌ Equity failed: ${(err as Error).message}`, parseMode: 'HTML' };
  }
}

// ── /summary — compact mobile portfolio overview ──

async function cmdSummary(): Promise<CommandResponse> {
  try {
    const [user, positions, regime] = await Promise.all([
      prisma.user.findUnique({ where: { id: DEFAULT_USER_ID }, select: { equity: true, riskProfile: true, operatingMode: true } }),
      prisma.position.findMany({ where: { userId: DEFAULT_USER_ID, status: 'OPEN' }, include: { stock: { select: { ticker: true, currency: true } } } }),
      getMarketRegime().catch(() => 'UNKNOWN' as const),
    ]);

    const equity = user?.equity ?? 0;
    const tickers = positions.map(p => p.stock.ticker);
    const prices = tickers.length > 0 ? await getBatchPrices(tickers) : {};

    let totalPnl = 0;
    const posLines: string[] = [];
    for (const p of positions) {
      const price = prices[p.stock.ticker] ?? p.entryPrice;
      const pnl = (price - p.entryPrice) * p.shares;
      const rMul = calculateRMultiple(price, p.entryPrice, p.initialRisk);
      totalPnl += pnl;
      const emoji = rMul >= 2 ? '🟢' : rMul >= 0 ? '🔵' : '🔴';
      posLines.push(`${emoji} ${p.stock.ticker} ${rMul >= 0 ? '+' : ''}${rMul.toFixed(1)}R`);
    }

    const regimeEmoji = regime === 'BULLISH' ? '🟢' : regime === 'SIDEWAYS' ? '🟡' : '🔴';

    const lines = [
      `📱 <b>Portfolio Summary</b>`,
      `${regimeEmoji} ${regime} | £${equity.toFixed(0)} | ${positions.length} pos`,
      '',
    ];

    if (posLines.length > 0) {
      lines.push(posLines.join(' | '));
      lines.push('');
      lines.push(`P&L: ${totalPnl >= 0 ? '+' : '-'}£${Math.abs(totalPnl).toFixed(2)}`);
    } else {
      lines.push('No open positions');
    }

    return { text: lines.join('\n'), parseMode: 'HTML' };
  } catch (err) {
    return { text: `❌ Summary failed: ${(err as Error).message}`, parseMode: 'HTML' };
  }
}

// ── /help ──

function cmdHelp(): CommandResponse {
  return {
    text: `🐢 <b>HybridTurtle Commands</b>
/status — system overview
/positions — open positions
/stopsdue — pending stop updates (also /stops)
/regime — market regime detail
/risk — risk budget
/candidates — ready candidates
/briefing — current session briefing
/backtest — system performance grade
/equity — equity + P&L trend
/summary — compact portfolio overview
/earnings — earnings calendar for holdings
/help — this message`,
    parseMode: 'HTML',
  };
}

// ── /earnings — earnings calendar for all open positions ──

async function cmdEarnings(): Promise<CommandResponse> {
  try {
    const positions = await prisma.position.findMany({
      where: { userId: DEFAULT_USER_ID, status: 'OPEN' },
      select: { stock: { select: { ticker: true } } },
    });

    if (positions.length === 0) {
      return {
        text: '📅 <b>Earnings Calendar</b>\n\nNo open positions to check.',
        parseMode: 'HTML',
      };
    }

    const tickers = positions.map(p => p.stock.ticker);
    const { fetchBatchNewsContext } = await import('@/lib/news-fetcher');
    const results = await fetchBatchNewsContext(tickers, 0); // 0 headlines — only earnings

    const lines: string[] = [];
    const alerts: string[] = [];

    for (const r of results) {
      if (r.earnings.nextEarningsDate) {
        const dateStr = new Date(r.earnings.nextEarningsDate).toLocaleDateString('en-GB', {
          day: 'numeric', month: 'short',
        });
        const days = r.earnings.daysUntil ?? 99;
        const warn = days <= 5 ? ' ⚠️' : days <= 10 ? ' ⏰' : '';
        const est = r.earnings.isEstimate ? ' (est)' : '';
        lines.push(`${warn ? warn + ' ' : ''}  <b>${escapeHtml(r.ticker)}</b>: ${dateStr} (${days}d)${est}`);
        if (days <= 5) alerts.push(r.ticker);
      } else {
        lines.push(`  <b>${escapeHtml(r.ticker)}</b>: no date announced`);
      }
    }

    // Sort by days-until (soonest first)
    lines.sort();

    const alertLine = alerts.length > 0
      ? `\n\n🔴 <b>Event Risk:</b> ${alerts.join(', ')} — earnings within 5 days`
      : '';

    return {
      text: `📅 <b>Earnings Calendar</b> (${tickers.length} positions)\n\n${lines.join('\n')}${alertLine}`,
      parseMode: 'HTML',
    };
  } catch (err) {
    console.error('[telegram-commands] /earnings error:', err);
    return {
      text: '📅 <b>Earnings Calendar</b>\n\n⚠️ Error checking earnings. Yahoo may be unreachable.',
      parseMode: 'HTML',
    };
  }
}
