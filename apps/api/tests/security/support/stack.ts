import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { Controller, Get, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import pg from 'pg';
import { it, vi } from 'vitest';
import { createApiApp } from '../../../src/bootstrap/api.module.js';
import { createWorkerApp } from '../../../src/bootstrap/worker.module.js';
import type { WorkerApp } from '../../../src/bootstrap/worker.module.js';
import { runSeed } from '../../../src/database/seed.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../../src/platform/db/test-database.js';
import type { TestDatabase } from '../../../src/platform/db/test-database.js';
import { EGRESS, Egress, EgressError } from '../../../src/platform/egress/index.js';
import type { Egress as EgressType } from '../../../src/platform/egress/index.js';
import { startServer } from '../../../src/platform/egress/test-support.js';
import { createRuntimeBoss, startRuntimeBoss } from '../../../src/platform/jobs/boss.js';
import { installJobs } from '../../../src/platform/jobs/test-support.js';
import { Scope } from '../../../src/platform/http/index.js';
import { buildLogger, createHttpLogging } from '../../../src/platform/logging/index.js';
import { STORAGE_PORT } from '../../../src/modules/media/index.js';
import type { StoragePort } from '../../../src/modules/media/index.js';
import { IDENTITY_PORT } from '../../../src/modules/identity/index.js';
import type { LocalIdentity } from '../../../src/modules/identity/index.js';
import { priceTableSeedStep } from '../../../src/modules/usage/index.js';
import { brandRulesSeedStep } from '../../../src/modules/brief/test-support.js';
import { AccountErasureJob } from '../../../src/modules/lifecycle/lifecycle.module.js';
import { generateKek, kekEnv } from '../../../src/modules/provider-keys/test-support.js';
import type { PgBoss } from 'pg-boss';

// Shared harness of the security suite (TASK-116): the real api composition root (`createApiApp`, the one `main.api.ts`
// runs) with `fastify.inject`, the real worker composition root (`createWorkerApp`), real PostgreSQL, an in-process S3
// stand-in that also plays the `erasure-ledger` bucket, and a local TLS server standing in for api.openai.com. Every sink
// the product writes (api log, worker log, database, queue, object stores, responses) is reachable from here so a test
// can scan it.

export const ORIGIN = 'http://localhost:3000';
export const APP_BUCKET = 'app';
export const LEDGER_BUCKET = 'ledger';
export const contractsDir = join(import.meta.dirname, '..', '..', '..', '..', '..', 'packages', 'contracts');

export interface Stand {
  readonly endpoint: string;
  /** Every stored object as `bucket/key`. */
  readonly objects: Map<string, Buffer>;
  failDeletes: boolean;
  /** Every request seen: method, bucket, key. */
  readonly requests: { method: string; bucket: string; key: string; query: string }[];
  stop(): Promise<void>;
}

/** An in-process S3 stand-in (path-style, plain http): conditional put, get, delete, batch delete and list, in any bucket. */
export async function startStand(): Promise<Stand> {
  const objects = new Map<string, Buffer>();
  const requests: Stand['requests'] = [];
  const stand = { objects, requests, failDeletes: false } as { objects: Map<string, Buffer>; requests: Stand['requests']; failDeletes: boolean };
  const xml = (res: ServerResponse, status: number, body: string): void => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/xml');
    res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
  };
  const error = (res: ServerResponse, status: number, code: string): void => xml(res, status, `<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const [, bucket = '', ...rest] = url.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    requests.push({ method: req.method ?? '', bucket, key, query: url.search });
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      if (key === '' && req.method === 'GET') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const listed = [...objects.entries()].filter(([name]) => name.startsWith(`${bucket}/${prefix}`)).sort(([a], [b]) => a.localeCompare(b));
        const contents = listed.map(([name, o]) => `<Contents><Key>${name.slice(bucket.length + 1)}</Key><Size>${String(o.length)}</Size><LastModified>${new Date().toISOString()}</LastModified></Contents>`).join('');
        return xml(res, 200, `<ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${String(listed.length)}</KeyCount><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
      }
      if (key === '' && req.method === 'POST' && url.searchParams.has('delete')) {
        if (stand.failDeletes) return error(res, 500, 'InternalError');
        for (const match of body.toString().matchAll(/<Key>([^<]+)<\/Key>/g)) objects.delete(`${bucket}/${match[1] as string}`);
        return xml(res, 200, '<DeleteResult></DeleteResult>');
      }
      const name = `${bucket}/${key}`;
      if (req.method === 'PUT') {
        if (req.headers['if-none-match'] === '*' && objects.has(name)) return error(res, 412, 'PreconditionFailed');
        objects.set(name, body);
        res.setHeader('etag', '"stub"');
        res.statusCode = 200;
        return res.end();
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const found = objects.get(name);
        if (found === undefined) return error(res, 404, 'NoSuchKey');
        res.setHeader('content-length', String(found.length));
        res.statusCode = 200;
        return res.end(req.method === 'HEAD' ? undefined : found);
      }
      if (req.method === 'DELETE') {
        if (stand.failDeletes) return error(res, 500, 'InternalError');
        objects.delete(name);
        res.statusCode = 204;
        return res.end();
      }
      return error(res, 400, 'BadRequest');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(stand, {
    endpoint: `http://127.0.0.1:${String(port)}`,
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  }) as Stand;
}

/** The route the suite adds to the api: a handler that fails with a message carrying whatever the test passes in. */
class Probe {
  static message = 'probe failure';
  boom(): never {
    throw new Error(Probe.message);
  }
}
// Applied by hand: the test transform does not read the decorator flags of the source tsconfig.
Controller('probe')(Probe);
const boomDescriptor = Object.getOwnPropertyDescriptor(Probe.prototype, 'boom') as PropertyDescriptor;
Get('boom')(Probe.prototype, 'boom', boomDescriptor);
Scope('U')(Probe.prototype, 'boom', boomDescriptor);

/** Sets the message of the next `GET /probe/boom` 500 (the route is `Pub`-less on purpose: a refusal is also a sink case). */
export function failWith(message: string): void {
  Probe.message = message;
}

export interface Body {
  success: boolean;
  data?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  error?: { code: string; message: string; details?: any[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  metaData: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface Reply {
  status?: number;
  body?: unknown;
  raw?: string;
}

export interface Account {
  id: string;
  sub: string;
  email: string;
  /** A token with both factors fresh. */
  token: string;
  /** A token of the same session with no factor evidence. */
  noFactor: string;
}

export interface Stack {
  readonly pool: pg.Pool;
  readonly stand: Stand;
  readonly testDb: TestDatabase;
  readonly logs: string[];
  readonly app: Awaited<ReturnType<typeof createApiApp>>['app'];
  /** The method index of the running app: which `METHOD /path` pairs are routed. */
  readonly index: Awaited<ReturnType<typeof createApiApp>>['index'];
  readonly worker: WorkerApp;
  readonly local: LocalIdentity;
  readonly workerIdentity: LocalIdentity;
  readonly storage: StoragePort;
  readonly erasure: AccountErasureJob;
  readonly boss: PgBoss;
  /** What the OpenAI stand-in answers (worker side) and what it saw. */
  readonly openai: { seen: { auth: string | undefined; body: Record<string, any> }[]; reply: (n: number) => Reply }; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** What the provider probe stand-in (api side) answers, and the calls it saw. */
  readonly probe: { answer: number | 'timeout'; calls: { provider: string; url: string; authorization: string | undefined }[] };
  call(method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, token?: string, payload?: unknown, extra?: Record<string, string>): Promise<{ status: number; raw: string; headers: Record<string, unknown>; body: Body }>;
  account(label?: string): Promise<Account>;
  admin(label?: string): Promise<Account>;
  one<T = any>(text: string, params?: unknown[]): Promise<T>; // eslint-disable-line @typescript-eslint/no-explicit-any
  count(table: string, where: string, params?: unknown[]): Promise<number>;
  until(check: () => Promise<boolean>, what: string, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export const OPENAI_CANARY = ['sk', 'canary-OPENAI-SEC116-0123456789abcdef'].join('-'); // assembled so no scanner reads it as a real key
export const WAVE_CANARY = 'wavecanary_SEC116_0123456789_abcdefghij';
const log = { info: () => undefined, warn: () => undefined };
export const silentJobLog = log;

const REFERENCE_MIGRATIONS = [
  '0010_task-032-audit.sql',
  '0020_task-033-identity.sql',
  '0030_task-039-provider-keys.sql',
  '0040_task-041-media.sql',
  '0050_task-044-usage.sql',
  '0060_task-058-lifecycle.sql',
  '0070_task-046-campaigns.sql',
  '0080_task-048-brief.sql',
  '0090_task-052-production-video.sql',
];

function statements(file: string): string[] {
  return (readFileSync(join(REAL_MIGRATIONS, file), 'utf8').split('-- Grants')[0] ?? '')
    .split('--> statement-breakpoint')
    .map((statement) => statement.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
    .filter((statement) => statement !== '');
}

/** The JSON envelope of a response; a non-JSON body (the usage report CSV) has no envelope and reads as a bare outcome. */
function parseBody(text: string, status: number): Body {
  if (text === '') return { success: true, metaData: {} };
  try {
    return JSON.parse(text) as Body;
  } catch {
    return { success: status < 400, metaData: {} };
  }
}

export async function bootStack(label: string, opts: { mfa?: 'all' | 'admins' } = {}): Promise<Stack> {
  const saved: Record<string, string | undefined> = {};
  const logs: string[] = [];
  const sink = new Writable({ write(chunk: Buffer, _e, done) { logs.push(chunk.toString()); done(); } });
  const stand = await startStand();
  const openai: Stack['openai'] = { seen: [], reply: () => ({}) };
  const probe: Stack['probe'] = { answer: 200, calls: [] };
  const tls = await startServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => {
      openai.seen.push({ auth: req.headers['authorization'], body: JSON.parse(Buffer.concat(parts).toString() || '{}') as Record<string, any> }); // eslint-disable-line @typescript-eslint/no-explicit-any
      const answer = openai.reply(openai.seen.length);
      res.statusCode = answer.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(answer.raw ?? JSON.stringify(answer.body ?? {}));
    });
  });

  const testDb = await createTestDatabase({ label, migrations: false });
  const pool = new pg.Pool({ connectionString: testDb.url, max: 8 });
  for (const statement of statements('0001_task-025-platform.sql')) {
    if (/^CREATE (TABLE|INDEX|UNIQUE INDEX) "?(idempotency_records|rate_limit_buckets)/.test(statement)) await pool.query(statement);
  }
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  for (const file of REFERENCE_MIGRATIONS) for (const statement of statements(file)) await pool.query(statement);
  await installJobs(testDb.url);
  await runSeed({ dataset: 'reference', appEnv: 'development', databaseUrl: testDb.url, steps: [priceTableSeedStep(), brandRulesSeedStep()] });

  const kek = generateKek();
  const workerEnv: Record<string, string | undefined> = {
    ...kekEnv({ 1: kek }, 1, true),
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
    OPENAI_TEXT_MODEL: 'local-stub-text',
    OPENAI_VISION_MODEL: 'local-stub-vision',
    KEY_AUTO_DISABLE_THRESHOLD: '2',
  };
  const env: Record<string, string | undefined> = {
    ...kekEnv({ 1: kek }, 1, false),
    KEY_FINGERPRINT_PEPPERS: JSON.stringify({ '1': Buffer.alloc(32, 7).toString('base64') }),
    KEY_FINGERPRINT_PEPPER_ACTIVE: '1',
    R2_ENDPOINT: stand.endpoint,
    R2_BUCKET: APP_BUCKET,
    R2_ACCESS_KEY_ID: 'stub-access',
    R2_SECRET_ACCESS_KEY: 'stub-secret',
    STORAGE_PUBLIC_ORIGIN: stand.endpoint,
    OWNER_EMAIL: 'owner116@example.test',
    INVITE_EMAIL_DOMAINS: 'example.test',
    CURSOR_SIGNING_KEY: 'k'.repeat(40),
    MFA_REQUIRED_FOR: opts.mfa ?? 'all',
  };
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  const { app, index } = await createApiApp(
    { WEB_ORIGIN: ORIGIN, APP_ENV: 'development', DATABASE_URL: testDb.url, DATABASE_POOL_MAX: 8, DATABASE_ACQUIRE_TIMEOUT_MS: 5000, RATE_LIMIT_IP_KEY: 'r'.repeat(40) },
    createHttpLogging({ level: 'debug', destination: sink }),
    [Probe],
  );
  const providers = [...app.get(ModulesContainer, { strict: false }).values()].flatMap((m) => [...m.providers.values()]);
  const found = providers.map((p) => p.instance as Partial<LocalIdentity> | undefined).find((i) => typeof i?.issueToken === 'function');
  if (found === undefined) throw new Error('local identity provider not found');
  const local = found as LocalIdentity;
  // The provider key probe goes to a stand-in behind the real egress client; its answer echoes the key (TC-KEY-06).
  const apiEgress = app.get<Pick<EgressType, 'fetch'>>(EGRESS, { strict: false });
  vi.spyOn(apiEgress, 'fetch').mockImplementation((provider, req) => {
    probe.calls.push({ provider, url: req.url, authorization: req.headers?.['authorization'] });
    if (probe.answer === 'timeout') return Promise.reject(new EgressError('timeout', 'after_send', 'the time limit passed'));
    return Promise.resolve({ status: probe.answer, headers: {}, body: Buffer.from(JSON.stringify({ error: `bad key ${req.headers?.['authorization'] ?? ''}` })) });
  });

  class StubEgress {}
  Module({})(StubEgress);
  const egressModule: DynamicModule = {
    module: StubEgress,
    providers: [{ provide: EGRESS, useValue: new Egress({
      allowedHosts: { openai: ['api.openai.com'] },
      timeoutMs: 1500,
      maxBytes: 5_000_000,
      resolver: async () => ['127.0.0.1'],
      testing: { isBlockedAddress: () => false, tls: { ca: tls.ca }, port: tls.port },
    }) }],
    exports: [EGRESS],
  };
  const worker = await createWorkerApp(
    { DATABASE_URL: testDb.url, DATABASE_POOL_MAX: 8, DATABASE_ACQUIRE_TIMEOUT_MS: 5000, WORKER_WATCHDOG_SECONDS: 180, WORKER_DRAIN_SECONDS: 5, WORKER_CONCURRENCY_PROVIDER: 2, WORKER_CONCURRENCY_SANITIZE: 1, WORKER_CONCURRENCY_DELETION: 2 },
    {
      logger: buildLogger({ level: 'debug', destination: sink }).logger,
      egress: egressModule,
      openAiChatUrl: `https://api.openai.com:${String(tls.port)}/v1/chat/completions`,
      env: workerEnv,
      exit: () => undefined,
    },
  );
  const storage = worker.context.get<StoragePort>(STORAGE_PORT, { strict: false });
  const erasure = worker.context.get(AccountErasureJob, { strict: false });
  const workerIdentity = worker.context.get<LocalIdentity>(IDENTITY_PORT, { strict: false });
  const boss = createRuntimeBoss({ DATABASE_URL: testDb.url, role: 'api' });
  boss.on('error', () => undefined);
  await startRuntimeBoss(boss);

  const fastify = () => app.getHttpAdapter().getInstance();
  let seq = 0;
  const stack: Stack = {
    pool, stand, testDb, logs, app, index, worker, local, workerIdentity, storage, erasure, boss, openai, probe,
    async call(method, url, token, payload, extra = {}) {
      const headers: Record<string, string> = { ...extra };
      if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
      const res = await fastify().inject({ method, url: `/api/v1${url}`, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
      return { status: res.statusCode, raw: res.body, headers: res.headers as Record<string, unknown>, body: parseBody(res.body, res.statusCode) };
    },
    async account(labelPart = 'u') {
      const n = ++seq;
      const sub = `user_t116_${labelPart}_${String(n)}`;
      const email = `${labelPart}${String(n)}.person@example.test`;
      local.addUser(sub, email, true);
      workerIdentity.addUser(sub, email, true);
      await pool.query(`insert into invitations (id, email, expires_at) values (gen_random_uuid(), $1, now() + interval '1 day')`, [email]);
      const token = local.issueToken({ sub, azp: ORIGIN, fva: [1, 1] });
      const linked = await stack.call('GET', '/me', token);
      if (linked.status !== 200) throw new Error(`account link failed: ${String(linked.status)} ${linked.raw}`);
      const id = (await pool.query(`select id from users where idp_subject = $1`, [sub])).rows[0].id as string;
      return { id, sub, email, token, noFactor: local.issueToken({ sub, azp: ORIGIN }) };
    },
    async admin(labelPart = 'adm') {
      const a = await stack.account(labelPart);
      await pool.query(`update users set role = 'admin' where id = $1`, [a.id]);
      return a;
    },
    async one<T>(text: string, params: unknown[] = []) { return (await pool.query(text, params)).rows[0] as T; },
    async count(table, where, params = []) { return (await stack.one<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`, params)).n; },
    async until(check, what, timeoutMs = 20_000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`timed out waiting for ${what}`);
    },
    async close() {
      vi.restoreAllMocks();
      await worker.runtime.drain().catch(() => undefined);
      await worker.context.close().catch(() => undefined);
      await boss.stop({ graceful: false }).catch(() => undefined);
      await app.close();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await pool.end();
      await settleConnections(testDb.url);
      await testDb.drop();
      await stand.stop();
      await tls.close();
    },
  };
  return stack;
}

/** Counts, per `table.column`, the rows that hold `text` in any text, varchar or jsonb column of the application schema. */
export async function rowsHolding(pool: pg.Pool, text: string, schemas: readonly string[] = ['public']): Promise<Record<string, number>> {
  const columns = (await pool.query<{ table_schema: string; table_name: string; column_name: string; data_type: string }>(
    `select table_schema, table_name, column_name, data_type from information_schema.columns where table_schema = any($1) and data_type in ('text', 'character varying', 'jsonb', 'character', 'json', 'bytea')`,
    [schemas],
  )).rows;
  const found: Record<string, number> = {};
  for (const { table_schema, table_name, column_name, data_type } of columns) {
    const expr = data_type === 'jsonb' || data_type === 'json' || data_type === 'bytea' ? `convert_from("${column_name}"::text::bytea, 'UTF8')` : `"${column_name}"`;
    const safe = data_type === 'bytea' ? `encode("${column_name}", 'escape')` : data_type === 'jsonb' || data_type === 'json' ? `"${column_name}"::text` : expr;
    const n = (await pool.query<{ n: number }>(`select count(*)::int as n from "${table_schema}"."${table_name}" where ${safe} ilike $1`, [`%${text}%`])).rows[0]?.n ?? 0;
    if (n > 0) found[`${table_schema === 'public' ? '' : `${table_schema}.`}${table_name}.${column_name}`] = n;
  }
  return found;
}

export const newId = (): string => randomUUID();

/**
 * A case for a product defect this suite found (a finding with a stable ID in docs/evidence/TASK-116). `it.fails` keeps the
 * suite green while the defect is open and turns red the day the product is fixed, so the marker cannot outlive the defect.
 */
export function openDefect(id: string, name: string, body: () => Promise<void>, timeout = 60_000): void {
  it.fails(`[${id} open] ${name}`, body, timeout);
}

/**
 * The application's own pools and the job queue end their connections asynchronously. DROP DATABASE ... WITH (FORCE) while one is
 * still closing makes the server kill it and the pool report an unhandled "terminating connection" error (seen as an intermittent
 * red run), so the teardown waits (bounded) until no other session is left on the database.
 */
async function settleConnections(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    for (let i = 0; i < 100; i += 1) {
      const { rows } = await client.query<{ n: string }>(`select count(*)::text as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`);
      if (rows[0]?.n === '0') return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch {
    // Teardown is best effort: the forced drop still follows.
  } finally {
    await client.end().catch(() => undefined);
  }
}
