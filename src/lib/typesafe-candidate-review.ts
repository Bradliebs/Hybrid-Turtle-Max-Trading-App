import { createHash } from 'node:crypto';
import { z } from 'zod';

export const TYPESAFE_MODEL = 'jev-1.13.0';
export const REVIEW_VERSION = 'candidate-evidence-v2';
export const REVIEW_LABELS = ['SUPPORTED', 'CONTRADICTED', 'MIXED', 'INSUFFICIENT_EVIDENCE'] as const;
export const reviewLabelSchema = z.enum(REVIEW_LABELS);
const measurement = z.number().finite().nullable();

export const candidateEvidenceSchema = z.object({
  ticker: z.string().regex(/^[A-Za-z0-9.^=-]{1,32}$/),
  regime: z.enum(['BULLISH', 'BEARISH', 'SIDEWAYS', 'NEUTRAL']),
  price: measurement,
  ma200: measurement,
  entryTrigger: measurement,
  adx: measurement,
  ncs: measurement,
  bqs: measurement,
  fws: measurement,
  volumeRatio: measurement,
  relativeStrength: measurement,
  source: z.enum(['LIVE', 'CACHE', 'STALE_CACHE', 'UNKNOWN']),
  dataAsOf: z.string().datetime().nullable(),
  scanTime: z.string().datetime(),
  claim: z.string().max(1500),
  comparisons: z.object({ aboveMa200: z.boolean(), triggerMet: z.boolean() }).strict(),
}).strict();

export interface CandidateReviewInput {
  ticker: string;
  regime: string;
  price: number | null;
  ma200: number | null;
  entryTrigger: number | null;
  adx: number | null;
  ncs: number | null;
  bqs: number | null;
  fws: number | null;
  volumeRatio: number | null;
  relativeStrength: number | null;
  grade: string | null;
  gradeReason: string | null;
  source: string | null;
  dataAsOf: string | null;
  scanTime: string;
  provenanceMatches: boolean;
}

const numericText = '-?\\d+(?:\\.\\d+)?';
const weakPoint = `(?:READY \\u2014 within 2% of trigger but breakout not yet confirmed|WATCH \\u2014 not yet ready|NCS ${numericText} < ${numericText}|FWS ${numericText} > ${numericText}|BQS ${numericText} < ${numericText}|Vol ratio ${numericText} < ${numericText}|RS ${numericText}% < ${numericText}%|ATR spiking \\u2014 volatility elevated)`;
const watchReason = new RegExp(`^Passes filters but not A-grade\\. (?:${weakPoint}(?:\\. ${weakPoint})*|Near threshold \\u2014 watch for improvement\\.)$`);
const buyReason = new RegExp(`^Trigger met \\u2014 price at or above entry\\. All filters pass, scores strong \\(NCS ${numericText}, BQS ${numericText}, FWS ${numericText}\\), volume confirmed\\.$`);

export function isApprovedTechnicalClaim(grade: string | null, reason: string | null): boolean {
  if (!reason || reason.length > 1500) return false;
  return (grade === 'A_GRADE_BUY' && buyReason.test(reason)) ||
    (grade === 'B_GRADE_WATCH' && watchReason.test(reason)) ||
    (grade === 'BLOCKED_CHASE' && reason === 'Price extended beyond entry trigger. Waiting for pullback into zone.');
}

export function buildCandidateEvidence(input: CandidateReviewInput) {
  const flags: string[] = [];
  if (!isApprovedTechnicalClaim(input.grade, input.gradeReason)) flags.push('NO_APPROVED_TECHNICAL_CLAIM');
  if (!input.provenanceMatches) flags.push('INCOMPLETE_OR_CONFLICTING_PROVENANCE');
  if (!input.source || !['LIVE', 'CACHE'].includes(input.source)) flags.push('STALE_OR_UNKNOWN_SOURCE');
  const scanTime = Date.parse(input.scanTime);
  const sourceTime = input.dataAsOf ? Date.parse(input.dataAsOf) : NaN;
  if (!Number.isFinite(sourceTime) || !Number.isFinite(scanTime) || sourceTime > scanTime || scanTime - sourceTime > 3_600_000) {
    flags.push('MISSING_OR_STALE_SOURCE_TIME');
  }
  if ([input.price, input.ma200, input.entryTrigger, input.adx, input.volumeRatio].some(value => value === null || !Number.isFinite(value) || value <= 0) ||
      [input.ncs, input.bqs, input.fws, input.relativeStrength].some(value => value === null || !Number.isFinite(value))) {
    flags.push('INCOMPLETE_MARKET_EVIDENCE');
  }
  if (flags.length) return { flags, state: null, inputHash: null };
  const parsed = candidateEvidenceSchema.safeParse({
    ticker: input.ticker, regime: input.regime, price: input.price, ma200: input.ma200,
    entryTrigger: input.entryTrigger, adx: input.adx, ncs: input.ncs, bqs: input.bqs,
    fws: input.fws, volumeRatio: input.volumeRatio, relativeStrength: input.relativeStrength,
    source: input.source, dataAsOf: input.dataAsOf, scanTime: input.scanTime,
    claim: input.gradeReason,
    comparisons: { aboveMa200: input.price! > input.ma200!, triggerMet: input.price! >= input.entryTrigger! },
  });
  if (!parsed.success) return { flags: ['INVALID_EVIDENCE'], state: null, inputHash: null };
  const state = parsed.data;
  const inputHash = createHash('sha256').update(JSON.stringify({ version: REVIEW_VERSION, model: TYPESAFE_MODEL, state })).digest('hex');
  return { flags, state, inputHash };
}

export type CandidateEvidence = z.infer<typeof candidateEvidenceSchema>;