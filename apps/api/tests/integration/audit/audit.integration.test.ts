import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../../src/bootstrap/api.module.js';
import { DATABASE } from '../../../src/platform/db/index.js';
import type { Database } from '../../../src/platform/db/index.js';
import { createHttpLogging } from '../../../src/platform/logging/index.js';
import { AlertService, AuditService } from '../../../src/modules/audit/index.js';
import {
  cleanup,
  drizzleMigrate,
  provision,
  renderMigrations,
  teardown,
  tryQuery,
  withClient,
} from '../migrations/support/harness.js';
import type { Env } from '../migrations/support/harness.js';

// TASK-032: migration M0002 (audit) through the real `drizzle-kit migrate` CLI, the append-only grants (TC-AUD-02), and the audit
// module reached through the real api composition root (`createApiApp`) on real PostgreSQL as the `app_api` role (TC-AUD-01, TC-AUD-03).

let env: Env;
let dir: string;
let app: Awaited<ReturnType<typeof createApiApp>>['app'];
const lines: Record<string, unknown>[] = [];
const UUID = (n: number) => `0197a1b2-0000-7000-8000-${String(n).padStart(12, '0')}`;

beforeAll(async () => {
  env = await provision();
  dir = renderMigrations(env);
  const run = drizzleMigrate(env, dir);
  expect(run.status, run.stdout + run.stderr).toBe(0);
  const destination = new Writable({
    write(chunk: Buffer, _enc, done) {
      for (const text of chunk.toString().split('\n').filter(Boolean)) {
        try {
          lines.push(JSON.parse(text) as Record<string, unknown>);
        } catch {
          /* not a JSON line */
        }
      }
      done();
    },
  });
  ({ app } = await createApiApp(
    {
      WEB_ORIGIN: 'http://localhost:3000',
      APP_ENV: 'development',
      DATABASE_URL: env.urlFor('api'),
      DATABASE_POOL_MAX: 4,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      RATE_LIMIT_IP_KEY: 'r'.repeat(40),
    },
    createHttpLogging({ destination, level: 'info' }),
  ));
});

afterAll(async () => {
  await app?.close();
  if (dir) cleanup(dir);
  if (env) expect(await teardown(env)).toEqual([]);
});

const adminLines = () => lines.filter((l) => l['msg'] === 'admin_alert');
const database = () => app.get<Database>(DATABASE, { strict: false });

describe('M0002 (TC-OPS-03, TC-AUD-02)', () => {
  it('is recorded once in the ledger, and a second run changes nothing', async () => {
    const again = drizzleMigrate(env, dir);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    await withClient(env.urlFor('superuser'), async (c) => {
      const ledger = await c.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
      expect((ledger.rows[0] as { n: number }).n).toBe(2);
    });
  });

  it('gives app_api and app_worker INSERT and SELECT only on audit_events', async () => {
    await withClient(env.urlFor('superuser'), async (c) => {
      for (const role of [env.roles.api, env.roles.worker]) {
        for (const [priv, expected] of [
          ['SELECT', true],
          ['INSERT', true],
          ['UPDATE', false],
          ['DELETE', false],
          ['TRUNCATE', false],
          ['REFERENCES', false],
        ] as const) {
          const r = await c.query('SELECT has_table_privilege($1, $2, $3) AS h', [
            role,
            'public.audit_events',
            priv,
          ]);
          expect((r.rows[0] as { h: boolean }).h, `${role} ${priv}`).toBe(expected);
        }
        const alerts = await c.query(
          `SELECT has_table_privilege($1, 'public.admin_alerts', 'DELETE') AS d, has_table_privilege($1, 'public.admin_alerts', 'UPDATE') AS u`,
          [role],
        );
        expect(alerts.rows[0]).toEqual({ d: false, u: true });
      }
    });
  });

  it('refuses UPDATE, DELETE and TRUNCATE on audit_events as app_api and app_worker (42501), even for a row that exists', async () => {
    await withClient(env.urlFor('superuser'), (c) =>
      c.query(
        `INSERT INTO audit_events (id, actor_type, action, object_type, outcome) VALUES ($1, 'system', 'erasure.resumed', 'user', 'allowed')`,
        [UUID(900)],
      ),
    );
    for (const role of ['api', 'worker'] as const) {
      for (const statement of [
        `UPDATE audit_events SET outcome = 'failed'`,
        `DELETE FROM audit_events`,
        `TRUNCATE audit_events`,
        `DROP TABLE audit_events`,
      ]) {
        const r = await tryQuery(env.urlFor(role), statement);
        expect(r.ok, `${role}: ${statement}`).toBe(false);
        expect(r.ok ? '' : r.code).toBe('42501');
      }
    }
    await withClient(env.urlFor('superuser'), async (c) => {
      const r = await c.query(`SELECT outcome FROM audit_events WHERE id = $1`, [UUID(900)]);
      expect(r.rows).toEqual([{ outcome: 'allowed' }]);
    });
  });

  it('enforces the actor type and outcome checks, and app_backup can read but not write', async () => {
    const bad = await tryQuery(
      env.urlFor('api'),
      `INSERT INTO audit_events (id, actor_type, action, object_type, outcome) VALUES ($1, 'bot', 'x', 'user', 'allowed')`,
      [UUID(901)],
    );
    expect(bad.ok ? '' : bad.code).toBe('23514');
    const read = await tryQuery(env.urlFor('backup'), 'SELECT count(*) FROM audit_events');
    expect(read.ok).toBe(true);
    const write = await tryQuery(env.urlFor('backup'), `DELETE FROM admin_alerts`);
    expect(write.ok).toBe(false);
  });

  it('rolls back by dropping the new objects and migrates forward again', async () => {
    await withClient(env.urlFor('migrator'), async (c) => {
      await c.query('BEGIN');
      await c.query('DROP TABLE audit_events, admin_alerts');
      const gone = await c.query(`SELECT to_regclass('public.audit_events') AS t`);
      expect((gone.rows[0] as { t: unknown }).t).toBeNull();
      await c.query('ROLLBACK');
    });
    await withClient(env.urlFor('superuser'), async (c) => {
      const back = await c.query(`SELECT to_regclass('public.admin_alerts') AS t`);
      expect((back.rows[0] as { t: unknown }).t).not.toBeNull();
    });
  });
});

describe('audit through the real api composition root (TC-AUD-01, TC-AUD-03)', () => {
  it('leaves exactly one event per audited action, with the stated fields and no secret', async () => {
    const audit = app.get(AuditService, { strict: false });
    const secret = 'sk-live-super-secret-value';
    await database().uow.run(async (tx) => {
      await audit.record(tx, {
        actorId: UUID(1),
        actorType: 'admin',
        action: 'key.added',
        objectType: 'provider_key',
        objectId: UUID(2),
        outcome: 'allowed',
        requestId: 'req-abc',
      });
    });
    // A denied call has no transaction: one statement through the pool.
    await audit.record(database().db, {
      actorId: UUID(3),
      actorType: 'user',
      action: 'auth.denied',
      objectType: 'route',
      objectId: null,
      outcome: 'denied',
    });
    await withClient(env.urlFor('superuser'), async (c) => {
      const rows = await c.query(
        `SELECT * FROM audit_events WHERE action IN ('key.added', 'auth.denied') ORDER BY action`,
      );
      expect(rows.rowCount).toBe(2);
      expect(rows.rows[1]).toMatchObject({
        actor_id: UUID(1),
        actor_type: 'admin',
        action: 'key.added',
        object_type: 'provider_key',
        object_id: UUID(2),
        outcome: 'allowed',
        request_id: 'req-abc',
      });
      expect((rows.rows[1] as { at: Date }).at).toBeInstanceOf(Date);
      expect(JSON.stringify(rows.rows)).not.toContain(secret);
      expect(Object.keys(rows.rows[0] as object).sort()).toEqual([
        'action',
        'actor_id',
        'actor_type',
        'at',
        'id',
        'object_id',
        'object_type',
        'outcome',
        'request_id',
      ]);
    });
  });

  it('rolls an event back with the caller transaction', async () => {
    const audit = app.get(AuditService, { strict: false });
    await expect(
      database().uow.run(async (tx) => {
        await audit.record(tx, {
          actorId: UUID(4),
          actorType: 'user',
          action: 'draft.deleted',
          objectType: 'draft',
          objectId: UUID(5),
          outcome: 'allowed',
        });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    await withClient(env.urlFor('superuser'), async (c) => {
      const r = await c.query(`SELECT count(*)::int AS n FROM audit_events WHERE actor_id = $1`, [
        UUID(4),
      ]);
      expect((r.rows[0] as { n: number }).n).toBe(0);
    });
  });

  it('writes an alert in the caller transaction and logs one admin_alert line only after commit', async () => {
    const alerts = app.get(AlertService, { strict: false });
    const before = adminLines().length;
    const pending = await database().uow.run(async (tx) => {
      const p = await alerts.raiseAlert(tx, 'account_erasure_stuck', UUID(10), { attempts: 3 });
      expect(adminLines()).toHaveLength(before);
      return p;
    });
    expect(pending.raised).toBe(true);
    expect(adminLines()).toHaveLength(before);
    pending.announce();
    pending.announce();
    expect(adminLines()).toHaveLength(before + 1);
    expect(adminLines().at(-1)).toMatchObject({
      code: 'account_erasure_stuck',
      userId: UUID(10),
      jobId: pending.alertId,
    });
    expect(JSON.stringify(adminLines().at(-1))).not.toContain('attempts');
    await withClient(env.urlFor('superuser'), async (c) => {
      const r = await c.query(
        `SELECT counts, dedupe_key FROM admin_alerts WHERE subject_user_id = $1`,
        [UUID(10)],
      );
      expect(r.rows).toEqual([
        { counts: { attempts: 3 }, dedupe_key: `account_erasure_stuck:${UUID(10)}` },
      ]);
    });
  });

  it('rolls the alert back with the caller and never announces it', async () => {
    const alerts = app.get(AlertService, { strict: false });
    const before = adminLines().length;
    await expect(
      database().uow.run(async (tx) => {
        await alerts.raiseAlert(tx, 'job_burst', UUID(11), { jobs: 99 });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(adminLines()).toHaveLength(before);
    await withClient(env.urlFor('superuser'), async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM admin_alerts WHERE subject_user_id = $1`,
        [UUID(11)],
      );
      expect((r.rows[0] as { n: number }).n).toBe(0);
    });
  });

  it('keeps one open alert per kind and subject, and raises again after acknowledgement', async () => {
    const alerts = app.get(AlertService, { strict: false });
    const run = () =>
      database().uow.run((tx) => alerts.raiseAlert(tx, 'key_unseal_failed', UUID(12), { keys: 1 }));
    const first = await run();
    const second = await run();
    expect([first.raised, second.raised]).toEqual([true, false]);
    const done = await alerts.acknowledge(database().db, first.alertId as string, UUID(1));
    expect(done.status).toBe('acknowledged');
    const third = await run();
    expect(third.raised).toBe(true);
  });

  it('acknowledges first-wins, concurrently, and reports unknown ids', async () => {
    const alerts = app.get(AlertService, { strict: false });
    const p = await database().uow.run((tx) =>
      alerts.raiseAlert(tx, 'keys_disabled_all', null, {}),
    );
    const id = p.alertId as string;
    const results = await Promise.all(
      [UUID(20), UUID(21), UUID(22), UUID(23)].map((by) =>
        alerts.acknowledge(database().db, id, by),
      ),
    );
    const winners = results.filter((r) => r.status === 'acknowledged');
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.status === 'already_acknowledged')).toHaveLength(3);
    const winner = winners[0];
    const stored = await alerts.acknowledge(database().db, id, UUID(24));
    expect(stored).toMatchObject({ status: 'already_acknowledged' });
    if (winner?.status === 'acknowledged' && stored.status === 'already_acknowledged') {
      expect(stored.alert.acknowledgedBy).toBe(winner.alert.acknowledgedBy);
    }
    expect(await alerts.acknowledge(database().db, UUID(999), UUID(1))).toEqual({
      status: 'not_found',
    });
  });

  it('lists open alerts first, newest first, and pages with a position', async () => {
    const alerts = app.get(AlertService, { strict: false });
    const db = database().db;
    const all = await alerts.listAlerts(db, { limit: 100 });
    expect(all.length).toBeGreaterThanOrEqual(4);
    const openFirst = all.findIndex((a) => a.acknowledgedAt !== null);
    expect(
      all.slice(0, openFirst < 0 ? all.length : openFirst).every((a) => a.acknowledgedAt === null),
    ).toBe(true);
    const walked = [];
    let after;
    for (;;) {
      const page = await alerts.listAlerts(db, { limit: 2, ...(after ? { after } : {}) });
      walked.push(...page);
      const last = page.at(-1);
      if (page.length < 2 || last === undefined) break;
      after = { acknowledgedAt: last.acknowledgedAt, raisedAt: last.raisedAt, id: last.id };
    }
    expect(walked.map((a) => a.id)).toEqual(all.map((a) => a.id));
    const open = await alerts.listAlerts(db, { limit: 100, acknowledged: false });
    expect(open.every((a) => a.acknowledgedAt === null)).toBe(true);
    const acked = await alerts.listAlerts(db, { limit: 100, acknowledged: true });
    expect(acked.length + open.length).toBe(all.length);
  });

  it('refuses an alert written outside the kind list at the database', async () => {
    const r = await tryQuery(
      env.urlFor('api'),
      `INSERT INTO admin_alerts (id, kind) VALUES ($1, 'made_up')`,
      [UUID(30)],
    );
    expect(r.ok ? '' : r.code).toBe('23514');
  });
});
