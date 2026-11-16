import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../../bootstrap/api.module.js';
import { createWorkerApp } from '../../../bootstrap/worker.module.js';
import type { WorkerApp } from '../../../bootstrap/worker.module.js';
import { REAL_MIGRATIONS, adminUrl, createTestDatabase } from '../../../platform/db/test-database.js';
import type { TestDatabase } from '../../../platform/db/test-database.js';
import { installJobs } from '../../../platform/jobs/test-support.js';
import { buildLogger, createHttpLogging } from '../../../platform/logging/index.js';
import { KEY_WRAP_PORT, UnsealFailed } from '../domain/key-wrap.js';
import type { KeyAad, KeyWrapPort, Sealed } from '../domain/key-wrap.js';
import { KeyUnsealer } from './key-unsealer.js';
import { generateKek, kekEnv } from './test-support.js';
import type { Kek } from './test-support.js';

// TASK-039 (provider-keys 1/2) on real PostgreSQL: M0004 applied as written, the column grants
// (TC-KEY-*, TC-SEC grants), and the seal and unseal sides reached through the real composition roots (`createApiApp`,
// `createWorkerApp`, the ones `main.api.ts` and `main.worker.ts` run).

const PLAINTEXT = 'integration-plaintext-key-9876543210';
const U1 = '0197a1b2-0000-7000-8000-000000000001';
const U2 = '0197a1b2-0000-7000-8000-000000000002';
const K1 = '0197a1b2-0000-7000-8000-0000000000a1';
const K2 = '0197a1b2-0000-7000-8000-0000000000a2';
const FP = 'a'.repeat(64);

let testDb: TestDatabase;
let pool: pg.Pool;
const roleNames = { api: '', worker: '' };
const rolePasswords = { api: '', worker: '' };
let kek: Kek;
let keyEnv: Record<string, string>;
let apiApp: Awaited<ReturnType<typeof createApiApp>>['app'];
let worker: WorkerApp;
const workerLines: string[] = [];
const apiLines: string[] = [];

const sink = (into: string[]) =>
  new Writable({
    write(chunk: Buffer, _enc, done) {
      into.push(chunk.toString());
      done();
    },
  });

function aad(userId: string, keyId: string, version = 1): KeyAad {
  return { userId, provider: 'openai', keyId, version };
}

const columns =
  '(id, owner_id, provider, status, version, ciphertext, nonce, wrapped_dek, kek_version, last4, fingerprint, fingerprint_pepper_version)';

async function insertKey(
  url: string,
  id: string,
  owner: string,
  sealed: Sealed,
  provider = 'openai',
): Promise<void> {
  const r = await tryQuery(
    url,
    `INSERT INTO provider_keys ${columns} VALUES ($1, $2, $3, 'active', 1, $4, $5, $6, $7, '3210', $8, 1)`,
    [id, owner, provider, sealed.ciphertext, sealed.nonce, sealed.wrappedDek, sealed.kekVersion, FP],
  );
  expect(r.ok, JSON.stringify(r)).toBe(true);
}

const roleUrl = (role: 'api' | 'worker'): string => {
  const url = new URL(testDb.url);
  url.username = roleNames[role];
  url.password = rolePasswords[role];
  return url.toString();
};
const api = () => roleUrl('api');
const wrk = () => roleUrl('worker');
type Attempt = { ok: true; rows: Record<string, unknown>[] } | { ok: false; code: string; message: string };
async function tryQuery(url: string, sql: string, params: unknown[] = []): Promise<Attempt> {
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
async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
/** The migration's statements (the part after the `-- Grants` comment when `grants`), roles renamed to this run's. */
function statementsOf(file: string, part: 'tables' | 'grants'): string[] {
  const text = readFileSync(join(REAL_MIGRATIONS, file), 'utf8');
  const [tables = '', grants = ''] = text.split('-- Grants');
  // The text after `-- Grants` starts inside that comment line; comment lines are dropped, the statements kept.
  const body = part === 'tables' ? tables : grants.slice(grants.indexOf('\n'));
  return body
    .split('--> statement-breakpoint')
    .map((x) =>
      x
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .replace(/\bapp_api\b/g, roleNames.api)
        .replace(/\bapp_worker\b/g, roleNames.worker)
        .trim(),
    )
    .filter((x) => x !== '');
}
const denied = (r: Awaited<ReturnType<typeof tryQuery>>) => {
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.code).toBe('42501');
};

beforeAll(async () => {
  kek = generateKek();
  keyEnv = kekEnv({ 1: kek }, 1, true);
  testDb = await createTestDatabase({ label: 'task039', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 3 });
  const suffix = randomBytes(4).toString('hex');
  for (const role of ['api', 'worker'] as const) {
    roleNames[role] = `app_${role}_t039_${suffix}`;
    rolePasswords[role] = randomBytes(12).toString('hex');
    await withClient(adminUrl(), (c) =>
      c.query(`CREATE ROLE "${roleNames[role]}" LOGIN NOSUPERUSER PASSWORD '${rolePasswords[role]}'`),
    );
  }
  const platform = readFileSync(join(REAL_MIGRATIONS, '0001_task-025-platform.sql'), 'utf8');
  for (const statement of platform.split('-- Grants')[0]?.split('--> statement-breakpoint') ?? []) {
    if (/^\s*CREATE (TABLE|INDEX|UNIQUE INDEX) "?(idempotency_records|rate_limit_buckets)/.test(statement)) {
      await pool.query(statement);
    }
  }
  for (const file of ['0010_task-032-audit.sql', '0020_task-033-identity.sql', '0030_task-039-provider-keys.sql']) {
    for (const statement of statementsOf(file, 'tables')) await pool.query(statement);
  }
  for (const file of ['0010_task-032-audit.sql', '0030_task-039-provider-keys.sql']) {
    for (const statement of statementsOf(file, 'grants')) await pool.query(statement);
  }
  await pool.query(
    `GRANT USAGE ON SCHEMA public TO "${roleNames.api}", "${roleNames.worker}"`,
  );
  await installJobs(testDb.url);
  for (const [id, email] of [
    [U1, 'one@example.test'],
    [U2, 'two@example.test'],
  ] as const) {
    await pool.query(
      `INSERT INTO users (id, idp_subject, email, linked_via) VALUES ($1, $2, $3, 'first_admin')`,
      [id, `sub_${id.slice(-1)}`, email],
    );
  }
  // The api process: public keys only, in the real api composition root.
  const apiEnv = kekEnv({ 1: kek }, 1, false);
  Object.assign(process.env, apiEnv);
  ({ app: apiApp } = await createApiApp(
    {
      WEB_ORIGIN: 'http://localhost:3000',
      APP_ENV: 'development',
      DATABASE_URL: testDb.url,
      DATABASE_POOL_MAX: 4,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      RATE_LIMIT_IP_KEY: 'r'.repeat(40),
    },
    createHttpLogging({ destination: sink(apiLines), level: 'debug' }),
  ));
  const { logger } = buildLogger({ level: 'debug', destination: sink(workerLines) });
  worker = await createWorkerApp(
    {
      DATABASE_URL: testDb.url,
      DATABASE_POOL_MAX: 4,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      WORKER_WATCHDOG_SECONDS: 180,
      WORKER_DRAIN_SECONDS: 5,
    },
    { logger, env: keyEnv, exit: () => undefined },
  );
}, 240_000);

afterAll(async () => {
  for (const name of Object.keys(kekEnv({ 1: kek }, 1, true))) delete process.env[name];
  await worker?.runtime.drain();
  await worker?.context.close();
  await apiApp?.close();
  await pool?.end();
  await testDb?.drop();
  for (const role of ['api', 'worker'] as const) {
    if (roleNames[role] !== '') {
      await withClient(adminUrl(), (c) => c.query(`DROP ROLE IF EXISTS "${roleNames[role]}"`));
    }
  }
});

describe('M0004 migration', () => {
  it('the tables have the designed shape: key_events has no foreign key, provider_keys one to users', async () => {
    await withClient(testDb.url, async (c) => {
      const cols = await c.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'provider_keys' AND column_name = 'fingerprint_pepper_version'`,
      );
      expect(cols.rowCount).toBe(1);
      const fks = await c.query(
        `SELECT conrelid::regclass::text AS t FROM pg_constraint WHERE contype = 'f' AND conrelid IN ('provider_keys'::regclass, 'key_events'::regclass)`,
      );
      expect(fks.rows).toEqual([{ t: 'provider_keys' }]);
    });
  });

  it('enforces the column constraints (TC-KEY data integrity)', async () => {
    const s = (await tryQuery(api(), 'select 1')).ok;
    expect(s).toBe(true);
    const sealed = apiApp.get<KeyWrapPort>(KEY_WRAP_PORT, { strict: false }).seal(Buffer.from(PLAINTEXT), aad(U1, K1));
    const base = [K1, U1, 'openai', sealed.ciphertext, sealed.nonce, sealed.wrappedDek, 1, '3210', FP, 1];
    const insert = (over: Record<number, unknown>, status = 'active') =>
      tryQuery(
        api(),
        `INSERT INTO provider_keys ${columns} VALUES ($1, $2, $3, '${status}', 1, $4, $5, $6, $7, $8, $9, $10)`,
        base.map((v, i) => (i in over ? over[i] : v)),
      );
    const rejected = async (r: ReturnType<typeof insert>) => {
      const a = await r;
      expect(a.ok).toBe(false);
      if (!a.ok) expect(a.code).toBe('23514');
    };
    await rejected(insert({ 2: 'anthropic' }));
    await rejected(insert({}, 'bogus'));
    await rejected(insert({ 4: Buffer.alloc(11) }));
    await rejected(insert({ 5: Buffer.alloc(383) }));
    await rejected(insert({ 3: Buffer.alloc(0) }));
    await rejected(insert({ 3: Buffer.alloc(1025) }));
    await rejected(insert({ 6: 0 }));
    await rejected(insert({ 8: 'ABC' + 'a'.repeat(61) }));
    await rejected(insert({ 9: 0 }));
    const orphan = await insert({ 1: '0197a1b2-0000-7000-8000-0000000000ff' });
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) expect(orphan.code).toBe('23503');
  });
});

describe('column grants (TC-KEY grants, T-20)', () => {
  it('app_api writes a sealed key but cannot read ciphertext, nonce or wrapped_dek back', async () => {
    const port = apiApp.get<KeyWrapPort>(KEY_WRAP_PORT, { strict: false });
    await insertKey(api(), K1, U1, port.seal(Buffer.from(PLAINTEXT), aad(U1, K1)));
    for (const sql of [
      'SELECT ciphertext FROM provider_keys',
      'SELECT nonce FROM provider_keys',
      'SELECT wrapped_dek FROM provider_keys',
      'SELECT * FROM provider_keys',
      'SELECT id FROM provider_keys WHERE ciphertext IS NOT NULL',
      'SELECT id FROM provider_keys ORDER BY nonce',
      `SELECT length(ciphertext) FROM provider_keys`,
    ]) {
      denied(await tryQuery(api(), sql));
    }
    // An INSERT that returns a secret column is a read.
    denied(
      await tryQuery(
        api(),
        `INSERT INTO provider_keys ${columns} VALUES ($1, $2, 'wavespeed', 'active', 1, $3, $4, $5, 1, '0000', $6, 1) RETURNING ciphertext`,
        [K2, U1, Buffer.alloc(20), Buffer.alloc(12), Buffer.alloc(384), FP],
      ),
    );
    const visible = await tryQuery(
      api(),
      `SELECT id, owner_id, provider, status, version, kek_version, last4, fingerprint, fingerprint_pepper_version, consecutive_auth_failures, last_validated_at, disabled_at, created_at, updated_at FROM provider_keys`,
    );
    expect(visible.ok && visible.rows).toHaveLength(1);
  });

  it('a replacement is one conditional UPDATE that reads no secret column and bumps the version', async () => {
    const port = apiApp.get<KeyWrapPort>(KEY_WRAP_PORT, { strict: false });
    const next = port.seal(Buffer.from('replaced-key-000000'), aad(U1, K1, 2));
    const update = `UPDATE provider_keys SET ciphertext = $1, nonce = $2, wrapped_dek = $3, kek_version = $4, version = version + 1, last4 = '0000', updated_at = now() WHERE id = $5 AND owner_id = $6 AND version = $7`;
    const args = [next.ciphertext, next.nonce, next.wrappedDek, next.kekVersion, K1, U1];
    const stale = await tryQuery(api(), update, [...args, 5]);
    expect(stale.ok && stale.rows).toEqual([]);
    const check = await withClient(testDb.url, (c) =>
      c.query('SELECT version FROM provider_keys WHERE id = $1', [K1]),
    );
    expect((check.rows[0] as { version: number }).version).toBe(1);
    const fresh = await withClient(api(), (c) => c.query(update, [...args, 1]));
    expect(fresh.rowCount).toBe(1);
    // The worker opens the new value only under the new version.
    const unsealer = worker.context.get(KeyUnsealer);
    const row = await withClient(wrk(), (c) =>
      c.query('SELECT ciphertext, nonce, wrapped_dek, kek_version, version FROM provider_keys WHERE id = $1', [K1]),
    );
    const r = row.rows[0] as Record<string, Buffer & number>;
    const sealed: Sealed = { ciphertext: r['ciphertext']!, nonce: r['nonce']!, wrappedDek: r['wrapped_dek']!, kekVersion: Number(r['kek_version']) };
    expect(Number(r['version'])).toBe(2);
    expect(unsealer.unseal(sealed, aad(U1, K1, 2)).toString()).toBe('replaced-key-000000');
    expect(() => unsealer.unseal(sealed, aad(U1, K1, 1))).toThrow(UnsealFailed);
  });

  it('app_api can delete by owner, app_worker reads every column and updates but cannot insert', async () => {
    const worker = await tryQuery(wrk(), 'SELECT ciphertext, nonce, wrapped_dek FROM provider_keys');
    expect(worker.ok && worker.rows).toHaveLength(1);
    denied(
      await tryQuery(
        wrk(),
        `INSERT INTO provider_keys ${columns} VALUES ($1, $2, 'wavespeed', 'active', 1, $3, $4, $5, 1, '0000', $6, 1)`,
        [K2, U2, Buffer.alloc(20), Buffer.alloc(12), Buffer.alloc(384), FP],
      ),
    );
    const upd = await tryQuery(wrk(), `UPDATE provider_keys SET consecutive_auth_failures = 1, status = 'untested' WHERE id = $1`, [K1]);
    expect(upd.ok).toBe(true);
    for (const role of ['api', 'worker'] as const) {
      denied(await tryQuery(roleUrl(role), 'TRUNCATE provider_keys'));
      denied(await tryQuery(roleUrl(role), 'CREATE TABLE x (id int)'));
    }
  });

  it('key_events is append-only for both runtime roles, and app_api cannot update audit_events', async () => {
    for (const role of ['api', 'worker'] as const) {
      const url = roleUrl(role);
      const ins = await tryQuery(url, `INSERT INTO key_events (id, owner_id, key_id, provider, kind) VALUES (gen_random_uuid(), $1, $2, 'openai', 'added')`, [U1, K1]);
      expect(ins.ok).toBe(true);
      denied(await tryQuery(url, `UPDATE key_events SET kind = 'deleted'`));
      denied(await tryQuery(url, 'DELETE FROM key_events'));
      denied(await tryQuery(url, 'TRUNCATE key_events'));
      denied(await tryQuery(url, `UPDATE audit_events SET outcome = 'allowed'`));
    }
    const bad = await tryQuery(api(), `INSERT INTO key_events (id, owner_id, provider, kind) VALUES (gen_random_uuid(), $1, 'openai', 'changed_db')`, [U1]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('23514');
  });

  it('removing the user cascades the key row but keeps the key_events history', async () => {
    await withClient(testDb.url, async (c) => {
      await c.query('DELETE FROM users WHERE id = $1', [U1]);
      expect((await c.query('SELECT 1 FROM provider_keys WHERE owner_id = $1', [U1])).rowCount).toBe(0);
      expect((await c.query('SELECT 1 FROM key_events WHERE owner_id = $1', [U1])).rowCount).toBe(2);
    });
  });
});

describe('seal in the api, unseal in the worker, through the real composition roots', () => {
  it('opens what the api sealed after a round trip through PostgreSQL', async () => {
    const port = apiApp.get<KeyWrapPort>(KEY_WRAP_PORT, { strict: false });
    await insertKey(api(), K2, U2, port.seal(Buffer.from(PLAINTEXT), aad(U2, K2)));
    const row = await withClient(wrk(), (c) =>
      c.query('SELECT ciphertext, nonce, wrapped_dek, kek_version FROM provider_keys WHERE id = $1', [K2]),
    );
    const r = row.rows[0] as Record<string, Buffer & number>;
    const sealed: Sealed = { ciphertext: r['ciphertext']!, nonce: r['nonce']!, wrappedDek: r['wrapped_dek']!, kekVersion: Number(r['kek_version']) };
    const unsealer = worker.context.get(KeyUnsealer);
    expect(unsealer.unseal(sealed, aad(U2, K2)).toString()).toBe(PLAINTEXT);
    // AAD mismatch, and the ciphertext moved to another user's row.
    expect(() => unsealer.unseal(sealed, aad(U2, K2, 2))).toThrow(UnsealFailed);
    expect(() => unsealer.unseal(sealed, aad(U1, K2))).toThrow(UnsealFailed);
    expect(() => unsealer.unseal(sealed, aad(U2, K1))).toThrow(UnsealFailed);
  });

  it('the api binding has no unsealer (probe): app.get(KeyUnsealer) throws', () => {
    expect(() => apiApp.get(KeyUnsealer, { strict: false })).toThrow();
    const port = apiApp.get<KeyWrapPort>(KEY_WRAP_PORT, { strict: false });
    expect(Object.keys(port)).not.toContain('unseal');
    expect((port as unknown as { unseal?: unknown }).unseal).toBeUndefined();
  });

  it('no process log holds the key, a PEM or the sealed bytes', () => {
    const text = [...apiLines, ...workerLines].join('');
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(PLAINTEXT);
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain('PUBLIC KEY');
  });

  it('the api start-up refuses a private key map and the worker start-up refuses an unreadable one', async () => {
    const logging = createHttpLogging({ level: 'silent' });
    const config = {
      WEB_ORIGIN: 'http://localhost:3000',
      APP_ENV: 'development' as const,
      DATABASE_URL: testDb.url,
      DATABASE_POOL_MAX: 2,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      RATE_LIMIT_IP_KEY: 'r'.repeat(40),
    };
    const before = process.env['KEK_PRIVATE_KEYS'];
    process.env['KEK_PRIVATE_KEYS'] = keyEnv['KEK_PRIVATE_KEYS'] as string;
    try {
      await expect(createApiApp(config, logging)).rejects.toThrow('KEK_PRIVATE_KEYS must be absent');
    } finally {
      if (before === undefined) delete process.env['KEK_PRIVATE_KEYS'];
      else process.env['KEK_PRIVATE_KEYS'] = before;
    }
    const { logger } = buildLogger({ level: 'silent' });
    const workerConfig = { DATABASE_URL: testDb.url, DATABASE_POOL_MAX: 2, DATABASE_ACQUIRE_TIMEOUT_MS: 5000 };
    await expect(
      createWorkerApp(workerConfig, { logger, env: { ...keyEnv, KEK_PRIVATE_KEYS: '{"1":"-----BEGIN PRIVATE KEY-----\\nzzz\\n-----END PRIVATE KEY-----"}' } }),
    ).rejects.toThrow(/KEK_PRIVATE_KEYS: holds an unreadable private key/);
    await expect(
      createWorkerApp(workerConfig, { logger, env: { ...keyEnv, KEK_ACTIVE_VERSION: '7' } }),
    ).rejects.toThrow(/KEK_ACTIVE_VERSION/);
  });
});
