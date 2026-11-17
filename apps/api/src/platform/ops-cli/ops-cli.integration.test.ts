/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles; prettier reflow detached the per-line directives (AIU-256) */
import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ModulesContainer } from '@nestjs/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkerApp } from '../../bootstrap/worker.module.js';
import type { WorkerApp } from '../../bootstrap/worker.module.js';
import { KEY_WRAP_PORT } from '../../modules/provider-keys/index.js';
import type { KeyWrapPort } from '../../modules/provider-keys/index.js';
import { createDatabase } from '../db/index.js';
import type { Database } from '../db/index.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../db/test-database.js';
import type { TestDatabase } from '../db/test-database.js';
import { installJobs } from '../jobs/test-support.js';
import { buildLogger } from '../logging/index.js';
import type { ProcessConfig } from '../config/index.js';
import { validEnv } from '../config/test-env.js';
import { Writable } from 'node:stream';
import { kekRewrap } from './commands.js';
import { privateKeysOf, publicKeysOf } from './kek-crypto.js';
import { executeCommand, runOps } from './index.js';
import type { OpsRuntime } from './index.js';

// TASK-062: the deployer's commands on real PostgreSQL. `erasure:resume` goes through the real entry point of the command
// line (`runOps` with the production `executeCommand`) and the resumed run is then taken up by the real worker composition
// root (`createWorkerApp`), the process `main.worker.ts` runs; `kek:rewrap` is proven by opening every rewrapped key with
// the worker's own unsealer holding the new private key only; the last case runs the compiled `dist/bin/ops.js`.
// TC-ACC-24, TC-KEY-rewrap, TC-DEL erasure:resume, the incident drill.

const APP_BUCKET = 'app';
const LEDGER_BUCKET = 'ledger';
const execFileAsync = promisify(execFile);
const sink = new Writable({
  write(_chunk: Buffer, _e, done) {
    done();
  },
});

interface Stand {
  readonly endpoint: string;
  readonly objects: Map<string, Buffer>;
  stop(): Promise<void>;
}

/** An in-process S3 stand-in (path-style): conditional put, get, delete, batch delete and list, in any bucket. */
async function startStand(): Promise<Stand> {
  const objects = new Map<string, Buffer>();
  const xml = (res: ServerResponse, status: number, body: string): void => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/xml');
    res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
  };
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const [, bucket = '', ...rest] = url.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      if (key === '' && req.method === 'GET') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const listed = [...objects.keys()].filter((name) => name.startsWith(`${bucket}/${prefix}`));
        const contents = listed
          .map(
            (name) =>
              `<Contents><Key>${name.slice(bucket.length + 1)}</Key><Size>1</Size><LastModified>${new Date().toISOString()}</LastModified></Contents>`,
          )
          .join('');
        return xml(
          res,
          200,
          `<ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${String(listed.length)}</KeyCount><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        );
      }
      if (key === '' && req.method === 'POST') {
        for (const match of body.toString().matchAll(/<Key>([^<]+)<\/Key>/g))
          objects.delete(`${bucket}/${match[1] as string}`);
        return xml(res, 200, '<DeleteResult></DeleteResult>');
      }
      const name = `${bucket}/${key}`;
      if (req.method === 'PUT') {
        if (req.headers['if-none-match'] === '*' && objects.has(name))
          return xml(res, 412, '<Error><Code>PreconditionFailed</Code></Error>');
        objects.set(name, body);
        res.setHeader('etag', '"stub"');
        res.statusCode = 200;
        return res.end();
      }
      if (req.method === 'DELETE') {
        objects.delete(name);
        res.statusCode = 204;
        return res.end();
      }
      const found = objects.get(name);
      if (found === undefined) return xml(res, 404, '<Error><Code>NoSuchKey</Code></Error>');
      res.statusCode = 200;
      return res.end(req.method === 'HEAD' ? undefined : found);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: `http://127.0.0.1:${String(port)}`,
    objects,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const rsa = () => generateKeyPairSync('rsa', { modulusLength: 3072 });
const pemOf = (key: ReturnType<typeof rsa>) => ({
  publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  privateKey: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
});
const kek1 = pemOf(rsa());
const kek2 = pemOf(rsa());

let testDb: TestDatabase;
let pool: pg.Pool;
let stand: Stand;
let database: Database;
const workers: WorkerApp[] = [];
let tmpBuild: string | undefined;

const one = async <T = any>(text: string, params: unknown[] = []): Promise<T> =>
  (await pool.query(text, params)).rows[0] as T;
const count = async (table: string, where: string, params: unknown[] = []) =>
  (await one<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`, params)).n;
async function until(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const workerEnv = (kek: {
  public: Record<string, string>;
  private: Record<string, string>;
  active: string;
}): Record<string, string | undefined> => ({
  KEK_PUBLIC_KEYS: JSON.stringify(kek.public),
  KEK_PRIVATE_KEYS: JSON.stringify(kek.private),
  KEK_ACTIVE_VERSION: kek.active,
  R2_ENDPOINT: stand.endpoint,
  R2_BUCKET: APP_BUCKET,
  R2_ACCESS_KEY_ID: 'stub-access',
  R2_SECRET_ACCESS_KEY: 'stub-secret',
  R2_LEDGER_BUCKET: LEDGER_BUCKET,
  R2_LEDGER_ACCESS_KEY_ID: 'stub-ledger-access',
  R2_LEDGER_SECRET_ACCESS_KEY: 'stub-ledger-secret',
  MEDIA_MAX_PIXEL_DIMENSION: '300',
  MEDIA_MAX_PIXELS: '40000',
  MEDIA_UNATTACHED_TTL_HOURS: '24',
  DELETION_RETRY_LIMIT: '2',
  VIDEO_JOB_DEADLINE_MIN: '5',
});

async function startWorker(env: Record<string, string | undefined>): Promise<WorkerApp> {
  const worker = await createWorkerApp(
    {
      DATABASE_URL: testDb.url,
      DATABASE_POOL_MAX: 8,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      WORKER_WATCHDOG_SECONDS: 180,
      WORKER_DRAIN_SECONDS: 5,
      WORKER_CONCURRENCY_PROVIDER: 2,
      WORKER_CONCURRENCY_SANITIZE: 1,
      WORKER_CONCURRENCY_DELETION: 2,
    },
    {
      logger: buildLogger({ level: 'silent', destination: sink }).logger,
      env,
      exit: () => undefined,
    },
  );
  workers.push(worker);
  return worker;
}

const providersOf = (worker: WorkerApp): unknown[] =>
  [...worker.context.get(ModulesContainer, { strict: false }).values()].flatMap((m) =>
    [...m.providers.values()].map((p) => p.instance as unknown),
  );

interface Unsealer {
  unseal(sealed: unknown, aad: unknown): Buffer;
}
const unsealerOf = (worker: WorkerApp): Unsealer => {
  const found = providersOf(worker).find(
    (i) =>
      typeof (i as Partial<Unsealer> | undefined)?.unseal === 'function' &&
      typeof (i as { versions?: unknown }).versions === 'function',
  );
  if (found === undefined) throw new Error('key unsealer not found in the worker');
  return found as Unsealer;
};

function runtime(config: Partial<ProcessConfig>) {
  const lines: string[] = [];
  const full = {
    APP_ENV: 'development',
    LOG_LEVEL: 'info',
    DATABASE_URL: testDb.url,
    DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
    ...config,
  } as unknown as ProcessConfig;
  const fake: OpsRuntime = {
    loadConfig: () => full,
    execute: executeCommand,
    write: (line) => lines.push(line),
  };
  return { fake, lines };
}
const ops = (argv: string[], config: Partial<ProcessConfig> = {}) => {
  const r = runtime(config);
  return runOps(argv, r.fake).then((code) => ({ code, lines: r.lines }));
};

beforeAll(async () => {
  stand = await startStand();
  testDb = await createTestDatabase({ label: 'task062', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 8 });
  const tables = (file: string): string[] =>
    (readFileSync(join(REAL_MIGRATIONS, file), 'utf8').split('-- Grants')[0] ?? '')
      .split('--> statement-breakpoint')
      .map((statement) =>
        statement
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n')
          .trim(),
      )
      .filter((statement) => statement !== '');
  for (const statement of tables('0001_task-025-platform.sql')) {
    if (
      /^CREATE (TABLE|INDEX|UNIQUE INDEX) "?(idempotency_records|rate_limit_buckets)/.test(
        statement,
      )
    )
      await pool.query(statement);
  }
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  for (const file of [
    '0010_task-032-audit.sql',
    '0020_task-033-identity.sql',
    '0030_task-039-provider-keys.sql',
    '0040_task-041-media.sql',
    '0050_task-044-usage.sql',
    '0060_task-058-lifecycle.sql',
    '0070_task-046-campaigns.sql',
    '0080_task-048-brief.sql',
    '0090_task-052-production-video.sql',
  ]) {
    for (const statement of tables(file)) await pool.query(statement);
  }
  await installJobs(testDb.url);
  database = createDatabase(
    { DATABASE_URL: testDb.url, DATABASE_POOL_MAX: 4, DATABASE_ACQUIRE_TIMEOUT_MS: 5000 },
    { applicationName: 'task062-test' },
  );
}, 300_000);

afterAll(async () => {
  for (const worker of workers) {
    await worker.runtime.drain().catch(() => undefined);
    await worker.context.close().catch(() => undefined);
  }
  await database?.close();
  await pool?.end();
  await testDb?.drop();
  await stand?.stop();
  if (tmpBuild !== undefined) rmSync(tmpBuild, { recursive: true, force: true });
}, 120_000);

async function account(role: 'user' | 'admin' = 'user'): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `u${id.slice(0, 8)}@example.test`;
  await pool.query(
    `insert into users (id, idp_subject, email, role, linked_via) values ($1, $2, $3, $4, 'invitation')`,
    [id, `sub_${id.slice(0, 8)}`, email, role],
  );
  return { id, email };
}

/** A value sealed through the worker's own seal port, stored as the api stores it. */
async function storeKey(
  worker: WorkerApp,
  ownerId: string,
  provider: 'openai' | 'wavespeed',
  secret: string,
  status = 'active',
): Promise<string> {
  const port = worker.context.get<KeyWrapPort>(KEY_WRAP_PORT, { strict: false });
  const id = randomUUID();
  const sealed = port.seal(Buffer.from(secret), {
    userId: ownerId,
    provider,
    keyId: id,
    version: 1,
  });
  await pool.query(
    `insert into provider_keys (id, owner_id, provider, status, version, ciphertext, nonce, wrapped_dek, kek_version, last4, fingerprint, fingerprint_pepper_version)
     values ($1, $2, $3, $4, 1, $5, $6, $7, $8, 'abcd', $9, 1)`,
    [
      id,
      ownerId,
      provider,
      status,
      sealed.ciphertext,
      sealed.nonce,
      sealed.wrappedDek,
      sealed.kekVersion,
      'a'.repeat(64),
    ],
  );
  return id;
}

const auditOf = (action: string) =>
  count('audit_events', `action = $1 and actor_type = 'operator' and actor_id is null`, [action]);

describe('first-admin:reopen', () => {
  it('TC-ACC-24: clears the once-only marker, audits it as the operator and prints counts only', async () => {
    await pool.query(
      `insert into platform_settings (id, first_admin_seeded_at) values (1, now()) on conflict (id) do update set first_admin_seeded_at = now()`,
    );
    const first = await ops(['first-admin:reopen', '--env=development']);
    expect(first).toEqual({ code: 0, lines: ['ops first-admin:reopen: done', 'reopened=1'] });
    expect(
      (await one(`select first_admin_seeded_at from platform_settings where id = 1`))
        .first_admin_seeded_at,
    ).toBeNull();
    expect(await auditOf('first_admin.reopened')).toBe(1);
    // A repeat finds it open already: still audited, nothing reopened.
    expect((await ops(['first-admin:reopen', '--env=development'])).lines).toEqual([
      'ops first-admin:reopen: done',
      'reopened=0',
    ]);
    expect(await auditOf('first_admin.reopened')).toBe(2);
  });

  it('refuses on an environment mismatch: no connection, no change, no audit event', async () => {
    await pool.query(`update platform_settings set first_admin_seeded_at = now() where id = 1`);
    const before = await count('audit_events', 'true');
    const refused = await ops(['first-admin:reopen', '--env=production'], { APP_ENV: 'staging' });
    expect(refused.code).toBe(2);
    expect(refused.lines).toEqual(['ops refused: --env does not match APP_ENV']);
    expect(
      (
        await one(
          `select first_admin_seeded_at is not null as set from platform_settings where id = 1`,
        )
      ).set,
    ).toBe(true);
    expect(await count('audit_events', 'true')).toBe(before);
  });

  it('refuses when the connection string points at another database than the one reached', async () => {
    const lines: string[] = [];
    const wrong = {
      APP_ENV: 'development',
      LOG_LEVEL: 'info',
      DATABASE_URL: testDb.url.replace(/\/[^/]+$/, '/postgres_other_name'),
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
    } as unknown as ProcessConfig;
    const code = await runOps(['first-admin:reopen', '--env=development'], {
      loadConfig: () => wrong,
      execute: executeCommand,
      write: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).not.toContain(testDb.name);
  });
});

describe('keys:disable-all', () => {
  it('disables every live key, one disabled_by_operator event each, one audit event and one alert; values never printed', async () => {
    const worker = await startWorker(
      workerEnv({
        public: { '1': kek1.publicKey },
        private: { '1': kek1.privateKey },
        active: '1',
      }),
    );
    const a = await account();
    const b = await account();
    const ids = [
      await storeKey(worker, a.id, 'openai', 'sk-secret-aaa'),
      await storeKey(worker, a.id, 'wavespeed', 'ws-secret-bbb', 'untested'),
      await storeKey(worker, b.id, 'openai', 'sk-secret-ccc'),
    ];
    const done = await ops(['keys:disable-all', '--env=development']);
    expect(done).toEqual({
      code: 0,
      lines: ['ops keys:disable-all: done', 'disabled=3', 'alerts_raised=1'],
    });
    expect(done.lines.join('\n')).not.toMatch(/secret|@example/);
    const rows = (
      await pool.query(
        `select status, disabled_at is not null as stamped from provider_keys where id = any($1)`,
        [ids],
      )
    ).rows;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === 'disabled' && r.stamped === true)).toBe(true);
    expect(
      await count('key_events', `kind = 'disabled_by_operator' and key_id = any($1)`, [ids]),
    ).toBe(3);
    expect(await auditOf('key.disabled_all')).toBe(1);
    expect(
      await one(
        `select counts, subject_user_id from admin_alerts where kind = 'keys_disabled_all'`,
      ),
    ).toEqual({ counts: { keys: 3 }, subject_user_id: null });
    // Deliberate and bounded: nothing is deleted, no session or account is touched.
    expect(await count('provider_keys', 'true')).toBe(3);
    expect(await count('users', `status <> 'active'`)).toBe(0);
    // A repeat disables nothing more and leaves the one open alert alone.
    expect((await ops(['keys:disable-all', '--env=development'])).lines).toEqual([
      'ops keys:disable-all: done',
      'disabled=0',
      'alerts_raised=0',
    ]);
    expect(await auditOf('key.disabled_all')).toBe(2);
    expect(await count('admin_alerts', `kind = 'keys_disabled_all'`)).toBe(1);
    await pool.query('delete from provider_keys');
    expect(
      (await ops(['keys:disable-all', '--env=staging'], { APP_ENV: 'development' })).code,
    ).toBe(2);
    expect(await auditOf('key.disabled_all')).toBe(2);
  });
});

describe('kek:rewrap', () => {
  it('TC-KEY-rewrap: a killed run resumes by kek_version and every key opens afterwards with the old private key gone', async () => {
    await pool.query('delete from provider_keys');
    const sealer = await startWorker(
      workerEnv({
        public: { '1': kek1.publicKey, '2': kek2.publicKey },
        private: { '1': kek1.privateKey },
        active: '1',
      }),
    );
    const owner = await account();
    const secrets = new Map<string, string>();
    for (let i = 0; i < 4; i += 1) {
      const provider = i % 2 === 0 ? 'openai' : 'wavespeed';
      const owner2 = i < 2 ? owner : await account();
      secrets.set(
        await storeKey(sealer, owner2.id, provider, `sk-live-${String(i)}-${randomUUID()}`),
        '',
      );
    }
    await sealer.runtime.drain();
    await sealer.context.close();
    workers.splice(workers.indexOf(sealer), 1);

    const keys = {
      privateKeys: privateKeysOf({ '1': kek1.privateKey, '2': kek2.privateKey }),
      publicKeys: publicKeysOf({ '1': kek1.publicKey, '2': kek2.publicKey }),
      active: 2,
    };
    // The process dies after two rows: the database wrapper stops answering once its budget of transactions is spent.
    let budget = 1 /* first batch read */ + 2;
    const dying = {
      uow: {
        run: (fn: Parameters<Database['uow']['run']>[0]) => {
          if (budget-- <= 0) throw new Error('killed');
          return database.uow.run(fn);
        },
      },
    } as unknown as Pick<Database, 'uow'>;
    await expect(kekRewrap(dying, keys)).rejects.toThrow('killed');
    const afterKill = (
      await pool.query<{ kek_version: number }>('select kek_version from provider_keys')
    ).rows
      .map((r) => r.kek_version)
      .sort();
    expect(afterKill).toEqual([1, 1, 2, 2]);
    expect(await auditOf('kek.rewrapped')).toBe(0);

    // The command itself resumes: only the two rows left are rewrapped, and it audits once.
    const resumed = await ops(['kek:rewrap', '--env=development'], {
      KEK_PUBLIC_KEYS: { '1': kek1.publicKey, '2': kek2.publicKey },
      KEK_PRIVATE_KEYS: { '1': kek1.privateKey, '2': kek2.privateKey },
      KEK_ACTIVE_VERSION: 2,
    } as unknown as Partial<ProcessConfig>);
    expect(resumed).toEqual({
      code: 0,
      lines: ['ops kek:rewrap: done', 'rewrapped=2', 'failed=0', 'already_current=0'],
    });
    expect(await count('provider_keys', 'kek_version = 2')).toBe(4);
    expect(await count('key_events', `kind = 'rewrapped'`)).toBe(4);
    expect(await auditOf('kek.rewrapped')).toBe(1);
    expect(
      (
        await ops(['kek:rewrap', '--env=development'], {
          KEK_PUBLIC_KEYS: { '1': kek1.publicKey, '2': kek2.publicKey },
          KEK_PRIVATE_KEYS: { '1': kek1.privateKey, '2': kek2.privateKey },
          KEK_ACTIVE_VERSION: 2,
        } as unknown as Partial<ProcessConfig>)
      ).lines,
    ).toEqual(['ops kek:rewrap: done', 'rewrapped=0', 'failed=0', 'already_current=0']);

    // The old private key is removed from the worker, as the rotation runbook does: every key still opens.
    const opener = await startWorker(
      workerEnv({
        public: { '2': kek2.publicKey },
        private: { '2': kek2.privateKey },
        active: '2',
      }),
    );
    const unsealer = unsealerOf(opener);
    const rows = (
      await pool.query(
        `select id, owner_id, provider, version, ciphertext, nonce, wrapped_dek, kek_version from provider_keys`,
      )
    ).rows;
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const plain = unsealer.unseal(
        {
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          wrappedDek: row.wrapped_dek,
          kekVersion: row.kek_version,
        },
        { userId: row.owner_id, provider: row.provider, keyId: row.id, version: row.version },
      );
      expect(plain.toString()).toMatch(/^sk-live-/);
    }
  }, 120_000);

  it('a row it cannot rewrap is left untouched, counted, audited as failed, and the command exits 1', async () => {
    await pool.query('delete from provider_keys');
    const owner = await account();
    const sealer = await startWorker(
      workerEnv({
        public: { '2': kek2.publicKey },
        private: { '2': kek2.privateKey },
        active: '2',
      }),
    );
    await storeKey(sealer, owner.id, 'openai', 'sk-orphan');
    const before = await one(`select wrapped_dek, kek_version from provider_keys`);
    // Version 2 sealed it; the operator's configuration holds the private key of version 1 and 3 only.
    const result = await ops(['kek:rewrap', '--env=development'], {
      KEK_PUBLIC_KEYS: { '1': kek1.publicKey, '3': kek1.publicKey },
      KEK_PRIVATE_KEYS: { '1': kek1.privateKey, '3': kek1.privateKey },
      KEK_ACTIVE_VERSION: 3,
    } as unknown as Partial<ProcessConfig>);
    expect(result).toEqual({
      code: 1,
      lines: ['ops kek:rewrap: incomplete', 'rewrapped=0', 'failed=1', 'already_current=0'],
    });
    expect(await one(`select wrapped_dek, kek_version from provider_keys`)).toEqual(before);
    expect(
      await count(
        'audit_events',
        `action = 'kek.rewrapped' and outcome = 'failed' and actor_type = 'operator'`,
      ),
    ).toBe(1);
  }, 120_000);

  it('refuses to start without the key maps, before opening a connection', async () => {
    const result = await ops(['kek:rewrap', '--env=development']);
    expect(result.code).toBe(2);
    expect(result.lines[0]).toContain('kek:rewrap needs');
  });
});

describe('erasure:resume', () => {
  it('TC-DEL: a stuck run is resumed, queued, taken up by the real worker and audited as the operator', async () => {
    const worker = await startWorker(
      workerEnv({
        public: { '2': kek2.publicKey },
        private: { '2': kek2.privateKey },
        active: '2',
      }),
    );
    void worker;
    const subject = await account();
    await pool.query(`update users set status = 'removed' where id = $1`, [subject.id]);
    const runId = randomUUID();
    await pool.query(
      `insert into deletion_runs (id, kind, subject_id, owner_id, step, state, attempts, last_error_class, not_before) values ($1, 'account', $2, $2, 1, 'stuck', 2, 'storage', now())`,
      [runId, subject.id],
    );
    expect(await count('pgboss.job', `data->>'runId' = $1`, [runId])).toBe(0);

    const resumed = await ops(['erasure:resume', runId, '--env=development']);
    expect(resumed).toEqual({ code: 0, lines: ['ops erasure:resume: done', 'resumed=1'] });
    expect(resumed.lines.join('\n')).not.toContain(runId);
    expect(
      await one(
        `select count(*)::int as n from audit_events where action = 'erasure.resumed' and actor_type = 'operator' and object_id = $1 and outcome = 'allowed'`,
        [subject.id],
      ),
    ).toEqual({ n: 1 });

    // The worker process picks the job up: the ledger object is written before step 1 and the run moves on.
    await until(
      async () =>
        (await one<{ step: number }>('select step from deletion_runs where id = $1', [runId]))
          .step >= 3,
      'the worker to advance the resumed run',
    );
    expect(
      [...stand.objects.keys()].filter(
        (name) => name.startsWith(`${LEDGER_BUCKET}/erasure/`) && name.includes(runId),
      ),
    ).toHaveLength(1);
    expect(await one(`select state, attempts from deletion_runs where id = $1`, [runId])).toEqual({
      state: 'running',
      attempts: 0,
    });
  }, 120_000);

  it('a run that is not stuck, or does not exist, is left alone, audited as failed and exits 1', async () => {
    const subject = await account();
    const runId = randomUUID();
    await pool.query(
      `insert into deletion_runs (id, kind, subject_id, owner_id, step, state) values ($1, 'account', $2, $2, 2, 'running')`,
      [runId, subject.id],
    );
    const notStuck = await ops(['erasure:resume', runId, '--env=development']);
    expect(notStuck).toEqual({
      code: 1,
      lines: ['ops erasure:resume: incomplete', 'resumed=0', 'not_stuck=1'],
    });
    expect(
      await count(
        'audit_events',
        `action = 'erasure.resumed' and outcome = 'failed' and object_id = $1`,
        [subject.id],
      ),
    ).toBe(1);
    const missing = await ops(['erasure:resume', randomUUID(), '--env=development']);
    expect(missing).toEqual({
      code: 1,
      lines: ['ops erasure:resume: incomplete', 'resumed=0', 'not_found=1'],
    });
    expect(
      await ops(['erasure:resume', runId, '--env=production'], { APP_ENV: 'development' }),
    ).toMatchObject({ code: 2 });
    expect(await ops(['erasure:resume', 'x; drop table users', '--env=development'])).toMatchObject(
      { code: 2 },
    );
  });

  it('a stuck campaign run goes to the campaign queue', async () => {
    const owner = await account();
    const campaignId = randomUUID();
    const runId = randomUUID();
    await pool.query(
      `insert into deletion_runs (id, kind, subject_id, owner_id, step, state, attempts) values ($1, 'campaign', $2, $3, 1, 'stuck', 2)`,
      [runId, campaignId, owner.id],
    );
    expect((await ops(['erasure:resume', runId, '--env=development'])).code).toBe(0);
    expect(
      await count(
        'audit_events',
        `action = 'erasure.resumed' and object_type = 'campaign' and object_id = $1`,
        [campaignId],
      ),
    ).toBe(1);
    expect(
      await count('pgboss.job', `name = 'lifecycle.campaign-deletion' and data->>'runId' = $1`, [
        runId,
      ]),
    ).toBe(1);
  });
});

describe('the compiled entry point (incident drill)', () => {
  it('node dist/bin/ops.js refuses a mismatched environment and runs first-admin:reopen with the real configuration', async () => {
    tmpBuild = mkdtempSync(join(import.meta.dirname, '..', '..', '..', '.ops-build-'));
    await execFileAsync(
      'pnpm',
      ['exec', 'tsc', '-p', 'tsconfig.build.json', '--outDir', tmpBuild],
      { cwd: join(import.meta.dirname, '..', '..', '..') },
    );
    const env = {
      ...process.env,
      ...validEnv('api', {
        DATABASE_URL: testDb.url,
        DATABASE_ACQUIRE_TIMEOUT_MS: '5000',
        DATABASE_POOL_MAX: '2',
        STORAGE_PUBLIC_ORIGIN: 'http://localhost:9000',
        OWNER_EMAIL: 'owner@example.test',
      }),
    };
    const run = (args: string[]) =>
      execFileAsync(process.execPath, [join(tmpBuild as string, 'bin', 'ops.js'), ...args], {
        env,
      }).then(
        (r) => ({ code: 0, out: r.stdout }),
        (e: { code: number; stdout: string; stderr: string }) => ({
          code: e.code,
          out: e.stdout + e.stderr,
        }),
      );
    await pool.query(`update platform_settings set first_admin_seeded_at = now() where id = 1`);
    const mismatch = await run(['first-admin:reopen', '--env=production']);
    expect(mismatch.code).toBe(2);
    expect(mismatch.out).toContain('--env does not match APP_ENV');
    expect(
      (
        await one(
          `select first_admin_seeded_at is not null as set from platform_settings where id = 1`,
        )
      ).set,
    ).toBe(true);
    const ok = await run(['first-admin:reopen', '--env=development']);
    expect(ok).toEqual({ code: 0, out: 'ops first-admin:reopen: done\nreopened=1\n' });
    expect(
      (await one(`select first_admin_seeded_at from platform_settings where id = 1`))
        .first_admin_seeded_at,
    ).toBeNull();
    const bad = await run(['first-admin:reopen']);
    expect(bad.code).toBe(2);
  }, 240_000);
});
