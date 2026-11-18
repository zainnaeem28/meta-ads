import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzleMigrate, tryQuery, withClient } from '../../migrations/support/harness.js';
import type { Env } from '../../migrations/support/harness.js';

// TASK-026: the checks behind `db:check-history` (TC-OPS-03, TC-NFR-05). Each check returns its findings (an empty
// list passes) so the negative probes can assert that a broken input is reported, not just that a good one passes.

export const fixturesDir = join(import.meta.dirname, '..', 'fixtures');

export interface PreviousRelease {
  readonly tag: string | null;
  readonly lastMigration: number;
  readonly snapshot: string;
  readonly synthetic: string;
}

export function readPreviousRelease(dir = join(fixturesDir, 'previous-release')): PreviousRelease {
  const meta = JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8')) as {
    tag: string | null;
    lastMigration: number;
  };
  return {
    tag: meta.tag,
    lastMigration: meta.lastMigration,
    snapshot: readFileSync(join(dir, 'snapshot.sql'), 'utf8'),
    synthetic: readFileSync(join(dir, 'synthetic-data.sql'), 'utf8'),
  };
}

export interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
}

export function readJournal(migrationsDir: string): JournalEntry[] {
  const journal = JSON.parse(
    readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  return journal.entries;
}

export const migrationNumber = (tag: string): number => Number(tag.slice(0, 4));

/** Fixture consistency: an empty snapshot means the first release; a tagged release carries snapshot and data. */
export function checkPreviousRelease(previous: PreviousRelease): string[] {
  const findings: string[] = [];
  const empty = previous.snapshot.trim() === '';
  if (previous.tag === null) {
    if (previous.lastMigration !== 0) findings.push('no release tag but lastMigration is not 0');
    if (!empty || previous.synthetic.trim() !== '')
      findings.push('first release (tag null) must have an empty snapshot and no synthetic data');
  } else {
    if (empty) findings.push(`release ${previous.tag} has an empty snapshot`);
    if (previous.synthetic.trim() === '')
      findings.push(`release ${previous.tag} has no synthetic data`);
    if (previous.lastMigration < 1)
      findings.push('lastMigration must be at least 1 after a release');
  }
  return findings;
}

// ---- expand/contract -------------------------------------------------------------------------------------------

const CONTRACT_RULES: readonly (readonly [RegExp, string])[] = [
  [
    /\bDROP\s+(TABLE|COLUMN|SCHEMA|TYPE|INDEX|CONSTRAINT)\b/i,
    'drops an object the previous release uses',
  ],
  [/\bRENAME\b/i, 'renames an object the previous release uses'],
  [/\bALTER\s+COLUMN\b[^;]*\bSET\s+NOT\s+NULL\b/i, 'adds NOT NULL to an existing column'],
  [/\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i, 'changes the type of an existing column'],
  [/\bTRUNCATE\b/i, 'truncates a table'],
  [/\bDELETE\s+FROM\b/i, 'deletes rows'],
];

const stripComments = (sql: string) =>
  sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Expand/contract (ARCHITECTURE §2.7): a migration released after the previous release may only expand. A contracting
 * statement is allowed in a file that carries a `-- contract: <ticket>` line, which marks the second release of the pair.
 */
export function contractViolations(file: string, sql: string): string[] {
  if (/^--\s*contract:\s*\S+/im.test(sql)) return [];
  const body = stripComments(sql);
  return CONTRACT_RULES.filter(([pattern]) => pattern.test(body)).map(
    ([, why]) =>
      `${file}: ${why} (expand first; contract in a later release with a "-- contract:" marker)`,
  );
}

export function checkExpandContract(migrationsDir: string, previous: PreviousRelease): string[] {
  const findings: string[] = [];
  for (const entry of readJournal(migrationsDir)) {
    if (migrationNumber(entry.tag) <= previous.lastMigration) continue;
    const sql = readFileSync(join(migrationsDir, `${entry.tag}.sql`), 'utf8');
    findings.push(...contractViolations(`${entry.tag}.sql`, sql));
  }
  return findings;
}

// ---- catalog -------------------------------------------------------------------------------------------------

/** Columns, indexes and constraints of public, as sorted text: equal signatures mean equal structure. */
export async function structure(env: Env, database = env.database): Promise<string[]> {
  return withClient(env.urlFor('superuser', database), async (c) => {
    const cols = await c.query(
      `SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable AS s
         FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const idx = await c.query(
      `SELECT 'index ' || indexdef AS s FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const cons = await c.query(
      `SELECT 'constraint ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS s
         FROM pg_constraint WHERE connamespace = 'public'::regnamespace`,
    );
    return [...cols.rows, ...idx.rows, ...cons.rows].map((r) => (r as { s: string }).s).sort();
  });
}

/** One digest of every row of every public table (the ledger is not included). */
export async function dataFingerprint(env: Env, database = env.database): Promise<string> {
  return withClient(env.urlFor('superuser', database), async (c) => {
    const tables = await c.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
    );
    const parts: string[] = [];
    for (const { tablename } of tables.rows as { tablename: string }[]) {
      const r = await c.query(
        `SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, ',' ORDER BY t::text)), '') AS d FROM public."${tablename}" t`,
      );
      parts.push(`${tablename}=${(r.rows[0] as { d: string }).d}`);
    }
    return parts.join(';');
  });
}

// ---- clean history ---------------------------------------------------------------------------------------------

/** Applies the whole history to the empty database; the ledger must hold exactly the journal's migrations. */
export async function checkCleanHistory(env: Env, dir: string): Promise<string[]> {
  const result = drizzleMigrate(env, dir);
  if (result.status !== 0)
    return [
      `drizzle-kit migrate failed (exit ${String(result.status)}): ${tail(result.stdout + result.stderr)}`,
    ];
  const expected = readJournal(join(dir, 'migrations')).length;
  const ledger = await tryQuery(
    env.urlFor('superuser'),
    'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
  );
  const applied = ledger.ok ? Number((ledger.rows[0] as { n: number }).n) : -1;
  return applied === expected
    ? []
    : [`ledger holds ${applied} migrations, the journal lists ${expected}`];
}

const tail = (text: string) => text.trim().split('\n').slice(-5).join(' | ');

// ---- grants ----------------------------------------------------------------------------------------------------

/** Table privileges every table must carry after the history is applied (ARCHITECTURE §2.7). */
export async function checkGrants(env: Env): Promise<string[]> {
  return withClient(env.urlFor('superuser'), async (c) => {
    const tables = await c.query(
      `SELECT schemaname || '.' || tablename AS t FROM pg_tables WHERE schemaname IN ('public', 'pgboss') ORDER BY 1`,
    );
    const findings: string[] = [];
    const has = async (role: string, table: string, privilege: string) =>
      Boolean(
        (
          (await c.query('SELECT has_table_privilege($1, $2, $3) AS h', [role, table, privilege]))
            .rows[0] as { h: boolean }
        ).h,
      );
    for (const { t } of tables.rows as { t: string }[]) {
      const inPublic = t.startsWith('public.');
      if (!(await has(env.roles.backup, t, 'SELECT')))
        findings.push(`app_backup lacks SELECT on ${t}`);
      for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
        if (await has(env.roles.backup, t, p)) findings.push(`app_backup holds ${p} on ${t}`);
      for (const key of ['api', 'worker'] as const) {
        if (inPublic && !(await has(env.roles[key], t, 'SELECT')))
          findings.push(`app_${key} lacks SELECT on ${t}`);
        if (await has(env.roles[key], t, 'TRUNCATE'))
          findings.push(`app_${key} holds TRUNCATE on ${t}`);
      }
    }
    for (const key of ['api', 'worker', 'backup'] as const) {
      const create = await c.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS h`, [
        env.roles[key],
      ]);
      if ((create.rows[0] as { h: boolean }).h)
        findings.push(`app_${key} can create objects in public`);
    }
    // CR-017-2: /health/ready counts the migration ledger as app_api
    const ledger = await c.query(
      `SELECT has_schema_privilege($1, 'drizzle', 'USAGE') AS u, has_table_privilege($1, 'drizzle.__drizzle_migrations', 'SELECT') AS s`,
      [env.roles.api],
    );
    const row = ledger.rows[0] as { u: boolean; s: boolean };
    if (!row.u || !row.s) findings.push('app_api cannot read drizzle.__drizzle_migrations');
    return findings;
  });
}

// ---- upgrade from the previous release ---------------------------------------------------------------------------

// pg_dump 17.6+ wraps a plain dump in psql `\restrict` / `\unrestrict` meta-commands, which the server does not parse; the database already has its public schema.
const withRoles = (sql: string, env: Env) =>
  sql
    .replace(/^\\.*$/gm, '')
    .replace(/^CREATE SCHEMA (?!IF NOT EXISTS)/gm, 'CREATE SCHEMA IF NOT EXISTS ')
    .replace(
      /\bapp_(migrator|api|worker|backup)\b/g,
      (_all, key: keyof Env['roles']) => env.roles[key],
    );

/** Restores the previous release's snapshot and synthetic data as app_migrator (a no-op at the first release). */
export async function restorePreviousRelease(
  env: Env,
  previous: PreviousRelease,
): Promise<string[]> {
  if (previous.snapshot.trim() === '') return [];
  for (const [name, sql] of [
    ['snapshot', previous.snapshot],
    ['synthetic data', previous.synthetic],
  ] as const) {
    const r = await tryQuery(env.urlFor('migrator'), withRoles(sql, env));
    if (!r.ok) return [`previous release ${name} does not load: ${r.message}`];
  }
  return [];
}

/** Every row of every public table as jsonb text, for the survival check of an upgrade. */
async function rowsOf(env: Env): Promise<Record<string, string[]>> {
  return withClient(env.urlFor('superuser'), async (c) => {
    const tables = await c.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
    );
    const out: Record<string, string[]> = {};
    for (const { tablename } of tables.rows as { tablename: string }[]) {
      const r = await c.query(`SELECT to_jsonb(t)::text AS j FROM public."${tablename}" t`);
      out[tablename] = r.rows.map((x) => (x as { j: string }).j);
    }
    return out;
  });
}

/**
 * Upgrade: previous release plus its synthetic data, then the whole history. Every synthetic row must still exist
 * (an expand migration may add columns, so a row survives when the new row contains the old one).
 */
export async function checkUpgrade(
  env: Env,
  dir: string,
  previous: PreviousRelease,
): Promise<string[]> {
  const restored = await restorePreviousRelease(env, previous);
  if (restored.length > 0) return restored;
  const before = await rowsOf(env);
  const findings = await checkCleanHistory(env, dir);
  if (findings.length > 0) return findings;
  return withClient(env.urlFor('superuser'), async (c) => {
    const lost: string[] = [];
    for (const [table, rows] of Object.entries(before)) {
      for (const row of rows) {
        const r = await c.query(
          `SELECT count(*)::int AS n FROM public."${table}" t WHERE to_jsonb(t) @> $1::jsonb`,
          [row],
        );
        if ((r.rows[0] as { n: number }).n === 0)
          lost.push(`upgrade lost or changed a ${table} row: ${row}`);
      }
    }
    return lost;
  });
}

// ---- rollback ----------------------------------------------------------------------------------------------------

/** A copy of the database (template copy, owned by app_migrator); the source must have no open connections. */
export async function copyDatabase(env: Env, name: string): Promise<string> {
  const copy = `${env.database}_${name}_${randomBytes(3).toString('hex')}`;
  await withClient(env.urlFor('superuser', 'postgres'), async (c) => {
    await c.query(
      `CREATE DATABASE "${copy}" TEMPLATE "${env.database}" OWNER "${env.roles.migrator}"`,
    );
  });
  return copy;
}

/**
 * The documented rollback check (before go-live): compensating forward migrations of every migration after the previous
 * release run, newest first, on a copy of the migrated database. The copy must return to the previous release's
 * structure with its data intact, and the source database must be untouched.
 */
export async function checkRollback(
  env: Env,
  migrationsDir: string,
  compensatingDir: string,
  previous: PreviousRelease,
  expectedStructure: string[],
  expectedData: string,
): Promise<string[]> {
  const findings: string[] = [];
  const entries = readJournal(migrationsDir).filter(
    (e) => migrationNumber(e.tag) > previous.lastMigration,
  );
  const files = entries.map((e) => ({
    entry: e,
    path: join(compensatingDir, `${e.tag.slice(0, 4)}.sql`),
  }));
  for (const { entry, path } of files)
    if (!existsSync(path)) findings.push(`${entry.tag} has no compensating migration (${path})`);
  if (findings.length > 0) return findings;
  const sourceBefore = await structure(env);
  const copy = await copyDatabase(env, 'rollback');
  for (const { entry, path } of [...files].reverse()) {
    const r = await tryQuery(
      env.urlFor('migrator', copy),
      withRoles(readFileSync(path, 'utf8'), env),
    );
    if (!r.ok) findings.push(`compensating migration for ${entry.tag} failed: ${r.message}`);
  }
  if (findings.length === 0) {
    const after = await structure(env, copy);
    for (const line of expectedStructure.filter((l) => !after.includes(l)))
      findings.push(`rollback lost structure: ${line}`);
    for (const line of after.filter((l) => !expectedStructure.includes(l)))
      findings.push(`rollback left structure behind: ${line}`);
    const data = await dataFingerprint(env, copy);
    if (data !== expectedData)
      findings.push(`rollback changed the previous release's data (${data})`);
  }
  if (JSON.stringify(await structure(env)) !== JSON.stringify(sourceBefore))
    findings.push('the rollback check changed the source database');
  return findings;
}

// ---- seed rerun --------------------------------------------------------------------------------------------------

/** Runs the seed twice; the second run must change no row of any public table. */
export async function checkSeedRerun(env: Env, seed: () => Promise<unknown>): Promise<string[]> {
  await seed();
  const first = await dataFingerprint(env);
  await seed();
  const second = await dataFingerprint(env);
  return first === second ? [] : [`seed rerun changed data: ${first} -> ${second}`];
}

// ---- probes ------------------------------------------------------------------------------------------------------

/** Appends a statement to a rendered migration (or writes a new one) for the negative probes. */
export function appendToMigration(dir: string, file: string, sql: string): void {
  const path = join(dir, 'migrations', file);
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n--> statement-breakpoint\n${sql}\n`);
}

/** Adds a migration file and its journal entry to a rendered migrations folder. */
export function addMigration(dir: string, tag: string, sql: string): void {
  writeFileSync(join(dir, 'migrations', `${tag}.sql`), sql);
  const journalPath = join(dir, 'migrations', 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: (JournalEntry & { version: string; breakpoints: boolean })[];
  };
  const last = journal.entries[journal.entries.length - 1];
  journal.entries.push({
    idx: journal.entries.length,
    version: '7',
    when: (last?.when ?? 0) + 1000,
    tag,
    breakpoints: true,
  });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
}
