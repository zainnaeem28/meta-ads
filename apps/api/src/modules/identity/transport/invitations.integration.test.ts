/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles; prettier reflow detached the per-line directives (AIU-256) */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiApp } from '../../../bootstrap/api.module.js';
import { createWorkerApp } from '../../../bootstrap/worker.module.js';
import type { WorkerApp } from '../../../bootstrap/worker.module.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../../platform/db/test-database.js';
import type { TestDatabase } from '../../../platform/db/test-database.js';
import { createRuntimeBoss, startRuntimeBoss } from '../../../platform/jobs/boss.js';
import { installJobs } from '../../../platform/jobs/test-support.js';
import { buildLogger, createHttpLogging } from '../../../platform/logging/index.js';
import { IDENTITY_PORT, IdentityUnavailable, InvitationJobs } from '../index.js';
import type { IdentityPort, LocalIdentity } from '../index.js';

// TASK-036 through the real api composition root (`createApiApp`, the one `main.api.ts` runs) and the real worker
// composition root (`createWorkerApp`) on real PostgreSQL, with `fastify.inject`: API-110..113, the send states, the
// replace rule, the hourly `identity.expire-invitations` job, and the canary check of SECT-AUTH-14.
// TC-INV-01..09, TC-ACC invitation cases (TC-ACC-05, TC-ACC-11).

const ORIGIN = 'http://localhost:3000';
const OWNER = 'owner@example.test';
const CANARY = 'CANARYTICKET';

let testDb: TestDatabase;
let app: Awaited<ReturnType<typeof createApiApp>>['app'];
let worker: WorkerApp;
let local: LocalIdentity;
let workerIdentity: LocalIdentity;
let pool: pg.Pool;
let seq = 0;
let provider = 0;
const logLines: string[] = [];

async function applyBeforeGrants(file: string, only?: RegExp): Promise<void> {
  const sql = readFileSync(join(REAL_MIGRATIONS, file), 'utf8').split('-- Grants')[0] ?? '';
  for (const statement of sql.split('--> statement-breakpoint')) {
    const text = statement.trim();
    if (text !== '' && (only === undefined || only.test(text))) await pool.query(text);
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase({ label: 'task036', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 4 });
  await applyBeforeGrants(
    '0001_task-025-platform.sql',
    /^(CREATE TABLE|CREATE INDEX) "(idempotency_records|rate_limit_buckets|idempotency_records_expiry_idx)/,
  );
  await applyBeforeGrants('0010_task-032-audit.sql');
  await applyBeforeGrants('0020_task-033-identity.sql');
  await installJobs(testDb.url);
  process.env['OWNER_EMAIL'] = OWNER;
  process.env['INVITE_EMAIL_DOMAINS'] = 'example.test';
  process.env['CURSOR_SIGNING_KEY'] = 'c'.repeat(40);
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logLines.push(chunk.toString('utf8'));
      done();
    },
  });
  ({ app } = await createApiApp(
    {
      WEB_ORIGIN: ORIGIN,
      APP_ENV: 'development',
      DATABASE_URL: testDb.url,
      DATABASE_POOL_MAX: 8,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      RATE_LIMIT_IP_KEY: 'r'.repeat(40),
    },
    createHttpLogging({ level: 'info', destination: sink }),
  ));
  local = app.get<IdentityPort>(IDENTITY_PORT, { strict: false }) as LocalIdentity;
  // The provider answers with a handle that carries the canary: it must never reach a response, a row's public
  // columns, an audit event or a log line.
  local.createInvitation = async (email: string, expiresInDays: number) => {
    await assertNoOpenTransaction();
    provider += 1;
    const id = `inv_${CANARY}${String(provider)}`;
    local.invitations.set(id, { id, email, expiresInDays, revoked: false });
    return id;
  };
  worker = await createWorkerApp(
    {
      DATABASE_URL: testDb.url,
      DATABASE_POOL_MAX: 4,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      WORKER_WATCHDOG_SECONDS: 180,
      WORKER_DRAIN_SECONDS: 5,
    },
    {
      logger: buildLogger({ level: 'silent' }).logger,
      env: { APP_ENV: 'development', WEB_ORIGIN: ORIGIN },
    },
  );
  workerIdentity = worker.context.get<IdentityPort>(IDENTITY_PORT, {
    strict: false,
  }) as LocalIdentity;
});

// Each test starts with empty rate-limit windows (the 20 per hour limit has its own test).
beforeEach(async () => {
  await pool.query('delete from rate_limit_buckets');
});

afterAll(async () => {
  for (const key of ['OWNER_EMAIL', 'INVITE_EMAIL_DOMAINS', 'CURSOR_SIGNING_KEY'])
    delete process.env[key];
  await worker?.runtime.drain().catch(() => undefined);
  await worker?.context.close().catch(() => undefined);
  await app?.close();
  await pool?.end();
  await testDb?.drop();
});

/** No provider call may run inside an open transaction (ARCHITECTURE 1.5): no session of this database is idle in one. */
async function assertNoOpenTransaction(): Promise<void> {
  const rows = await pool.query(
    `select count(*)::int as n from pg_stat_activity
      where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()`,
  );
  expect((rows.rows[0] as { n: number }).n).toBe(0);
}

type Body = { success: boolean; data?: any; error?: { code: string }; metaData?: any };
const fastify = () => app.getHttpAdapter().getInstance();
async function call(method: 'GET' | 'POST', url: string, token?: string, payload?: unknown) {
  const res = await fastify().inject({
    method,
    url: `/api/v1${url}`,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, text: res.body, body: res.json() as Body };
}
const code = (r: { body: Body }) => r.body.error?.code;
function person(email: string, verified = true): { sub: string; email: string } {
  const sub = `user_t36_${String(++seq)}`;
  local.addUser(sub, email, verified);
  return { sub, email };
}
const token = (sub: string) => local.issueToken({ sub, azp: ORIGIN, fva: [1, 1] });
const count = async (sql: string, params: unknown[] = []) =>
  Number(((await pool.query(sql, params)).rows[0] as { n: string }).n);
const row = async (email: string) =>
  (
    await pool.query('select * from invitations where lower(email) = $1 order by created_at desc', [
      email,
    ])
  ).rows as any[];

let adminToken: string;
let adminId: string;
let memberToken: string;

async function newAdmin(label: string): Promise<{ token: string; id: string }> {
  const p = person(`${label}@example.test`);
  const id = (
    await pool.query(
      `insert into users (id, idp_subject, email, role, linked_via) values (gen_random_uuid(), $1, $2, 'admin', 'first_admin') returning id`,
      [p.sub, p.email],
    )
  ).rows[0].id as string;
  return { token: token(p.sub), id };
}

describe('setup: a first admin and an invited member', () => {
  it('links the owner as admin, and an invited address becomes an active account with role user', async () => {
    const owner = person(OWNER);
    adminToken = token(owner.sub);
    const me = await call('GET', '/me', adminToken);
    expect(me.body.data).toMatchObject({ linkState: 'linked', role: 'admin' });
    adminId = (await pool.query('select id from users where idp_subject = $1', [owner.sub])).rows[0]
      .id as string;

    const invite = await call('POST', '/admin/invitations', adminToken, {
      email: 'Member@Example.test ',
    });
    expect(invite.status).toBe(202);
    const member = person('member@example.test');
    memberToken = token(member.sub);
    const linked = await call('GET', '/me', memberToken);
    expect(linked.body.data).toMatchObject({ linkState: 'linked', role: 'user' });
    expect(
      (await pool.query('select status, role from users where idp_subject = $1', [member.sub]))
        .rows[0],
    ).toEqual({
      status: 'active',
      role: 'user',
    });
    expect((await row('member@example.test'))[0].state).toBe('accepted');
  });
});

describe('authorization and validation', () => {
  it('refuses anonymous 401, a member 403 forbidden_role (audited), bad bodies and ids 400', async () => {
    expect((await call('GET', '/admin/invitations')).status).toBe(401);
    expect(
      (await call('POST', '/admin/invitations', undefined, { email: 'a@example.test' })).status,
    ).toBe(401);
    for (const [method, url] of [
      ['GET', '/admin/invitations'],
      ['POST', '/admin/invitations'],
      ['POST', '/admin/invitations/00000000-0000-4000-8000-000000000001/resend'],
      ['POST', '/admin/invitations/00000000-0000-4000-8000-000000000001/revoke'],
    ] as const) {
      const r = await call(
        method,
        url,
        memberToken,
        method === 'POST' ? { email: 'a@example.test' } : undefined,
      );
      expect([url, r.status, code(r)]).toEqual([url, 403, 'forbidden_role']);
    }
    expect(
      await count(`select count(*) n from audit_events where action = 'auth.denied'`),
    ).toBeGreaterThanOrEqual(4);

    for (const payload of [
      {},
      { email: 'not-an-email' },
      { email: 'a@example.test', extra: 1 },
      { email: 'x'.repeat(330) + '@example.test' },
    ]) {
      const r = await call('POST', '/admin/invitations', adminToken, payload);
      expect([r.status, code(r)]).toEqual([400, 'validation_failed']);
    }
    expect(code(await call('POST', '/admin/invitations/not-a-uuid/resend', adminToken))).toBe(
      'validation_failed',
    );
    expect(code(await call('GET', '/admin/invitations?limit=0', adminToken))).toBe(
      'validation_failed',
    );
    expect(code(await call('GET', '/admin/invitations?state=bogus', adminToken))).toBe(
      'validation_failed',
    );
    expect(code(await call('GET', '/admin/invitations?cursor=garbage', adminToken))).toBe(
      'validation_failed',
    );
    const unknown = '00000000-0000-4000-8000-0000000000aa';
    expect(await call('POST', `/admin/invitations/${unknown}/resend`, adminToken)).toMatchObject({
      status: 404,
    });
    expect(code(await call('POST', `/admin/invitations/${unknown}/revoke`, adminToken))).toBe(
      'not_found',
    );
  });

  it('refuses a domain outside INVITE_EMAIL_DOMAINS with 422 invite_domain_not_allowed and stores nothing', async () => {
    const r = await call('POST', '/admin/invitations', adminToken, {
      email: 'someone@elsewhere.test',
    });
    expect([r.status, code(r)]).toEqual([422, 'invite_domain_not_allowed']);
    expect(await row('someone@elsewhere.test')).toHaveLength(0);
  });
});

describe('create, list and the send states (TC-INV-01, 02, 08)', () => {
  it('sends the invitation: 202, row invited/sent with a handle, never returned (TC-INV-01)', async () => {
    const r = await call('POST', '/admin/invitations', adminToken, { email: 'inv1@example.test' });
    expect(r.status).toBe(202);
    expect(r.body.data).toEqual({
      email: 'inv1@example.test',
      message: 'If this address can be invited, an invitation is on its way.',
    });
    const [stored] = await row('inv1@example.test');
    expect(stored).toMatchObject({ state: 'invited', send_state: 'sent', invited_by: adminId });
    expect(stored.idp_invitation_id).toMatch(new RegExp(`^inv_${CANARY}`));
    expect(Date.parse(stored.expires_at) - Date.parse(stored.created_at)).toBeGreaterThan(
      6.9 * 86_400_000,
    );
    expect(local.invitations.get(stored.idp_invitation_id)).toMatchObject({
      email: 'inv1@example.test',
      expiresInDays: 7,
    });

    const list = await call('GET', '/admin/invitations', adminToken);
    const mine = (list.body.data as any[]).find((i) => i.email === 'inv1@example.test');
    expect(mine).toMatchObject({ state: 'invited', sendState: 'sent', invitedBy: adminId });
    expect(Object.keys(mine).sort()).toEqual([
      'createdAt',
      'email',
      'expiresAt',
      'id',
      'invitedBy',
      'sendState',
      'state',
      'updatedAt',
    ]);
    expect(list.text).not.toContain('idp');
    const columns = (
      await pool.query(
        `select column_name from information_schema.columns where table_name = 'invitations'`,
      )
    ).rows.map((c) => c.column_name as string);
    expect(columns).not.toContain('token_hash');
    expect(
      await count(
        `select count(*) n from audit_events where action = 'invitation.created' and object_id = $1`,
        [stored.id],
      ),
    ).toBe(1);
  });

  it('answers a registered address exactly like a fresh one and creates no row (TC-INV-08, TC-ACC-05)', async () => {
    const fresh = await call('POST', '/admin/invitations', adminToken, {
      email: 'fresh1@example.test',
    });
    const registered = await call('POST', '/admin/invitations', adminToken, {
      email: 'member@example.test',
    });
    expect(registered.status).toBe(fresh.status);
    expect(Object.keys(registered.body.data).sort()).toEqual(Object.keys(fresh.body.data).sort());
    expect(registered.body.data.message).toBe(fresh.body.data.message);
    expect(await row('member@example.test')).toHaveLength(1);
    expect(await row('fresh1@example.test')).toHaveLength(1);
  });

  it('a provider error then a timeout leave the row invited/send_failed; resend recovers it with a restarted expiry (TC-INV-02, TC-ACC-11)', async () => {
    const original = local.createInvitation;
    local.createInvitation = () =>
      Promise.reject(new IdentityUnavailable('createInvitation', 'provider'));
    let created;
    try {
      created = await call('POST', '/admin/invitations', adminToken, {
        email: 'inv2@example.test',
      });
      expect(created.status).toBe(202);
      local.createInvitation = () =>
        Promise.reject(new IdentityUnavailable('createInvitation', 'timeout'));
      expect(
        (await call('POST', '/admin/invitations', adminToken, { email: 'inv2b@example.test' }))
          .status,
      ).toBe(202);
    } finally {
      local.createInvitation = original;
    }
    const [failed] = await row('inv2@example.test');
    expect(failed).toMatchObject({
      state: 'invited',
      send_state: 'send_failed',
      idp_invitation_id: null,
    });
    expect((await row('inv2b@example.test'))[0].send_state).toBe('send_failed');
    const shown = (
      await call('GET', '/admin/invitations?state=invited', adminToken)
    ).body.data.find((i: any) => i.id === failed.id);
    expect(shown.sendState).toBe('send_failed');

    await pool.query(
      `update invitations set expires_at = now() + interval '1 hour' where id = $1`,
      [failed.id],
    );
    const resent = await call('POST', `/admin/invitations/${failed.id}/resend`, adminToken);
    expect(resent.status).toBe(200);
    expect(resent.body.data).toMatchObject({ id: failed.id, state: 'invited', sendState: 'sent' });
    const [after] = await row('inv2@example.test');
    expect(after.send_state).toBe('sent');
    expect(after.idp_invitation_id).toMatch(new RegExp(CANARY));
    expect(Date.parse(after.expires_at)).toBeGreaterThan(Date.now() + 6.9 * 86_400_000);
    expect(
      await count(
        `select count(*) n from audit_events where action = 'invitation.resent' and object_id = $1`,
        [failed.id],
      ),
    ).toBe(1);
  });
});

describe('replace, resend and revoke (TC-INV-04, 05, 06)', () => {
  it('a second invite for the address replaces the first and revokes its provider invitation (TC-INV-06)', async () => {
    await call('POST', '/admin/invitations', adminToken, { email: 'twice@example.test' });
    const [first] = await row('twice@example.test');
    await call('POST', '/admin/invitations', adminToken, { email: 'twice@example.test' });
    const rows = await row('twice@example.test');
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.state === 'invited')).toHaveLength(1);
    const old = rows.find((r) => r.id === first.id);
    expect(old.state).toBe('revoked');
    expect(old.idp_invitation_id).toBeNull();
    expect(local.invitations.get(first.idp_invitation_id)?.revoked).toBe(true);
  });

  it('two concurrent invites end with one invited row, no 500, and a provider revoke only for a set handle (TC-INV-06)', async () => {
    const revoked: string[] = [];
    const original = local.revokeInvitation.bind(local);
    local.revokeInvitation = async (id: string) => {
      revoked.push(id);
      return original(id);
    };
    try {
      for (const email of ['race1@example.test', 'race2@example.test', 'race3@example.test']) {
        const results = await Promise.all([
          call('POST', '/admin/invitations', adminToken, { email }),
          call('POST', '/admin/invitations', adminToken, { email }),
        ]);
        expect(results.map((r) => r.status)).toEqual([202, 202]);
        const rows = await row(email);
        expect(rows.filter((r) => r.state === 'invited')).toHaveLength(1);
        expect(rows.filter((r) => r.state === 'revoked').length).toBeLessThanOrEqual(1);
        const handles = rows.map((r) => r.idp_invitation_id).filter((h) => h !== null);
        expect(new Set(handles).size).toBe(handles.length);
      }
    } finally {
      local.revokeInvitation = original;
    }
    // every revoke the provider saw belonged to a handle that had been issued
    for (const id of revoked) expect(local.invitations.has(id)).toBe(true);
  });

  it('resend works for an invited row in every send state, and answers 409 for accepted, revoked and expired (TC-INV-04)', async () => {
    for (const sendState of ['pending', 'sent', 'send_failed']) {
      const email = `state-${sendState}@example.test`;
      await call('POST', '/admin/invitations', adminToken, { email });
      const [r] = await row(email);
      await pool.query(`update invitations set send_state = $2 where id = $1`, [r.id, sendState]);
      if (sendState !== 'sent')
        await pool.query(`update invitations set idp_invitation_id = null where id = $1`, [r.id]);
      const res = await call('POST', `/admin/invitations/${r.id}/resend`, adminToken);
      expect([sendState, res.status, res.body.data?.sendState]).toEqual([sendState, 200, 'sent']);
    }
    const [accepted] = await row('member@example.test');
    const [revoked] = (await row('twice@example.test')).filter((r) => r.state === 'revoked');
    await call('POST', '/admin/invitations', adminToken, { email: 'gone@example.test' });
    const [gone] = await row('gone@example.test');
    await pool.query(`update invitations set state = 'expired' where id = $1`, [gone.id]);
    for (const target of [accepted, revoked, gone]) {
      const res = await call('POST', `/admin/invitations/${target.id}/resend`, adminToken);
      expect([res.status, code(res)]).toEqual([409, 'state_conflict']);
    }
  });

  it('resend revokes the old provider invitation only when a handle is set (TC-INV-03)', async () => {
    await call('POST', '/admin/invitations', adminToken, { email: 'handle@example.test' });
    const [r] = await row('handle@example.test');
    const oldHandle = r.idp_invitation_id as string;
    await call('POST', `/admin/invitations/${r.id}/resend`, adminToken);
    expect(local.invitations.get(oldHandle)?.revoked).toBe(true);
    const [after] = await row('handle@example.test');
    expect(after.idp_invitation_id).not.toBe(oldHandle);

    await pool.query(
      `update invitations set send_state = 'pending', idp_invitation_id = null where id = $1`,
      [r.id],
    );
    const seen: string[] = [];
    const original = local.revokeInvitation.bind(local);
    local.revokeInvitation = async (id: string) => {
      seen.push(id);
      return original(id);
    };
    try {
      expect(
        (await call('POST', `/admin/invitations/${r.id}/resend`, adminToken)).body.data.sendState,
      ).toBe('sent');
    } finally {
      local.revokeInvitation = original;
    }
    expect(seen).toEqual([]);
    expect(await row('handle@example.test')).toHaveLength(1);
  });

  it('resend keeps the old handle and reports send_failed when the provider cannot revoke it', async () => {
    await call('POST', '/admin/invitations', adminToken, { email: 'stuck@example.test' });
    const [r] = await row('stuck@example.test');
    const original = local.revokeInvitation;
    local.revokeInvitation = () =>
      Promise.reject(new IdentityUnavailable('revokeInvitation', 'provider'));
    try {
      const res = await call('POST', `/admin/invitations/${r.id}/resend`, adminToken);
      expect([res.status, res.body.data.sendState]).toEqual([200, 'send_failed']);
    } finally {
      local.revokeInvitation = original;
    }
    expect((await row('stuck@example.test'))[0].idp_invitation_id).toBe(r.idp_invitation_id);
    expect(
      (await call('POST', `/admin/invitations/${r.id}/resend`, adminToken)).body.data.sendState,
    ).toBe('sent');
  });

  it('a resend whose new provider invitation fails clears the revoked old handle and ends send_failed', async () => {
    await call('POST', '/admin/invitations', adminToken, { email: 'halfway@example.test' });
    const [r] = await row('halfway@example.test');
    const original = local.createInvitation;
    local.createInvitation = () =>
      Promise.reject(new IdentityUnavailable('createInvitation', 'provider'));
    try {
      expect(
        (await call('POST', `/admin/invitations/${r.id}/resend`, adminToken)).body.data.sendState,
      ).toBe('send_failed');
    } finally {
      local.createInvitation = original;
    }
    expect((await row('halfway@example.test'))[0].idp_invitation_id).toBeNull();
    expect(local.invitations.get(r.idp_invitation_id)?.revoked).toBe(true);
  });

  it('revoke: provider failure leaves the revoke owed and the job completes it; a null handle makes no provider call; revoked twice is unchanged (TC-INV-05)', async () => {
    await call('POST', '/admin/invitations', adminToken, { email: 'rev1@example.test' });
    const [r] = await row('rev1@example.test');
    const original = local.revokeInvitation;
    local.revokeInvitation = () =>
      Promise.reject(new IdentityUnavailable('revokeInvitation', 'provider'));
    try {
      const res = await call('POST', `/admin/invitations/${r.id}/revoke`, adminToken);
      expect([res.status, res.body.data.state]).toEqual([200, 'revoked']);
    } finally {
      local.revokeInvitation = original;
    }
    expect((await row('rev1@example.test'))[0].idp_invitation_id).toBe(r.idp_invitation_id);
    expect(
      await count(
        `select count(*) n from audit_events where action = 'invitation.revoked' and object_id = $1`,
        [r.id],
      ),
    ).toBe(1);

    // the worker owns the retry: its provider knows the invitation here, and the job settles it
    workerIdentity.invitations.set(r.idp_invitation_id, {
      id: r.idp_invitation_id,
      email: 'rev1@example.test',
      expiresInDays: 7,
      revoked: false,
    });
    await worker.context.get(InvitationJobs).run();
    expect(workerIdentity.invitations.get(r.idp_invitation_id)?.revoked).toBe(true);
    expect((await row('rev1@example.test'))[0].idp_invitation_id).toBeNull();

    const again = await call('POST', `/admin/invitations/${r.id}/revoke`, adminToken);
    expect(again.body.data).toMatchObject({ id: r.id, state: 'revoked' });
    expect(
      await count(
        `select count(*) n from audit_events where action = 'invitation.revoked' and object_id = $1`,
        [r.id],
      ),
    ).toBe(1);

    await pool.query(
      `update invitations set state = 'invited', send_state = 'send_failed', idp_invitation_id = null where id = $1`,
      [r.id],
    );
    const seen: string[] = [];
    const spy = local.revokeInvitation.bind(local);
    local.revokeInvitation = async (id: string) => {
      seen.push(id);
      return spy(id);
    };
    try {
      expect(
        (await call('POST', `/admin/invitations/${r.id}/revoke`, adminToken)).body.data.state,
      ).toBe('revoked');
    } finally {
      local.revokeInvitation = spy;
    }
    expect(seen).toEqual([]);

    const [accepted] = await row('member@example.test');
    expect(code(await call('POST', `/admin/invitations/${accepted.id}/revoke`, adminToken))).toBe(
      'state_conflict',
    );
  });

  it('a revoked, expired or used invitation gives the neutral failure at sign-in (no account)', async () => {
    for (const [email, state] of [
      ['neutral-revoked@example.test', 'revoked'],
      ['neutral-expired@example.test', 'expired'],
    ] as const) {
      await call('POST', '/admin/invitations', adminToken, { email });
      const [r] = await row(email);
      await pool.query(`update invitations set state = $2 where id = $1`, [r.id, state]);
      const p = person(email);
      expect((await call('GET', '/me', token(p.sub))).body.data.linkState).toBe('not_linked');
    }
    await call('POST', '/admin/invitations', adminToken, { email: 'neutral-late@example.test' });
    const [late] = await row('neutral-late@example.test');
    await pool.query(
      `update invitations set expires_at = now() - interval '1 minute', created_at = now() - interval '2 days' where id = $1`,
      [late.id],
    );
    expect(
      (await call('GET', '/me', token(person('neutral-late@example.test').sub))).body.data
        .linkState,
    ).toBe('not_linked');
    // the used one: the second sign-in with the accepted address finds the account, never a second one
    expect(
      await count(`select count(*) n from users where lower(email) = 'member@example.test'`),
    ).toBe(1);
  });
});

describe('list: paging, filter and computed states', () => {
  it('pages by (created_at desc, id desc) with a signed cursor, filters by state, and shows an overdue invitation as expired', async () => {
    const admin = await newAdmin('lister');
    for (let i = 0; i < 5; i += 1)
      await call('POST', '/admin/invitations', admin.token, {
        email: `page${String(i)}@example.test`,
      });
    await pool.query(
      `update invitations set expires_at = now() - interval '1 minute', created_at = now() - interval '3 days' where email = 'page0@example.test'`,
    );

    const seen: any[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/admin/invitations?limit=4${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const page = await call('GET', url, admin.token);
      expect(page.status).toBe(200);
      expect(page.body.metaData.pagination).toMatchObject({ type: 'cursor', limit: 4 });
      seen.push(...(page.body.data as any[]));
      cursor = page.body.metaData.pagination.nextCursor as string | null;
      pages += 1;
    } while (cursor !== null && pages < 20);
    const total = await count('select count(*) n from invitations');
    expect(seen).toHaveLength(total);
    expect(new Set(seen.map((i) => i.id)).size).toBe(total);
    const stamps = seen.map((i) => Date.parse(i.createdAt));
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
    expect(seen.find((i) => i.email === 'page0@example.test').state).toBe('expired');

    const expired = (await call('GET', '/admin/invitations?state=expired&limit=50', admin.token))
      .body.data as any[];
    expect(expired.map((i) => i.email)).toContain('page0@example.test');
    expect(expired.every((i) => i.state === 'expired')).toBe(true);
    const invited = (await call('GET', '/admin/invitations?state=invited&limit=50', admin.token))
      .body.data as any[];
    expect(invited.map((i) => i.email)).not.toContain('page0@example.test');

    // a cursor is bound to its list: another admin or another filter cannot use it
    const first = await call('GET', '/admin/invitations?limit=1', admin.token);
    const foreign = encodeURIComponent(first.body.metaData.pagination.nextCursor as string);
    expect(
      code(await call('GET', `/admin/invitations?limit=1&cursor=${foreign}`, adminToken)),
    ).toBe('validation_failed');
    expect(
      code(
        await call(
          'GET',
          `/admin/invitations?limit=1&state=invited&cursor=${foreign}`,
          admin.token,
        ),
      ),
    ).toBe('validation_failed');

    // an overdue invitation cannot be resent or revoked as if it were waiting
    const overdue = seen.find((i) => i.email === 'page0@example.test');
    expect(code(await call('POST', `/admin/invitations/${overdue.id}/resend`, admin.token))).toBe(
      'state_conflict',
    );
    expect(code(await call('POST', `/admin/invitations/${overdue.id}/revoke`, admin.token))).toBe(
      'state_conflict',
    );
  });

  it('limits 20 invitations or resends per admin per hour with 429 rate_limited', async () => {
    const admin = await newAdmin('limited');
    for (let i = 0; i < 20; i += 1) {
      expect(
        (
          await call('POST', '/admin/invitations', admin.token, {
            email: `rate${String(i)}@example.test`,
          })
        ).status,
      ).toBe(202);
    }
    const r = await call('POST', '/admin/invitations', admin.token, {
      email: 'rate21@example.test',
    });
    expect([r.status, code(r)]).toEqual([429, 'rate_limited']);
    const [any] = await row('rate0@example.test');
    expect((await call('POST', `/admin/invitations/${any.id}/resend`, admin.token)).status).toBe(
      429,
    );
    expect((await call('POST', `/admin/invitations/${any.id}/revoke`, admin.token)).status).toBe(
      200,
    );
  });
});

describe('the hourly job through the real worker (identity.expire-invitations)', () => {
  it('expires overdue invitations, fails stale pending sends and settles owed revokes when the queue fires', async () => {
    await call('POST', '/admin/invitations', adminToken, { email: 'job-expire@example.test' });
    await call('POST', '/admin/invitations', adminToken, { email: 'job-stale@example.test' });
    const [expiring] = await row('job-expire@example.test');
    const [stale] = await row('job-stale@example.test');
    workerIdentity.invitations.set(expiring.idp_invitation_id, {
      id: expiring.idp_invitation_id,
      email: 'job-expire@example.test',
      expiresInDays: 7,
      revoked: false,
    });
    await pool.query(
      `update invitations set expires_at = now() - interval '1 minute', created_at = now() - interval '3 days' where id = $1`,
      [expiring.id],
    );
    await pool.query(
      `update invitations set send_state = 'pending', idp_invitation_id = null, updated_at = now() - interval '30 minutes' where id = $1`,
      [stale.id],
    );
    // the api shows the stale send as send_failed before the job has run
    expect(
      (
        (await call('GET', '/admin/invitations?state=invited&limit=50', adminToken)).body
          .data as any[]
      ).find((i) => i.id === stale.id).sendState,
    ).toBe('send_failed');

    const boss = createRuntimeBoss({ DATABASE_URL: testDb.url, role: 'api' });
    boss.on('error', () => undefined);
    await startRuntimeBoss(boss);
    try {
      await boss.send('identity.expire-invitations', {});
      await vi.waitFor(
        async () => {
          expect((await row('job-expire@example.test'))[0]).toMatchObject({
            state: 'expired',
            idp_invitation_id: null,
          });
          expect((await row('job-stale@example.test'))[0]).toMatchObject({
            state: 'invited',
            send_state: 'send_failed',
          });
        },
        { timeout: 20_000 },
      );
      const schedule = await boss.getSchedule('identity.expire-invitations');
      expect(schedule?.cron).toBe('0 * * * *');
    } finally {
      await boss.stop({ graceful: false }).catch(() => undefined);
    }
    expect(workerIdentity.invitations.get(expiring.idp_invitation_id)?.revoked).toBe(true);
  });

  it('a pending send that never got its provider answer is recovered by resend after the job marked it failed (TC-INV-03)', async () => {
    await call('POST', '/admin/invitations', adminToken, { email: 'crash@example.test' });
    const [r] = await row('crash@example.test');
    await pool.query(
      `update invitations set send_state = 'pending', idp_invitation_id = null, updated_at = now() - interval '1 hour' where id = $1`,
      [r.id],
    );
    const outcome = await worker.context.get(InvitationJobs).run();
    expect(outcome.staleSends).toBeGreaterThanOrEqual(1);
    expect((await row('crash@example.test'))[0].send_state).toBe('send_failed');
    const res = await call('POST', `/admin/invitations/${r.id}/resend`, adminToken);
    expect(res.body.data.sendState).toBe('sent');
    expect((await row('crash@example.test')).filter((x) => x.state === 'invited')).toHaveLength(1);
  });
});

describe('no ticket in any sink (TC-INV-09, SECT-AUTH-14)', () => {
  it('keeps the provider handle and the invited emails out of responses, audit events and logs', async () => {
    await call('POST', '/admin/invitations', adminToken, { email: 'canary@example.test' });
    const [r] = await row('canary@example.test');
    expect(r.idp_invitation_id).toContain(CANARY);
    const bodies = [
      (await call('GET', '/admin/invitations?limit=50', adminToken)).text,
      (await call('POST', `/admin/invitations/${r.id}/resend`, adminToken)).text,
      (await call('POST', `/admin/invitations/${r.id}/revoke`, adminToken)).text,
    ];
    for (const text of bodies) expect(text).not.toContain(CANARY);
    const audit = JSON.stringify((await pool.query('select * from audit_events')).rows);
    expect(audit).not.toContain(CANARY);
    expect(audit).not.toContain('@example.test');
    const logs = logLines.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(CANARY);
    expect(logs).not.toContain('canary@example.test');
    expect(logs).not.toContain('inv1@example.test');
  });
});
