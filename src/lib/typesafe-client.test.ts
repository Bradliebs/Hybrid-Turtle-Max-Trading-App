import { describe, expect, it, vi } from 'vitest';
import { createTypesafeReviewer, typesafeResponseSchema } from './typesafe-client';
import { buildCandidateEvidence, TYPESAFE_MODEL } from './typesafe-candidate-review';

const state = buildCandidateEvidence({
  ticker: 'TEST', regime: 'BULLISH', price: 100, ma200: 90, entryTrigger: 101, adx: 25,
  ncs: 60, bqs: 60, fws: 20, volumeRatio: 1, relativeStrength: 1,
  grade: 'B_GRADE_WATCH', gradeReason: 'Passes filters but not A-grade. NCS 60 < 70',
  source: 'LIVE', dataAsOf: '2026-09-22T10:00:00.000Z', scanTime: '2026-09-22T10:01:00.000Z', provenanceMatches: true,
}).state!;

const response = {
  model: TYPESAFE_MODEL,
  answers: { evidence: { type: 'choice', choice: 'SUPPORTED', confidence: 0.8,
    probabilities: { SUPPORTED: 0.85, CONTRADICTED: 0.05, MIXED: 0.05, INSUFFICIENT_EVIDENCE: 0.05 } } },
  usage: { input_tokens: 100, output_tokens: 20 },
};

describe('Typesafe transport', () => {
  it('pins destination/model, sends bearer server-side and refuses redirects', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response)));
    expect(await createTypesafeReviewer('test-key', transport)(state)).toEqual(response);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, options] = transport.mock.calls[0];
    expect(String(url)).toBe('https://api.typesafe.ai/v1/systemone');
    expect(options?.redirect).toBe('error');
    expect(new Headers(options?.headers).get('authorization')).toBe('Bearer test-key');
    expect(JSON.parse(String(options?.body)).model).toBe(TYPESAFE_MODEL);
    expect(Object.keys(JSON.parse(String(options?.body)).questions)).toEqual(['evidence', 'pick', 'move20d']);
  });
  it.each([401, 403, 422, 429, 529])('does not retry %s or leak error bodies', async status => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('PRIVATE BODY test-key', { status, headers: { 'retry-after': '60' } }));
    await expect(createTypesafeReviewer('test-key', transport)(state)).rejects.toMatchObject({ message: 'PROVIDER_UNAVAILABLE', status });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed response distributions and unknown answers', () => {
    expect(typesafeResponseSchema.safeParse(response).success).toBe(true);
    expect(typesafeResponseSchema.safeParse({ ...response, model: 'jev-latest' }).success).toBe(false);
    expect(typesafeResponseSchema.safeParse({ ...response, answers: {} }).success).toBe(false);
    const invalid = structuredClone(response);
    invalid.answers.evidence.probabilities.SUPPORTED = 0.1;
    expect(typesafeResponseSchema.safeParse(invalid).success).toBe(false);
  });
  it('fails missing keys before transport and rejects extra outbound fields', async () => {
    expect(() => createTypesafeReviewer('')).toThrow('MISSING_KEY');
    const transport = vi.fn<typeof fetch>();
    await expect(createTypesafeReviewer('key', transport)({ ...state, privateField: 'SECRET' } as typeof state)).rejects.toThrow('INVALID_PROVIDER_DATA');
    expect(transport).not.toHaveBeenCalled();
  });
});