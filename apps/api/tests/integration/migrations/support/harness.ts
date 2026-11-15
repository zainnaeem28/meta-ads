import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import type { Queue } from 'pg-boss';
import { adminUrl } from '../../../support/test-database.js';

// Provisioning and run helpers for the M0001 grants suite. A run creates a uniquely named database and
// run-suffixed copies of the four roles the way the host does (a non-superuser CREATEROLE admin creates them, so the
// PostgreSQL 16+ creator grant is exercised), applies the real migrations through the `drizzle-kit migrate` CLI with
// the role names rewritten to the suffixed ones, and drops everything afterwards.

export const apiDir = join(import.meta.dirname, '..', '..', '..', '..');
export const realMigrations = join(apiDir, 'src', 'database', 'migrations');

const clientRoot = process.env['PG_CLIENT_ROOT'];
export const pgDump = clientRoot
  ? join(clientRoot, 'usr/lib/postgresql/17/bin/pg_dump')
  : 'pg_dump';
const pgDumpEnv = clientRoot
  ? { ...process.env, LD_LIBRARY_PATH: join(clientRoot, 'usr/lib/x86_64-linux-gnu') }
  : process.env;

export type RoleKey = 'migrator' | 'api' | 'worker' | 'backup';
export const ROLE_KEYS: readonly RoleKey[] = ['migrator', 'api', 'worker', 'backup'];

export interface Env {
  suffix: string;
  database: string;
  hostAdmin: string;
  roles: Record<RoleKey, string>;
  urlFor: (role: RoleKey | 'hostAdmin' | 'superuser', database?: string) => string;
}

export interface ProvisionOptions {
  /** Leave out the named roles, or their session defaults (for the fail-closed cases). */
  readonly skipRoles?: readonly RoleKey[];
  readonly skipBackupReadOnlyDefault?: boolean;
  readonly skipSearchPath?: boolean;
}

function ident(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe identifier ${name}`);
  return `"${name}"`;
}

export async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export type Attempt =
  { ok: true; rows: Record<string, unknown>[] } | { ok: false; code: string; message: string };

export async function tryQuery(url: string, sql: string, params: unknown[] = []): Promise<Attempt> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    const result = await client.query(sql, params);
    return { ok: true, rows: result.rows as Record<string, unknown>[] };
  } catch (error) {
    const e = error as { code?: string; message: string };
    return { ok: false, code: e.code ?? 'none', message: e.message };
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function provision(options: ProvisionOptions = {}): Promise<Env> {
  const suffix = randomBytes(4).toString('hex');
  const roles: Record<RoleKey, string> = {
    migrator: `app_migrator_${suffix}`,
    api: `app_api_${suffix}`,
    worker: `app_worker_${suffix}`,
    backup: `app_backup_${suffix}`,
  };
  const names = { database: `t025_${suffix}`, hostAdmin: `host_admin_${suffix}`, roles };
  const secret = () => randomBytes(18).toString('hex');
  const passwords: Record<RoleKey | 'hostAdmin', string> = {
    hostAdmin: secret(),
    migrator: secret(),
    api: secret(),
    worker: secret(),
    backup: secret(),
  };
  const base = new URL(adminUrl());
  const urlFor: Env['urlFor'] = (role, database) => {
    const u = new URL(base.toString());
    u.pathname = `/${database ?? names.database}`;
    if (role === 'superuser') return u.toString();
    u.username = role === 'hostAdmin' ? names.hostAdmin : roles[role];
    u.password = passwords[role];
    return u.toString();
  };
  const env: Env = { suffix, ...names, urlFor };
  const skip = new Set(options.skipRoles ?? []);

  await withClient(adminUrl(), (c) =>
    c.query(
      `CREATE ROLE ${ident(env.hostAdmin)} LOGIN CREATEROLE NOSUPERUSER PASSWORD '${passwords.hostAdmin}'`,
    ),
  );
  await withClient(urlFor('hostAdmin', 'postgres'), async (c) => {
    const create: Record<RoleKey, string> = {
      migrator: 'NOSUPERUSER NOCREATEDB NOCREATEROLE',
      api: 'NOSUPERUSER NOCREATEDB NOCREATEROLE',
      worker: 'NOSUPERUSER NOCREATEDB NOCREATEROLE',
      backup:
        'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2',
    };
    for (const key of ROLE_KEYS) {
      if (skip.has(key)) continue;
      await c.query(
        `CREATE ROLE ${ident(roles[key])} LOGIN ${create[key]} PASSWORD '${passwords[key]}'`,
      );
    }
    if (!skip.has('backup') && options.skipBackupReadOnlyDefault !== true) {
      await c.query(`ALTER ROLE ${ident(roles.backup)} SET default_transaction_read_only = on`);
    }
    if (options.skipSearchPath !== true) {
      for (const key of ['migrator', 'api', 'worker'] as const) {
        if (!skip.has(key))
          await c.query(`ALTER ROLE ${ident(roles[key])} SET search_path = public`);
      }
    }
  });
  await withClient(urlFor('superuser', 'postgres'), async (c) => {
    const owner = skip.has('migrator') ? 'postgres' : ident(roles.migrator);
    await c.query(`CREATE DATABASE ${ident(env.database)} OWNER ${owner}`);
  });
  await withClient(urlFor('superuser'), async (c) => {
    await c.query(`REVOKE CONNECT ON DATABASE ${ident(env.database)} FROM PUBLIC`);
    const connect = ROLE_KEYS.filter((k) => k !== 'migrator' && !skip.has(k)).map((k) =>
      ident(roles[k]),
    );
    if (connect.length > 0) {
      await c.query(`GRANT CONNECT ON DATABASE ${ident(env.database)} TO ${connect.join(', ')}`);
    }
    if (!skip.has('migrator')) {
      await c.query(`ALTER SCHEMA public OWNER TO ${ident(roles.migrator)}`);
    }
  });
  return env;
}

export async function leftovers(env: Env): Promise<string[]> {
  return withClient(env.urlFor('superuser', 'postgres'), async (c) => {
    const db = await c.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [
      `%${env.suffix}%`,
    ]);
    const found = await c.query('SELECT rolname FROM pg_roles WHERE rolname LIKE $1', [
      `%${env.suffix}%`,
    ]);
    return [
      ...db.rows.map((r) => `database ${String(r.datname)}`),
      ...found.rows.map((r) => `role ${String(r.rolname)}`),
    ];
  });
}

/** Drop the run's database and roles, then return what is left (must be empty). */
export async function teardown(env: Env): Promise<string[]> {
  await withClient(env.urlFor('superuser', 'postgres'), async (c) => {
    await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [
      env.database,
    ]);
    const dbs = await c.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [
      `%${env.suffix}%`,
    ]);
    for (const row of dbs.rows as { datname: string }[]) {
      await c.query(`DROP DATABASE IF EXISTS ${ident(row.datname)} WITH (FORCE)`);
    }
    for (const r of [...Object.values(env.roles), env.hostAdmin]) {
      await c.query(`DROP ROLE IF EXISTS ${ident(r)}`);
    }
  });
  return leftovers(env);
}

/** The real migrations folder copied with the fixed role names replaced by this run's suffixed names. */
export function renderMigrations(env: Env, through?: number): string {
  const dir = mkdtempSync(join(tmpdir(), `t025-${env.suffix}-`));
  cpSync(realMigrations, join(dir, 'migrations'), { recursive: true });
  for (const name of readdirSync(join(dir, 'migrations')).filter((n) => n.endsWith('.sql'))) {
    const path = join(dir, 'migrations', name);
    const sql = readFileSync(path, 'utf8').replace(
      /\bapp_(migrator|api|worker|backup)\b/g,
      (_all, key: RoleKey) => env.roles[key],
    );
    writeFileSync(path, sql);
  }
  if (through !== undefined) {
    // Only the migrations numbered up to `through` (the M0001 suite stands in for the later ones with scaffolds).
    const journalPath = join(dir, 'migrations', 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter((e) => Number(e.tag.slice(0, 4)) <= through);
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  }
  writeFileSync(
    join(dir, 'drizzle.config.ts'),
    `export default { dialect: 'postgresql', out: './migrations', dbCredentials: { url: process.env.MIGRATION_DATABASE_URL } };\n`,
  );
  return dir;
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** `drizzle-kit migrate`, the CLI behind `pnpm db:migrate`, as app_migrator against the run's database. */
export function drizzleMigrate(env: Env, dir: string): RunResult {
  const r = spawnSync(
    join(apiDir, 'node_modules', '.bin', 'drizzle-kit'),
    ['migrate', '--config', join(dir, 'drizzle.config.ts')],
    {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, MIGRATION_DATABASE_URL: env.urlFor('migrator'), CI: '1' },
    },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * The error text of the migration's role check. drizzle-kit exits non-zero on a failed statement but does not always
 * print its message, so the check statement (the first of the file) is also run on its own to read it.
 */
export async function roleCheckMessage(env: Env, dir: string): Promise<string> {
  const file = readdirSync(join(dir, 'migrations')).find((n) => n.endsWith('.sql')) ?? '';
  const first =
    readFileSync(join(dir, 'migrations', file), 'utf8').split('--> statement-breakpoint')[0] ?? '';
  const r = await tryQuery(env.urlFor('migrator'), first);
  return r.ok ? '' : r.message;
}

/** The release step `jobs:migrate` in miniature: pg-boss install into `pgboss`, then every queue, under app_migrator. */
export async function installQueues(env: Env, queues: readonly Queue[]): Promise<string[]> {
  const created: string[] = [];
  const boss = new PgBoss({
    connectionString: env.urlFor('migrator'),
    schema: 'pgboss',
    migrate: true,
    createSchema: false,
    supervise: false,
    schedule: false,
    max: 2,
  });
  boss.on('error', () => undefined);
  await boss.start();
  try {
    for (const { name, ...options } of queues) {
      if ((await boss.getQueue(name)) === null) {
        await boss.createQueue(name, options);
        created.push(name);
      }
    }
  } finally {
    await boss.stop({ graceful: true });
  }
  return created;
}

/** A pg-boss instance as a runtime process builds it: no migration, no schema creation. */
export function runtimeBoss(
  env: Env,
  role: 'api' | 'worker',
  extra: Partial<ConstructorParameters<typeof PgBoss>[0]> = {},
) {
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

export async function pgbossTables(env: Env): Promise<string[]> {
  return withClient(env.urlFor('superuser'), async (c) => {
    const r = await c.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pgboss' AND c.relkind IN ('r', 'p') ORDER BY 1`,
    );
    return r.rows.map((x) => String((x as { relname: string }).relname));
  });
}

export function runPgDump(
  env: Env,
  role: RoleKey,
  args: string[] = [],
): RunResult & { dump: string } {
  const r = spawnSync(
    pgDump,
    [
      '--format=plain',
      '--no-owner',
      '--no-privileges',
      '--schema=public',
      '--schema=pgboss',
      ...args,
      '--dbname',
      env.urlFor(role),
    ],
    { encoding: 'utf8', env: pgDumpEnv, maxBuffer: 256 * 1024 * 1024 },
  );
  return { status: r.status, stdout: '', stderr: r.stderr, dump: r.stdout };
}
