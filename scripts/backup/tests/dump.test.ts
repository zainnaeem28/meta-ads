import { execFileSync, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { installQueues } from '../../../apps/api/tests/integration/migrations/support/harness.ts';
import { makeDb, tryQuery, withClient } from './support/db.ts';
import type { BackupDb } from './support/db.ts';
import { BUCKETS, decryptDump, makeRig, pgDumpBin } from './support/fixture.ts';
import type { Rig } from './support/fixture.ts';
import { runOnce } from './support/run.ts';
import { RELEASE_MIGRATION_LOCK, releaseMigrationRunning } from '../src/window.ts';

// TC-BKP-01 (dump part), 07, 09, 10, 21, 23, 24 through the service's own run against the shared test PostgreSQL, with the
// real M0001 grants applied by the real migration CLI, and age for real. The grants themselves (TC-BKP-01..11 as role
// tests) are the TASK-025 suite; here the dump is taken the way the service takes it.

let rig: Rig;
let db: BackupDb;
const pgRestore = pgDumpBin.replace(/pg_dump$/, 'pg_restore');

beforeAll(async () => {
  rig = await makeRig();
  db = await makeDb();
});
afterAll(async () => {
  await db.dispose();
  await rig.dispose();
});

const dumpKeys = () => rig.emu.keys(BUCKETS.backup, 'db/');
const restoreList = (dump: Buffer): string =>
  execFileSync(pgRestore, ['--list'], { input: dump, encoding: 'utf8', env: process.env });
/** The archive as plain SQL, so its (compressed) table data can be searched. */
const restoreSql = (dump: Buffer): string =>
  execFileSync(pgRestore, ['--file=-'], {
    input: dump,
    encoding: 'latin1',
    env: process.env,
    maxBuffer: 256 * 1024 * 1024,
  });

describe('the dump (TC-BKP-01, TC-BKP-23, TC-BKP-24)', () => {
  it('writes one age-encrypted custom-format dump of public and pgboss that only the escrowed key opens', async () => {
    const r = await runOnce(rig, db.backupUrl);
    expect(r.ok, r.failures.join(';')).toBe(true);
    const keys = dumpKeys();
    expect(keys.length).toBe(1);
    expect(keys[0]).toMatch(/^db\/2026-11-15\/[0-9A-Z]{26}\.dump\.age$/);
    const encrypted = rig.emu.get(BUCKETS.backup, keys[0] as string)?.data as Buffer;
    expect(encrypted.subarray(0, 21).toString()).toBe('age-encryption.org/v1');
    expect(encrypted.includes(Buffer.from('PGDMP'))).toBe(false);
    // The service holds no private key: decrypting without the escrowed identity fails.
    const without = spawnSync(rig.ageBin, ['--decrypt', '--identity', '/nonexistent'], {
      input: encrypted,
    });
    expect(without.status).not.toBe(0);
    // With the escrowed identity the dump is a custom-format archive with both schemas and every row.
    const plain = decryptDump(rig, encrypted);
    expect(plain.subarray(0, 5).toString()).toBe('PGDMP');
    const list = restoreList(plain);
    expect(list).toMatch(/TABLE public provider_keys/);
    expect(list).toMatch(/TABLE public rate_limit_buckets/);
    expect(list).toMatch(/TABLE pgboss job/);
    // Key ciphertext is in the dump as stored; no KEK private key exists anywhere in the backup set.
    const sql = restoreSql(plain);
    expect(sql).toContain('\\xdeadbeef');
    const backupSet = rig.emu
      .keys(BUCKETS.backup)
      .map((k) => rig.emu.get(BUCKETS.backup, k)?.data.toString('latin1') ?? '')
      .join('\n');
    expect(sql + backupSet).not.toMatch(/KEK_V\d+|KEK_PRIVATE_KEYS|AGE-SECRET-KEY-/);
  });

  it('restores into an empty database with the escrowed key (TC-BKP-23, the backup half of TC-NFR-05)', async () => {
    const encrypted = rig.emu.get(BUCKETS.backup, dumpKeys()[0] as string)?.data as Buffer;
    const target = `t011_restore_${db.env.suffix}`;
    await withClient(db.env.urlFor('superuser', 'postgres'), (c) =>
      c.query(`CREATE DATABASE "${target}"`),
    );
    try {
      const url = db.env.urlFor('superuser', target);
      await withClient(url, (c) => c.query('DROP SCHEMA public')); // the archive carries its own CREATE SCHEMA public
      // The dump is of --schema=public and --schema=pgboss, which does not carry pg_trgm (finding F-DR-2): restore in sections,
      // the extension between pre-data and data, as docs/ops/ROLLBACK-RUNBOOK.md does.
      const dumpBytes = decryptDump(rig, encrypted);
      const restoreSection = (section: string) =>
        spawnSync(
          pgRestore,
          [
            '--no-owner',
            '--no-privileges',
            '--exit-on-error',
            `--section=${section}`,
            '--dbname',
            url,
          ],
          { input: dumpBytes, encoding: 'utf8', env: process.env },
        );
      let restore = restoreSection('pre-data');
      expect(restore.status, restore.stderr).toBe(0);
      await withClient(url, (c) => c.query('CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public'));
      for (const section of ['data', 'post-data']) {
        restore = restoreSection(section);
        expect(restore.status, restore.stderr).toBe(0);
      }
      expect(restore.status, restore.stderr).toBe(0);
      const rows = await tryQuery(
        url,
        "SELECT (SELECT count(*) FROM public.provider_keys)::int AS keys, (SELECT count(*) FROM public.rate_limit_buckets)::int AS buckets, (SELECT encode(ciphertext, 'hex') FROM public.provider_keys) AS ct",
      );
      expect(rows).toMatchObject({ ok: true, rows: [{ keys: 1, buckets: 1, ct: 'deadbeef' }] });
    } finally {
      await withClient(db.env.urlFor('superuser', 'postgres'), (c) =>
        c.query(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`),
      );
    }
  });

  it('queue-then-dump: a queue created by the release step is in the next dump (TC-BKP-07)', async () => {
    const created = await installQueues(db.env, [
      { name: 'backup-probe', policy: 'standard', retryLimit: 0, expireInSeconds: 900 },
      {
        name: 'late-queue-t011',
        policy: 'standard',
        retryLimit: 0,
        expireInSeconds: 900,
        partition: true,
      },
    ]);
    expect(created).toEqual(['late-queue-t011']);
    rig.clock.now = new Date('2026-11-16T02:00:00Z');
    const r = await runOnce(rig, db.backupUrl);
    expect(r.ok, r.failures.join(';')).toBe(true);
    const newest = dumpKeys().at(-1) as string;
    const list = restoreList(decryptDump(rig, rig.emu.get(BUCKETS.backup, newest)?.data as Buffer));
    expect(list).toMatch(/TABLE pgboss j[0-9a-f]+/);
    const tables = await withClient(db.env.urlFor('superuser'), (c) =>
      c.query(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'pgboss' AND c.relkind IN ('r','p')`,
      ),
    );
    const listed = (list.match(/TABLE pgboss /g) ?? []).length;
    expect(listed).toBeGreaterThanOrEqual(Number((tables.rows[0] as { n: number }).n));
  });
});

describe('row security off (TC-BKP-09)', () => {
  it('the service fails loudly, names the table, uploads no dump and withholds the heartbeat; without the probe it completes', async () => {
    await withClient(db.env.urlFor('migrator'), async (c) => {
      await c.query('CREATE TABLE public.rls_probe_t011 (id int)');
      await c.query('INSERT INTO public.rls_probe_t011 VALUES (1)');
      await c.query('ALTER TABLE public.rls_probe_t011 ENABLE ROW LEVEL SECURITY');
    });
    rig.clock.now = new Date('2026-11-17T02:00:00Z');
    const before = dumpKeys().length;
    const pings: string[] = [];
    const fetchImpl = (async (u: string) => (
      pings.push(u),
      new Response('ok')
    )) as unknown as typeof fetch;
    const failed = await runOnce(
      rig,
      db.backupUrl,
      { HEARTBEAT_URL_BACKUP: 'https://hc.example.test/b' },
      { fetchImpl },
    );
    expect(failed.ok).toBe(false);
    expect(failed.failures.join(' ')).toMatch(/pg_dump failed.*rls_probe_t011/s);
    expect(failed.heartbeat).toBe('not-sent');
    expect(pings).toEqual([]);
    expect(dumpKeys().length).toBe(before);
    await withClient(db.env.urlFor('migrator'), (c) => c.query('DROP TABLE public.rls_probe_t011'));
    const ok = await runOnce(rig, db.backupUrl);
    expect(ok.ok, ok.failures.join(';')).toBe(true);
    expect(dumpKeys().length).toBe(before + 1);
  });
});

describe('connections (TC-BKP-10)', () => {
  it('app_backup connects to the application database; another database shows no object it may read', async () => {
    const other = `t011_other_${db.env.suffix}`;
    await withClient(db.env.urlFor('superuser', 'postgres'), (c) =>
      c.query(`CREATE DATABASE "${other}"`),
    );
    try {
      await withClient(db.env.urlFor('superuser', other), (c) =>
        c.query('CREATE TABLE public.secret (id int)'),
      );
      expect((await tryQuery(db.backupUrl, 'SELECT 1 AS ok')).ok).toBe(true);
      expect(
        await tryQuery(db.env.urlFor('backup', other), 'SELECT * FROM public.secret'),
      ).toMatchObject({ ok: false, code: '42501' });
    } finally {
      await withClient(db.env.urlFor('superuser', 'postgres'), (c) =>
        c.query(`DROP DATABASE IF EXISTS "${other}" WITH (FORCE)`),
      );
    }
  });
});

describe('does not run during a release migration (TC-BKP-21)', () => {
  const hold = async (sql: string): Promise<{ release: () => Promise<void> }> => {
    const c = new pg.Client({ connectionString: db.env.urlFor('migrator') });
    await c.connect();
    await c.query('BEGIN');
    await c.query(sql);
    return { release: async () => void (await c.query('ROLLBACK'), await c.end()) };
  };
  const probe = async () => {
    const c = new pg.Client({ connectionString: db.backupUrl });
    await c.connect();
    try {
      return await releaseMigrationRunning(c);
    } finally {
      await c.end();
    }
  };

  it('is quiet while ordinary application work holds row locks', async () => {
    const dml = await hold(
      "INSERT INTO public.rate_limit_buckets (scope, subject, window_start, count) VALUES ('dml', 's', now(), 1)",
    );
    try {
      expect(await probe()).toBe(false);
    } finally {
      await dml.release();
    }
  });

  for (const [name, sql] of [
    [
      'the release-migration advisory lock',
      `SELECT pg_advisory_xact_lock(hashtextextended('${RELEASE_MIGRATION_LOCK}', 0))`,
    ],
    ['a DDL lock on a public table', 'LOCK TABLE public.provider_keys IN ACCESS EXCLUSIVE MODE'],
    ['an index build lock on a pgboss table', 'LOCK TABLE pgboss.job IN SHARE MODE'],
  ] as const) {
    it(`skips the run while ${name} is held and starts after it ends`, async () => {
      rig.clock.now = new Date('2026-11-18T02:00:00Z');
      const before = dumpKeys().length;
      const held = await hold(sql);
      let blocked;
      try {
        expect(await probe()).toBe(true);
        blocked = await runOnce(rig, db.backupUrl);
      } finally {
        await held.release();
      }
      expect(blocked.status).toBe('skipped-migration-window');
      expect(blocked.ok).toBe(false);
      expect(dumpKeys().length).toBe(before);
      const after = await runOnce(rig, db.backupUrl);
      expect(after.ok, after.failures.join(';')).toBe(true);
      expect(dumpKeys().length).toBe(before + 1);
    });
  }

  it('waits for the window to close when allowed to wait, then runs', async () => {
    rig.clock.now = new Date('2026-11-19T02:00:00Z');
    const held = await hold(
      `SELECT pg_advisory_xact_lock(hashtextextended('${RELEASE_MIGRATION_LOCK}', 0))`,
    );
    const pending = runOnce(rig, db.backupUrl, {
      BACKUP_MIGRATION_WAIT_SECONDS: '60',
      BACKUP_MIGRATION_POLL_SECONDS: '1',
    });
    await new Promise((r) => setTimeout(r, 1500));
    await held.release();
    const r = await pending;
    expect(r.ok, r.failures.join(';')).toBe(true);
    expect(r.logs.some((l) => l['event'] === 'release_migration_running')).toBe(true);
  });
});
