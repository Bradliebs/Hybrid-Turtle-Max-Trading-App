import { DEFAULT_GRADE_THRESHOLDS } from '../src/lib/candidate-grade';

/**
 * Snapshot `relativeStrength` here is `rsVsBenchmarkPct`: the stock's return minus
 * SPY's, in percent. Production grades a 0–100 score (50 = level with SPY) against
 * minRelativeStrength = 50, i.e. "return at least SPY's", which is excess >= 0.
 */
export const MIN_RS_EXCESS_PCT = 0;

export interface EntryPolicyObservation {
  regime: string | null;
  status: string | null;
  price: number | null;
  trigger: number | null;
  ncs: number | null;
  bqs: number | null;
  fws: number | null;
  volumeRatio: number | null;
  relativeStrength: number | null;
  atrSpiking: boolean | null;
}

export function screenEntryPolicy(observation: EntryPolicyObservation, minVolumeRatio: number) {
  if (!Number.isFinite(minVolumeRatio) || minVolumeRatio < 0) {
    throw new Error('A valid session volume threshold is required');
  }
  const rejected: string[] = [];
  const missing: string[] = [];
  const checkNumber = (name: string, value: number | null, passes: (value: number) => boolean) => {
    if (value == null || !Number.isFinite(value)) missing.push(name);
    else if (!passes(value)) rejected.push(name);
  };
  if (observation.regime == null || observation.regime === '') missing.push('regime');
  else if (observation.regime !== 'BULLISH') rejected.push('regime');
  if (observation.status == null || observation.status === '') missing.push('status');
  else if (['EARNINGS_BLOCK', 'WAIT_PULLBACK', 'COOLDOWN'].includes(observation.status)) {
    rejected.push('status');
  }
  checkNumber('ncs', observation.ncs, value => value >= DEFAULT_GRADE_THRESHOLDS.minNCS);
  checkNumber('bqs', observation.bqs, value => value >= DEFAULT_GRADE_THRESHOLDS.minBQS);
  checkNumber('fws', observation.fws, value => value <= DEFAULT_GRADE_THRESHOLDS.maxFWS);
  checkNumber('volume', observation.volumeRatio, value => value >= minVolumeRatio);
  checkNumber('relativeStrength', observation.relativeStrength,
    value => value >= MIN_RS_EXCESS_PCT);
  if (observation.price == null || observation.trigger == null
    || !Number.isFinite(observation.price) || !Number.isFinite(observation.trigger)
    || observation.price <= 0 || observation.trigger <= 0) missing.push('trigger');
  else if (observation.price < observation.trigger) rejected.push('trigger');
  if (observation.atrSpiking == null) missing.push('atrSpike');
  else if (observation.atrSpiking) rejected.push('atrSpike');
  return {
    verdict: rejected.length > 0 ? 'REJECTED' as const : 'INCOMPLETE' as const,
    rejected,
    missing,
    unresolved: [
      'Point-in-time health and complete technical filters',
      'Six portfolio risk gates, sizing, session routing and existing holdings',
      'Fresh execution-time quote, technicals and anti-chase check',
      'Broker fills, costs and price-basis certification',
    ],
  };
}