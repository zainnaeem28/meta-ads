import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '../../../platform/http/domain-error.js';
import type { ActorContext } from '../../../platform/http/index.js';
import { encodeCursor } from '../../../platform/http/index.js';
import { RateLimitedError } from '../../../platform/rate-limit/index.js';
import type { DraftRecord } from '../domain/draft.js';
import { DraftsController, versionOf } from './drafts.controller.js';

const A = '0197a1b2-0000-7000-8000-000000000001';
const D = '0197a1b2-0000-7000-8000-0000000000d1';
const KEY = 'k'.repeat(40);
const actor = { userId: A } as ActorContext;

const record = (over: Partial<DraftRecord> = {}): DraftRecord => ({
  id: D,
  ownerId: A,
  version: 3,
  step: 2,
  adStyle: 'ugc',
  intakeMode: 'description',
  productName: 'Test Tonic',
  productDescription: null,
  audience: { ageMin: 35, ageMax: 52 },
  direction: { goal: 'awareness', segmentCount: 4 },
  concept: null,
  script: null,
  productMediaId: null,
  campaignId: null,
  createdAt: '2026-11-16 10:00:00.123456+00',
  updatedAt: '2026-11-16 10:05:00+00',
  ...over,
});

function setup(limiter: { allowed: boolean } = { allowed: true }) {
  const service = {
    listOpen: vi.fn(async () => [record()]),
    get: vi.fn(async () => record()),
    create: vi.fn(async () => record({ version: 1 })),
    patch: vi.fn(async () => record({ version: 4 })),
    remove: vi.fn(async () => undefined),
  };
  const consume = vi.fn(async () => ({
    allowed: limiter.allowed,
    count: 1,
    limit: 30,
    retryAfterSeconds: 17,
  }));
  const controller = new DraftsController(service as never, KEY, { consume } as never);
  const headers: Record<string, string> = {};
  const reply = { header: (name: string, value: string) => void (headers[name] = value) } as never;
  return { service, controller, headers, reply, consume };
}

const fails = async (promise: Promise<unknown>): Promise<DomainError> => {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
};

describe('versionOf (ETag and If-Match)', () => {
  it('reads a quoted positive integer', () => {
    expect(versionOf('"3"')).toBe(3);
    expect(versionOf(' "12" ')).toBe(12);
  });
  it.each([undefined, '3', '"0"', '"x"', 'W/"3"', '"-1"', '"1234567890"'])(
    'refuses %s',
    (value) => {
      expect(() => versionOf(value)).toThrow(DomainError);
    },
  );
});

describe('DraftsController', () => {
  it('renders a draft with an ETag, duration and ISO instants (API-022)', async () => {
    const { controller, headers, reply } = setup();
    const view = await controller.get(actor, { draftId: D }, reply);
    expect(headers['ETag']).toBe('"3"');
    expect(view).toMatchObject({
      id: D,
      version: 3,
      durationSeconds: 60,
      campaignId: null,
      createdAt: '2026-11-16T10:00:00.123456Z',
      updatedAt: '2026-11-16T10:05:00Z',
    });
  });
  it('refuses a malformed ID and a missing actor', async () => {
    const { controller, reply } = setup();
    expect((await fails(controller.get(actor, { draftId: 'nope' }, reply))).code).toBe(
      'validation_failed',
    );
    expect((await fails(controller.get(undefined, { draftId: D }, reply))).code).toBe(
      'unauthenticated',
    );
  });
  it('creates with 30/min, Location and ETag (API-021)', async () => {
    const { controller, service, headers, reply, consume } = setup();
    const view = await controller.create(actor, { productName: '  Test Tonic ', step: 1 }, reply);
    expect(consume).toHaveBeenCalledWith('draft-create', A, 30, 60);
    expect(service.create).toHaveBeenCalledWith(A, { productName: 'Test Tonic', step: 1 });
    expect(headers['ETag']).toBe('"1"');
    expect(headers['Location']).toBe(`/api/v1/drafts/${D}`);
    expect(view.version).toBe(1);
  });
  it('answers 429 with Retry-After and never reaches the service when over the limit', async () => {
    const { controller, service, headers, reply } = setup({ allowed: false });
    await expect(controller.create(actor, {}, reply)).rejects.toBeInstanceOf(RateLimitedError);
    expect(headers['Retry-After']).toBe('17');
    await expect(
      controller.patch(actor, { draftId: D }, { step: 2 }, '"1"', reply),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(service.create).not.toHaveBeenCalled();
    expect(service.patch).not.toHaveBeenCalled();
  });
  it('saves under If-Match with 60/min (API-023)', async () => {
    const { controller, service, headers, reply, consume } = setup();
    await controller.patch(
      actor,
      { draftId: D },
      { direction: { segmentCount: 2 }, concept: null },
      '"3"',
      reply,
    );
    expect(consume).toHaveBeenCalledWith('draft-patch', A, 60, 60);
    expect(service.patch).toHaveBeenCalledWith(A, D, 3, {
      direction: { segmentCount: 2 },
      concept: null,
    });
    expect(headers['ETag']).toBe('"4"');
  });
  it('requires If-Match and at least one field on PATCH', async () => {
    const { controller, reply } = setup();
    expect(
      (await fails(controller.patch(actor, { draftId: D }, { step: 2 }, undefined, reply)))
        .details?.[0],
    ).toMatchObject({ field: 'If-Match', code: 'required' });
    expect(
      (await fails(controller.patch(actor, { draftId: D }, {}, '"1"', reply))).details?.[0],
    ).toMatchObject({ field: 'body', code: 'required' });
  });
  it.each([0, 5, -1, 4.5, '3'])(
    'rejects segment count %s with a field error (TC-INT-02)',
    async (segmentCount) => {
      const { controller, reply } = setup();
      const error = await fails(controller.create(actor, { direction: { segmentCount } }, reply));
      expect(error.code).toBe('validation_failed');
      expect(error.details?.[0]?.field).toBe('direction.segmentCount');
    },
  );
  it.each([1, 2, 3, 4])('accepts segment count %s', async (segmentCount) => {
    const { controller, reply } = setup();
    await expect(
      controller.create(actor, { direction: { segmentCount } }, reply),
    ).resolves.toBeDefined();
  });
  it('rejects unknown, mistyped and oversized fields (TC-INT-07)', async () => {
    const { controller, reply } = setup();
    for (const body of [
      { nope: 1 },
      { productName: 5 },
      { productName: '   ' },
      { productName: 'x'.repeat(121) },
      { concept: 'x'.repeat(4001) },
      { audience: { ageMin: 20 } },
      { audience: { interests: new Array(11).fill('a') } },
      { audience: { extra: 1 } },
      { direction: { goal: 'sales' } },
      { productMediaId: 'not-a-uuid' },
      { step: 6 },
      'text',
    ]) {
      expect((await fails(controller.create(actor, body, reply))).code).toBe('validation_failed');
    }
  });
  it('deletes with 204 semantics and the request id (API-025)', async () => {
    const { controller, service } = setup();
    await controller.remove(actor, { draftId: D }, { id: 'req-9' } as never);
    expect(service.remove).toHaveBeenCalledWith(A, D, 'req-9');
  });
});

describe('DraftsController.list (API-020)', () => {
  it('pages with a signed cursor over (updated_at, id)', async () => {
    const { controller, service } = setup();
    service.listOpen.mockResolvedValue([
      record(),
      record({ id: '0197a1b2-0000-7000-8000-0000000000d2' }),
      record({ id: '0197a1b2-0000-7000-8000-0000000000d3' }),
    ]);
    const page = await controller.list(actor, { limit: '2' });
    expect(service.listOpen).toHaveBeenCalledWith(A, 3, undefined);
    expect(page.items).toHaveLength(2);
    expect(page.pagination).toMatchObject({ limit: 2, returnedCount: 2, hasNextPage: true });
    const cursor = page.pagination.nextCursor as string;
    service.listOpen.mockResolvedValue([]);
    await controller.list(actor, { limit: '2', cursor });
    expect(service.listOpen).toHaveBeenLastCalledWith(A, 3, {
      updatedAt: '2026-11-16 10:05:00+00',
      id: '0197a1b2-0000-7000-8000-0000000000d2',
    });
  });
  it('defaults the limit and refuses 0 and 51', async () => {
    const { controller, service } = setup();
    await controller.list(actor, {});
    expect(service.listOpen).toHaveBeenCalledWith(A, 21, undefined);
    expect((await fails(controller.list(actor, { limit: '0' }))).code).toBe('validation_failed');
    expect((await fails(controller.list(actor, { limit: '51' }))).code).toBe('validation_failed');
  });
  it('refuses a forged, foreign or malformed cursor', async () => {
    const { controller } = setup();
    const scope = { owner: A };
    const sign = (sortKey: string) => encodeCursor(KEY, scope, sortKey);
    for (const cursor of [
      'garbage',
      encodeCursor(
        KEY,
        { owner: '0197a1b2-0000-7000-8000-0000000000ff' },
        JSON.stringify(['2026-11-16 10:00:00+00', D]),
      ),
      sign('not json'),
      sign('{"a":1}'),
      sign(JSON.stringify([1, 2])),
      sign(JSON.stringify(['2026-11-16 10:00:00+00', 'not-a-uuid'])),
      sign(JSON.stringify(['not a date', D])),
    ]) {
      const error = await fails(controller.list(actor, { cursor }));
      expect(error.code).toBe('validation_failed');
      expect(error.details?.[0]).toMatchObject({ field: 'cursor' });
    }
  });
});
