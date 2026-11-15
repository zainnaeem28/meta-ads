import { PgBoss } from 'pg-boss';
import type { Queue } from 'pg-boss';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  drizzleMigrate,
  jobsMigrate,
  leftovers,
  pgDump,
  pgDumpVersion,
  provision,
  renderMigrations,
  runPgDump,
  teardown,
  tryQuery,
  withClient,
} from './harness.ts';
import type { Env, RoleKey } from './harness.ts';

let env: Env;
let migrationsDir = '';
let finalLeftovers: string[] | undefined;
const log = (line: string) => console.log(`[db-proof] ${line}`);

const permissionDenied = (r: { ok: boolean; code?: string; message?: string }) => {
  expect(r.ok).toBe(false);
  // 42501 insufficient_privilege; the message text is recorded in the proof output.
  expect(r.code).toBe('42501');
};

/** A pg-boss instance as a runtime process would build it: no migration, no schema creation. */
function runtimeBoss(role: RoleKey, extra: Partial<ConstructorParameters<typeof PgBoss>[0]> = {}) {
  const errors: string[] = [];
  const boss = new PgBoss({
    connectionString: env.urlFor(role),
    schema: 'pgboss',
    migrate: false,
    createSchema: false,
    max: 3,
    ...extra,
  });
  boss.on('error', (e: Error) => errors.push(e.message));
  return { boss, errors };
}

async function pgbossTables(): Promise<string[]> {
  return withClient(env.urlFor('superuser'), async (c) => {
    const r = await c.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pgboss' AND c.relkind IN ('r', 'p') ORDER BY 1`,
    );
    return r.rows.map((x) => String(x.relname));
  });
}

/** What app_api does at runtime: send and read queue state. */
async function apiFlow(): Promise<void> {
  const { boss, errors } = runtimeBoss('api', { supervise: false, schedule: false });
  await boss.start();
  try {
    expect(await boss.send('probe-standard', { from: 'api' })).toBeTruthy();
    expect(await boss.send('probe-partitioned', { from: 'api' })).toBeTruthy();
    expect(await boss.getQueue('probe-standard')).not.toBeNull();
    expect(await boss.getQueue('no-such-queue')).toBeNull();
    expect(errors).toEqual([]);
  } finally {
    await boss.stop({ graceful: true });
  }
}

/** What app_worker does at runtime: send, fetch, complete, schedule, supervision and maintenance. */
async function workerFlow(): Promise<string[]> {
  const { boss, errors } = runtimeBoss('worker', { supervise: true, schedule: true });
  const warnings: string[] = [];
  boss.on('warning', (w: { message: string }) => warnings.push(w.message));
  await boss.start();
  try {
    for (const queue of ['probe-standard', 'probe-partitioned']) {
      expect(await boss.send(queue, { from: 'worker' })).toBeTruthy();
      const jobs = await boss.fetch<{ from: string }>(queue, { batchSize: 10 });
      expect(jobs.length).toBeGreaterThan(0);
      await boss.complete(
        queue,
        jobs.map((j) => j.id),
      );
      expect((await boss.getQueueStats(queue)).length).toBeGreaterThan(0);
    }
    await boss.schedule('probe-standard', '0 3 * * *', { cron: true }, { key: 'foundation' });
    expect((await boss.getSchedules('probe-standard')).length).toBe(1);
    await boss.unschedule('probe-standard', 'foundation');
    await boss.supervise('probe-standard');
    await boss.supervise('probe-partitioned');
    expect(errors).toEqual([]);
    return warnings;
  } finally {
    await boss.stop({ graceful: true });
  }
}

async function plainQueueRows(): Promise<string[]> {
  return withClient(env.urlFor('superuser'), async (c) => {
    const r = await c.query(`SELECT name FROM pgboss.queue ORDER BY 1`);
    return r.rows.map((x) => String(x.name));
  });
}

beforeAll(async () => {
  env = await provision();
  migrationsDir = renderMigrations(env);
  log(
    `server ${await withClient(env.urlFor('superuser'), async (c) => String((await c.query('SELECT version()')).rows[0]?.version))}`,
  );
  log(`pg_dump ${pgDumpVersion()} (${pgDump})`);
  log(`database ${env.database}, roles suffix ${env.suffix}`);
});

afterAll(async () => {
  if (migrationsDir) cleanup(migrationsDir);
  if (!env) return;
  finalLeftovers = await teardown(env);
  log(`teardown: leftovers after drop = ${JSON.stringify(finalLeftovers)}`);
  expect(finalLeftovers).toEqual([]);
});

describe('roles as at provisioning (TC-BKP-03, TC-BKP-04)', () => {
  it('TC-BKP-03: app_backup attributes, memberships and connection limit', async () => {
    await withClient(env.urlFor('hostAdmin', 'postgres'), async (c) => {
      const admin = await c.query(
        'SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = $1',
        [env.hostAdmin],
      );
      // Fixture rule: a superuser creator is a fixture error, never a pass.
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
        expect(x.rows[0]?.m, predefined).toBe(false);
      }
      const settings = await c.query(
        `SELECT unnest(setconfig) AS s FROM pg_db_role_setting WHERE setrole = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
        [env.roles.backup],
      );
      expect(settings.rows).toEqual([{ s: 'default_transaction_read_only=on' }]);
    });
    // Third concurrent connection is refused (limit 2).
    const open: pg.Client[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const c = new pg.Client({ connectionString: env.urlFor('backup') });
        await c.connect();
        open.push(c);
      }
      const third = new pg.Client({ connectionString: env.urlFor('backup') });
      await expect(third.connect()).rejects.toMatchObject({ code: '53300' });
      log('TC-BKP-03: third concurrent app_backup connection refused (53300)');
    } finally {
      await Promise.all(open.map((c) => c.end()));
    }
  });

  it('TC-BKP-04: only the creating admin holds a grant on app_backup (ADMIN, no INHERIT, no SET)', async () => {
    await withClient(env.urlFor('hostAdmin', 'postgres'), async (c) => {
      const v = await c.query('SHOW server_version_num');
      const major = Math.floor(Number(v.rows[0]?.server_version_num) / 10000);
      expect(major).toBeGreaterThanOrEqual(16); // below 16 the case is "not applicable", never a pass
      const r = await c.query(
        `SELECT m.rolname AS member, am.admin_option, am.inherit_option, am.set_option
           FROM pg_auth_members am
           JOIN pg_roles r ON r.oid = am.roleid
           JOIN pg_roles m ON m.oid = am.member
          WHERE r.rolname = $1`,
        [env.roles.backup],
      );
      expect(r.rows).toEqual([
        { member: env.hostAdmin, admin_option: true, inherit_option: false, set_option: false },
      ]);
      await expect(c.query(`SET ROLE "${env.roles.backup}"`)).rejects.toMatchObject({
        code: '42501',
      });
      log(
        `TC-BKP-04: PostgreSQL ${major}; pg_auth_members row = ${JSON.stringify(r.rows[0])}; SET ROLE refused`,
      );
    });
  });
});

describe('drizzle-kit migrate as app_migrator', () => {
  it('applies the CLI-generated probe migrations and pre-creates the pgboss schema', async () => {
    const r = drizzleMigrate(env, migrationsDir);
    log(`drizzle-kit migrate exit ${r.status}`);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    await withClient(env.urlFor('superuser'), async (c) => {
      const applied = await c.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
      expect(applied.rows[0]?.n).toBe(2);
      const owners = await c.query(
        `SELECT nspname, pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname IN ('public', 'pgboss') ORDER BY 1`,
      );
      expect(owners.rows).toEqual([
        { nspname: 'pgboss', owner: env.roles.migrator },
        { nspname: 'public', owner: env.roles.migrator },
      ]);
    });
    expect(await pgbossTables()).toEqual([]);
    // A second run is a no-op (idempotent).
    expect(drizzleMigrate(env, migrationsDir).status).toBe(0);
  });
});

describe('runtime roles before the pg-boss schema exists (TC-BKP-08, pre-install)', () => {
  for (const role of ['worker', 'api'] as const) {
    it(`a pg-boss migrate start as app_${role} is refused and creates nothing`, async () => {
      const { boss } = runtimeBoss(role, { migrate: true });
      await expect(boss.start()).rejects.toThrow(/permission denied|must be owner|pgboss/i);
      await boss.stop({ graceful: false }).catch(() => undefined);
      expect(await pgbossTables()).toEqual([]);
      const direct = await tryQuery(
        env.urlFor(role),
        'CREATE TABLE pgboss.should_not_exist (id int)',
      );
      permissionDenied(direct);
    });

    it(`a runtime start as app_${role} with migrate:false fails fast on the missing schema`, async () => {
      const { boss } = runtimeBoss(role);
      await expect(boss.start()).rejects.toThrow();
      await boss.stop({ graceful: false }).catch(() => undefined);
    });
  }
});

describe('jobs:migrate as app_migrator (real entry point)', () => {
  it('installs pg-boss 12 into pgboss and creates every catalogue queue', async () => {
    const r = jobsMigrate(env);
    log(`jobs:migrate stdout: ${r.stdout.trim().replaceAll('\n', ' | ')}`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('created queue probe-standard');
    expect(r.stdout).toContain('created queue probe-partitioned');
    const tables = await pgbossTables();
    expect(tables).toEqual(expect.arrayContaining(['job', 'queue', 'schedule', 'version']));
    await withClient(env.urlFor('superuser'), async (c) => {
      const owners = await c.query(
        `SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'pgboss' AND c.relkind IN ('r', 'p', 'S')`,
      );
      expect(owners.rows).toEqual([{ owner: env.roles.migrator }]);
    });
    // Idempotent re-run.
    const again = jobsMigrate(env);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).not.toContain('created queue');
    log(`pgboss tables after jobs:migrate: ${(await pgbossTables()).length}`);
  });
});

describe('runtime roles with only USAGE and DML on pgboss (TC-BKP-08, post-install)', () => {
  it('the role privileges on pgboss are USAGE and DML only', async () => {
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

  it('app_api can send and read queue state', async () => {
    await apiFlow();
    log('app_api: send (standard and partitioned queue) and getQueue ok');
  });

  it('app_worker can send, fetch, complete, schedule, and run supervision and maintenance', async () => {
    const warnings = await workerFlow();
    log(
      `app_worker: send/fetch/complete/schedule/supervise ok on both queues; warnings=${JSON.stringify(warnings)}`,
    );
  });

  for (const role of ['worker', 'api'] as const) {
    it(`createQueue for a partitioned queue as app_${role} is refused (no CREATE on pgboss)`, async () => {
      const before = await pgbossTables();
      const { boss } = runtimeBoss(role, { supervise: false, schedule: false });
      await boss.start();
      try {
        await expect(boss.createQueue('probe-runtime-made', { partition: true })).rejects.toThrow(
          /permission denied/i,
        );
        expect(await boss.getQueue('probe-runtime-made')).toBeNull();
      } finally {
        await boss.stop({ graceful: true });
      }
      expect(await pgbossTables()).toEqual(before);
    });

    it(`a pg-boss migrate start as app_${role} writes no DDL`, async () => {
      const before = await pgbossTables();
      const { boss } = runtimeBoss(role, { migrate: true, supervise: false, schedule: false });
      const outcome = await boss.start().then(
        () => 'started (schema already current, nothing to migrate)',
        (e: Error) => `refused: ${e.message}`,
      );
      await boss.stop({ graceful: false }).catch(() => undefined);
      log(`app_${role}: migrate start on a current schema -> ${outcome}`);
      expect(await pgbossTables()).toEqual(before);
    });
  }

  it('GAP G-1: with the M0001 default privileges a plain (non-partitioned) createQueue by a runtime role is not refused', async () => {
    // A queue without its own table is one INSERT into pgboss.queue, which the DML grant allows. The
    // scheduler (schedule: true) itself calls createQueue('__pgboss__send-it') at every start, so
    // app_worker needs that INSERT. Only DDL (a partitioned queue's table) is refused.
    for (const role of ['worker', 'api'] as const) {
      const { boss } = runtimeBoss(role, { supervise: false, schedule: false });
      await boss.start();
      try {
        await boss.createQueue(`probe-runtime-plain-${role}`);
        expect(await boss.getQueue(`probe-runtime-plain-${role}`)).not.toBeNull();
      } finally {
        await boss.stop({ graceful: true });
      }
      log(
        `GAP G-1 observed: app_${role} created plain queue probe-runtime-plain-${role} (one INSERT on pgboss.queue)`,
      );
    }
    const dump = runPgDump(env, 'backup');
    expect(dump.status, dump.stderr).toBe(0); // the stray rows are readable by app_backup
    await withClient(env.urlFor('migrator'), (c) =>
      c.query(`DELETE FROM pgboss.queue WHERE name LIKE 'probe-runtime-plain-%'`),
    );
  });

  it('candidate for M0001/jobs:migrate (recorded, not product code): REVOKE INSERT, DELETE on pgboss.queue from app_api and DELETE from app_worker', async () => {
    const [a, w] = [env.roles.api, env.roles.worker];
    await withClient(env.urlFor('migrator'), async (c) => {
      await c.query(`REVOKE INSERT, DELETE ON pgboss.queue FROM "${a}"`);
      await c.query(`REVOKE DELETE ON pgboss.queue FROM "${w}"`);
    });
    const before = await plainQueueRows();
    const api = runtimeBoss('api', { supervise: false, schedule: false });
    await api.boss.start();
    try {
      await expect(api.boss.createQueue('probe-runtime-plain-api')).rejects.toThrow(
        /permission denied/i,
      );
      await expect(
        api.boss.createQueue('probe-runtime-part-api', { partition: true }),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await api.boss.stop({ graceful: true });
    }
    expect(await plainQueueRows()).toEqual(before);
    permissionDenied(
      await tryQuery(
        env.urlFor('api'),
        `INSERT INTO pgboss.queue (name) VALUES ('probe-runtime-plain-api')`,
      ),
    );
    permissionDenied(
      await tryQuery(
        env.urlFor('worker'),
        `DELETE FROM pgboss.queue WHERE name = 'probe-standard'`,
      ),
    );
    // The runtime flows, including the scheduler's own createQueue, still work.
    await apiFlow();
    const warnings = await workerFlow();
    log(
      `candidate: app_api createQueue refused (plain and partitioned); app_worker keeps INSERT for the scheduler; runtime flows pass; warnings=${JSON.stringify(warnings)}`,
    );
  });

  it('a queue missing from the catalogue is detected by the runtime role (startup check basis)', async () => {
    const { boss } = runtimeBoss('worker', { supervise: false, schedule: false });
    await boss.start();
    try {
      const catalogue = ['probe-standard', 'probe-partitioned', 'probe-added-later'];
      const missing: string[] = [];
      for (const name of catalogue) if (!(await boss.getQueue(name))) missing.push(name);
      expect(missing).toEqual(['probe-added-later']);
      log(`startup check basis: missing queue named = ${missing.join(',')}`);
    } finally {
      await boss.stop({ graceful: true });
    }
  });
});

describe('queue-then-dump (TC-BKP-07)', () => {
  it('jobs:migrate creates a new queue and pg_dump as app_backup contains its table', async () => {
    const extra: Queue[] = [
      {
        name: 'probe-added-later',
        policy: 'standard',
        retryLimit: 0,
        expireInSeconds: 900,
        partition: true,
      },
    ];
    const tablesBefore = await pgbossTables();
    const r = jobsMigrate(env, extra);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('created queue probe-added-later');
    const tablesAfter = await pgbossTables();
    const added = tablesAfter.filter((t) => !tablesBefore.includes(t));
    expect(added.length).toBeGreaterThan(0);
    log(`jobs:migrate created tables for the new queue: ${added.join(',')}`);
    const drizzleHistory = await tryQuery(
      env.urlFor('backup'),
      'SELECT count(*) FROM drizzle.__drizzle_migrations',
    );
    log(
      `finding: app_backup reads drizzle.__drizzle_migrations -> ${drizzleHistory.ok ? 'allowed' : `${drizzleHistory.code} ${drizzleHistory.message}`}`,
    );
    const dump = runPgDump(env, 'backup');
    log(`pg_dump as app_backup exit ${dump.status}, ${dump.dump.length} bytes`);
    expect(dump.status, dump.stderr).toBe(0);
    for (const t of added) expect(dump.dump).toContain(`CREATE TABLE pgboss.${t}`);
    expect(dump.dump).toContain('CREATE TABLE public.probe_items');
    // The runtime role sees the queue created by the release step.
    const { boss } = runtimeBoss('worker', { supervise: false, schedule: false });
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
    const backup = env.urlFor('backup');
    const counts = async () =>
      withClient(env.urlFor('superuser'), async (c) => {
        const x = await c.query(
          `SELECT (SELECT count(*) FROM public.probe_items)::int AS items, (SELECT count(*) FROM pgboss.job)::int AS jobs,
                  (SELECT last_value FROM public.probe_items_id_seq) AS seq`,
        );
        return x.rows[0];
      });
    await withClient(env.urlFor('superuser'), (c) =>
      c.query(`INSERT INTO public.probe_items (label) VALUES ('seed')`),
    );
    const before = await counts();
    const targets = ['public.probe_items', 'pgboss.job', 'pgboss.queue'];
    const statements: string[] = [];
    for (const t of targets) {
      statements.push(`INSERT INTO ${t} DEFAULT VALUES`);
      statements.push(`UPDATE ${t} SET ${t === 'public.probe_items' ? 'label' : 'name'} = 'x'`);
      statements.push(`DELETE FROM ${t}`);
      statements.push(`TRUNCATE ${t}`);
    }
    statements.push(
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
      `COPY (SELECT 1) TO '/tmp/t002_${env.suffix}.out'`,
      `SELECT nextval('public.probe_items_id_seq')`,
    );
    await withClient(backup, async (c) => {
      for (const sql of statements) {
        // READ WRITE so that the grants, not the session default, are what refuses the statement.
        await c.query('BEGIN READ WRITE');
        const refused = await c.query(sql).then(
          () => 'allowed',
          (e: { code?: string }) => e.code ?? 'none',
        );
        await c.query('ROLLBACK');
        expect(refused, sql).toBe('42501');
      }
    });
    // REFERENCES and TRIGGER are privileges, so probe them with the catalogue as well as with DDL.
    await withClient(env.urlFor('superuser'), async (c) => {
      for (const t of ['public.probe_items', 'pgboss.job', 'pgboss.queue']) {
        for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          const r = await c.query('SELECT has_table_privilege($1, $2, $3) AS h', [
            env.roles.backup,
            t,
            p,
          ]);
          expect(r.rows[0]?.h, `${p} on ${t}`).toBe(false);
        }
        const sel = await c.query('SELECT has_table_privilege($1, $2, $3) AS h', [
          env.roles.backup,
          t,
          'SELECT',
        ]);
        expect(sel.rows[0]?.h, `SELECT on ${t}`).toBe(true);
      }
    });
    // pg_terminate_backend of a backend that belongs to another role (app_worker).
    const victim = new pg.Client({ connectionString: env.urlFor('worker') });
    await victim.connect();
    try {
      const pid = Number((await victim.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid);
      const r = await tryQuery(backup, 'SELECT pg_terminate_backend($1)', [pid]);
      expect(r.ok).toBe(false);
      expect((await victim.query('SELECT 1 AS ok')).rows[0]?.ok).toBe(1);
    } finally {
      await victim.end();
    }
    expect(await counts()).toEqual(before);
    log(
      `TC-BKP-02: ${statements.length} statements refused with 42501; row counts and sequence unchanged ${JSON.stringify(before)}`,
    );
  });

  it('TC-BKP-05: the session default is read-only and a READ WRITE transaction still cannot write', async () => {
    await withClient(env.urlFor('backup'), async (c) => {
      expect(
        (await c.query('SHOW default_transaction_read_only')).rows[0]
          ?.default_transaction_read_only,
      ).toBe('on');
      await c.query('BEGIN READ WRITE');
      await expect(
        c.query(`INSERT INTO public.probe_items (label) VALUES ('nope')`),
      ).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
    });
  });

  it('TC-BKP-06: a table added later by app_migrator is readable without a new grant', async () => {
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
      const r = await tryQuery(env.urlFor('backup'), sql);
      expect(r.ok, sql).toBe(true);
    }
    // Negative probe: app_api has no CREATE, so no table of another owner can exist.
    permissionDenied(await tryQuery(env.urlFor('api'), 'CREATE TABLE public.by_api (id int)'));
    permissionDenied(await tryQuery(env.urlFor('api'), 'CREATE TABLE pgboss.by_api (id int)'));
    const dump = runPgDump(env, 'backup');
    expect(dump.status, dump.stderr).toBe(0);
    expect(dump.dump).toContain('CREATE TABLE public.added_later');
  });
});

describe('leftovers check', () => {
  it('lists the run objects that the teardown must drop', async () => {
    const present = await leftovers(env);
    expect(present.length).toBe(6); // database, 4 roles, host_admin
    log(`before teardown: ${present.length} run objects present`);
  });
});
