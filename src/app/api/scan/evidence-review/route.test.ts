import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ session: vi.fn(), owns: vi.fn(), latest: vi.fn(), read: vi.fn(), close: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: mocks.session }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/typesafe-review-source', () => ({ reviewDatabasePath: () => 'fixture', TypesafeReviewSource: class {
  ownsScan = mocks.owns; latest = mocks.latest; close = mocks.close;
} }));
vi.mock('@/lib/typesafe-review-store', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/typesafe-review-store')>();
  return { ...actual, TypesafeReviewStore: class { read = mocks.read; } };
});
import { GET } from './route';
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('TYPESAFE_REVIEW_ENABLED', 'true');
  vi.stubEnv('TYPESAFE_API_KEY', 'secret-test-key');
  vi.stubEnv('DISABLE_API_AUTH', 'false');
  mocks.session.mockResolvedValue({ user: { id: 'owner' } });
  mocks.owns.mockReturnValue(true);
  mocks.latest.mockReturnValue(null);
  mocks.read.mockReturnValue({ attempts: [], reviews: {}, cooldownUntil: 0, lastRun: null });
});
afterEach(() => vi.unstubAllEnvs());
const request = (suffix = '?scanId=scan') => new NextRequest(`http://localhost/api/scan/evidence-review${suffix}`);
describe('read-only evidence route', () => {
  it('requires authentication and scan ownership', async () => {
    mocks.session.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    mocks.session.mockResolvedValue({ user: { id: 'owner' } });
    mocks.owns.mockReturnValue(false);
    expect((await GET(request())).status).toBe(404);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.owns).toHaveBeenCalledWith('scan', 'owner');
  });
  it('rejects invalid IDs and never treats a missing ID as latest', async () => {
    expect((await GET(request('?scanId=../secret'))).status).toBe(400);
    const response = await GET(request(''));
    expect((await response.json()).scanId).toBeNull();
    expect(mocks.latest).not.toHaveBeenCalled();
  });
  it('reports configuration and storage failures without key or error leakage', async () => {
    vi.stubEnv('TYPESAFE_REVIEW_ENABLED', 'false');
    expect((await (await GET(request())).json()).status).toBe('DISABLED');
    vi.stubEnv('TYPESAFE_REVIEW_ENABLED', 'true');
    mocks.read.mockImplementation(() => { throw new Error('private path secret-test-key'); });
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/secret-test-key|private path/);
  });
  it('does not return another owner or another snapshot and suppresses stale answers', async () => {
    const record = { ownerId: 'owner', scanId: 'scan', resultId: 'result', scanTime: new Date().toISOString(), answer: { choice: 'SUPPORTED' }, inputHash: 'hash' };
    mocks.read.mockReturnValue({ attempts: [], reviews: { own: record, other: { ...record, ownerId: 'other' }, newer: { ...record, scanId: 'newer' } }, lastRun: null, cooldownUntil: 0 });
    const response = await GET(request());
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(body.reviews).toHaveLength(1);
    expect(body.reviews[0]).toMatchObject({ scanId: 'scan', stale: true, answer: null });
    expect(body.reviews[0].ownerId).toBeUndefined();
  });
  it('limits explicit desktop bypass to loopback and default owner', async () => {
    vi.stubEnv('DISABLE_API_AUTH', 'true');
    mocks.session.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(200);
    expect(mocks.owns).toHaveBeenCalledWith('scan', 'default-user');
    expect((await GET(new NextRequest('http://remote/api/scan/evidence-review?scanId=scan'))).status).toBe(401);
  });
});