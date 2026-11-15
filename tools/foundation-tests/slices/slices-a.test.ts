import { PgBoss } from 'pg-boss';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, evaluateFva } from './app.ts';
import { ClerkFake } from './clerk-fake.ts';
import type { FakeSession, FakeUser } from './clerk-fake.ts';
import {
  applySliceSchema,
  createSliceQueues,
  provision,
  startProcess,
  teardown,
  withClient,
} from './harness.ts';
import type { Env, Started } from './harness.ts';

const WEB_ORIGIN = 'http://web.test';
const OWNER_EMAIL = 'owner@example.test';
const log = (line: string) => console.log(`[slices-a] ${line}`);

let env: Env;
let fake: ClerkFake;
let api: Awaited<ReturnType<typeof buildApp>>;
let base = '';
let leftover: string[] | undefined;

async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    // Test helper: response bodies are asserted field by field, so they stay loosely typed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json: text ? (JSON.parse(text) as any) : null,
  };
}

const person = (email: string, verified = true) => {
  const user = fake.addUser(email, verified);
  return { user, session: fake.addSession(user.id) };
};

beforeAll(async () => {
  env = await provision();
  await applySliceSchema(env);
  createSliceQueues(env);
  fake = new ClerkFake();
  await fake.start();
  api = await buildApp({
    databaseUrl: env.urlFor('api'),
    clerkApiUrl: fake.url,
    clerkSecretKey: fake.secretKey,
    webOrigin: WEB_ORIGIN,
    ownerEmail: OWNER_EMAIL,
  });
  await api.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = api.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
  log(`database ${env.database}; slice API ${base}; Clerk fake ${fake.url} (kid ${fake.kid})`);
});

afterAll(async () => {
  await api?.close();
  await fake?.stop();
  if (env) leftover = await teardown(env);
  log(`leftovers after teardown: ${JSON.stringify(leftover ?? 'n/a')}`);
});

describe('step 3: auth slice against the local JWKS fake', () => {
  let owner: ReturnType<typeof person>;

  it('refuses a missing, malformed, foreign-key, wrong-party and expired token; allows 5 s of skew', async () => {
    owner = person(OWNER_EMAIL);
    expect((await call('GET', '/v1/me')).status).toBe(401);
    expect((await call('GET', '/v1/me', 'not.a.jwt')).status).toBe(401);
    const stranger = new ClerkFake(); // signs with a different key but the same kid layout
    expect((await call('GET', '/v1/me', stranger.mint(owner.session))).status).toBe(401);
    expect(
      (await call('GET', '/v1/me', fake.mint(owner.session, { azp: 'http://evil.test' }))).status,
    ).toBe(401);
    expect(
      (await call('GET', '/v1/me', fake.mint(owner.session, { ttlSeconds: -30 }))).status,
    ).toBe(401);
    // Expired 3 s ago: inside the 5 s clock skew, accepted (and links the owner as first admin).
    const skew = await call(
      'GET',
      '/v1/me',
      fake.mint(owner.session, { ttlSeconds: -3, fva: [1, 1] }),
    );
    expect(skew.status).toBe(200);
    log(
      'token checks: missing/garbage/foreign key/wrong azp/expired -> 401; 3 s past exp -> 200 (skew 5 s)',
    );
  });

  it('links the first admin from OWNER_EMAIL once, and only for a verified matching address', async () => {
    const me = await call('GET', '/v1/me', fake.mint(owner.session, { fva: [1, 1] }));
    expect(me.json.data).toMatchObject({ role: 'admin', mfaSatisfied: true, recentAuth: true });
    const rows = await withClient(env.urlFor('superuser'), (c) =>
      c.query('SELECT email, role FROM users'),
    );
    expect(rows.rows).toEqual([{ email: OWNER_EMAIL, role: 'admin' }]);

    const other = person('someone@example.test');
    const unverified = person(OWNER_EMAIL.replace('owner', 'owner2'), false);
    const again = person(OWNER_EMAIL.toUpperCase()); // same address, second Clerk user, admin already exists
    for (const p of [other, unverified, again]) {
      const r = await call('GET', '/v1/me', fake.mint(p.session, { fva: [1, 1] }));
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe('account_not_active');
    }
    const count = await withClient(env.urlFor('superuser'), (c) =>
      c.query('SELECT count(*)::int AS n FROM users'),
    );
    expect(count.rows[0].n).toBe(1);
    log(
      'first admin linked once; non-owner, unverified owner address and second claimant of OWNER_EMAIL -> 403 account_not_active',
    );
  });

  it('concurrent first sign-ins of the owner create exactly one admin', async () => {
    const fresh = await provision();
    try {
      await applySliceSchema(fresh);
      const f2 = new ClerkFake();
      await f2.start();
      const a2 = await buildApp({
        databaseUrl: fresh.urlFor('api'),
        clerkApiUrl: f2.url,
        clerkSecretKey: f2.secretKey,
        webOrigin: WEB_ORIGIN,
        ownerEmail: OWNER_EMAIL,
      });
      await a2.app.listen({ port: 0, host: '127.0.0.1' });
      const addr = a2.app.server.address() as { port: number };
      const users: FakeUser[] = [];
      for (let i = 0; i < 4; i++) users.push(f2.addUser(OWNER_EMAIL));
      const results = await Promise.all(
        users.map(async (u) => {
          const s: FakeSession = f2.addSession(u.id);
          const res = await fetch(`http://127.0.0.1:${addr.port}/v1/me`, {
            headers: { authorization: `Bearer ${f2.mint(s, { fva: [1, 1] })}` },
          });
          return res.status;
        }),
      );
      expect(results.filter((s) => s === 200)).toHaveLength(1);
      const n = await withClient(fresh.urlFor('superuser'), (c) =>
        c.query(`SELECT count(*)::int AS n FROM users WHERE role='admin'`),
      );
      expect(n.rows[0].n).toBe(1);
      await a2.close();
      await f2.stop();
      log(`4 concurrent claimants of OWNER_EMAIL -> statuses ${JSON.stringify(results)}; admins=1`);
    } finally {
      await teardown(fresh);
    }
  });

  it('fva semantics: mfaSatisfied = fva[1] >= 0; recentAuth within 10 min, second factor too when required', async () => {
    const cases: [[number, number], boolean, boolean, boolean][] = [
      [[1, 1], true, true, true],
      [[0, 0], true, true, true],
      [[10, 10], true, true, true],
      [[11, 3], true, false, true],
      [[3, 11], true, false, true], // first factor fresh, second stale
      [[3, -1], true, false, false], // no second factor at all
      [[3, -1], false, true, false], // not required for the actor
      [[-1, -1], false, false, false], // nothing proven
      [[20, 20], false, false, true],
    ];
    for (const [fva, required, recent, mfa] of cases) {
      const r = evaluateFva(fva, required);
      expect({ fva, required, ...r }).toEqual({
        fva,
        required,
        recentAuth: recent,
        mfaSatisfied: mfa,
      });
    }
    // Through the running API for an admin (MFA required for the actor).
    const through = async (fva: [number, number]) =>
      (await call('GET', '/v1/me', fake.mint(owner.session, { fva }))).json.data;
    expect(await through([2, 2])).toMatchObject({ mfaSatisfied: true, recentAuth: true });
    expect(await through([2, 30])).toMatchObject({ mfaSatisfied: true, recentAuth: false });
    expect(await through([2, -1])).toMatchObject({ mfaSatisfied: false, recentAuth: false });
    log(`fva matrix: ${cases.length} direct cases and 3 through the API pass`);
  });

  it('reverification: a stale session gets 403 recent_auth_required, a fresh token then succeeds', async () => {
    const stale = fake.mint(owner.session, { fva: [45, 45] });
    const refused = await call('POST', '/v1/admin/invitations', stale, {
      email: 'inv0@example.test',
    });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('recent_auth_required');
    expect(fake.invitations.size).toBe(0);
    // The browser re-verifies with Clerk (useReverification) and gets a token with fresh factors.
    const fresh = fake.mint(owner.session, { fva: [0, 0] });
    expect(
      (await call('POST', '/v1/admin/invitations', fresh, { email: 'inv0@example.test' })).status,
    ).toBe(201);
    log('stale fva [45,45] -> 403 recent_auth_required; after reverification fva [0,0] -> 201');
  });

  it('MFA is never bypassed: a first-factor-only token cannot use admin functions', async () => {
    // Stands for a session reached through a recovery path: first factor fresh, no second factor.
    const t = fake.mint(owner.session, { fva: [0, -1] });
    for (const [method, path, body] of [
      ['POST', '/v1/admin/invitations', { email: 'x@example.test' }],
      ['DELETE', '/v1/admin/invitations/inv_x', undefined],
      ['DELETE', '/v1/admin/users/00000000-0000-0000-0000-000000000000', undefined],
    ] as const) {
      const r = await call(method, path, t, body);
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe('mfa_required');
    }
    log('first-factor-only token -> 403 mfa_required on every admin route');
  });

  it('creates an invitation with expiresInDays 7 and revokes it', async () => {
    const t = fake.mint(owner.session, { fva: [0, 0] });
    const created = await call('POST', '/v1/admin/invitations', t, {
      email: 'invitee@example.test',
    });
    expect(created.status).toBe(201);
    const id = created.json.data.id as string;
    const sent = fake.calls
      .filter((c) => c.method === 'POST' && c.path === '/v1/invitations')
      .at(-1);
    expect(sent?.body).toMatchObject({ email_address: 'invitee@example.test', expires_in_days: 7 });
    expect(fake.invitations.get(id)?.expiresInDays).toBe(7);
    expect((await call('DELETE', `/v1/admin/invitations/${id}`, t)).status).toBe(204);
    expect(fake.invitations.get(id)?.status).toBe('revoked');
    expect((await call('DELETE', `/v1/admin/invitations/${id}`, t)).status).toBe(404);
    expect((await call('POST', '/v1/admin/invitations', t, { email: 'nope' })).status).toBe(400);
    log(
      `invitation ${id}: Backend API body ${JSON.stringify(sent?.body)}; revoked; second revoke -> 404`,
    );
  });

  it('a revoked session stops working at once, and deleting a user removes the account and ends its sessions', async () => {
    const member = person('member@example.test');
    const t = fake.mint(owner.session, { fva: [0, 0] });
    const memberRow = await withClient(env.urlFor('superuser'), (c) =>
      c.query(
        `INSERT INTO users (clerk_user_id, email, role) VALUES ($1, $2, 'user') RETURNING id`,
        [member.user.id, 'member@example.test'],
      ),
    );
    const memberToken = fake.mint(member.session, { fva: [1, -1] });
    expect((await call('GET', '/v1/me', memberToken)).status).toBe(200);
    // Session revoke (Clerk Backend API): the still-unexpired token is refused on the next request.
    await fetch(`${fake.url}/v1/sessions/${member.session.id}/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fake.secretKey}` },
    });
    expect((await call('GET', '/v1/me', memberToken)).status).toBe(401);
    // A non-admin cannot delete users.
    const second = person('member2@example.test');
    expect(
      (await call('DELETE', '/v1/admin/users/' + memberRow.rows[0].id, fake.mint(second.session)))
        .status,
    ).toBe(403);
    // User delete: Clerk user gone, sessions ended, row gone.
    const live = fake.addSession(member.user.id);
    const liveToken = fake.mint(live, { fva: [1, -1] });
    expect((await call('GET', '/v1/me', liveToken)).status).toBe(200);
    expect((await call('DELETE', `/v1/admin/users/${memberRow.rows[0].id}`, t)).status).toBe(204);
    expect(fake.users.has(member.user.id)).toBe(false);
    expect((await call('GET', '/v1/me', liveToken)).status).toBe(401);
    const gone = await withClient(env.urlFor('superuser'), (c) =>
      c.query('SELECT 1 FROM users WHERE id = $1', [memberRow.rows[0].id]),
    );
    expect(gone.rowCount).toBe(0);
    expect((await call('DELETE', `/v1/admin/users/${memberRow.rows[0].id}`, t)).status).toBe(404);
    log(
      'session revoke -> next request 401; user delete -> account row gone, Clerk user gone, live session 401',
    );
  });

  it('NOT_RUN against a real Clerk development instance (deployment-time owner item DOP-OI-4)', () => {
    const notRun = [
      'TR-08 fva values and reverification strict_mfa 10 min as issued by Clerk (token shape here comes from the fake)',
      'L-1 session revocation latency: Clerk session tokens are short-lived and verifyToken is networkless; this slice checks the session through the Backend API on each request',
      'D-S2 MFA recovery path that does not bypass MFA (recovery codes / backup flow) in the Clerk UI',
      'Real invitation email delivery, expiry at 7 days and acceptance, and invitation revoke semantics on Clerk',
      'Real user deletion webhook/ordering and the Clerk Pro plan "require MFA" setting',
    ];
    for (const row of notRun) log(`NOT_RUN ${row}`);
    expect(notRun.length).toBeGreaterThan(0);
  });
});

describe('step 4: owner-scoped CRUD through the real Fastify app on real PostgreSQL', () => {
  let a: string;
  let b: string;
  const ids: string[] = [];

  beforeAll(async () => {
    a = fake.mint(
      [...fake.sessions.values()].find(
        (s) => fake.users.get(s.userId)?.email === OWNER_EMAIL,
      ) as FakeSession,
      { fva: [0, 0] },
    );
    const userB = person('userb@example.test');
    await withClient(env.urlFor('superuser'), (c) =>
      c.query(
        `INSERT INTO users (clerk_user_id, email, role) VALUES ($1, 'userb@example.test', 'user')`,
        [userB.user.id],
      ),
    );
    b = fake.mint(userB.session, { fva: [1, -1] });
  });

  it('creates with the envelope, Location and ETag; validates input', async () => {
    for (let i = 1; i <= 5; i++) {
      const r = await call('POST', '/v1/campaigns', a, { name: `Campaign ${i}` });
      expect(r.status).toBe(201);
      expect(r.json).toEqual({
        data: {
          id: expect.any(String),
          name: `Campaign ${i}`,
          version: 1,
          createdAt: expect.any(String),
        },
      });
      expect(r.headers.get('location')).toBe(`/v1/campaigns/${r.json.data.id}`);
      expect(r.headers.get('etag')).toBe(`"${r.json.data.id}-v1"`);
      expect(r.headers.get('x-request-id')).toBeTruthy();
      ids.push(r.json.data.id as string);
    }
    const bad = await call('POST', '/v1/campaigns', a, { name: '' });
    expect(bad.status).toBe(400);
    expect(bad.json).toEqual({
      error: {
        code: 'validation_failed',
        message: expect.any(String),
        requestId: expect.any(String),
      },
    });
    expect((await call('GET', '/v1/campaigns', undefined)).json.error.code).toBe('unauthenticated');
  });

  it('answers 404 identically for another owner’s record and a record that does not exist', async () => {
    const real = ids[0] as string;
    const missing = '11111111-1111-4111-8111-111111111111';
    for (const [method, body] of [
      ['GET', undefined],
      ['PATCH', { name: 'x' }],
      ['DELETE', undefined],
    ] as const) {
      const other = await call(method, `/v1/campaigns/${real}`, b, body, {
        'if-match': `"${real}-v1"`,
      });
      const none = await call(method, `/v1/campaigns/${missing}`, b, body, {
        'if-match': `"${missing}-v1"`,
      });
      expect(other.status).toBe(404);
      expect(none.status).toBe(404);
      expect({ ...other.json.error, requestId: 0 }).toEqual({ ...none.json.error, requestId: 0 });
      expect(other.headers.get('etag')).toBeNull();
    }
    expect((await call('GET', '/v1/campaigns/not-a-uuid', a)).status).toBe(404);
    expect((await call('GET', '/v1/unknown', a)).status).toBe(404);
    const stillThere = await call('GET', `/v1/campaigns/${real}`, a);
    expect(stillThere.status).toBe(200);
    log(
      'another owner’s id and a missing id: identical 404 body for GET, PATCH and DELETE; the record is untouched',
    );
  });

  it('enforces If-Match: 428 without it, 412 when stale, 200 and a new version when current, one winner when racing', async () => {
    const id = ids[1] as string;
    expect((await call('PATCH', `/v1/campaigns/${id}`, a, { name: 'Renamed' })).status).toBe(428);
    const ok = await call(
      'PATCH',
      `/v1/campaigns/${id}`,
      a,
      { name: 'Renamed' },
      { 'if-match': `"${id}-v1"` },
    );
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ name: 'Renamed', version: 2 });
    expect(ok.headers.get('etag')).toBe(`"${id}-v2"`);
    const stale = await call(
      'PATCH',
      `/v1/campaigns/${id}`,
      a,
      { name: 'Late' },
      { 'if-match': `"${id}-v1"` },
    );
    expect(stale.status).toBe(412);
    expect(stale.json.error.code).toBe('precondition_failed');
    const race = await Promise.all(
      ['One', 'Two', 'Three', 'Four'].map((name) =>
        call('PATCH', `/v1/campaigns/${id}`, a, { name }, { 'if-match': `"${id}-v2"` }),
      ),
    );
    expect(race.filter((r) => r.status === 200)).toHaveLength(1);
    expect(race.filter((r) => r.status === 412)).toHaveLength(3);
    const final = await call('GET', `/v1/campaigns/${id}`, a);
    expect(final.json.data.version).toBe(3);
    log(
      `If-Match: 428 / 200 / 412; 4 racing writers -> statuses ${race
        .map((r) => r.status)
        .sort()
        .join(',')}`,
    );
  });

  it('pages with an opaque cursor: no duplicates, no gaps, scoped to the owner, bad cursor refused', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: Awaited<ReturnType<typeof call>> = await call(
        'GET',
        `/v1/campaigns?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        a,
      );
      expect(r.status).toBe(200);
      seen.push(...(r.json.data as { id: string }[]).map((x) => x.id));
      cursor = r.json.meta.nextCursor as string | null;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(ids);
    const listB = await call('GET', '/v1/campaigns', b);
    expect(listB.json).toEqual({ data: [], meta: { nextCursor: null } });
    expect((await call('GET', '/v1/campaigns?cursor=%25%25', a)).status).toBe(400);
    expect((await call('GET', '/v1/campaigns?limit=500', a)).json.data).toHaveLength(5);
    log(`cursor paging: ${pages} pages of 2 over ${seen.length} rows; other owner sees none`);
  });

  it('deletes only the owner’s record', async () => {
    const id = ids[4] as string;
    expect((await call('DELETE', `/v1/campaigns/${id}`, b)).status).toBe(404);
    expect((await call('DELETE', `/v1/campaigns/${id}`, a)).status).toBe(204);
    expect((await call('GET', `/v1/campaigns/${id}`, a)).status).toBe(404);
  });

  it('runs as app_api: no DDL, no pgboss CREATE', async () => {
    const r = await withClient(env.urlFor('api'), async (c) => {
      const out: string[] = [];
      for (const stmt of [
        'CREATE TABLE public.x (a int)',
        'CREATE TABLE pgboss.x (a int)',
        'DROP TABLE campaigns',
      ]) {
        try {
          await c.query(stmt);
          out.push('allowed');
        } catch (e) {
          out.push((e as { code?: string }).code ?? 'err');
        }
      }
      return out;
    });
    expect(r).toEqual(['42501', '42501', '42501']);
  });
});

describe('built web and api artifacts, with the slice behind them', () => {
  let apiArtifact: Started | undefined;
  let web: Started | undefined;
  afterAll(async () => {
    await Promise.all([apiArtifact?.stop(), web?.stop()]);
  });

  it('serves the built api artifact (apps/api/dist) and the built web artifact (next standalone)', async () => {
    apiArtifact = await startProcess(
      'node',
      ['apps/api/dist/main.api.js'],
      { PORT: '3811' },
      'http://127.0.0.1:3811/health/live',
    );
    const live = await (await fetch('http://127.0.0.1:3811/health/live')).json();
    expect(live).toEqual({ status: 'ok' });
    web = await startProcess(
      'node',
      ['apps/web/.next/standalone/apps/web/server.js'],
      { PORT: '3812', HOSTNAME: '127.0.0.1' },
      'http://127.0.0.1:3812/',
    );
    const home = await fetch('http://127.0.0.1:3812/');
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('Shroomap foundation');
    log(
      'built api artifact: GET /health/live -> {"status":"ok"}; built web artifact: GET / -> 200 "Shroomap foundation"',
    );
  });

  it('TC-AUT-11 (home route, unknown route) against the built web artifact', async () => {
    const missing = await fetch('http://127.0.0.1:3812/no-such-page');
    const html = await missing.text();
    expect(missing.status).toBe(404);
    const noindex =
      /<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i.test(html) ||
      (missing.headers.get('x-robots-tag') ?? '').includes('noindex');
    expect(noindex).toBe(true);
    expect(html).not.toMatch(/campaign|record/i);
    log(`TC-AUT-11: unknown route -> 404, non-indexable=${noindex}`);
    log(
      'NOT_RUN TC-AUT-11 "Go Home" action and the signed-in campaign list on `/`: the web app has only a foundation page; owned by the web tickets',
    );
  });

  it('one request path through all layers: web home, then Bearer REST call, PostgreSQL row, auth check', async () => {
    const page = await fetch('http://127.0.0.1:3812/');
    expect(page.status).toBe(200);
    const owner = [...fake.sessions.values()].find(
      (s) => fake.users.get(s.userId)?.email === OWNER_EMAIL,
    ) as FakeSession;
    const token = fake.mint(owner, { fva: [0, 0] });
    const created = await call('POST', '/v1/campaigns', token, { name: 'End to end' });
    expect(created.status).toBe(201);
    const row = await withClient(env.urlFor('superuser'), (c) =>
      c.query(
        `SELECT c.name, u.email FROM campaigns c JOIN users u ON u.id = c.owner_id WHERE c.id = $1`,
        [created.json.data.id],
      ),
    );
    expect(row.rows).toEqual([{ name: 'End to end', email: OWNER_EMAIL }]);
    expect((await call('POST', '/v1/campaigns', undefined, { name: 'x' })).status).toBe(401);
    log(
      'web artifact 200 -> Bearer POST /v1/campaigns 201 -> row owned by the linked admin; no token -> 401',
    );
    log(
      'NOT_RUN browser-driven UI leg: apps/web has no page that calls the REST API yet and no browser is installed in this environment; the web leg is the built artifact serving, the REST leg is the slice app',
    );
  });
});

describe('step 5: worker slice (pg-boss 12 on the shared PostgreSQL)', () => {
  const boss = (role: 'api' | 'worker', extra: Record<string, unknown> = {}) => {
    const b = new PgBoss({
      connectionString: env.urlFor(role),
      schema: 'pgboss',
      migrate: false,
      createSchema: false,
      max: 4,
      ...extra,
    });
    b.on('error', (e: Error) => console.error(`[slices-a] pg-boss error ${e.message}`));
    return b;
  };
  const jobCount = (name: string) =>
    withClient(env.urlFor('superuser'), async (c) =>
      Number(
        (await c.query('SELECT count(*) AS n FROM pgboss.job WHERE name = $1', [name])).rows[0].n,
      ),
    );
  const jobState = (id: string) =>
    withClient(
      env.urlFor('superuser'),
      async (c) =>
        (
          await c.query('SELECT state, retry_count, retry_limit FROM pgboss.job WHERE id = $1', [
            id,
          ])
        ).rows[0],
    );
  const pgbossJobLog = pgTable('job_log', { userId: text('user_id'), note: text('note') });
  const until = async (cond: () => Promise<boolean>, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('condition not reached');
  };

  it('send({db}) inside a Drizzle transaction rolls back with it, and commits with it', async () => {
    const b = boss('api', { supervise: false, schedule: false });
    await b.start();
    const client = new pg.Client({ connectionString: env.urlFor('api') });
    await client.connect();
    try {
      const db = drizzle(client);
      const before = await jobCount('slice-job');
      await expect(
        db.transaction(async (tx) => {
          await tx.insert(pgbossJobLog).values({ userId: 'u-rollback', note: 'in tx' });
          const id = await b.send(
            'slice-job',
            { n: 1 },
            { db: { executeSql: (t, v) => client.query(t, v as unknown[]) } },
          );
          expect(id).toBeTruthy();
          expect(await jobCountThrough(client)).toBe(before + 1); // visible inside the transaction
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await jobCount('slice-job')).toBe(before);
      const rows = await withClient(env.urlFor('superuser'), (c) =>
        c.query(`SELECT 1 FROM job_log WHERE user_id = 'u-rollback'`),
      );
      expect(rows.rowCount).toBe(0);

      await db.transaction(async (tx) => {
        await tx.insert(pgbossJobLog).values({ userId: 'u-commit', note: 'in tx' });
        await b.send(
          'slice-job',
          { n: 2 },
          { db: { executeSql: (t, v) => client.query(t, v as unknown[]) } },
        );
      });
      expect(await jobCount('slice-job')).toBe(before + 1);
      log(
        'send({db}) in a Drizzle transaction: rollback -> 0 jobs and 0 rows; commit -> 1 job and 1 row',
      );
    } finally {
      await client.end();
      await b.stop({ graceful: true });
    }
    async function jobCountThrough(c: pg.Client): Promise<number> {
      return Number(
        (await c.query(`SELECT count(*) AS n FROM pgboss.job WHERE name = 'slice-job'`)).rows[0].n,
      );
    }
  });

  it('retryLimit 0: a failing handler fails the job once and it is not retried', async () => {
    await withClient(env.urlFor('superuser'), (c) =>
      c.query(`DELETE FROM pgboss.job WHERE name = 'slice-job'`),
    );
    const b = boss('worker', { supervise: false, schedule: false });
    await b.start();
    try {
      let attempts = 0;
      await b.work('slice-job', { pollingIntervalSeconds: 0.5 }, async () => {
        attempts++;
        throw new Error('boom');
      });
      const id = (await b.send('slice-job', { n: 3 })) as string;
      await until(async () => (await jobState(id))?.state === 'failed');
      await new Promise((r) => setTimeout(r, 2500));
      expect(attempts).toBe(1);
      expect(await jobState(id)).toMatchObject({ state: 'failed', retry_count: 0, retry_limit: 0 });
      log(`retryLimit 0: handler ran ${attempts} time, job state failed, retry_count 0`);
    } finally {
      await b.stop({ graceful: true });
    }
  });

  it('expireInSeconds: an active job nobody completes is failed by supervision after the expiry', async () => {
    const b = boss('worker', { supervise: true, schedule: false });
    await b.start();
    try {
      const id = (await b.send('slice-job', { n: 4 })) as string;
      const [job] = await b.fetch('slice-job');
      expect(job?.id).toBe(id);
      expect((await jobState(id)).state).toBe('active');
      await new Promise((r) => setTimeout(r, 4000));
      await b.supervise('slice-job');
      await until(async () => (await jobState(id)).state === 'failed', 10_000);
      expect(await jobState(id)).toMatchObject({ state: 'failed', retry_count: 0 });
      log('expireInSeconds 3: fetched, never completed -> failed after supervise, not retried');
    } finally {
      await b.stop({ graceful: true });
    }
  });

  it('singletonKey: a second send with the same key on a short-policy queue is dropped until the first is fetched', async () => {
    const b = boss('api', { supervise: false, schedule: false });
    await b.start();
    try {
      const first = await b.send('slice-short', { n: 1 }, { singletonKey: 'user-1:render' });
      const dup = await b.send('slice-short', { n: 2 }, { singletonKey: 'user-1:render' });
      const other = await b.send('slice-short', { n: 3 }, { singletonKey: 'user-2:render' });
      expect(first).toBeTruthy();
      expect(dup).toBeNull();
      expect(other).toBeTruthy();
      expect(await jobCount('slice-short')).toBe(2);
      log('singletonKey: same key -> second send returns null; other key accepted; 2 jobs stored');
    } finally {
      await b.stop({ graceful: true });
    }
  });

  it('graceful drain: stop({graceful}) waits for the running handler, which completes its job', async () => {
    await withClient(env.urlFor('superuser'), (c) =>
      c.query(`DELETE FROM pgboss.job WHERE name = 'slice-short'`),
    );
    const b = boss('worker', { supervise: false, schedule: false });
    await b.start();
    let started = false;
    let finished = false;
    await b.work('slice-short', { pollingIntervalSeconds: 0.5 }, async () => {
      started = true;
      await new Promise((r) => setTimeout(r, 2000));
      finished = true;
    });
    const id = (await b.send('slice-short', { n: 9 }, { singletonKey: 'drain' })) as string;
    await until(async () => started);
    const t0 = Date.now();
    await b.stop({ graceful: true, timeout: 15_000 });
    const waited = Date.now() - t0;
    expect(finished).toBe(true);
    expect(waited).toBeGreaterThan(500);
    expect((await jobState(id)).state).toBe('completed');
    log(
      `graceful drain: stop() returned after ${waited} ms with the handler finished and the job completed`,
    );
  });

  it('counted per-user claim: at most N concurrent claims per user, released claims free a slot, users are independent', async () => {
    const pool = new pg.Pool({ connectionString: env.urlFor('worker'), max: 12 });
    const limit = 3;
    const claim = async (user: string) =>
      (
        await pool.query(
          `INSERT INTO user_claims (user_id, active) VALUES ($1, 1)
           ON CONFLICT (user_id) DO UPDATE SET active = user_claims.active + 1
           WHERE user_claims.active < $2 RETURNING active`,
          [user, limit],
        )
      ).rowCount === 1;
    const release = (user: string) =>
      pool.query('UPDATE user_claims SET active = active - 1 WHERE user_id = $1 AND active > 0', [
        user,
      ]);
    try {
      const wins = await Promise.all(Array.from({ length: 10 }, () => claim('u1')));
      expect(wins.filter(Boolean)).toHaveLength(limit);
      expect(await claim('u2')).toBe(true);
      expect(await claim('u1')).toBe(false);
      await release('u1');
      expect(await claim('u1')).toBe(true);
      const active = await pool.query(`SELECT user_id, active FROM user_claims ORDER BY user_id`);
      expect(active.rows).toEqual([
        { user_id: 'u1', active: 3 },
        { user_id: 'u2', active: 1 },
      ]);
      // The claim is part of the caller's transaction: a rollback gives the slot back.
      const c = await pool.connect();
      await c.query('BEGIN');
      await c.query(`INSERT INTO user_claims (user_id, active) VALUES ('u3', 1)`);
      await c.query('ROLLBACK');
      c.release();
      expect((await pool.query(`SELECT 1 FROM user_claims WHERE user_id = 'u3'`)).rowCount).toBe(0);
      log(
        `counted claim: 10 concurrent claims, limit ${limit} -> ${wins.filter(Boolean).length} won; release frees one slot; u2 independent`,
      );
    } finally {
      await pool.end();
    }
  });

  it('runs as app_worker/app_api with USAGE and DML only; jobs:migrate created the queues', async () => {
    const r = await withClient(env.urlFor('worker'), async (c) => {
      const q = await c.query(`SELECT name FROM pgboss.queue WHERE name LIKE 'slice-%' ORDER BY 1`);
      let ddl = 'allowed';
      try {
        await c.query('CREATE TABLE pgboss.nope (a int)');
      } catch (e) {
        ddl = (e as { code?: string }).code ?? 'err';
      }
      return { queues: q.rows.map((x) => x.name), ddl };
    });
    expect(r).toEqual({ queues: ['slice-job', 'slice-short'], ddl: '42501' });
  });
});
