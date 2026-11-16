import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Body, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateJobs } from '../../database/jobs-migrate.js';
import { createApiApp } from '../../bootstrap/api.module.js';
import type { ApiApp } from '../../bootstrap/api.module.js';
import { validEnv } from '../config/test-env.js';
import { DATABASE, createDatabase, dbConfigOf } from '../db/index.js';
import type { Database, DbTx } from '../db/index.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../db/test-database.js';
import type { TestDatabase } from '../db/test-database.js';
import { Scope } from '../http/scope-registry.js';
import { createHttpLogging } from '../logging/index.js';
import { RateLimit, RateLimiter } from '../rate-limit/index.js';
import { PLATFORM_CLEANUP, parseIdempotencyKey, requestHash, runPlatformCleanup, withIdempotency } from './index.js';
import type { PlatformCleanup } from './index.js';

// TASK-027 on real PostgreSQL, through the real api composition root (createApiApp): the general IP limit, the
// per-route limit, idempotent creation (replay, conflict, concurrent same key) and the platform.cleanup handler.

const OWNER = '00000000-0000-4000-8000-0000000000aa';
let testDb: TestDatabase;
let direct: pg.Pool;
let created = 0;

@Controller('jobs')
@Scope('Pub')
class JobsProbe {
  constructor() {}
  @Post()
  @HttpCode(202)
  @RateLimit('job-create')
  async create(
    @Headers('idempotency-key') header: string | undefined,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{ id: string; replayed: boolean }> {
    const key = parseIdempotencyKey(header);
    const database = state.database as Database;
    const out = await database.uow.run((tx: DbTx) =>
      withIdempotency(
        tx,
        { ownerId: OWNER, operationId: 'API-024', key, requestHash: requestHash('POST', request.url, body) },
        { resourceType: 'job', responseStatus: 202 },
        async () => {
          created += 1;
          await new Promise((resolve) => setTimeout(resolve, 150));
        },
      ),
    );
    return { id: out.resourceId, replayed: out.replayed };
  }
}
const state: { database?: Database } = {};

let api: ApiApp;
const post = (key: string | undefined, body: unknown, ip = '198.51.100.1') =>
  api.app.inject({
    method: 'POST',
    url: '/api/v1/jobs',
    headers: { 'x-forwarded-for': ip, ...(key === undefined ? {} : { 'idempotency-key': key }) },
    payload: body as object,
  });

beforeAll(async () => {
  // M0001 needs the provisioned roles (TASK-025's grants suite covers it whole); here only the DDL of the two
  // tables this ticket owns is taken from that real migration file.
  testDb = await createTestDatabase({ label: 'task027', migrations: false });
  direct = new pg.Pool({ connectionString: testDb.url, max: 2 });
  const ddl = readFileSync(`${REAL_MIGRATIONS}/0001_task-025-platform.sql`, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => /^(CREATE TABLE|CREATE INDEX) "(idempotency_records|rate_limit_buckets)/.test(statement) || /^CREATE INDEX "idempotency_records_expiry_idx"/.test(statement));
  expect(ddl).toHaveLength(3);
  for (const statement of ddl) await direct.query(statement);
  // The api fails closed without the pg-boss schema and queues (release order: db:migrate, then jobs:migrate).
  await direct.query('CREATE SCHEMA pgboss');
  await migrateJobs(testDb.url, undefined, null);
  const config = {
    ...validEnv('api', { DATABASE_URL: testDb.url }),
  };
  const edge = {
    APP_ENV: 'development' as const,
    WEB_ORIGIN: 'http://localhost:3000',
    DATABASE_URL: testDb.url,
    DATABASE_POOL_MAX: 6,
    DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
    RATE_LIMIT_IP_KEY: config['RATE_LIMIT_IP_KEY'],
    TRUST_PROXY_HOPS: 1,
    JOB_CREATE_RATE_LIMIT: 3,
    JOB_CREATE_RATE_WINDOW_MIN: 10,
  };
  api = await createApiApp(edge, createHttpLogging({ level: 'silent' }), [JobsProbe]);
  state.database = api.app.get<Database>(DATABASE);
});

afterAll(async () => {
  await api?.app.close();
  await direct?.end();
  await testDb?.drop();
});

describe('idempotent creation through the running app', () => {
  it('requires the header', async () => {
    const res = await post(undefined, { a: 1 }, '198.51.100.10');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
  });

  it('replays the stored resource for the same key and body; one resource created', async () => {
    const first = await post('k-replay', { b: 2, a: 1 }, '198.51.100.11');
    const second = await post('k-replay', { a: 1, b: 2 }, '198.51.100.11');
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json().data).toEqual({ id: first.json().data.id, replayed: true });
    expect(created).toBe(1);
  });

  it('is 409 idempotency_key_reused for the same key and another body', async () => {
    await post('k-conflict', { a: 1 }, '198.51.100.12');
    const res = await post('k-conflict', { a: 2 }, '198.51.100.12');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('idempotency_key_reused');
  });

  it('creates one resource for concurrent same-key requests', async () => {
    const before = created;
    const results = await Promise.all(Array.from({ length: 3 }, () => post('k-concurrent', { x: 1 }, '198.51.100.13')));
    expect(results.map((r) => r.statusCode)).toEqual([202, 202, 202]);
    expect(new Set(results.map((r) => r.json().data.id)).size).toBe(1);
    expect(results.filter((r) => r.json().data.replayed === false)).toHaveLength(1);
    expect(created - before).toBe(1);
    const rows = await direct.query("select count(*)::int as n from idempotency_records where key = 'k-concurrent'");
    expect(rows.rows[0].n).toBe(1);
  });

  it('keeps the record out of the database when the creating transaction rolls back', async () => {
    const database = state.database as Database;
    await expect(
      database.uow.run(async (tx) => {
        await withIdempotency(tx, { ownerId: OWNER, operationId: 'API-024', key: 'k-rollback', requestHash: requestHash('POST', '/x', {}) }, { resourceType: 'job', responseStatus: 202 }, async () => {
          throw new Error('boom');
        });
      }),
    ).rejects.toThrow('boom');
    const rows = await direct.query("select 1 from idempotency_records where key = 'k-rollback'");
    expect(rows.rowCount).toBe(0);
  });

  it('treats an expired record as absent', async () => {
    await direct.query(
      `insert into idempotency_records values ($1, 'API-024', 'k-old', $2, 'job', $3, 202, now() - interval '1 minute')`,
      [OWNER, requestHash('POST', '/x', { old: true }), randomUUID()],
    );
    const res = await post('k-old', { fresh: true }, '198.51.100.14');
    expect(res.statusCode).toBe(202);
    expect(res.json().data.replayed).toBe(false);
  });

  it('stores a 24 hour expiry', async () => {
    const rows = await direct.query(
      "select extract(epoch from (expires_at - now()))/3600 as hours from idempotency_records where key = 'k-replay'",
    );
    expect(Number(rows.rows[0].hours)).toBeGreaterThan(23.9);
    expect(Number(rows.rows[0].hours)).toBeLessThanOrEqual(24);
  });
});

describe('rate limits through the running app', () => {
  it('refuses the request after the per-route limit with 429 and Retry-After, per client IP', async () => {
    const ip = '198.51.100.20';
    for (let n = 0; n < 3; n++) expect((await post(`k-rl-${n}`, { n }, ip)).statusCode).toBe(202);
    const res = await post('k-rl-3', { n: 3 }, ip);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
    const wait = Number(res.headers['retry-after']);
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(600);
    expect((await post('k-rl-other', { n: 9 }, '198.51.100.21')).statusCode).toBe(202);
    const stored = await direct.query("select subject from rate_limit_buckets where scope = 'job-create'");
    expect(stored.rows.every((r: { subject: string }) => /^[0-9a-f]{64}$/.test(r.subject))).toBe(true);
  });

  it('refuses the 61st unauthenticated request in a window with 429', async () => {
    const ip = '198.51.100.30';
    let refused: Awaited<ReturnType<typeof post>> | undefined;
    for (let n = 0; n < 61 && refused === undefined; n++) {
      const res = await post(undefined, {}, ip);
      if (res.statusCode === 429) refused = res;
    }
    expect(refused).toBeDefined();
    expect(refused?.headers['retry-after']).toBeDefined();
  });

  it('does not rate limit the health probe', async () => {
    for (let n = 0; n < 70; n++) {
      expect((await api.app.inject({ method: 'GET', url: '/health/live', headers: { 'x-forwarded-for': '198.51.100.40' } })).statusCode).toBe(200);
    }
  });

  it('is 503 service_unavailable, not a pass-through, when the database is unavailable', async () => {
    const dead = createDatabase(dbConfigOf({ DATABASE_URL: 'postgres://postgres@127.0.0.1:9/none', DATABASE_POOL_MAX: 1, DATABASE_ACQUIRE_TIMEOUT_MS: 300 } as never));
    const limiter = new RateLimiter(dead.db);
    await expect(limiter.consume('s', 'u', 5, 60)).rejects.toMatchObject({ code: 'service_unavailable', status: 503 });
    await dead.close().catch(() => undefined);
  });

  it('counts each request in one fixed-window row', async () => {
    const limiter = new RateLimiter((state.database as Database).db, () => Date.UTC(2026, 5, 1, 12, 0, 30));
    for (let n = 1; n <= 4; n++) expect((await limiter.consume('tc-rlm', 'edge', 3, 60)).allowed).toBe(n <= 3);
    const rows = await direct.query("select count, window_start from rate_limit_buckets where scope = 'tc-rlm'");
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].count).toBe(4);
    expect(new Date(rows.rows[0].window_start).toISOString()).toBe('2026-06-01T12:00:00.000Z');
    const next = new RateLimiter((state.database as Database).db, () => Date.UTC(2026, 5, 1, 12, 1, 0));
    expect((await next.consume('tc-rlm', 'edge', 3, 60)).allowed).toBe(true);
  });
});

describe('platform.cleanup', () => {
  it('removes expired records and buckets older than a day only', async () => {
    await direct.query("delete from idempotency_records; delete from rate_limit_buckets;");
    const hash = requestHash('POST', '/x', {});
    const ins = (key: string, expiry: string) =>
      direct.query(`insert into idempotency_records values ($1, 'API-024', $2, $3, 'job', $4, 202, ${expiry})`, [OWNER, key, hash, randomUUID()]);
    await ins('expired', "now() - interval '1 second'");
    await ins('live', "now() + interval '1 hour'");
    const bucket = (subject: string, age: string) =>
      direct.query(`insert into rate_limit_buckets values ('s', $1, now() - interval '${age}', 1)`, [subject]);
    await bucket('old', '25 hours');
    await bucket('recent', '23 hours');
    const handler = api.app.get<PlatformCleanup>(PLATFORM_CLEANUP);
    expect(await handler()).toEqual({ idempotencyRecords: 1, rateLimitBuckets: 1 });
    expect((await direct.query('select key from idempotency_records')).rows).toEqual([{ key: 'live' }]);
    expect((await direct.query('select subject from rate_limit_buckets')).rows).toEqual([{ subject: 'recent' }]);
    expect(await runPlatformCleanup((state.database as Database).db)).toEqual({ idempotencyRecords: 0, rateLimitBuckets: 0 });
  });
});
