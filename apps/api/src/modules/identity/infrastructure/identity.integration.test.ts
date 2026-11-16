import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../../bootstrap/api.module.js';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../../platform/db/test-database.js';
import type { TestDatabase } from '../../../platform/db/test-database.js';
import { installJobs } from '../../../platform/jobs/test-support.js';
import { createHttpLogging } from '../../../platform/logging/index.js';
import { IDENTITY_PORT, IdentityNotFound, LocalIdentity } from '../identity.module.js';
import type { IdentityPort } from '../identity.module.js';
import {
  AccessRequestRepository,
  InvitationRepository,
  SettingsRepository,
  UserRepository,
} from './identity.repositories.js';

// TASK-033: M0003 on real PostgreSQL (the grants run in the migration-harness suite of TASK-025/032 and the CLI
// clean-history check; here the owner has no application roles), the identity constraints, and the module reached
// through the real api composition root (`createApiApp`, the one `main.api.ts` runs) in IDENTITY_MODE=local.

let testDb: TestDatabase;
let app: Awaited<ReturnType<typeof createApiApp>>['app'];
const lines: string[] = [];
const UUID = (n: number) => `0197a1b2-0000-7000-8000-${String(n).padStart(12, '0')}`;
const CANARY_EMAIL = 'canary.person+7f3a@example.test';

beforeAll(async () => {
  testDb = await createTestDatabase({ label: 'task033', migrations: false });
  await installJobs(testDb.url);
  const sql = readFileSync(join(REAL_MIGRATIONS, '0020_task-033-identity.sql'), 'utf8');
  const client = new pg.Client({ connectionString: testDb.url });
  await client.connect();
  try {
    // The GRANT block names roles that exist only where the migration harness provisions them.
    for (const statement of sql.split('-- Grants')[0]?.split('--> statement-breakpoint') ?? []) {
      if (statement.trim() !== '') await client.query(statement);
    }
  } finally {
    await client.end();
  }
  const destination = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  ({ app } = await createApiApp(
    {
      WEB_ORIGIN: 'http://localhost:3000',
      APP_ENV: 'development',
      DATABASE_URL: testDb.url,
      DATABASE_POOL_MAX: 4,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      RATE_LIMIT_IP_KEY: 'r'.repeat(40),
    },
    createHttpLogging({ destination, level: 'info' }),
  ));
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

const query = async (sql: string, params: unknown[] = []) => {
  const client = new pg.Client({ connectionString: testDb.url });
  await client.connect();
  try {
    return await client.query(sql, params);
  } catch (error) {
    return { code: (error as { code?: string }).code ?? 'error', rows: [] as unknown[] };
  } finally {
    await client.end();
  }
};
const tryQuery = async (sql: string, params: unknown[] = []) => {
  const r = (await query(sql, params)) as { code?: string };
  return r.code === undefined ? ({ ok: true } as const) : ({ ok: false, code: r.code } as const);
};

const database = () => app.get<Database>(DATABASE, { strict: false });
const users = () => app.get(UserRepository, { strict: false });
const invites = () => app.get(InvitationRepository, { strict: false });
const requests = () => app.get(AccessRequestRepository, { strict: false });
const settings = () => app.get(SettingsRepository, { strict: false });

describe('M0003 (REQ-002, REQ-003, REQ-004, REQ-026)', () => {
  it('refuses a second user for one subject and a second user for one email (unique indexes)', async () => {
    const first = await database().db.transaction((tx) =>
      users().insertIfAbsent(tx, {
        id: UUID(1),
        idpSubject: 'user_one',
        email: 'One@Example.test',
        linkedVia: 'invitation',
      }),
    );
    expect(first).toMatchObject({
      email: 'one@example.test',
      role: 'user',
      status: 'active',
      version: 1,
    });
    const again = await database().db.transaction((tx) =>
      users().insertIfAbsent(tx, {
        id: UUID(2),
        idpSubject: 'user_one',
        email: 'other@example.test',
        linkedVia: 'invitation',
      }),
    );
    expect(again).toBeUndefined();
    const raw = await tryQuery(
      `INSERT INTO users (id, idp_subject, email, linked_via) VALUES ($1, 'user_one', 'x@example.test', 'invitation')`,
      [UUID(3)],
    );
    expect(raw.ok ? '' : raw.code).toBe('23505');
    const mail = await tryQuery(
      `INSERT INTO users (id, idp_subject, email, linked_via) VALUES ($1, 'user_two', 'ONE@example.test', 'invitation')`,
      [UUID(4)],
    );
    expect(mail.ok ? '' : mail.code).toBe('23505');
  });

  it('lets one concurrent first token win and the other read the row', async () => {
    const results = await Promise.all(
      [10, 11, 12, 13].map((n) =>
        database().db.transaction((tx) =>
          users().insertIfAbsent(tx, {
            id: UUID(n),
            idpSubject: 'user_race',
            email: `race${n}@example.test`,
            linkedVia: 'first_admin',
            role: 'admin',
          }),
        ),
      ),
    );
    expect(results.filter((row) => row !== undefined)).toHaveLength(1);
    const row = await users().findBySubject(database().db, 'user_race');
    expect(row).toMatchObject({ role: 'admin', linkedVia: 'first_admin' });
    expect(await users().findById(database().db, row?.id as string)).toMatchObject({
      idpSubject: 'user_race',
    });
  });

  it('allows one pending invitation per email, whatever its case, and a new one after it is revoked', async () => {
    const expiresAt = new Date(Date.now() + 7 * 86_400_000);
    const insert = (n: number, email: string) =>
      database().db.transaction((tx) =>
        invites().insertInvited(tx, { id: UUID(n), email, invitedBy: UUID(1), expiresAt }),
      );
    expect(await insert(20, 'Guest@Example.test')).toMatchObject({
      state: 'invited',
      sendState: 'pending',
      email: 'guest@example.test',
    });
    expect(await insert(21, 'guest@example.test')).toBeUndefined();
    const raw = await tryQuery(
      `INSERT INTO invitations (id, email, state, expires_at) VALUES ($1, 'GUEST@example.test', 'invited', now() + interval '1 day')`,
      [UUID(22)],
    );
    expect(raw.ok ? '' : raw.code).toBe('23505');
    const found = await invites().findInvitedByEmail(database().db, 'GUEST@example.test');
    expect(found?.id).toBe(UUID(20));

    await database().db.transaction(async (tx) => {
      expect(await invites().markSent(tx, UUID(20), 'inv_abc')).toBe(true);
      expect(await invites().markSent(tx, UUID(20), 'inv_def')).toBe(false);
      expect(await invites().markSendFailed(tx, UUID(20))).toBe(false);
      expect(await invites().sendStateOf(tx, UUID(20))).toBe('sent');
      expect(await invites().transition(tx, UUID(20), 'revoked')).toBe(true);
      expect(await invites().transition(tx, UUID(20), 'expired')).toBe(false);
    });
    expect(await insert(23, 'guest@example.test')).toMatchObject({ state: 'invited' });
    await database().db.transaction(async (tx) => {
      expect(await invites().markSendFailed(tx, UUID(23))).toBe(true);
      expect(await invites().transition(tx, UUID(23), 'accepted', UUID(1))).toBe(true);
    });
    expect(await invites().findById(database().db, UUID(23))).toMatchObject({
      state: 'accepted',
      acceptedUserId: UUID(1),
      sendState: 'send_failed',
    });
    // the provider id is unique once set
    const dup = await tryQuery(
      `UPDATE invitations SET idp_invitation_id = 'inv_abc' WHERE id = $1`,
      [UUID(23)],
    );
    expect(dup.ok ? '' : dup.code).toBe('23505');
  });

  it('allows one pending access request per subject and decides it once', async () => {
    const insert = (n: number) =>
      database().db.transaction((tx) =>
        requests().insertPending(tx, {
          id: UUID(n),
          idpSubject: 'user_req',
          email: 'Req@Example.test',
          note: null,
        }),
      );
    expect(await insert(30)).toMatchObject({ state: 'pending', email: 'req@example.test' });
    expect(await insert(31)).toBeUndefined();
    const decided = await database().db.transaction((tx) =>
      requests().decide(tx, UUID(30), 'approved', UUID(1), UUID(2)),
    );
    expect(decided).toMatchObject({ state: 'approved', decidedBy: UUID(1), userId: UUID(2) });
    expect(
      await database().db.transaction((tx) =>
        requests().decide(tx, UUID(30), 'declined', UUID(1), null),
      ),
    ).toBeUndefined();
    expect(await insert(32)).toMatchObject({ state: 'pending' });
    expect(await requests().findById(database().db, UUID(32))).toBeDefined();
  });

  it('versions user changes, counts active admins and keeps one settings row', async () => {
    const db = database().db;
    const user = await users().findBySubject(db, 'user_one');
    expect(await users().setStatus(db, UUID(1), 99, 'suspended')).toBeUndefined();
    expect(
      await users().setStatus(db, UUID(1), user?.version as number, 'suspended'),
    ).toMatchObject({ status: 'suspended', version: 2 });
    expect(await users().setRole(db, UUID(1), 2, 'admin')).toMatchObject({
      role: 'admin',
      version: 3,
    });
    expect(await users().setRole(db, UUID(1), 2, 'user')).toBeUndefined();
    expect(await users().countActiveAdmins(db)).toBe(1);

    const first = await settings().get(db);
    expect(first).toMatchObject({
      id: 1,
      signupMode: 'invited_only',
      firstAdminSeededAt: null,
      version: 1,
    });
    expect(await settings().markFirstAdminSeeded(db)).toBe(true);
    expect(await settings().markFirstAdminSeeded(db)).toBe(false);
    expect(await settings().setSignupMode(db, 5, 'open', null)).toBeUndefined();
    expect(await settings().setSignupMode(db, 1, 'open', UUID(1))).toMatchObject({
      signupMode: 'open',
      version: 2,
    });
    const second = await tryQuery(`INSERT INTO platform_settings (id) VALUES (2)`);
    expect(second.ok ? '' : second.code).toBe('23514');
  });

  it('enforces the value checks', async () => {
    for (const [sql, code] of [
      [
        `INSERT INTO users (id, idp_subject, email, role, linked_via) VALUES ('${UUID(40)}', 's40', 'a@example.test', 'owner', 'invitation')`,
        '23514',
      ],
      [
        `INSERT INTO users (id, idp_subject, email, status, linked_via) VALUES ('${UUID(41)}', 's41', 'b@example.test', 'gone', 'invitation')`,
        '23514',
      ],
      [
        `INSERT INTO users (id, idp_subject, email, linked_via) VALUES ('${UUID(42)}', 's42', 'c@example.test', 'magic')`,
        '23514',
      ],
      [
        `INSERT INTO users (id, idp_subject, email, linked_via, version) VALUES ('${UUID(43)}', 's43', 'd@example.test', 'invitation', 0)`,
        '23514',
      ],
      [
        `INSERT INTO invitations (id, email, expires_at, created_at) VALUES ('${UUID(44)}', 'e@example.test', now() - interval '1 day', now())`,
        '23514',
      ],
      [
        `INSERT INTO invitations (id, email, send_state, expires_at) VALUES ('${UUID(45)}', 'f@example.test', 'lost', now() + interval '1 day')`,
        '23514',
      ],
      [
        `INSERT INTO access_requests (id, idp_subject, email, state) VALUES ('${UUID(46)}', 's46', 'g@example.test', 'maybe')`,
        '23514',
      ],
      [`INSERT INTO platform_settings (id, signup_mode) VALUES (1, 'wide_open')`, '23514'],
    ] as const) {
      const r = await tryQuery(sql);
      expect(r.ok ? 'ok' : r.code, sql).toBe(code);
    }
  });
});

describe('IdentityPort through the real composition root (IDENTITY_MODE=local)', () => {
  it('selects the local provider and serves every operation', async () => {
    const port = app.get<IdentityPort>(IDENTITY_PORT, { strict: false });
    expect(port).toBeInstanceOf(LocalIdentity);
    const local = port as LocalIdentity;
    local.addUser('user_live', CANARY_EMAIL, true);
    const token = local.issueToken({
      sub: 'user_live',
      sid: 'sess_live',
      azp: 'http://localhost:3000',
    });
    expect(await port.verifyToken(token)).toMatchObject({ sub: 'user_live', sid: 'sess_live' });
    expect(await port.getUser('user_live')).toEqual({
      primaryEmail: CANARY_EMAIL,
      emailVerified: true,
    });
    const id = await port.createInvitation(CANARY_EMAIL, 7, 'http://localhost:3000/welcome');
    await port.revokeInvitation(id);
    await port.revokeSessions('user_live');
    await port.deleteUser('user_live');
    await expect(port.deleteUser('user_live')).rejects.toBeInstanceOf(IdentityNotFound);

    // A request that carries a token through the real http edge: no token or email reaches a log line.
    const fastify = app.getHttpAdapter().getInstance();
    await fastify.inject({
      method: 'GET',
      url: '/api/v1/nothing-here',
      headers: { authorization: `Bearer ${token}` },
    });
    const logged = lines.join('\n');
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(token.split('.')[1] as string);
    expect(logged).not.toContain(CANARY_EMAIL);
  });

  it('refuses local identity in a hosted environment at startup, for real', async () => {
    process.env['IDENTITY_MODE'] = 'local';
    try {
      await expect(
        createApiApp(
          {
            WEB_ORIGIN: 'http://localhost:3000',
            APP_ENV: 'production',
            RATE_LIMIT_IP_KEY: 'r'.repeat(40),
          },
          createHttpLogging({ level: 'silent' }),
        ),
      ).rejects.toThrow(/IDENTITY_MODE=local is refused/);
    } finally {
      delete process.env['IDENTITY_MODE'];
    }
  });
});
