import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Controller, Get, Query } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validEnv } from '../config/test-env.js';
import { installJobs } from '../jobs/test-support.js';
import { buildPage, decodeCursor } from './cursor.js';
import { ZodValidationPipe } from './validation.pipe.js';
import { createTestApp } from './test-support.js';

// TASK-022: the envelope, error filter and validation run in the built apps/api/dist/main.api.js (real entry
// point); the SQLSTATE mapping and cursor paging run on a uniquely named database of the shared test PostgreSQL.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const apiDir = join(import.meta.dirname, '..', '..', '..');
const adminUrl =
  process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgres://postgres@test-db:5432/postgres';
const database = `task022_${randomBytes(4).toString('hex')}`;
const PORT = 3942;
const KEY = 'c'.repeat(40);
const OWNER = '0198a5e0-0000-7000-8000-0000000000aa';
let pool: pg.Pool;
let child: ChildProcess;
let stderr = '';
let app: NestFastifyApplication;

@Controller('db')
class DbController {
  @Get('slow')
  async slow(): Promise<unknown> {
    const client = await pool.connect();
    try {
      await client.query("SET statement_timeout = '50ms'");
      return await client.query('SELECT pg_sleep(2)');
    } finally {
      await client.query('RESET statement_timeout').catch(() => undefined);
      client.release();
    }
  }

  @Get('locked')
  async locked(): Promise<unknown> {
    const holder = await pool.connect();
    const waiter = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE items IN ACCESS EXCLUSIVE MODE');
      await waiter.query("SET lock_timeout = '50ms'");
      return await waiter.query('SELECT count(*) FROM items');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      waiter.release();
    }
  }

  @Get('items')
  async items(
    @Query(new ZodValidationPipe(z.object({ limit: z.coerce.number().int().min(1).max(50), cursor: z.string().optional() })))
    q: { limit: number; cursor?: string },
  ): Promise<unknown> {
    const scope = { owner: OWNER, filters: { sort: 'seq' } };
    const after = q.cursor === undefined ? -1 : Number(decodeCursor(KEY, q.cursor, scope));
    const { rows } = await pool.query<{ seq: number }>(
      'SELECT seq FROM items WHERE seq > $1 ORDER BY seq LIMIT $2',
      [after, q.limit + 1],
    );
    return buildPage(rows, q.limit, (r) => String(r.seq), KEY, scope);
  }
}

async function waitForLive(): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health/live`)).ok) return;
    } catch {
      if (Date.now() > deadline) throw new Error(`api did not start: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

beforeAll(async () => {
  const build = spawnSync('pnpm', ['build'], { cwd: apiDir, encoding: 'utf8' });
  expect(build.status, build.stdout + build.stderr).toBe(0);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  await installJobs(url.toString());
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  await pool.query('CREATE TABLE items (seq int PRIMARY KEY)');
  await pool.query('INSERT INTO items SELECT generate_series(1, 11)');
  child = spawn('node', ['dist/main.api.js'], {
    cwd: apiDir,
    env: {
      PATH: process.env['PATH'] ?? '',
      ...validEnv('api', { DATABASE_URL: url.toString(), API_PORT: String(PORT) }),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  await waitForLive();
  ({ app } = await createTestApp([DbController]));
});

afterAll(async () => {
  child?.kill('SIGTERM');
  await app?.close();
  await pool?.end();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
});

const base = `http://127.0.0.1:${PORT}`;

describe('main.api.js (real entry point)', () => {
  it('answers an unknown route with the 404 envelope and the request ID of the header', async () => {
    const res = await fetch(`${base}/nowhere`, { headers: { 'X-Request-ID': 'req-integration-1' } });
    const body = (await res.json()) as Json;
    expect(res.status).toBe(404);
    expect(body['success']).toBe(false);
    expect(body['error']['code']).toBe('not_found');
    expect(body['metaData']['requestId']).toBe('req-integration-1');
    expect(res.headers.get('x-request-id')).toBe('req-integration-1');
  });

  it('answers a method with no route 405 with Allow, before the body is read (TASK-023)', async () => {
    const bad = await fetch(`${base}/health/live`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(bad.status).toBe(405);
    expect(bad.headers.get('allow')).toBe('GET, HEAD');
    expect(((await bad.json()) as Json)['error']['code']).toBe('method_not_allowed');
    const unknown = await fetch(`${base}/nope`, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: '<a/>' });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as Json)['error']['code']).toBe('not_found');
  });

  it('leaves the liveness probe raw', async () => {
    expect(await (await fetch(`${base}/health/live`)).json()).toMatchObject({ success: true, data: { status: 'ok' } });
  });
});

describe('real PostgreSQL through the filter and pipe', () => {
  it('statement timeout (57014) gives 503 service_unavailable without details', async () => {
    const res = await app.inject({ method: 'GET', url: '/db/slow' });
    const body = JSON.parse(res.body) as Json;
    expect(res.statusCode).toBe(503);
    expect(body['error']['code']).toBe('service_unavailable');
    expect(body['error']).not.toHaveProperty('details');
  });

  it('lock timeout (55P03) gives 503 service_unavailable', async () => {
    const res = await app.inject({ method: 'GET', url: '/db/locked' });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)['error']['code']).toBe('service_unavailable');
  });

  it('page size 10 over 11 rows gives two pages with no repeat and no gap; a bad cursor is a 400', async () => {
    const first = JSON.parse((await app.inject({ method: 'GET', url: '/db/items?limit=10' })).body);
    expect(first.data.map((r: { seq: number }) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(first.metaData.pagination).toMatchObject({ hasNextPage: true, returnedCount: 10 });
    const cursor = encodeURIComponent(first.metaData.pagination.nextCursor);
    const second = JSON.parse((await app.inject({ method: 'GET', url: `/db/items?limit=10&cursor=${cursor}` })).body);
    expect(second.data).toEqual([{ seq: 11 }]);
    expect(second.metaData.pagination).toMatchObject({ hasNextPage: false, nextCursor: null });
    const bad = await app.inject({ method: 'GET', url: '/db/items?limit=10&cursor=tampered.value' });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).error.details[0]).toMatchObject({ field: 'cursor', code: 'cursor_invalid' });
  });
});
