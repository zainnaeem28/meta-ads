import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { send } from './support/cells.js';
import { FAKE_KEY } from './support/requests.js';
import * as fx from './support/fixtures.js';
import { isAdmin, isGuarded, operations } from './support/spec.js';
import { baseClaims, forgedTokens, signedWith } from './support/tokens.js';
import { openDefect } from '../security/support/stack.js';
import { bootWorld } from './support/world.js';
import type { Account, World } from './support/world.js';

// TC-ZT-01 (forged, expired, wrong-audience and invalid tokens), TC-ZT-02 (over-privileged identity), TC-ZT-04 (injection),
// TC-ZT-06 (mass assignment), TC-AUT-13, TC-AUT-12: against every guarded operation of the running app.

let w: World;
let user: Account;
let victim: Account;
let boss: Account;
beforeAll(async () => {
  w = await bootWorld('t65zt');
  user = await w.account('zt');
  victim = await w.account('victim');
  boss = await w.admin('zt-boss');
}, 300_000);
afterAll(async () => { await w?.close(); });

const guarded = operations().filter(isGuarded);
const TABLES = ['users', 'campaigns', 'drafts', 'media_objects', 'brief_jobs', 'video_jobs', 'assembly_jobs', 'provider_keys', 'invitations', 'access_requests', 'platform_settings'];
const state = async (): Promise<string> => {
  const parts: string[] = [];
  for (const table of TABLES) parts.push(`${table}:${String((await w.pool.query(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h from ${table} t`)).rows[0].h)}`);
  return parts.join(',');
};

describe('forged and invalid tokens are 401 on every guarded operation with no state change (TC-ZT-01, TC-AUT-13)', () => {
  it('twelve forged shapes x every guarded operation', async () => {
    const forged = forgedTokens(w, user, victim);
    expect(Object.keys(forged).length).toBeGreaterThanOrEqual(12);
    const before = await state();
    for (const [name, token] of Object.entries(forged)) {
      for (const op of guarded) {
        const res = await send(w, op, token === '' ? undefined : token);
        expect([name, op.id, res.status, res.code]).toEqual([name, op.id, 401, 'unauthenticated']);
      }
    }
    expect(await state(), 'a refused call changed state').toBe(before);
  });

  openDefect('CONF065-F6', 'a 401 carries WWW-Authenticate: Bearer (components.responses.Unauthenticated)', async () => {
    const res = await send(w, guarded[0] as (typeof guarded)[number], undefined);
    expect(res.status).toBe(401);
    expect(String(res.headers['www-authenticate'])).toMatch(/^Bearer/i);
  });

  it('the same identity with a good token is served (the refusals were the tokens, not the account)', async () => {
    expect((await w.call('GET', '/me', user.token)).status).toBe(200);
  });
});

describe('an over-privileged identity is held to the role in the database (TC-ZT-02)', () => {
  it('a user token carrying admin claims in every shape is refused on every administrator operation', async () => {
    const adminOps = operations().filter(isAdmin);
    expect(adminOps.length).toBeGreaterThan(15);
    const shapes: Record<string, Record<string, unknown>> = {
      role: { role: 'admin' },
      'public metadata': { public_metadata: { role: 'admin' } },
      'private metadata': { metadata: { role: 'admin', admin: true } },
      organisation: { org_role: 'org:admin', o: { rol: 'admin' } },
      scope: { scope: 'admin', scp: ['admin'], permissions: ['admin'] },
      flag: { admin: true, is_admin: true, isAdmin: true },
    };
    for (const [name, extra] of Object.entries(shapes)) {
      const token = signedWith(w, baseClaims(w, user, extra));
      for (const op of adminOps) {
        const res = await send(w, op, token);
        expect([name, op.id, res.status, res.code]).toEqual([name, op.id, 403, 'forbidden_role']);
      }
    }
  });

  it('forged identity headers and body fields widen nothing', async () => {
    const headers = { 'x-role': 'admin', 'x-user-role': 'admin', 'x-user-id': victim.id, 'x-tenant-id': victim.id, 'x-forwarded-user': 'admin', 'x-owner-id': victim.id };
    for (const op of operations().filter(isAdmin)) {
      const res = await send(w, op, user.token, { extra: headers });
      expect([op.id, res.status, res.code]).toEqual([op.id, 403, 'forbidden_role']);
    }
    const me = await w.call('GET', '/me', user.token, undefined, headers);
    expect(me.body.data.id).toBe(user.id);
  });

  it('a stale administrator token after demotion is refused on the very next request, on every administrator operation', async () => {
    const former = await w.admin('former');
    expect((await w.call('GET', '/admin/users', former.token)).status).toBe(200);
    await w.pool.query(`update users set role = 'user' where id = $1`, [former.id]);
    for (const op of operations().filter(isAdmin)) {
      const res = await send(w, op, former.token);
      expect([op.id, res.status, res.code]).toEqual([op.id, 403, 'forbidden_role']);
    }
  });

  openDefect('SEC116-F2', 'an administrator token with an old sign-in is refused recent_auth_required on every administrator operation (scope A promises a recent sign-in)', async () => {
    const stale = w.local.issueToken({ sub: boss.sub, azp: 'http://localhost:3000', fva: [600, 600] });
    for (const op of operations().filter(isAdmin)) {
      const res = await send(w, op, stale);
      expect([op.id, res.status, res.code]).toEqual([op.id, 403, 'recent_auth_required']);
    }
  });
});

describe('input is data (TC-ZT-04)', () => {
  const needles = ["' OR '1'='1", "'; drop table users; --", '%', '_', '\\', '" or ""="', '${jndi:ldap://x}', '<script>alert(1)</script>', '%27%20OR%201=1', 'a%00b'];
  it('search text that is SQL, a wildcard or markup finds nothing it should not and breaks nothing', async () => {
    await fx.campaign(w, user);
    await fx.campaign(w, victim);
    for (const needle of needles.filter((n) => n.length >= 2)) {
      const res = await w.call('GET', `/campaigns?q=${encodeURIComponent(needle)}`, user.token);
      expect([needle, res.status]).toEqual([needle, 200]);
      expect(JSON.stringify(res.body.data), needle).not.toContain(victim.id);
    }
    const wildcard = await w.call('GET', `/campaigns?q=${encodeURIComponent('%%')}`, user.token);
    expect(wildcard.body.data, 'a wildcard is text, not a match-all').toEqual([]);
    expect((await w.pool.query(`select count(*)::int as n from users`)).rows[0].n).toBeGreaterThan(3);
  });

  it('a filter, a cursor and a limit that are SQL are refused as invalid shapes; the list has no sort key to inject into', async () => {
    const ignored = await w.call('GET', '/campaigns?sort=created_at;drop table users', user.token);
    expect(ignored.status, 'an unknown query name is not read').toBe(200);
    for (const query of ["filter=' or 1=1", "cursor=' or 1=1 --", "limit=1;select 1"]) {
      const res = await w.call('GET', `/campaigns?${query}`, user.token);
      expect([query, res.status, res.body.error?.code, res.raw.slice(0, 100)]).toEqual([query, 400, 'validation_failed', res.raw.slice(0, 100)]);
    }
  });

  it('stored markup comes back as the same JSON text, never as a page, with nosniff', async () => {
    const markup = '<img src=x onerror=alert(1)>"\'</script><svg/onload=alert(1)>';
    const made = await w.call('POST', '/drafts', user.token, { productName: markup, concept: markup });
    expect(made.status).toBe(201);
    const read = await w.call('GET', `/drafts/${made.body.data.id}`, user.token);
    expect(read.body.data.productName).toBe(markup);
    expect(String(read.headers['content-type'])).toContain('application/json');
    expect(read.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('closed DTOs: no field the contract does not name is applied (TC-ZT-06)', () => {
  const fields = { role: 'admin', owner_id: '00000000-0000-0000-0000-000000000001', ownerId: '00000000-0000-0000-0000-000000000001', status: 'removed', campaign_id: '00000000-0000-0000-0000-000000000002', campaignId: '00000000-0000-0000-0000-000000000002', key_id: '00000000-0000-0000-0000-000000000003', version: 99 };
  it('every extra field on API-023, 051, 011 and 104 is 400 validation_failed and nothing is applied', async () => {
    const draft = (await w.call('POST', '/drafts', user.token, { productName: 'Mass' })).body.data;
    const c = await fx.campaign(w, user, { briefState: 'draft' });
    const target = await w.account('mass-target');
    const before = await state();
    for (const [name, value] of Object.entries(fields)) {
      const cases: [string, string, unknown, Record<string, string>][] = [
        ['PATCH', `/drafts/${draft.id}`, { productName: 'Changed', [name]: value }, { 'if-match': '"1"' }],
        ['PATCH', `/campaigns/${c.id}/brief`, { segments: [{ position: 1, dialogue: 'Changed line.' }], [name]: value }, { 'if-match': '"1"' }],
        ['PUT', '/me/provider-keys/openai', { apiKey: FAKE_KEY, [name]: value }, {}],
      ];
      for (const [method, path, body, extra] of cases) {
        const res = await w.call(method as 'PATCH', path, user.token, body, extra);
        expect([name, method, path, res.status, res.body.error?.code]).toEqual([name, method, path, 400, 'validation_failed']);
      }
      const role = await w.call('PUT', `/admin/users/${target.id}/role`, boss.token, { ...(name === 'role' ? { roles: ['admin'] } : { role: 'admin', [name]: value }) }, { 'if-match': '"1"' });
      expect([name, role.status, role.body.error?.code]).toEqual([name, 400, 'validation_failed']);
    }
    expect(await state()).toBe(before);
  });

  it('a body that is not an object, and unknown fields in a create, are refused as well', async () => {
    for (const body of [[], 'text', 42, null]) {
      const res = await w.raw('POST', '/api/v1/drafts', { authorization: `Bearer ${user.token}`, 'content-type': 'application/json' }, JSON.stringify(body));
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
    }
    expect((await w.call('POST', '/drafts', user.token, { productName: 'X', ownerId: victim.id })).status).toBe(400);
  });
});
