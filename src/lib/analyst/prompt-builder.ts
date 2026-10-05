/**
 * DEPENDENCIES
 * Consumed by: analyst-service.ts
 * Consumes: safety-filter.ts (stripSensitiveData)
 * Risk-sensitive: NO — pure string assembly, no side effects
 * Notes: Assembles structured prompts from system data for Ollama.
 *        Never includes credentials, API keys, or broker tokens.
 *        All data must be passed in — never fetches from DB directly.
 */

import { stripSensitiveData } from './safety-filter';
import { ATR_TRAILING_MULTIPLIER } from '@/types';

// ── System prompt (constant across all requests) ──

const ANALYST_SYSTEM_PROMPT = `You are a read-only trading analyst assistant for the HybridTurtle systematic trend-following system.

HARD RULES — you must NEVER:
- Tell the user to buy or sell any stock
- Suggest changing stop levels
- Recommend overriding risk gates or safety controls
- Invent numbers, prices, or statistics not provided in the data context
- Claim to have access to real-time data
- Pretend to be a financial advisor

YOUR JOB:
- Explain the current system state in plain English
- Summarise scan results, stop levels, and risk metrics
- Explain why trades are allowed or blocked
- Help beginners understand what the dashboard is showing
- Draft trade journal entries based on provided position data
- Flag anything that looks unusual in the data

STYLE:
- Be concise — 2-4 paragraphs for summaries, 1-2 sentences for explanations
- Use plain English, not jargon
- Reference specific numbers from the data context
- Start with the most important information
- End with any warnings or things to watch

DISCLAIMER: Always remind the user that your analysis is advisory only and they should verify against the dashboard.`;

// ── Prompt template types ──

export interface SystemSummaryData {
  decision: string;
  headline: string;
  explanation: string;
  phase: string;
  regime: string;
  operatingMode: string;
  healthOverall: string;
  heartbeatAgeHours: number;
  scanAgeHours: number;
  openPositionCount: number;
  maxPositions: number;
  openRiskPct: number;
  maxOpenRisk: number;
  readyCandidateCount: number;
  triggerMetCount: number;
  stopsPending: number;
  laggardCount: number;
  pyramidCount: number;
  killSwitchActive: boolean;
  autoTradingEnabled: boolean;
  t212Connected: boolean;
  dataStale: boolean;
  blockers: Array<{ code: string; label: string; severity: string }>;
  equity?: number;
  riskProfile?: string;
}

export interface CandidateExplainData {
  ticker: string;
  name: string;
  status: string;
  price: number;
  entryTrigger: number;
  distancePercent: number;
  sleeve: string;
  sector: string;
  cluster: string;
  adx: number;
  atrPercent: number;
  efficiency: number;
  ma200: number;
  riskPerShare: number;
  positionSize: number;
  bqs?: number;
  fws?: string;
  ncs?: number;
  grade?: string;
  gateResults?: Array<{ gate: string; passed: boolean; reason?: string }>;
  stage6Reason?: string;
  entryMode?: string;
}

export interface StopExplainData {
  ticker: string;
  entryPrice: number;
  currentPrice: number;
  currentStop: number;
  initialRisk: number;
  protectionLevel: string;
  rMultiple: number;
  atr?: number;
  stopHistory: Array<{
    date: string;
    oldStop: number;
    newStop: number;
    reason: string;
    level: string;
  }>;
}

export interface NewsContextData {
  ticker: string;
  name?: string;
  sleeve?: string;
  scanStatus?: string;
  headlines: Array<{
    title: string;
    publisher: string;
    publishedAt: string;
    ageHours: number;
  }>;
  earnings: {
    nextEarningsDate: string | null;
    daysUntil: number | null;
    isEstimate: boolean;
  };
}

export interface TradePulseExplainData {
  ticker: string;
  score: number;
  grade: string;
  decision: string;
  signals: Array<{
    name: string;
    shortName: string;
    score: number;
    weight: number;
    status: string;
    detail?: string;
  }>;
  concerns: string[];
  opportunities: string[];
  headlines?: Array<{ title: string; publisher: string; ageHours: number }>;
  earnings?: { nextEarningsDate: string | null; daysUntil: number | null; isEstimate: boolean };
  sentiment?: { overall: string; confidence: string };
}

export interface JournalDraftData {
  ticker: string;
  name: string;
  type: 'entry' | 'close' | 'lesson';
  entryPrice: number;
  entryDate: string;
  currentPrice?: number;
  closePrice?: number;
  closeDate?: string;
  initialStop: number;
  currentStop?: number;
  rMultiple?: number;
  protectionLevel?: string;
  entryGrade?: string;
  executionGrade?: string;
  regime?: string;
  scanStatus?: string;
  sleeve: string;
  sector: string;
  pnlPercent?: number;
  pnlAbsolute?: number;
  holdingDays?: number;
  outcome?: 'WIN' | 'LOSS' | 'OPEN';
}

// ── Prompt builders ──

export function buildSystemSummaryPrompt(data: SystemSummaryData): {
  system: string;
  prompt: string;
  contextNumbers: number[];
} {
  const contextNumbers = [
    data.openPositionCount,
    data.maxPositions,
    data.openRiskPct,
    data.maxOpenRisk,
    data.readyCandidateCount,
    data.triggerMetCount,
    data.stopsPending,
    data.laggardCount,
    data.heartbeatAgeHours,
    data.scanAgeHours,
    data.equity ?? 0,
  ].filter(n => n != null);

  const blockerText = data.blockers.length > 0
    ? `\nActive Blockers:\n${data.blockers.map(b => `- [${b.severity.toUpperCase()}] ${b.label} (${b.code})`).join('\n')}`
    : '\nNo active blockers.';

  const prompt = stripSensitiveData(`Summarise today's trading system state based on this data:

Today's Decision: ${data.decision}
Headline: ${data.headline}
System Explanation: ${data.explanation}

System State:
- Weekly Phase: ${data.phase}
- Market Regime: ${data.regime}
- Operating Mode: ${data.operatingMode}
- System Health: ${data.healthOverall}
- Risk Profile: ${data.riskProfile || 'BALANCED'}
- Account Equity: £${data.equity?.toFixed(0) || 'unknown'}

Positions & Risk:
- Open Positions: ${data.openPositionCount} / ${data.maxPositions} max
- Open Risk: ${data.openRiskPct.toFixed(1)}% / ${data.maxOpenRisk}% max
- Laggards (dead money): ${data.laggardCount}
- Pyramid opportunities: ${data.pyramidCount}

Scan & Candidates:
- Ready candidates: ${data.readyCandidateCount}
- Trigger-met (breakout): ${data.triggerMetCount}
- Scan age: ${data.scanAgeHours.toFixed(1)} hours

Stops & Safety:
- Stops pending update: ${data.stopsPending}
- Heartbeat age: ${data.heartbeatAgeHours.toFixed(1)} hours
- Kill switch: ${data.killSwitchActive ? 'ACTIVE — all trading blocked' : 'off'}
- Auto-trading: ${data.autoTradingEnabled ? 'enabled' : 'disabled'}
- T212 connected: ${data.t212Connected ? 'yes' : 'no'}
- Data stale: ${data.dataStale ? 'YES — data may be outdated' : 'no'}
${blockerText}

Explain what all this means for a beginner. What is the system telling the user to do today? Why?`);

  return { system: ANALYST_SYSTEM_PROMPT, prompt, contextNumbers };
}

export function buildCandidateExplainPrompt(data: CandidateExplainData): {
  system: string;
  prompt: string;
  contextNumbers: number[];
} {
  const contextNumbers = [
    data.price, data.entryTrigger, data.distancePercent,
    data.adx, data.atrPercent, data.efficiency, data.ma200,
    data.riskPerShare, data.positionSize,
    data.bqs ?? 0, data.ncs ?? 0,
  ].filter(n => n != null);

  const gateText = data.gateResults?.length
    ? `\nRisk Gate Results:\n${data.gateResults.map(g => `- ${g.gate}: ${g.passed ? '✅ PASS' : '❌ FAIL'}${g.reason ? ` — ${g.reason}` : ''}`).join('\n')}`
    : '';

  const prompt = stripSensitiveData(`Explain this scan candidate for a beginner:

Ticker: ${data.ticker} (${data.name})
Status: ${data.status}
Sleeve: ${data.sleeve} | Sector: ${data.sector} | Cluster: ${data.cluster}

Price Data:
- Current Price: ${data.price.toFixed(2)}
- Entry Trigger: ${data.entryTrigger.toFixed(2)}
- Distance to Trigger: ${data.distancePercent.toFixed(2)}%
- 200-day MA: ${data.ma200.toFixed(2)}

Technical Indicators:
- ADX (trend strength): ${data.adx.toFixed(1)} ${data.adx >= 20 ? '(strong trend)' : '(weak trend)'}
- ATR% (volatility): ${data.atrPercent.toFixed(2)}%
- Efficiency: ${data.efficiency.toFixed(0)}

Sizing:
- Risk per share: ${data.riskPerShare.toFixed(2)}
- Position size: ${data.positionSize} shares

Scores:
- BQS (breakout quality): ${data.bqs ?? 'N/A'}
- FWS (forward score): ${data.fws ?? 'N/A'}
- NCS (normalised confidence): ${data.ncs ?? 'N/A'}
- Grade: ${data.grade ?? 'N/A'}
${gateText}
${data.stage6Reason ? `\nAnti-chase result: ${data.stage6Reason}` : ''}
${data.entryMode ? `\nEntry mode: ${data.entryMode}` : ''}

Explain what this means: why does it have this status? What do the numbers tell us? What would need to change for this to become actionable?`);

  return { system: ANALYST_SYSTEM_PROMPT, prompt, contextNumbers };
}

export function buildStopExplainPrompt(data: StopExplainData): {
  system: string;
  prompt: string;
  contextNumbers: number[];
} {
  const contextNumbers = [
    data.entryPrice, data.currentPrice, data.currentStop,
    data.initialRisk, data.rMultiple, data.atr ?? 0,
    ...data.stopHistory.flatMap(h => [h.oldStop, h.newStop]),
  ].filter(n => n != null);

  const historyText = data.stopHistory.length > 0
    ? `\nStop History (most recent first):\n${data.stopHistory.slice(0, 10).map(h =>
        `- ${h.date}: ${h.oldStop.toFixed(2)} → ${h.newStop.toFixed(2)} (${h.level}) — ${h.reason}`
      ).join('\n')}`
    : '\nNo stop changes recorded yet.';

  const prompt = stripSensitiveData(`Explain the stop management for this position:

Ticker: ${data.ticker}
Entry Price: ${data.entryPrice.toFixed(2)}
Current Price: ${data.currentPrice.toFixed(2)}
Current Stop: ${data.currentStop.toFixed(2)}
Initial Risk (R): ${data.initialRisk.toFixed(2)}
Current R-Multiple: ${data.rMultiple.toFixed(2)}R
Protection Level: ${data.protectionLevel}
ATR: ${data.atr?.toFixed(2) ?? 'N/A'}
${historyText}

Protection Level Ladder:
- INITIAL: Stop at entry minus initial risk (0R protection)
- TRAILING_ATR: Nightly trailing stop at the highest close since entry minus ${ATR_TRAILING_MULTIPLIER}×ATR, from the entry day
- BREAKEVEN: Stop at entry price (0R risk, ~1.5R gain needed)
- LOCK_08R: Stop locks in 0.5R profit (~2.5R gain needed)
- LOCK_1R_TRAIL: Trailing stop at max of 1R profit or Close - ${ATR_TRAILING_MULTIPLIER}×ATR (~3R+)

Explain in plain English: Where is the stop now? What does the R-multiple mean? What protection level is active and why? What happens next as the price moves?`);

  return { system: ANALYST_SYSTEM_PROMPT, prompt, contextNumbers };
}

export function buildJournalDraftPrompt(data: JournalDraftData): {
  system: string;
  prompt: string;
  contextNumbers: number[];
} {
  const contextNumbers = [
    data.entryPrice, data.currentPrice ?? 0, data.closePrice ?? 0,
    data.initialStop, data.currentStop ?? 0, data.rMultiple ?? 0,
    data.pnlPercent ?? 0, data.pnlAbsolute ?? 0, data.holdingDays ?? 0,
  ].filter(n => n != null);

  const typeLabels = {
    entry: 'entry journal (why I took this trade)',
    close: 'close journal (what happened and why I exited)',
    lesson: 'lessons learned (what I would do differently)',
  };

  const prompt = stripSensitiveData(`Draft a trade journal ${typeLabels[data.type]} based on this data:

Position: ${data.ticker} (${data.name})
Sleeve: ${data.sleeve} | Sector: ${data.sector}

Entry:
- Entry Date: ${data.entryDate}
- Entry Price: ${data.entryPrice.toFixed(2)}
- Initial Stop: ${data.initialStop.toFixed(2)}
- Entry Grade: ${data.entryGrade ?? 'N/A'}
- Scan Status at Entry: ${data.scanStatus ?? 'N/A'}
- Regime at Entry: ${data.regime ?? 'N/A'}

Current State:
${data.closePrice
  ? `- Close Price: ${data.closePrice.toFixed(2)}\n- Close Date: ${data.closeDate ?? 'N/A'}`
  : `- Current Price: ${data.currentPrice?.toFixed(2) ?? 'N/A'}`}
- Current Stop: ${data.currentStop?.toFixed(2) ?? 'N/A'}
- R-Multiple: ${data.rMultiple?.toFixed(2) ?? 'N/A'}R
- Protection Level: ${data.protectionLevel ?? 'N/A'}
- Execution Grade: ${data.executionGrade ?? 'N/A'}

Performance:
- P&L: ${data.pnlPercent?.toFixed(1) ?? '?'}% (£${data.pnlAbsolute?.toFixed(2) ?? '?'})
- Holding Days: ${data.holdingDays ?? '?'}
- Outcome: ${data.outcome ?? 'OPEN'}

Write the journal in first person. Use the data provided — do not invent facts. Structure it with:
1. Setup — why this trade appeared (regime, scan status, technical setup)
2. Entry — how the entry was executed (price, sizing, grade)
3. Management — how the position was managed (stop moves, R progression)
4. ${data.type === 'lesson' ? 'Lessons — what to do differently next time' : 'Result — outcome and key takeaway'}`);

  return { system: ANALYST_SYSTEM_PROMPT, prompt, contextNumbers };
}

export function buildTradePulseExplainPrompt(data: TradePulseExplainData): {
  system: string;
  prompt: string;
  contextNumbers: number[];
} {
  const contextNumbers = [
    data.score,
    ...data.signals.map(s => s.score),
    ...data.signals.map(s => Math.round(s.weight * 100)),
    data.earnings?.daysUntil ?? 0,
  ].filter(n => n != null);

  const signalLines = data.signals
    .sort((a, b) => b.weight - a.weight)
    .map(s => `- ${s.shortName} (${s.name}): score ${Math.round(s.score)}/100, weight ${Math.round(s.weight * 100)}%, status ${s.status}${s.detail ? ` — ${s.detail}` : ''}`)
    .join('\n');

  const concernLines = data.concerns.length > 0
    ? data.concerns.map(c => `- ⚠ ${c}`).join('\n')
    : '(none)';

  const oppLines = data.opportunities.length > 0
    ? data.opportunities.map(o => `- ✓ ${o}`).join('\n')
    : '(none)';

  const earningsLine = data.earnings?.nextEarningsDate
    ? `Next earnings: ${data.earnings.nextEarningsDate.slice(0, 10)} (${data.earnings.daysUntil} days)${data.earnings.isEstimate ? ' [estimated]' : ''}`
    : 'Earnings: not announced / unknown';

  const headlinesBlock = data.headlines?.length
    ? data.headlines.map((h, i) => `${i + 1}. [${h.publisher}, ${Math.round(h.ageHours)}h ago] ${h.title}`).join('\n')
    : '(no recent headlines)';

  const sentimentLine = data.sentiment
    ? `News Sentiment: ${data.sentiment.overall} (confidence: ${data.sentiment.confidence})`
    : 'News Sentiment: not assessed';

  const prompt = stripSensitiveData(`Explain this TradePulse analysis for ${data.ticker} in plain English for a beginner.

Overall Score: ${Math.round(data.score)}/100
Grade: ${data.grade}
Decision: ${data.decision}

Signal Breakdown (sorted by weight):
${signalLines}

Concerns:
${concernLines}

Confirming Signals:
${oppLines}

Calendar:
${earningsLine}

${sentimentLine}

Recent Headlines:
${headlinesBlock}

Produce a clear, beginner-friendly explanation:
1. **Overall verdict** (1-2 sentences): What does this grade mean? Is this a strong or weak candidate?
2. **Key drivers** (2-3 sentences): Which signals matter most and why? What's pulling the score up or down?
3. **Risk factors** (1-2 sentences): Summarise the concerns. Is there earnings event risk?
4. **News context** (1-2 sentences): Does the news sentiment and flow support or contradict the setup?

Keep it conversational. Reference specific signal names and numbers from the data. Do NOT recommend buy or sell.`);

  return { system: ANALYST_SYSTEM_PROMPT, prompt, contextNumbers };
}

export function buildNewsContextPrompt(data: NewsContextData): {
  system: string;
  prompt: string;
  contextNumbers: number[];
} {
  const contextNumbers = [
    data.earnings.daysUntil ?? 0,
    data.headlines.length,
  ].filter(n => n != null);

  const earningsLine = data.earnings.nextEarningsDate
    ? `- Next earnings: ${data.earnings.nextEarningsDate.slice(0, 10)} (in ${data.earnings.daysUntil} days)${data.earnings.isEstimate ? ' [estimated]' : ''}`
    : '- Next earnings: not announced / unknown';

  const headlinesText = data.headlines.length > 0
    ? data.headlines.map((h, i) =>
        `${i + 1}. [${h.publisher}, ${h.ageHours.toFixed(0)}h ago] ${h.title}`
      ).join('\n')
    : '(no recent headlines available)';

  const meta = [
    data.name ? `Name: ${data.name}` : null,
    data.sleeve ? `Sleeve: ${data.sleeve}` : null,
    data.scanStatus ? `Current scan status: ${data.scanStatus}` : null,
  ].filter(Boolean).join(' | ');

  const prompt = stripSensitiveData(`Review the public news + event calendar for this ticker and flag anything a trend-following trader should know BEFORE entering a position.

Ticker: ${data.ticker}
${meta || ''}

Calendar:
${earningsLine}

Recent Headlines:
${headlinesText}

Produce a SHORT review (max 4 short bullets):
- Earnings event risk: is earnings within the next ~10 trading days? If yes, flag it as material event risk.
- News tone: is the recent news flow material (M&A, guidance, regulatory, leadership change, lawsuit) or routine noise?
- Catalyst alignment: do the headlines support or contradict a trend-continuation thesis?
- Verdict: one sentence — "context appears clean", "elevated event risk near-term", or "material news — verify before acting".

Do NOT recommend buy or sell. Do NOT invent prices or numbers. Stick strictly to the headlines and calendar provided.`);

  return { system: ANALYST_SYSTEM_PROMPT, prompt, contextNumbers };
}

export { ANALYST_SYSTEM_PROMPT };
