import { describe, expect, it } from 'vitest';
import { runPlatformCleanup } from './cleanup.js';
import { IdempotencyModule, IDEMPOTENCY_TTL_HOURS, PLATFORM_CLEANUP } from './idempotency.module.js';
import { lookupRecord, parseIdempotencyKey, requestHash, withIdempotency } from './idempotency.js';

const scope = { ownerId: '00000000-0000-4000-8000-000000000001', operationId: 'API-024', key: 'k1', requestHash: requestHash('POST', '/p', { a: 1 }) };

/** Scripted tx: answers each `execute` in order. */
function tx(...answers: { rows: unknown[] }[]) {
  const queue = [...answers];
  const seen: number[] = [];
  return {
    seen,
    tx: {
      execute: () => {
        seen.push(queue.length);
        const next = queue.shift();
        if (next === undefined) throw new Error('unexpected query');
        return Promise.resolve(next);
      },
    } as never,
  };
}
const row = (hash: Buffer) => ({ rows: [{ request_hash: hash, resource_type: 'job', resource_id: 'rid', response_status: '202' }] });

describe('requestHash', () => {
  it('is 32 bytes, ignores key order and undefined members, and depends on method, path and body', () => {
    const base = requestHash('post', '/p', { b: [1, { y: 2, x: 1 }], a: null });
    expect(base).toHaveLength(32);
    expect(requestHash('POST', '/p', { a: null, b: [1, { x: 1, y: 2 }], c: undefined })).toEqual(base);
    expect(requestHash('PUT', '/p', { a: null, b: [1, { x: 1, y: 2 }] })).not.toEqual(base);
    expect(requestHash('POST', '/q', { a: null, b: [1, { x: 1, y: 2 }] })).not.toEqual(base);
    expect(requestHash('POST', '/p', { a: 1 })).not.toEqual(requestHash('POST', '/p', { a: '1' }));
    expect(requestHash('POST', '/p', undefined)).toHaveLength(32);
    expect(requestHash('POST', '/p', [{ b: 1, a: 2 }])).toEqual(requestHash('POST', '/p', [{ a: 2, b: 1 }]));
  });
});

describe('parseIdempotencyKey', () => {
  it('returns a valid key and refuses a missing, repeated, long or non-visible one with 400', () => {
    expect(parseIdempotencyKey(' abc-123 ')).toBe('abc-123');
    for (const bad of [undefined, '', '  ', ['a', 'b'], 'x'.repeat(129), 'has space', 'a\tb', 'ü']) {
      expect(() => parseIdempotencyKey(bad as never)).toThrowError(expect.objectContaining({ code: 'validation_failed', status: 400 }));
    }
    expect(parseIdempotencyKey('x'.repeat(128))).toHaveLength(128);
  });
});

describe('withIdempotency', () => {
  const options = { resourceType: 'job', responseStatus: 202 };

  it('creates once when the record is new', async () => {
    const { tx: t } = tx({ rows: [] }, { rows: [1] });
    const out = await withIdempotency(t, scope, { ...options, resourceId: 'fixed' }, async (id) => `made-${id}`);
    expect(out).toEqual({ replayed: false, result: 'made-fixed', resourceType: 'job', resourceId: 'fixed', responseStatus: 202 });
  });

  it('generates the resource ID when none is given', async () => {
    const { tx: t } = tx({ rows: [] }, { rows: [1] });
    const out = await withIdempotency(t, scope, { ...options, ttlHours: 2 }, async (id) => id);
    expect(out.resourceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('replays the stored resource for the same hash without running create', async () => {
    const { tx: t } = tx({ rows: [] }, { rows: [] }, row(scope.requestHash));
    const out = await withIdempotency(t, scope, options, () => Promise.reject(new Error('must not run')));
    expect(out).toEqual({ replayed: true, resourceType: 'job', resourceId: 'rid', responseStatus: 202 });
  });

  it('is 409 idempotency_key_reused for another hash', async () => {
    const { tx: t } = tx({ rows: [] }, { rows: [] }, row(requestHash('POST', '/p', { a: 2 })));
    await expect(withIdempotency(t, scope, options, async () => 1)).rejects.toMatchObject({ code: 'idempotency_key_reused', status: 409 });
  });

  it('starts over when the record expired between the conflict and the read', async () => {
    const { tx: t } = tx({ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [1] });
    const out = await withIdempotency(t, scope, options, async () => 'ok');
    expect(out.replayed).toBe(false);
  });

  it('lookupRecord returns undefined when nothing live exists', async () => {
    expect(await lookupRecord(tx({ rows: [] }).tx, scope)).toBeUndefined();
  });
});

describe('cleanup and module', () => {
  it('reports the rows each delete removed (null counts as 0)', async () => {
    const answers = [{ rowCount: 3 }, { rowCount: null }];
    const db = { execute: () => Promise.resolve(answers.shift()) } as never;
    expect(await runPlatformCleanup(db)).toEqual({ idempotencyRecords: 3, rateLimitBuckets: 0 });
  });

  it('registers the TTL (24 h default) and the cleanup handler', async () => {
    const module = IdempotencyModule.register({});
    const providers = module.providers as { provide: symbol; useValue?: unknown; useFactory?: (d: unknown) => () => Promise<unknown> }[];
    expect(providers.find((p) => p.provide === IDEMPOTENCY_TTL_HOURS)?.useValue).toBe(24);
    expect((IdempotencyModule.register({ IDEMPOTENCY_TTL_HOURS: 48 }).providers as typeof providers)[0]?.useValue).toBe(48);
    const factory = providers.find((p) => p.provide === PLATFORM_CLEANUP)?.useFactory;
    const handler = factory?.({ db: { execute: () => Promise.resolve({ rowCount: 1 }) } });
    expect(await handler?.()).toEqual({ idempotencyRecords: 1, rateLimitBuckets: 1 });
  });
});
