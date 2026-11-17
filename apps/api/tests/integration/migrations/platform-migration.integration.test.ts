import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import type { Queue } from 'pg-boss';
import { validEnv } from '../../../src/platform/config/test-env.js';
import { migrateJobs } from '../../../src/database/jobs-migrate.js';
import { QUEUES } from '../../../src/platform/jobs/queues.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiDir,
  cleanup,
  drizzleMigrate,
  installQueues,
  leftovers,
  provision,
  pgbossTables,
  renderMigrations,
  roleCheckMessage,
  runPgDump,
  runtimeBoss,
  teardown,
  tryQuery,
  withClient,
} from './support/harness.js';
import type { Attempt, Env, ProvisionOptions } from './support/harness.js';

// TASK-025: migration M0001 (platform) applied through the real `drizzle-kit migrate` CLI as app_migrator on real
// PostgreSQL, and the grants suite of ARCHITECTURE §2.7 (SB v6 §7.1 E): TC-BKP-01..11 (TC-BKP-12 and 13 test the
// backup script and image, which a later ticket delivers). Every run uses a unique database and run-suffixed roles.

const queues: Queue[] = [
  { name: 'probe-standard', policy: 'standard', retryLimit: 0, expireInSeconds: 900 },
  {
    name: 'probe-partitioned',
    policy: 'standard',
    retryLimit: 0,
    expireInSeconds: 900,
    partition: true,
  },
];

const envs: Env[] = [];
const dirs: string[] = [];

async function setUp(options: ProvisionOptions = {}) {
  const env = await provision(options);
  envs.push(env);
  const dir = renderMigrations(env, 1);
  dirs.push(dir);
  return { env, dir };
}

afterAll(async () => {
  dirs.forEach(cleanup);
  for (const env of envs) expect(await teardown(env)).toEqual([]);
});

const denied = (r: Attempt) => {
  expect(r.ok).toBe(false);
  expect(r.ok ? '' : r.code).toBe('42501');
};

let env: Env;
let dir: string;

beforeAll(async () => {
  ({ env, dir } = await setUp());
});

describe('M0001 through drizzle-kit migrate (TC-OPS-03)', () => {
  it('applies to a clean database, and a second run changes nothing', async () => {
    const first = drizzleMigrate(env, dir);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const snapshot = async () =>
      withClient(env.urlFor('superuser'), async (c) => {
        const ledger = await c.query('SELECT hash, created_at FROM drizzle.__drizzle_migrations');
        const catalog = await c.query(
          `SELECT c.relname, c.relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'i') ORDER BY 1`,
        );
        return { ledger: ledger.rows, catalog: catalog.rows };
      });
    const before = await snapshot();
    expect(before.ledger).toHaveLength(1);
    const second = drizzleMigrate(env, dir);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it('creates the extension, the schema, the two tables and the ownership M0001 promises', async () => {
    await withClient(env.urlFor('superuser'), async (c) => {
      const ext = await c.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
      expect(ext.rowCount).toBe(1);
      const owner = await c.query(
        `SELECT nspname, pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname IN ('public', 'pgboss') ORDER BY 1`,
      );
      expect(owner.rows).toEqual([
        { nspname: 'pgboss', owner: env.roles.migrator },
        { nspname: 'public', owner: env.roles.migrator },
      ]);
      const tables = await c.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('rate_limit_buckets', 'idempotency_records') ORDER BY 1`,
      );
      expect(tables.rows.map((r) => (r as { table_name: string }).table_name)).toEqual([
        'idempotency_records',
        'rate_limit_buckets',
      ]);
      const idx = await c.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'idempotency_records' ORDER BY 1`,
      );
      expect(idx.rows.map((r) => (r as { indexname: string }).indexname)).toEqual([
        'idempotency_records_expiry_idx',
        'idempotency_records_owner_id_operation_id_key_pk',
      ]);
      for (const role of [env.roles.api, env.roles.worker]) {
        for (const t of ['public.rate_limit_buckets', 'public.idempotency_records']) {
          for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
            const r = await c.query('SELECT has_table_privilege($1, $2, $3) AS h', [role, t, p]);
            expect((r.rows[0] as { h: boolean }).h, `${role} ${p} ${t}`).toBe(true);
          }
          const trunc = await c.query('SELECT has_table_privilege($1, $2, $3) AS h', [
            role,
            t,
            'TRUNCATE',
          ]);
          expect((trunc.rows[0] as { h: boolean }).h).toBe(false);
        }
      }
    });
  });

  it('enforces the idempotency hash length and the bucket primary key', async () => {
    const api = env.urlFor('api');
    const owner = '00000000-0000-4000-8000-000000000001';
    const insert = (hash: Buffer, key: string) =>
      tryQuery(
        api,
        `INSERT INTO idempotency_records (owner_id, operation_id, key, request_hash, resource_type, resource_id, response_status, expires_at)
         VALUES ($1, 'API-024', $2, $3, 'campaign', $1, 202, now() + interval '24 hours')`,
        [owner, key, hash],
      );
    expect((await insert(Buffer.alloc(32, 1), 'k1')).ok).toBe(true);
    const duplicate = await insert(Buffer.alloc(32, 2), 'k1');
    expect(duplicate).toMatchObject({ ok: false, code: '23505' });
    const short = await insert(Buffer.alloc(31, 1), 'k2');
    expect(short).toMatchObject({ ok: false, code: '23514' });
    const bucket = `INSERT INTO rate_limit_buckets (scope, subject, window_start, count) VALUES ('login', 'u1', date_trunc('minute', now()), 1)`;
    expect((await tryQuery(api, bucket)).ok).toBe(true);
    expect(await tryQuery(api, bucket)).toMatchObject({ ok: false, code: '23505' });
    expect((await tryQuery(env.urlFor('worker'), `DELETE FROM rate_limit_buckets`)).ok).toBe(true);
  });
});

describe('fail closed (TC-BKP-11)', () => {
  const failed = async (options: ProvisionOptions, message: RegExp) => {
    const run = await setUp(options);
    const result = drizzleMigrate(run.env, run.dir);
    expect(result.status).not.toBe(0);
    expect(await roleCheckMessage(run.env, run.dir)).toMatch(message);
    const left = await tryQuery(
      run.env.urlFor('superuser'),
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname IN ('public', 'pgboss')`,
    );
    expect(left).toMatchObject({ ok: true, rows: [{ n: 0 }] });
    return run;
  };

  it('refuses, naming the role, when app_backup is missing, and creates nothing', async () => {
    const options: ProvisionOptions = { skipRoles: ['backup'] };
    const run = await setUp(options);
    const result = drizzleMigrate(run.env, run.dir);
    expect(result.status).not.toBe(0);
    expect(await roleCheckMessage(run.env, run.dir)).toContain(
      `required database role(s) missing: ${run.env.roles.backup}`,
    );
    const tables = await tryQuery(
      run.env.urlFor('superuser'),
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname IN ('public', 'pgboss')`,
    );
    expect(tables).toMatchObject({ ok: true, rows: [{ n: 0 }] });
    const schema = await tryQuery(
      run.env.urlFor('superuser'),
      `SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss'`,
    );
    expect(schema).toMatchObject({ ok: true, rows: [] });
  });

  it('refuses when a runtime role is missing', async () => {
    await failed({ skipRoles: ['worker'] }, new RegExp(`missing: ${'app_worker_'}`));
  });

  it('refuses when app_backup has no read-only session default', async () => {
    await failed({ skipBackupReadOnlyDefault: true }, /no default_transaction_read_only = on/);
  });

  it('refuses when the runtime roles have no search_path default', async () => {
    await failed({ skipSearchPath: true }, /no search_path = public session default/);
  });

  it('refuses an app_backup that can inherit through a membership', async () => {
    const run = await setUp();
    await withClient(run.env.urlFor('superuser', 'postgres'), (c) =>
      c.query(`GRANT "${run.env.roles.api}" TO "${run.env.roles.backup}"`),
    );
    const result = drizzleMigrate(run.env, run.dir);
    expect(result.status).not.toBe(0);
    expect(await roleCheckMessage(run.env, run.dir)).toContain('is a member of another role');
  });

  it('with every role present the grants and default privileges are in the migration history', async () => {
    const migration = readFileSync(
      join(apiDir, 'src', 'database', 'migrations', '0001_task-025-platform.sql'),
      'utf8',
    );
    for (const text of [
      'ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public GRANT SELECT ON TABLES TO app_backup',
      'ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA pgboss GRANT SELECT ON SEQUENCES TO app_backup',
      'ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_api, app_worker',
      'REVOKE CREATE ON SCHEMA public FROM PUBLIC',
    ]) {
      expect(migration).toContain(text);
    }
    expect(drizzleMigrate(env, dir).status).toBe(0);
  });
});

describe('roles as provisioned (TC-BKP-03, TC-BKP-04)', () => {
  it('TC-BKP-03: attributes, memberships, session default and connection limit', async () => {
    await withClient(env.urlFor('hostAdmin', 'postgres'), async (c) => {
      const admin = await c.query(
        'SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = $1',
        [env.hostAdmin],
      );
      expect(admin.rows[0]).toEqual({ rolsuper: false, rolcreaterole: true });
      const r = await c.query(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls, rolconnlimit
           FROM pg_roles WHERE rolname = $1`,
        [env.roles.backup],
      );
      expect(r.rows[0]).toEqual({
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
        rolconnlimit: 2,
      });
      const member = await c.query(
        `SELECT rolname FROM pg_roles WHERE rolname <> $1 AND pg_has_role($1, oid, 'MEMBER') ORDER BY 1`,
        [env.roles.backup],
      );
      expect(member.rows).toEqual([]);
      for (const predefined of [
        'pg_read_all_data',
        'pg_write_all_data',
        'pg_monitor',
        'pg_read_server_files',
        'pg_execute_server_program',
        'pg_signal_backend',
      ]) {
        const x = await c.query('SELECT pg_has_role($1, $2, $3) AS m', [
          env.roles.backup,
          predefined,
          'MEMBER',
        ]);
        expect((x.rows[0] as { m: boolean }).m, predefined).toBe(false);
      }
    });
    const open: pg.Client[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const c = new pg.Client({ connectionString: env.urlFor('backup') });
        await c.connect();
        open.push(c);
      }
      const third = new pg.Client({ connectionString: env.urlFor('backup') });
      await expect(third.connect()).rejects.toMatchObject({ code: '53300' });
    } finally {
      await Promise.all(open.map((c) => c.end()));
    }
  });

  it('TC-BKP-04: only the creating admin holds a grant on app_backup (ADMIN, no INHERIT, no SET)', async () => {
    await withClient(env.urlFor('hostAdmin', 'postgres'), async (c) => {
      const v = await c.query('SHOW server_version_num');
      const major = Math.floor(
        Number((v.rows[0] as { server_version_num: string }).server_version_num) / 10000,
      );
      expect(major).toBeGreaterThanOrEqual(16);
      const r = await c.query(
        `SELECT m.rolname AS member, am.admin_option, am.inherit_option, am.set_option
           FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
          WHERE r.rolname = $1`,
        [env.roles.backup],
      );
      expect(r.rows).toEqual([
        { member: env.hostAdmin, admin_option: true, inherit_option: false, set_option: false },
      ]);
      await expect(c.query(`SET ROLE "${env.roles.backup}"`)).rejects.toMatchObject({
        code: '42501',
      });
    });
  });
});

describe('later-migration scaffold: what the runtime roles get by default', () => {
  // These tables stand for what M0002 and M0004 create: owned by app_migrator, with explicit grants only.
  it('a table created later gives the runtime roles nothing until a migration grants it', async () => {
    await withClient(env.urlFor('migrator'), async (c) => {
      await c.query(
        `CREATE TABLE public.audit_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, what text NOT NULL)`,
      );
      await c.query(
        `GRANT SELECT, INSERT ON public.audit_events TO "${env.roles.api}", "${env.roles.worker}"`,
      );
      await c.query(
        `CREATE TABLE public.provider_keys (id uuid PRIMARY KEY, label text NOT NULL, ciphertext bytea NOT NULL, nonce bytea NOT NULL, wrapped_dek bytea NOT NULL)`,
      );
      await c.query(
        `GRANT SELECT (id, label), INSERT, UPDATE (label) ON public.provider_keys TO "${env.roles.api}"`,
      );
      await c.query(`CREATE TABLE public.ungranted (id int)`);
      await c.query(`INSERT INTO public.audit_events (what) VALUES ('seed')`);
      await c.query(
        `INSERT INTO public.provider_keys VALUES ('00000000-0000-4000-8000-000000000002', 'k', '\\x0102', '\\x03', '\\x04')`,
      );
    });
    denied(await tryQuery(env.urlFor('api'), 'SELECT * FROM public.ungranted'));
    denied(await tryQuery(env.urlFor('worker'), 'SELECT * FROM public.ungranted'));
    expect(
      (await tryQuery(env.urlFor('api'), 'SELECT id, label FROM public.provider_keys')).ok,
    ).toBe(true);
  });

  it('app_api has no DDL, cannot update audit_events and cannot select provider_keys.ciphertext', async () => {
    const api = env.urlFor('api');
    denied(await tryQuery(api, 'UPDATE public.audit_events SET what = $1', ['x']));
    denied(await tryQuery(api, 'DELETE FROM public.audit_events'));
    denied(await tryQuery(api, 'SELECT ciphertext FROM public.provider_keys'));
    denied(await tryQuery(api, 'SELECT id, nonce, wrapped_dek FROM public.provider_keys'));
    for (const role of ['api', 'worker'] as const) {
      const url = env.urlFor(role);
      denied(await tryQuery(url, 'CREATE TABLE public.by_runtime (id int)'));
      denied(await tryQuery(url, 'CREATE TABLE pgboss.by_runtime (id int)'));
      denied(await tryQuery(url, 'CREATE SCHEMA by_runtime'));
      denied(await tryQuery(url, 'ALTER TABLE public.audit_events ADD COLUMN extra int'));
      denied(await tryQuery(url, 'DROP TABLE public.audit_events'));
      denied(await tryQuery(url, 'TRUNCATE public.rate_limit_buckets'));
    }
  });
});

describe('jobs:migrate then the runtime roles (TC-BKP-08)', () => {
  it('a pg-boss migrate start by a runtime role before the schema is installed is refused and creates nothing', async () => {
    for (const role of ['worker', 'api'] as const) {
      const { boss } = runtimeBoss(env, role, { migrate: true });
      await expect(boss.start()).rejects.toThrow(/permission denied|must be owner|pgboss/i);
      await boss.stop({ graceful: false }).catch(() => undefined);
      expect(await pgbossTables(env)).toEqual([]);
      const { boss: plain } = runtimeBoss(env, role);
      await expect(plain.start()).rejects.toThrow();
      await plain.stop({ graceful: false }).catch(() => undefined);
    }
  });

  it('installs pg-boss into the pre-created schema and creates the catalogue queues as app_migrator', async () => {
    expect(await installQueues(env, queues)).toEqual(['probe-standard', 'probe-partitioned']);
    expect(await installQueues(env, queues)).toEqual([]);
    expect(await pgbossTables(env)).toEqual(
      expect.arrayContaining(['job', 'queue', 'schedule', 'version']),
    );
    await withClient(env.urlFor('superuser'), async (c) => {
      const owners = await c.query(
        `SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'pgboss' AND c.relkind IN ('r', 'p', 'S')`,
      );
      expect(owners.rows).toEqual([{ owner: env.roles.migrator }]);
    });
  });

  it('the runtime roles hold USAGE and DML on pgboss and no CREATE anywhere', async () => {
    await withClient(env.urlFor('superuser'), async (c) => {
      for (const role of [env.roles.api, env.roles.worker]) {
        const r = await c.query(
          `SELECT has_schema_privilege($1, 'pgboss', 'USAGE') AS usage, has_schema_privilege($1, 'pgboss', 'CREATE') AS create_priv,
                  has_database_privilege($1, current_database(), 'CREATE') AS db_create,
                  has_schema_privilege($1, 'public', 'CREATE') AS public_create`,
          [role],
        );
        expect(r.rows[0]).toEqual({
          usage: true,
          create_priv: false,
          db_create: false,
          public_create: false,
        });
      }
    });
  });

  it('app_api sends and reads queue state; app_worker sends, fetches, completes, schedules and supervises', async () => {
    const api = runtimeBoss(env, 'api', { supervise: false, schedule: false });
    await api.boss.start();
    try {
      expect(await api.boss.send('probe-standard', { from: 'api' })).toBeTruthy();
      expect(await api.boss.send('probe-partitioned', { from: 'api' })).toBeTruthy();
      expect(await api.boss.getQueue('probe-standard')).not.toBeNull();
      expect(api.errors).toEqual([]);
    } finally {
      await api.boss.stop({ graceful: true });
    }
    const worker = runtimeBoss(env, 'worker', { supervise: true, schedule: true });
    await worker.boss.start();
    try {
      for (const queue of ['probe-standard', 'probe-partitioned']) {
        expect(await worker.boss.send(queue, { from: 'worker' })).toBeTruthy();
        const jobs = await worker.boss.fetch<{ from: string }>(queue, { batchSize: 10 });
        expect(jobs.length).toBeGreaterThan(0);
        await worker.boss.complete(
          queue,
          jobs.map((j) => j.id),
        );
      }
      await worker.boss.schedule('probe-standard', '0 3 * * *', { cron: true }, { key: 'm0001' });
      expect((await worker.boss.getSchedules('probe-standard')).length).toBe(1);
      await worker.boss.unschedule('probe-standard', 'm0001');
      await worker.boss.supervise('probe-standard');
      await worker.boss.supervise('probe-partitioned');
      expect(worker.errors).toEqual([]);
    } finally {
      await worker.boss.stop({ graceful: true });
    }
  });

  for (const role of ['worker', 'api'] as const) {
    it(`createQueue of a table-backed queue and a pg-boss migrate start as app_${role} are refused`, async () => {
      const before = await pgbossTables(env);
      const { boss } = runtimeBoss(env, role, { supervise: false, schedule: false });
      await boss.start();
      try {
        await expect(
          boss.createQueue(`probe-runtime-made-${role}`, { partition: true }),
        ).rejects.toThrow(/permission denied/i);
        expect(await boss.getQueue(`probe-runtime-made-${role}`)).toBeNull();
      } finally {
        await boss.stop({ graceful: true });
      }
      const migrating = runtimeBoss(env, role, {
        migrate: true,
        supervise: false,
        schedule: false,
      });
      // On a schema that is already current there is nothing to migrate, so the start may succeed; either way no DDL runs.
      await migrating.boss.start().catch(() => undefined);
      await migrating.boss.stop({ graceful: false }).catch(() => undefined);
      expect(await pgbossTables(env)).toEqual(before);
      denied(await tryQuery(env.urlFor(role), 'CREATE TABLE pgboss.should_not_exist (id int)'));
    });
  }

  it('GAP G-1: a plain queue is one INSERT into pgboss.queue, which the DML default allows; it creates no table', async () => {
    // A post-install REVOKE (a jobs:migrate step, recorded for that ticket) closes it for app_api and keeps the scheduler's
    // own INSERT for app_worker. M0001 cannot issue it: pgboss.queue does not exist when M0001 runs.
    const before = await pgbossTables(env);
    const api = runtimeBoss(env, 'api', { supervise: false, schedule: false });
    await api.boss.start();
    try {
      await api.boss.createQueue('probe-runtime-plain');
      expect(await pgbossTables(env)).toEqual(before);
    } finally {
      await api.boss.stop({ graceful: true });
    }
    expect(runPgDump(env, 'backup').status).toBe(0);
    await withClient(env.urlFor('migrator'), async (c) => {
      await c.query(`DELETE FROM pgboss.queue WHERE name = 'probe-runtime-plain'`);
      await c.query(`REVOKE INSERT, DELETE ON pgboss.queue FROM "${env.roles.api}"`);
    });
    const closed = runtimeBoss(env, 'api', { supervise: false, schedule: false });
    await closed.boss.start();
    try {
      await expect(closed.boss.createQueue('probe-runtime-plain')).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await closed.boss.stop({ graceful: true });
    }
  });

  it('a queue missing from the catalogue is detected by the runtime role (startup check basis)', async () => {
    const { boss } = runtimeBoss(env, 'worker', { supervise: false, schedule: false });
    await boss.start();
    try {
      const missing: string[] = [];
      for (const name of ['probe-standard', 'probe-partitioned', 'probe-added-later']) {
        if ((await boss.getQueue(name)) === null) missing.push(name);
      }
      expect(missing).toEqual(['probe-added-later']);
    } finally {
      await boss.stop({ graceful: true });
    }
  });
});

describe('app_backup reads everything (TC-BKP-01, TC-BKP-07)', () => {
  it('TC-BKP-01: SELECT on every table and sequence of public and pgboss, every column, and pg_dump completes', async () => {
    await withClient(env.urlFor('backup'), async (c) => {
      const tables = await c.query(
        `SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('public', 'pgboss') AND c.relkind IN ('r', 'p', 'S') ORDER BY 1, 2`,
      );
      expect(tables.rowCount).toBeGreaterThan(10);
      for (const row of tables.rows as { nspname: string; relname: string; relkind: string }[]) {
        const name = `"${row.nspname}"."${row.relname}"`;
        const sql =
          row.relkind === 'S' ? `SELECT last_value FROM ${name}` : `SELECT * FROM ${name}`;
        await c.query(sql);
      }
      const keys = await c.query('SELECT ciphertext, nonce, wrapped_dek FROM public.provider_keys');
      expect(keys.rows).toHaveLength(1);
      expect((keys.rows[0] as { ciphertext: Buffer }).ciphertext.toString('hex')).toBe('0102');
    });
    const dump = runPgDump(env, 'backup');
    expect(dump.status, dump.stderr).toBe(0);
    expect(dump.dump).toContain('CREATE TABLE public.provider_keys');
    expect(dump.dump).toContain('CREATE TABLE public.rate_limit_buckets');
    expect(dump.dump).toContain('CREATE TABLE pgboss.job');
  });

  it('TC-BKP-07: a queue created by jobs:migrate is in the next dump taken as app_backup', async () => {
    const before = await pgbossTables(env);
    const created = await installQueues(env, [
      ...queues,
      {
        name: 'probe-added-later',
        policy: 'standard',
        retryLimit: 0,
        expireInSeconds: 900,
        partition: true,
      },
    ]);
    expect(created).toEqual(['probe-added-later']);
    const added = (await pgbossTables(env)).filter((t) => !before.includes(t));
    expect(added.length).toBeGreaterThan(0);
    const dump = runPgDump(env, 'backup');
    expect(dump.status, dump.stderr).toBe(0);
    for (const t of added) expect(dump.dump).toContain(`CREATE TABLE pgboss.${t}`);
    const { boss } = runtimeBoss(env, 'worker', { supervise: false, schedule: false });
    await boss.start();
    try {
      expect(await boss.getQueue('probe-added-later')).not.toBeNull();
      expect(await boss.send('probe-added-later', { ok: true })).toBeTruthy();
    } finally {
      await boss.stop({ graceful: true });
    }
  });
});

describe('app_backup is read-only (TC-BKP-02, TC-BKP-05, TC-BKP-06)', () => {
  it('TC-BKP-02: writes, DDL, SET ROLE, COPY, terminate and nextval are refused with no side effects', async () => {
    await withClient(env.urlFor('migrator'), async (c) => {
      await c.query(
        `CREATE TABLE public.probe_items (id bigint GENERATED ALWAYS AS IDENTITY, label text NOT NULL)`,
      );
      await c.query(`INSERT INTO public.probe_items (label) VALUES ('seed')`);
    });
    const counts = async () =>
      withClient(env.urlFor('superuser'), async (c) => {
        const x = await c.query(
          `SELECT (SELECT count(*) FROM public.probe_items)::int AS items, (SELECT count(*) FROM pgboss.job)::int AS jobs,
                  (SELECT count(*) FROM public.audit_events)::int AS audit, (SELECT last_value FROM public.probe_items_id_seq) AS seq`,
        );
        return x.rows[0];
      });
    const before = await counts();
    const statements: string[] = [];
    for (const t of [
      'public.probe_items',
      'public.provider_keys',
      'public.rate_limit_buckets',
      'pgboss.job',
      'pgboss.queue',
    ]) {
      statements.push(`INSERT INTO ${t} DEFAULT VALUES`, `DELETE FROM ${t}`, `TRUNCATE ${t}`);
    }
    statements.push(
      `UPDATE public.probe_items SET label = 'x'`,
      `UPDATE pgboss.queue SET name = 'x'`,
      `CREATE TABLE public.x (id int)`,
      `CREATE TABLE pgboss.x (id int)`,
      `ALTER TABLE public.probe_items ADD COLUMN extra int`,
      `ALTER TABLE pgboss.job ADD COLUMN extra int`,
      `DROP TABLE public.probe_items`,
      `DROP TABLE pgboss.job`,
      `CREATE SCHEMA other`,
      `SET ROLE "${env.roles.api}"`,
      `SET ROLE "${env.roles.worker}"`,
      `SET ROLE "${env.roles.migrator}"`,
      `COPY (SELECT 1) TO PROGRAM 'true'`,
      `COPY (SELECT 1) TO '/tmp/t025_${env.suffix}.out'`,
      `SELECT nextval('public.probe_items_id_seq')`,
    );
    await withClient(env.urlFor('backup'), async (c) => {
      for (const sql of statements) {
        // READ WRITE, so that the grants and not the session default refuse the statement.
        await c.query('BEGIN READ WRITE');
        const refused = await c.query(sql).then(
          () => 'allowed',
          (e: { code?: string }) => e.code ?? 'none',
        );
        await c.query('ROLLBACK');
        expect(refused, sql).toBe('42501');
      }
    });
    await withClient(env.urlFor('superuser'), async (c) => {
      for (const t of [
        'public.probe_items',
        'public.provider_keys',
        'public.rate_limit_buckets',
        'pgboss.job',
        'pgboss.queue',
      ]) {
        for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          const r = await c.query('SELECT has_table_privilege($1, $2, $3) AS h', [
            env.roles.backup,
            t,
            p,
          ]);
          expect((r.rows[0] as { h: boolean }).h, `${p} on ${t}`).toBe(false);
        }
        const sel = await c.query('SELECT has_table_privilege($1, $2, $3) AS h', [
          env.roles.backup,
          t,
          'SELECT',
        ]);
        expect((sel.rows[0] as { h: boolean }).h, `SELECT on ${t}`).toBe(true);
      }
      const seq = await c.query(
        `SELECT has_sequence_privilege($1, 'public.probe_items_id_seq', 'USAGE') AS u, has_sequence_privilege($1, 'public.probe_items_id_seq', 'UPDATE') AS w`,
        [env.roles.backup],
      );
      expect(seq.rows[0]).toEqual({ u: false, w: false });
      for (const schema of ['public', 'pgboss']) {
        const r = await c.query(`SELECT has_schema_privilege($1, $2, 'CREATE') AS h`, [
          env.roles.backup,
          schema,
        ]);
        expect((r.rows[0] as { h: boolean }).h).toBe(false);
      }
    });
    const victim = new pg.Client({ connectionString: env.urlFor('worker') });
    await victim.connect();
    try {
      const pid = Number(
        ((await victim.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid,
      );
      const r = await tryQuery(env.urlFor('backup'), 'SELECT pg_terminate_backend($1)', [pid]);
      expect(r.ok).toBe(false);
      expect(((await victim.query('SELECT 1 AS ok')).rows[0] as { ok: number }).ok).toBe(1);
    } finally {
      await victim.end();
    }
    expect(await counts()).toEqual(before);
  });

  it('TC-BKP-05: the session default is read-only and a READ WRITE transaction still cannot write', async () => {
    await withClient(env.urlFor('backup'), async (c) => {
      const show = await c.query('SHOW default_transaction_read_only');
      expect(
        (show.rows[0] as { default_transaction_read_only: string }).default_transaction_read_only,
      ).toBe('on');
      await c.query('BEGIN READ WRITE');
      await expect(
        c.query(`INSERT INTO public.probe_items (label) VALUES ('nope')`),
      ).rejects.toMatchObject({
        code: '42501',
      });
      await c.query('ROLLBACK');
    });
  });

  it('TC-BKP-06: a table added later by app_migrator is readable without a new grant; app_api cannot add one', async () => {
    await withClient(env.urlFor('migrator'), async (c) => {
      await c.query('CREATE TABLE public.added_later (id int)');
      await c.query('CREATE TABLE pgboss.added_later (id int)');
      await c.query('CREATE SEQUENCE public.added_later_seq');
    });
    for (const sql of [
      'SELECT count(*) FROM public.added_later',
      'SELECT count(*) FROM pgboss.added_later',
      'SELECT last_value FROM public.added_later_seq',
    ]) {
      expect((await tryQuery(env.urlFor('backup'), sql)).ok, sql).toBe(true);
    }
    denied(await tryQuery(env.urlFor('api'), 'CREATE TABLE public.by_api (id int)'));
    denied(await tryQuery(env.urlFor('api'), 'CREATE TABLE pgboss.by_api (id int)'));
    const dump = runPgDump(env, 'backup');
    expect(dump.status, dump.stderr).toBe(0);
    expect(dump.dump).toContain('CREATE TABLE public.added_later');
  });
});

describe('pg_dump with row security off (TC-BKP-09)', () => {
  it('fails loudly on a table with row security and no policy, and completes without it', async () => {
    await withClient(env.urlFor('migrator'), async (c) => {
      await c.query('CREATE TABLE public.rls_probe (id int)');
      await c.query('INSERT INTO public.rls_probe VALUES (1)');
      await c.query('ALTER TABLE public.rls_probe ENABLE ROW LEVEL SECURITY');
    });
    const failed = runPgDump(env, 'backup');
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('rls_probe');
    await withClient(env.urlFor('migrator'), (c) => c.query('DROP TABLE public.rls_probe'));
    const ok = runPgDump(env, 'backup');
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.dump).toContain('CREATE TABLE public.provider_keys');
  });
});

describe('other databases (TC-BKP-10)', () => {
  it('connects to the application database; another database shows only its catalog or refuses', async () => {
    const other = `t025_other_${env.suffix}`;
    await withClient(env.urlFor('superuser', 'postgres'), (c) =>
      c.query(`CREATE DATABASE "${other}"`),
    );
    await withClient(env.urlFor('superuser', other), (c) =>
      c.query('CREATE TABLE public.secret (id int)'),
    );
    expect((await tryQuery(env.urlFor('backup'), 'SELECT 1 AS ok')).ok).toBe(true);
    // CONNECT is granted by PUBLIC default here; the object grants exist only in the application database.
    denied(await tryQuery(env.urlFor('backup', other), 'SELECT * FROM public.secret'));
    await withClient(env.urlFor('superuser', other), (c) =>
      c.query(`REVOKE CONNECT ON DATABASE "${other}" FROM PUBLIC`),
    );
    expect(await tryQuery(env.urlFor('backup', other), 'SELECT 1')).toMatchObject({
      ok: false,
      code: '42501',
    });
  });
});

describe('real entry points on the migrated database', () => {
  const PORT = 3957;
  let child: ChildProcess | undefined;
  afterAll(() => {
    child?.kill('SIGTERM');
  });

  it('db:seed (dist/database/seed.js) runs as app_migrator against the migrated database, twice', async () => {
    const build = spawnSync('pnpm', ['build'], { cwd: apiDir, encoding: 'utf8' });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    // The reference dataset writes price_table, brand_rules and platform_settings: bring the schema to the latest migration.
    // A fresh database: the suites above leave this one deliberately altered.
    const { env: seedEnv } = await setUp();
    const fullDir = renderMigrations(seedEnv);
    dirs.push(fullDir);
    const rest = drizzleMigrate(seedEnv, fullDir);
    expect(rest.status, rest.stdout + rest.stderr).toBe(0);
    for (let run = 0; run < 2; run += 1) {
      const result = spawnSync('node', ['dist/database/seed.js', '--dataset=reference'], {
        cwd: apiDir,
        env: {
          PATH: process.env['PATH'] ?? '',
          ...validEnv('release', { MIGRATION_DATABASE_URL: seedEnv.urlFor('migrator') }),
        },
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
  });

  it('the built API (dist/main.api.js) starts as app_api on the migrated database and closes its pool', async () => {
    // The release order: db:migrate, then jobs:migrate; the api fails closed without the pg-boss schema and queues.
    await migrateJobs(env.urlFor('migrator'), QUEUES, {
      api: env.roles.api,
      worker: env.roles.worker,
    });
    let stderr = '';
    child = spawn('node', ['dist/main.api.js'], {
      cwd: apiDir,
      env: {
        PATH: process.env['PATH'] ?? '',
        ...validEnv('api', {
          DATABASE_URL: env.urlFor('api'),
          API_PORT: String(PORT),
          DATABASE_POOL_MAX: '3',
        }),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/health/live`)).ok) break;
      } catch {
        if (Date.now() > deadline) throw new Error(`api did not start: ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const closed = new Promise<void>((resolve) => child?.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await closed;
  });
});

describe('cleanup', () => {
  it('lists run objects that the teardown must drop', async () => {
    expect((await leftovers(env)).length).toBeGreaterThanOrEqual(7);
  });
});
