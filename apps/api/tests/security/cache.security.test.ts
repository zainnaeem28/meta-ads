import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openApiOperations, seedSubject } from './support/data.js';
import type { Seeded } from './support/data.js';
import { APP_BUCKET, bootStack } from './support/stack.js';
import type { Account, Stack } from './support/stack.js';

// TASK-116: SECT-AZ-07, SECT-AZ-04 (headers), SECT-UP-07 (no signed URL for a media that is not ready), SECT-LOG-03 (the
// URL itself), TEST-CASES TC-ZT-07 (cache-control no-store on key and media routes) and TC-ZT-10: signed-URL and cache
// isolation. No identity-scoped content may sit in a cache shared between users. The suite plays a shared cache keyed by
// method and URL only (the worst case for a CDN or proxy in front of the API) and proves it can store nothing. The bucket
// side (an unsigned GET is denied, a signed URL stops working after its life, a guessed path and a listing are refused) is
// the deploy case SECT-R2-03 / SECT-AZ-08 and the e2e TC-H case of TEST-CASES §11; the in-process S3 stand-in does not verify
// signatures, so this file proves what the API controls: who gets a URL, for which one object, for how long, and how it is cached.

let s: Stack;
let a: Account;
let b: Account;
let boss: Account;
let sweeper: Account;
let ssw: Seeded;
let sa: Seeded;
let sb: Seeded;
const ops = openApiOperations();

const urlOf = (path: string, ids: Record<string, string> = {}) =>
  path.replace(
    /\{(\w+)\}/g,
    (_m, name: string) =>
      ids[name] ?? (name === 'position' ? '1' : name === 'provider' ? 'openai' : randomUUID()),
  );

beforeAll(async () => {
  s = await bootStack('t116cache');
  a = await s.account('cache-a');
  b = await s.account('cache-b');
  boss = await s.admin('cache-boss');
  // The all-operations sweep mutates what it touches (deletes, role changes): it runs on its own subject so the other cases never depend on its order or timing.
  sweeper = await s.account('cache-sweep');
  ssw = await seedSubject(s, sweeper, 'cachesss3');
  sa = await seedSubject(s, a, 'cacheaaa1');
  sb = await seedSubject(s, b, 'cachebbb2');
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe('no identity-scoped content in a shared cache (TC-ZT-07, TC-ZT-10)', () => {
  it('marks every API response no-store with no validator, on success, refusal, missing object, bad input and the 500 path', async () => {
    const ids = {
      mediaId: ssw.upload,
      campaignId: ssw.campaign,
      draftId: randomUUID(),
      userId: sweeper.id,
    };
    const seen: string[] = [];
    for (const op of ops.filter(
      (o) =>
        !o.scopes.includes('Pub') &&
        !o.scopes.includes('M') &&
        s.index.match(o.method, `/api/v1${urlOf(o.path, ids)}`).kind === 'found',
    )) {
      for (const [label, token] of [
        ['owner', sweeper.token],
        ['other user', b.token],
        ['anonymous', undefined],
        ['admin', boss.token],
      ] as const) {
        const res = await s.call(
          op.method as 'GET',
          urlOf(op.path, ids),
          token,
          op.method === 'GET' || op.method === 'DELETE' ? undefined : {},
        );
        const where = `${op.id} ${label} ${String(res.status)}`;
        expect(String(res.headers['cache-control']).toLowerCase(), where).toBe('no-store');
        // A resource version ETag (optimistic concurrency, If-Match) may ride along: under no-store a cache cannot keep or revalidate it.
        for (const validator of ['last-modified', 'age', 'set-cookie', 'expires'])
          expect(res.headers[validator], `${where} ${validator}`).toBeUndefined();
        expect(String(res.headers['cache-control'] ?? '').toLowerCase(), where).not.toMatch(
          /public|max-age|s-maxage|immutable|stale-while/,
        );
        seen.push(`${res.status}`);
      }
    }
    expect(
      new Set(seen).size,
      'success, refusal and missing paths were all exercised',
    ).toBeGreaterThan(3);
    for (const path of ['/no-such-path', '/probe/boom', '/me?x=' + 'a'.repeat(50)]) {
      const res = await s.call('GET', path, a.token);
      expect(String(res.headers['cache-control']).toLowerCase(), path).toBe('no-store');
    }
    const head = await s.app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'HEAD',
        url: '/api/v1/me',
        headers: { authorization: `Bearer ${a.token}` },
      });
    expect(String(head.headers['cache-control']).toLowerCase()).toBe('no-store');
  });

  it("never answers a conditional request with 304 or a cached body, so no validator can serve one user's content to another", async () => {
    const mine = await s.call('GET', '/campaigns', a.token);
    for (const conditional of [
      { 'if-none-match': '*' },
      { 'if-none-match': 'W/"anything"' },
      { 'if-modified-since': new Date(Date.now() + 86_400_000).toUTCString() },
      { 'cache-control': 'max-age=3600', pragma: 'cache' },
    ] as Record<string, string>[]) {
      const res = await s.call('GET', '/campaigns', b.token, undefined, conditional);
      expect(res.status, JSON.stringify(conditional)).toBe(200);
      expect(res.raw, JSON.stringify(conditional)).not.toContain(sa.canaries.productName);
      expect(res.raw).not.toBe(mine.raw);
    }
  });

  it('a shared cache keyed by method and URL holds nothing that could be replayed to another user, on every read of the owner', async () => {
    const reads = [
      '/me',
      '/me/provider-keys',
      '/me/key-events',
      '/campaigns',
      '/drafts',
      `/media/${sa.upload}`,
      `/media/${sa.upload}/url`,
      '/campaigns?limit=5',
    ];
    const cache = new Map<string, string>();
    for (const url of reads) {
      const res = await s.call('GET', url, a.token);
      expect(res.status, url).toBe(200);
      const storable =
        !/no-store|private/i.test(String(res.headers['cache-control'] ?? '')) &&
        res.headers['vary'] !== '*';
      if (storable) cache.set(`GET ${url}`, res.raw);
    }
    expect([...cache.keys()], 'responses a shared cache could keep').toEqual([]);
    // What the other user gets on the same URLs is theirs or a refusal, never the owner's.
    for (const url of reads) {
      const res = await s.call('GET', url, b.token);
      for (const secret of [
        a.email,
        a.sub,
        sa.canaries.productName,
        sa.canaries.dialogue,
        sa.upload,
        sa.campaign,
        a.id,
      ])
        expect(res.raw.includes(secret), `${url} leaked ${secret}`).toBe(false);
    }
  });
});

describe('signed URLs (SECT-AZ-07, SECT-UP-07, SECT-LOG-03)', () => {
  it('signs one object for its owner only, for a bounded life, and never caches the answer', async () => {
    const res = await s.call('GET', `/media/${sa.upload}/url`, a.token);
    expect(res.status).toBe(200);
    expect(String(res.headers['cache-control']).toLowerCase()).toBe('no-store');
    const { url, expiresAt } = res.body.data as { url: string; expiresAt: string };
    const parsed = new URL(url);
    const key = (
      await s.one<{ storage_key: string }>(`select storage_key from media_objects where id = $1`, [
        sa.upload,
      ])
    ).storage_key;
    // One object: the path is the bucket and that object's key, nothing broader (no prefix, no listing, no wildcard).
    expect(decodeURIComponent(parsed.pathname)).toBe(`/${APP_BUCKET}/${key}`);
    expect(parsed.search).not.toMatch(/prefix=|list-type|delimiter|\*/i);
    expect(parsed.origin).toBe(s.stand.endpoint);
    // Bounded life, signed and expiring: the life in the URL, the life in the body and the configured browser life agree.
    const life = Number(parsed.searchParams.get('X-Amz-Expires'));
    expect(life).toBeGreaterThan(0);
    expect(life).toBeLessThanOrEqual(3600);
    expect(Math.abs(Date.parse(expiresAt) - (Date.now() + life * 1000))).toBeLessThan(5000);
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    // Another object gets another path and another signature: a URL cannot be reused for a neighbour.
    const other = await s.call('GET', `/media/${sa.media[0]}/url`, a.token);
    expect([other.status, other.raw]).toEqual([200, expect.stringContaining('X-Amz-Signature')]);
    const otherUrl = new URL(other.body.data.url as string);
    expect(otherUrl.pathname).not.toBe(parsed.pathname);
    expect(otherUrl.searchParams.get('X-Amz-Signature')).not.toBe(
      parsed.searchParams.get('X-Amz-Signature'),
    );
    // The secret and the owner's token are never part of it.
    expect(url).not.toContain('stub-secret');
    expect(url).not.toContain(a.token);
  });

  it('refuses to sign a foreign, a missing, a processing and a rejected object, identically, and leaves no URL in the answer', async () => {
    const processing = randomUUID();
    const rejected = randomUUID();
    for (const [id, state] of [
      [processing, 'processing'],
      [rejected, 'rejected'],
    ] as const) {
      await s.pool.query(
        `insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, reject_reason) values ($1, $2, 'upload', $3, $4, 8, 'image/png', $5)`,
        [
          id,
          a.id,
          state,
          `u/${a.id}/media/${id}`,
          state === 'rejected' ? 'type_not_allowed' : null,
        ],
      );
    }
    const missing = await s.call('GET', `/media/${randomUUID()}/url`, a.token);
    for (const [label, token, id] of [
      ['foreign', b.token, sa.upload],
      ['foreign clip', b.token, sa.media[0] as string],
      ['admin', boss.token, sa.upload],
      ['anonymous', undefined, sa.upload],
    ] as const) {
      const res = await s.call('GET', `/media/${id}/url`, token, undefined);
      if (label === 'anonymous') {
        expect(res.status).toBe(401);
        continue;
      }
      expect([label, res.status, res.body.error?.code]).toEqual([
        label,
        missing.status,
        missing.body.error?.code,
      ]);
      expect(res.body.error?.message).toBe(missing.body.error?.message);
      expect(res.raw).not.toMatch(/X-Amz|https?:\/\//);
    }
    for (const id of [processing, rejected]) {
      const res = await s.call('GET', `/media/${id}/url`, a.token);
      expect(res.status, id).toBeGreaterThanOrEqual(400);
      expect(res.raw, id).not.toMatch(/X-Amz|https?:\/\//);
    }
    // Nested IDs of another user (a draft's product image, a brief job's media) are refused the same way (SECT-AZ-09).
    const draft = await s.call('POST', '/drafts', a.token, {
      productName: 'Mine',
      productMediaId: sb.upload,
    });
    expect(draft.status).toBeGreaterThanOrEqual(400);
    expect(
      await s.count('drafts', `owner_id = $1 and product_media_id = $2`, [a.id, sb.upload]),
    ).toBe(0);
  });

  it('puts no signed URL in any stored row, queue message, audit event or log line (SECT-LOG-03)', async () => {
    const res = await s.call('GET', `/media/${sa.upload}/url`, a.token);
    const search = new URL(res.body.data.url as string).search;
    expect(s.logs.join('')).not.toContain(search);
    expect(s.logs.join('')).not.toMatch(/X-Amz-Signature/i);
    const { rowsHolding } = await import('./support/stack.js');
    expect(await rowsHolding(s.pool, 'X-Amz-Signature', ['public', 'pgboss'])).toEqual({});
  });

  it("lists the bucket only in the deletion sweep, inside the subject's own prefix, and never from a request path (SECT-R2-02)", async () => {
    s.stand.requests.length = 0;
    for (const url of [
      `/media/${sa.upload}`,
      `/media/${sa.upload}/url`,
      '/campaigns',
      `/campaigns/${sa.campaign}`,
      '/drafts',
    ])
      await s.call('GET', url, a.token);
    expect(s.stand.requests.filter((r) => r.method === 'GET' && r.key === '')).toEqual([]);
  });
});
