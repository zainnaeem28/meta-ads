import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

// Shared test helper: a uniquely named database per run on the shared test PostgreSQL, the real migrations
// applied, dropped when done. It refuses any server that is not the test server.

export const DEFAULT_ADMIN_URL = 'postgres://postgres@test-db:5432/postgres';
export const REAL_MIGRATIONS = join(import.meta.dirname, '..', '..', 'database', 'migrations');

export class TestServerRefusedError extends Error {
  constructor(host: string) {
    super(
      `refusing to use ${host}: the test database helper only runs on the test server (TEST_DATABASE_HOSTS)`,
    );
    this.name = 'TestServerRefusedError';
  }
}

export function allowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env['TEST_DATABASE_HOSTS'] ?? 'test-db')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
}

/** The admin URL of the test server, or throws when its host is not an allowed test host. */
export function adminUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env['TEST_DATABASE_ADMIN_URL'] ?? DEFAULT_ADMIN_URL;
  const host = new URL(url).hostname;
  if (!allowedHosts(env).includes(host)) throw new TestServerRefusedError(host);
  return url;
}

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  readonly migrationsApplied: boolean;
  drop(): Promise<void>;
}

export interface TestDatabaseOptions {
  /** Short label put in the database name (the ticket identifier). */
  readonly label?: string;
  /** Folder with `meta/_journal.json`; the repository's real migrations by default; false applies none. */
  readonly migrations?: string | false;
}

async function withAdmin<T>(
  fn: (client: pg.Client) => Promise<T>,
  env?: NodeJS.ProcessEnv,
): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl(env) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function databaseExists(name: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  return withAdmin(async (client) => {
    const found = await client.query('select 1 from pg_database where datname = $1', [name]);
    return found.rowCount === 1;
  }, env);
}

export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const label = (options.label ?? 'test')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 24);
  const name = `t_${label}_${randomBytes(6).toString('hex')}`;
  const url = new URL(adminUrl());
  await withAdmin((client) => client.query(`CREATE DATABASE "${name}"`));
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();
  const folder = options.migrations === undefined ? REAL_MIGRATIONS : options.migrations;
  let migrationsApplied = false;
  let dropped = false;
  const drop = async (): Promise<void> => {
    if (dropped) return;
    dropped = true;
    await withAdmin((client) => client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
  };
  try {
    if (folder !== false && existsSync(join(folder, 'meta', '_journal.json'))) {
      const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
      try {
        await migrate(drizzle(pool), { migrationsFolder: folder });
        migrationsApplied = true;
      } finally {
        await pool.end();
      }
    }
  } catch (error) {
    await drop();
    throw error;
  }
  return { name, url: databaseUrl, migrationsApplied, drop };
}

/** Create, run `fn`, drop (also when `fn` throws). */
export async function withTestDatabase<T>(
  fn: (database: TestDatabase) => Promise<T>,
  options: TestDatabaseOptions = {},
): Promise<T> {
  const database = await createTestDatabase(options);
  try {
    return await fn(database);
  } finally {
    await database.drop();
  }
}
