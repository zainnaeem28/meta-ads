import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

export const packageDir = import.meta.dirname;
export const repoRoot = join(packageDir, '..', '..', '..');

const adminUrl =
  process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgres://postgres@test-db:5432/postgres';
// pg_dump comes from PATH, or from an extracted PostgreSQL client package (PG_CLIENT_ROOT=<dpkg -x root>).
const clientRoot = process.env['PG_CLIENT_ROOT'];
export const pgDump = clientRoot
  ? join(clientRoot, 'usr/lib/postgresql/17/bin/pg_dump')
  : 'pg_dump';
const pgDumpEnv = clientRoot
  ? { ...process.env, LD_LIBRARY_PATH: join(clientRoot, 'usr/lib/x86_64-linux-gnu') }
  : process.env;

export type RoleKey = 'migrator' | 'api' | 'worker' | 'backup';

export interface Env {
  suffix: string;
  database: string;
  hostAdmin: string;
  roles: Record<RoleKey, string>;
  passwords: Record<RoleKey | 'hostAdmin', string>;
  urlFor: (role: RoleKey | 'hostAdmin' | 'superuser', database?: string) => string;
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

export async function tryQuery(
  url: string,
  sql: string,
  params: unknown[] = [],
): Promise<
  { ok: true; rows: Record<string, unknown>[] } | { ok: false; code: string; message: string }
> {
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

/**
 * Provision a uniquely named database and run-suffixed roles the way the host does:
 * the shared server's superuser creates the non-superuser CREATEROLE admin `host_admin`,
 * and `host_admin` (not the superuser) creates the four roles, so the PostgreSQL 16+
 * creator grant is exercised (TC-BKP-04 fixture rule).
 */
export async function provision(): Promise<Env> {
  const suffix = randomBytes(4).toString('hex');
  const names = {
    database: `t002_${suffix}`,
    hostAdmin: `host_admin_${suffix}`,
    roles: {
      migrator: `app_migrator_${suffix}`,
      api: `app_api_${suffix}`,
      worker: `app_worker_${suffix}`,
      backup: `app_backup_${suffix}`,
    },
  };
  const secret = () => randomBytes(18).toString('hex');
  const passwords = {
    hostAdmin: secret(),
    migrator: secret(),
    api: secret(),
    worker: secret(),
    backup: secret(),
  };
  const base = new URL(adminUrl);
  const urlFor: Env['urlFor'] = (role, database) => {
    const u = new URL(base.toString());
    u.pathname = `/${database ?? names.database}`;
    if (role === 'superuser') return u.toString();
    const user = role === 'hostAdmin' ? names.hostAdmin : names.roles[role];
    u.username = user;
    u.password = passwords[role];
    return u.toString();
  };
  const env: Env = { suffix, ...names, passwords, urlFor };

  await withClient(adminUrl, async (c) => {
    await c.query(
      `CREATE ROLE ${ident(env.hostAdmin)} LOGIN CREATEROLE NOSUPERUSER PASSWORD '${passwords.hostAdmin}'`,
    );
  });
  // Roles and database settings as DO-05/DO-11 create them. The creating admin is host_admin.
  const [m, a, w, b] = [env.roles.migrator, env.roles.api, env.roles.worker, env.roles.backup].map(
    ident,
  ) as [string, string, string, string];
  await withClient(urlFor('hostAdmin', 'postgres'), async (c) => {
    await c.query(
      `CREATE ROLE ${m} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${passwords.migrator}'`,
    );
    await c.query(
      `CREATE ROLE ${a} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${passwords.api}'`,
    );
    await c.query(
      `CREATE ROLE ${w} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${passwords.worker}'`,
    );
    await c.query(
      `CREATE ROLE ${b} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD '${passwords.backup}'`,
    );
    await c.query(`ALTER ROLE ${b} SET default_transaction_read_only = on`);
    for (const r of [m, a, w]) await c.query(`ALTER ROLE ${r} SET search_path = public`);
  });
  await withClient(urlFor('superuser', 'postgres'), async (c) => {
    await c.query(`CREATE DATABASE ${ident(env.database)} OWNER ${m}`);
  });
  await withClient(urlFor('superuser'), async (c) => {
    await c.query(`REVOKE CONNECT ON DATABASE ${ident(env.database)} FROM PUBLIC`);
    await c.query(`GRANT CONNECT ON DATABASE ${ident(env.database)} TO ${a}, ${w}, ${b}`);
    await c.query(`ALTER SCHEMA public OWNER TO ${m}`);
  });
  return env;
}

export async function leftovers(env: Env): Promise<string[]> {
  return withClient(env.urlFor('superuser', 'postgres'), async (c) => {
    const db = await c.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [
      `%${env.suffix}%`,
    ]);
    const roles = await c.query('SELECT rolname FROM pg_roles WHERE rolname LIKE $1', [
      `%${env.suffix}%`,
    ]);
    return [
      ...db.rows.map((r) => `database ${String(r.datname)}`),
      ...roles.rows.map((r) => `role ${String(r.rolname)}`),
    ];
  });
}

/** Drop the run's database and roles, then return what is left (must be empty). */
export async function teardown(env: Env): Promise<string[]> {
  await withClient(env.urlFor('superuser', 'postgres'), async (c) => {
    await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [
      env.database,
    ]);
    await c.query(`DROP DATABASE IF EXISTS ${ident(env.database)} WITH (FORCE)`);
    for (const r of [...Object.values(env.roles), env.hostAdmin])
      await c.query(`DROP ROLE IF EXISTS ${ident(r)}`);
  });
  return leftovers(env);
}

/** Copy the probe migrations with the role tokens replaced, and write a drizzle config for this run. */
export function renderMigrations(env: Env): string {
  const dir = mkdtempSync(join(tmpdir(), `t002-${env.suffix}-`));
  const src = join(packageDir, 'fixtures', 'probe', 'migrations');
  cpSync(src, join(dir, 'migrations'), { recursive: true });
  for (const f of readdirSync(join(dir, 'migrations')).filter((n) => n.endsWith('.sql'))) {
    const p = join(dir, 'migrations', f);
    let sql = readFileSync(p, 'utf8');
    for (const key of ['migrator', 'api', 'worker', 'backup'] as const) {
      sql = sql.replaceAll(`{{${key}}}`, ident(env.roles[key]));
    }
    writeFileSync(p, sql);
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

export function drizzleMigrate(env: Env, dir: string): RunResult {
  const bin = join(packageDir, 'node_modules', '.bin', 'drizzle-kit');
  const r = spawnSync(bin, ['migrate', '--config', join(dir, 'drizzle.config.ts')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, MIGRATION_DATABASE_URL: env.urlFor('migrator'), CI: '1' },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function jobsMigrate(env: Env, extraQueues: unknown[] = []): RunResult {
  const r = spawnSync(process.execPath, [join(packageDir, 'jobs-migrate.ts')], {
    cwd: packageDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      MIGRATION_DATABASE_URL: env.urlFor('migrator'),
      EXTRA_QUEUES: JSON.stringify(extraQueues),
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
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
    {
      encoding: 'utf8',
      env: pgDumpEnv,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  return { status: r.status, stdout: '', stderr: r.stderr, dump: r.stdout };
}

export function pgDumpVersion(): string {
  return execFileSync(pgDump, ['--version'], { encoding: 'utf8', env: pgDumpEnv }).trim();
}
