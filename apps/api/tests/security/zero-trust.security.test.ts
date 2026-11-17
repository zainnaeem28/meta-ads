import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openApiOperations, seedSubject } from './support/data.js';
import { ORIGIN, bootStack, openDefect } from './support/stack.js';
import type { Account, Stack } from './support/stack.js';

// TASK-116: SECT-ZT-01, 02, 03, 05, 06; SECT-AZ-10, 11, 13; SECT-AUTH-05, 06; TC-ZT-01, 02, 03, 06, TC-AUT-12, 13: the
// zero-trust revocation matrix. Every operation of the OpenAPI file (generated: ID, method, path, scope) is called as an
// anonymous caller, with an expired token, as a suspended, a removed and a demoted user, as an unlinked identity, with the
// identity provider down, and with forged identity fields. The role and the status come from the database on every request.

let s: Stack;
let ops: ReturnType<typeof openApiOperations>;

/** The operations of the OpenAPI file that the running app routes (a slice that is not built yet has no route to test). */
const routed = (op: { method: string; path: string }) => s.index.match(op.method, `/api/v1${urlOf(op.path)}`).kind === 'found';
const guarded = () => ops.filter((op) => !op.scopes.includes('Pub') && !op.scopes.includes('M') && routed(op));
const urlOf = (path: string) => path.replace(/\{position\}/g, '1').replace(/\{provider\}/g, 'openai').replace(/\{[^}]+\}/g, () => randomUUID());
const BODY: Record<string, unknown> = {};

async function hit(op: { method: string; path: string }, token: string | undefined, extra: Record<string, string> = {}) {
  const payload = op.method === 'GET' || op.method === 'DELETE' ? undefined : BODY;
  return s.call(op.method as 'GET', urlOf(op.path), token, payload, extra);
}

beforeAll(async () => {
  s = await bootStack('t116zt');
  ops = openApiOperations();
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe('identity is checked on every operation (SECT-AUTH-05, TC-ZT-01)', () => {
  it('refuses an anonymous caller, a cookie, other schemes and other credentials on every guarded operation with 401', async () => {
    expect(guarded().length).toBeGreaterThan(35);
    const user = await s.account('anon');
    for (const op of guarded()) {
      const none = await hit(op, undefined);
      expect([op.id, none.status, none.body.error?.code], 'anonymous').toEqual([op.id, 401, 'unauthenticated']);
      for (const headers of [
        { cookie: `__session=${user.token}; session=${user.token}` },
        { authorization: `Basic ${Buffer.from(`${user.sub}:x`).toString('base64')}` },
        { authorization: `Token ${user.token}` },
        { 'x-api-key': user.token },
        { 'x-service-token': 'internal', 'x-internal-jwt': user.token },
      ]) {
        const res = await s.app.getHttpAdapter().getInstance().inject({ method: op.method as 'GET', url: `/api/v1${urlOf(op.path)}`, headers, ...(op.method === 'GET' || op.method === 'DELETE' ? {} : { payload: BODY }) });
        expect([op.id, Object.keys(headers)[0], res.statusCode], 'no other credential is accepted').toEqual([op.id, Object.keys(headers)[0], 401]);
      }
      const query = await s.app.getHttpAdapter().getInstance().inject({ method: op.method as 'GET', url: `/api/v1${urlOf(op.path)}?access_token=${user.token}&token=${user.token}`, ...(op.method === 'GET' || op.method === 'DELETE' ? {} : { payload: BODY }) });
      expect([op.id, query.statusCode], 'a token in the query string').toEqual([op.id, 401]);
    }
  });

  it('refuses expired, not-yet-valid, wrong-party and unknown-key tokens with 401 on every guarded operation', async () => {
    const user = await s.account('expiry');
    const now = Math.floor(Date.now() / 1000);
    const bad = {
      expired: s.local.issueToken({ sub: user.sub, azp: ORIGIN, fva: [1, 1], iat: now - 600, ttlSeconds: 60 }),
      notYetValid: s.local.issueToken({ sub: user.sub, azp: ORIGIN, fva: [1, 1], iat: now + 3600 }),
      wrongParty: s.local.issueToken({ sub: user.sub, azp: 'https://evil.example.com', fva: [1, 1] }),
      wrongIssuer: s.local.issueToken({ sub: user.sub, azp: ORIGIN, fva: [1, 1], issuer: 'https://other-issuer.invalid' }),
      unknownKey: s.local.issueToken({ sub: user.sub, azp: ORIGIN, fva: [1, 1], kid: 'not-a-key' }),
    };
    for (const [name, token] of Object.entries(bad)) {
      for (const op of guarded()) {
        const res = await hit(op, token);
        expect([name, op.id, res.status, res.body.error?.code]).toEqual([name, op.id, 401, 'unauthenticated']);
      }
    }
    // The same identity with a fresh token is fine: the refusals above are the token's, not the account's.
    expect((await s.call('GET', '/me', user.token)).status).toBe(200);
  });

  it('fails closed with the identity provider down: no operation answers success without a verified token (SECT-ZT-06, SECT-AUTH-04)', async () => {
    const user = await s.account('outage');
    s.local.available = false;
    try {
      for (const op of guarded()) {
        const res = await hit(op, user.token);
        expect(res.status, `${op.id} must not succeed`).toBeGreaterThanOrEqual(401);
        expect([401, 503], `${op.id}`).toContain(res.status);
        expect(res.body.success).toBe(false);
      }
    } finally {
      s.local.available = true;
    }
    expect((await s.call('GET', '/me', user.token)).status).toBe(200);
  });
});

describe('role and status are read from the database on every request (SECT-AZ-13, SECT-ZT-02, TC-AUT-12, 13)', () => {
  it('a suspended user is refused on the next request on every guarded operation, an administrator included, and reinstating restores it', async () => {
    const boss = await s.admin('zt-boss');
    const victim = await s.account('suspended');
    const adminVictim = await s.admin('suspended-admin');
    expect((await s.call('GET', '/campaigns', victim.token)).status).toBe(200);
    for (const target of [victim, adminVictim]) expect((await s.call('POST', `/admin/users/${target.id}/suspend`, boss.token)).status).toBe(200);
    for (const target of [victim, adminVictim]) {
      for (const op of guarded()) {
        const res = await hit(op, target.token);
        expect([op.id, res.status, res.body.error?.code]).toEqual([op.id, 403, 'account_suspended']);
      }
    }
    // The session revocation is queued with the status change (never called from the API), and the audit trail says who did it.
    expect(await s.count('pgboss.job', `name = 'identity.revoke-sessions' and data->>'userId' = $1`, [victim.id])).toBe(1);
    expect(await s.count('audit_events', `action = 'account.suspended' and object_id = $1 and actor_id = $2`, [victim.id, boss.id])).toBe(1);
    expect((await s.call('POST', `/admin/users/${victim.id}/reinstate`, boss.token)).status).toBe(200);
    expect((await s.call('GET', '/campaigns', victim.token)).status).toBe(200);
  });

  openDefect('SEC116-F1', 'the worker handles identity.revoke-sessions: a suspended user\'s provider sessions are ended (SECT-ID-02, SECT-AUTH-06)', async () => {
    const boss = await s.admin('zt-boss-rev');
    const victim = await s.account('revoked');
    expect((await s.call('POST', `/admin/users/${victim.id}/suspend`, boss.token)).status).toBe(200);
    await s.until(async () => s.workerIdentity.sessionRevocations.includes(victim.sub), 'the provider session revocation', 8_000);
  });

  it('a removed user is refused on the next request with account_removed on every guarded operation', async () => {
    const boss = await s.admin('zt-boss2');
    const victim = await s.account('removed');
    await seedSubject(s, victim, 'zt-rm-0001');
    expect((await s.call('GET', '/campaigns', victim.token)).status).toBe(200);
    expect((await s.call('POST', `/admin/users/${victim.id}/remove`, boss.token, { confirmation: victim.email })).status).toBe(202);
    for (const op of guarded()) {
      const res = await hit(op, victim.token);
      expect([op.id, res.status, res.body.error?.code]).toEqual([op.id, 403, 'account_removed']);
    }
  });

  it('a role change takes effect on the next request in both directions, and a user token carrying an admin hint stays a user', async () => {
    const person = await s.account('rolechange');
    const adminOps = guarded().filter((op) => op.scopes.includes('A'));
    expect(adminOps.length).toBeGreaterThan(15);
    const refusals = async (token: string) => {
      const codes: Record<string, string | undefined> = {};
      for (const op of adminOps) codes[op.id] = (await hit(op, token)).body.error?.code;
      return codes;
    };
    for (const [id, code] of Object.entries(await refusals(person.token))) expect([id, code]).toEqual([id, 'forbidden_role']);
    await s.pool.query(`update users set role = 'admin' where id = $1`, [person.id]);
    for (const [id, code] of Object.entries(await refusals(person.token))) expect([id, code], 'promoted: the role check passes').not.toEqual([id, 'forbidden_role']);
    await s.pool.query(`update users set role = 'user' where id = $1`, [person.id]);
    for (const [id, code] of Object.entries(await refusals(person.token))) expect([id, code], 'demoted: refused again on the very next request').toEqual([id, 'forbidden_role']);
    // Forged identity fields and headers do not widen anything (SECT-ZT-01, SECT-AZ-10).
    const forged = { 'x-role': 'admin', 'x-user-role': 'admin', 'x-user-id': randomUUID(), 'x-tenant-id': randomUUID(), 'x-forwarded-user': 'admin', 'x-internal-user': 'admin', 'x-owner-id': randomUUID() };
    for (const op of adminOps) {
      const res = await hit(op, person.token, forged);
      expect([op.id, res.body.error?.code]).toEqual([op.id, 'forbidden_role']);
    }
  });

  it('an unlinked identity reaches only API-001 and API-002; the rest answer 403 not_linked (SECT-AZ-11)', async () => {
    const sub = `user_t116_unlinked_${randomUUID().slice(0, 8)}`;
    s.local.addUser(sub, 'stranger.person@elsewhere.test', true);
    const token = s.local.issueToken({ sub, azp: ORIGIN, fva: [1, 1] });
    for (const op of guarded()) {
      const res = await hit(op, token);
      if (op.scopes.includes('T')) expect([op.id, res.status === 403 && res.body.error?.code === 'not_linked'], 'the token-only operations').toEqual([op.id, false]);
      else expect([op.id, res.status, res.body.error?.code]).toEqual([op.id, 403, 'not_linked']);
    }
    expect(await s.count('users', 'idp_subject = $1', [sub])).toBe(0);
  });
});

describe('forged identity in a body, a query or a path never widens access (SECT-AZ-10, TC-ZT-06)', () => {
  it('ignores or rejects role, owner, status, userId and tenant fields, and never lists another user\'s rows', async () => {
    const a = await s.account('forge-a');
    const b = await s.account('forge-b');
    const seeded = await seedSubject(s, b, 'zt-forge-b');
    const attempts = [
      { ownerId: b.id }, { owner_id: b.id }, { userId: b.id }, { role: 'admin' }, { status: 'active' }, { campaign_id: seeded.campaign }, { key_id: randomUUID() },
    ];
    for (const extra of attempts) {
      const res = await s.call('POST', '/drafts', a.token, { productName: 'Mine', ...extra });
      expect([JSON.stringify(extra), res.status], 'closed DTO').toEqual([JSON.stringify(extra), 400]);
      expect(res.body.error?.code).toBe('validation_failed');
    }
    expect(await s.count('drafts', 'owner_id = $1', [a.id])).toBe(0);
    for (const url of [`/campaigns?ownerId=${b.id}`, `/campaigns?userId=${b.id}&role=admin`, `/drafts?owner_id=${b.id}`, `/media/${seeded.upload}`, `/campaigns/${seeded.campaign}`]) {
      const res = await s.call('GET', url, a.token, undefined, { 'x-user-id': b.id, 'x-owner-id': b.id });
      const text = JSON.stringify(res.body);
      expect(text, url).not.toContain(seeded.canaries.productName);
      expect(text, url).not.toContain(seeded.upload);
      expect(text, url).not.toContain(b.email);
    }
    expect(await s.count('users', `id = $1 and role = 'user' and status = 'active'`, [a.id])).toBe(1);
    expect((await s.call('PUT', `/admin/users/${a.id}/role`, a.token, { role: 'admin' })).body.error?.code).toBe('forbidden_role');
  });

  it('answers a foreign and a missing object identically: same status, same body shape, same headers, nothing leaks (SECT-AZ-04, TC-ZT-03)', async () => {
    const a = await s.account('own-a');
    const b = await s.account('own-b');
    const seeded = await seedSubject(s, b, 'zt-own-b');
    const idOps = guarded().filter((op) => op.scopes.includes('U') && !op.scopes.includes('A') && /\{(mediaId|campaignId|draftId|videoJobId)\}/.test(op.path) && !op.path.includes('{position}'));
    expect(idOps.length).toBeGreaterThan(10);
    const real: Record<string, string> = { '{mediaId}': seeded.upload, '{campaignId}': seeded.campaign };
    let compared = 0;
    for (const op of idOps) {
      const placeholder = Object.keys(real).find((p) => op.path.includes(p));
      if (placeholder === undefined) continue;
      const foreignPath = op.path.replace(placeholder, real[placeholder] as string);
      const missingPath = op.path.replace(placeholder, randomUUID());
      const call = (path: string) => s.call(op.method as 'GET', urlOf(path), a.token, op.method === 'GET' || op.method === 'DELETE' ? undefined : BODY);
      const foreign = await call(foreignPath);
      const missing = await call(missingPath);
      expect([op.id, foreign.status, foreign.body.error?.code]).toEqual([op.id, missing.status, missing.body.error?.code]);
      expect(foreign.body.error?.message, op.id).toBe(missing.body.error?.message);
      expect(Object.keys(foreign.headers).sort(), op.id).toEqual(Object.keys(missing.headers).sort());
      expect(foreign.raw.includes(seeded.campaign) || foreign.raw.includes(seeded.upload), op.id).toBe(false);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(5);
    // Nothing was changed by the foreign attempts.
    expect(await s.count('campaigns', `id = $1 and state = 'active'`, [seeded.campaign])).toBe(1);
    expect(await s.count('media_objects', 'owner_id = $1', [b.id])).toBe(3);
    // An administrator gets no role-based read of a user's content (SECT-AZ-02).
    const boss = await s.admin('zt-boss3');
    for (const url of [`/campaigns/${seeded.campaign}`, `/media/${seeded.upload}`, `/media/${seeded.upload}/url`, `/campaigns/${seeded.campaign}/brief`]) {
      const res = await s.call('GET', url, boss.token);
      expect([url, res.status, res.body.error?.code]).toEqual([url, 404, 'not_found']);
    }
  });
});
