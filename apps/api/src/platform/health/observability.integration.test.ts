import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validEnv } from '../config/test-env.js';
import { installJobs } from '../jobs/test-support.js';

// TASK-061: API-900..903 through the built apps/api/dist/main.api.js (the real entry point) against the shared test
// PostgreSQL, validated against OpenAPI design.5 (packages/contracts/openapi.yaml). TC-OPS-01, TC-OPS-10.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const apiDir = join(import.meta.dirname, '..', '..', '..');
const contractsDir = join(apiDir, '..', '..', 'packages', 'contracts');
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgres://postgres@test-db:5432/postgres';
const suffix = randomBytes(4).toString('hex');
const database = `task061_${suffix}`;
const METRICS = 'm'.repeat(20) + 'T'.repeat(30);
const SESSION_LIKE = 'eyJhbGciOiJSUzI1NiJ9.e30.c2lnbmF0dXJl';
let databaseUrl = '';

interface Running {
  child: ChildProcess;
  base: string;
  stderr: () => string;
}
const running: Running[] = [];

async function start(port: number, env: Record<string, string>): Promise<Running> {
  let err = '';
  const child = spawn('node', ['dist/main.api.js'], {
    cwd: apiDir,
    env: { PATH: process.env['PATH'] ?? '', ...validEnv('api', { DATABASE_URL: databaseUrl, API_PORT: String(port), ...env }) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
  const entry = { child, base: `http://127.0.0.1:${port}`, stderr: () => err };
  running.push(entry);
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${entry.base}/health/live`)).ok) return entry;
    } catch {
      if (Date.now() > deadline) throw new Error(`api did not start: ${err}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

type Validate = ((value: unknown) => boolean) & { errors?: unknown };
function contractValidator(schema: string): Validate {
  const requireFromContracts = createRequire(join(contractsDir, 'package.json'));
  const Ajv2020 = (requireFromContracts('ajv/dist/2020') as { default: new (o: object) => any }).default; // eslint-disable-line @typescript-eslint/no-explicit-any
  const addFormats = (requireFromContracts('ajv-formats') as { default: (a: unknown) => void }).default;
  const yaml = requireFromContracts('js-yaml') as { load(text: string): Json };
  const spec = yaml.load(readFileSync(join(contractsDir, 'openapi.yaml'), 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ components: spec['components'] }, 'spec');
  return ajv.compile({ $ref: `spec#/components/schemas/${schema}` }) as Validate;
}

async function body(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

let api: Running;
let noToken: Running;

beforeAll(async () => {
  const build = spawnSync('pnpm', ['build'], { cwd: apiDir, encoding: 'utf8' });
  expect(build.status, build.stdout + build.stderr).toBe(0);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  databaseUrl = url.toString();
  await installJobs(databaseUrl);
  api = await start(3951, { METRICS_TOKEN: METRICS });
  noToken = await start(3952, { MIN_SCHEMA_HEAD: '99' });
});

afterAll(async () => {
  for (const { child } of running) child.kill('SIGKILL');
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
});

describe('API-900 / API-901 (public)', () => {
  it('answers live with the enveloped HealthResponse and ignores any Authorization header', async () => {
    const validate = contractValidator('HealthResponse');
    for (const headers of [{}, { authorization: `Bearer ${METRICS}` }, { authorization: 'Bearer junk' }]) {
      const res = await fetch(`${api.base}/health/live`, { headers });
      expect(res.status).toBe(200);
      const json = await body(res);
      expect(json['data']).toEqual({ status: 'ok' });
      expect(validate(json), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it('answers ready 200 when the database, pg-boss and the schema head are fine', async () => {
    const res = await fetch(`${api.base}/health/ready`);
    expect(res.status).toBe(200);
    const json = await body(res);
    expect(contractValidator('HealthResponse')(json)).toBe(true);
    expect(JSON.stringify(json)).not.toMatch(/database|queue|schema/i);
  });

  it('answers ready 503 service_unavailable, with no detail, when the schema head is outside the range; live stays 200', async () => {
    const res = await fetch(`${noToken.base}/health/ready`);
    expect(res.status).toBe(503);
    const json = await body(res);
    expect(json['error']['code']).toBe('service_unavailable');
    expect(json['error']['details']).toBeUndefined();
    expect(JSON.stringify(json)).not.toMatch(/schema|head|database/i);
    expect((await fetch(`${noToken.base}/health/live`)).status).toBe(200);
  });

  it('answers ready 503 while draining after SIGTERM, then exits', async () => {
    const drain = await start(3953, { API_DRAIN_SECONDS: '3' });
    expect((await fetch(`${drain.base}/health/ready`)).status).toBe(200);
    const exited = new Promise((resolve) => drain.child.once('exit', resolve));
    drain.child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await fetch(`${drain.base}/health/ready`)).status).toBe(503);
    await exited;
  });
});

describe('API-902 / API-903 (scope M, TC-OPS-10)', () => {
  const unknown = async (res: Response): Promise<void> => {
    expect(res.status).toBe(404);
    const json = await body(res);
    expect(json).toMatchObject({ success: false, error: { code: 'not_found', message: 'Not found.' } });
  };
  const wrong: [string, Record<string, string>][] = [
    ['no token', {}],
    ['a wrong token', { authorization: `Bearer ${'x'.repeat(50)}` }],
    ['a prefix of the token', { authorization: `Bearer ${METRICS.slice(0, 30)}` }],
    ['an empty token', { authorization: 'Bearer ' }],
    ['a session token', { authorization: `Bearer ${SESSION_LIKE}` }],
    ['the token without the scheme', { authorization: METRICS }],
  ];

  for (const path of ['/internal/metrics', '/internal/metrics/window']) {
    for (const [name, headers] of wrong) {
      it(`${path} answers the unknown-path 404 for ${name}`, async () => unknown(await fetch(`${api.base}${path}`, { headers })));
    }
    it(`${path} answers 404 for every request when METRICS_TOKEN is unset`, async () => {
      await unknown(await fetch(`${noToken.base}${path}`, { headers: { authorization: `Bearer ${METRICS}` } }));
      await unknown(await fetch(`${noToken.base}${path}`));
    });
  }

  it('serves the Prometheus exposition with the right token, bounded labels and no IDs', async () => {
    await fetch(`${api.base}/api/v1/nowhere/0198a5e0-0000-7000-8000-000000000001`);
    const res = await fetch(`${api.base}/internal/metrics`, { headers: { authorization: `Bearer ${METRICS}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(text).toContain('telemetry_dropped_total 0');
    expect(text).toContain('db_pool_size');
    expect(text).toContain('pgboss_send_failures_total 0');
    expect(text).not.toContain('0198a5e0');
    expect(text).not.toContain(METRICS);
    expect(text).not.toContain('health/live');
  });

  it('serves a MetricsWindowResponse valid against OpenAPI design.5, not counting the probes or itself', async () => {
    const validate = contractValidator('MetricsWindowResponse');
    const read = async (): Promise<Json> => {
      const res = await fetch(`${api.base}/internal/metrics/window`, { headers: { authorization: `Bearer ${METRICS}` } });
      expect(res.status).toBe(200);
      return body(res);
    };
    const first = await read();
    expect(validate(first), JSON.stringify(validate.errors)).toBe(true);
    expect(first['data']['windows'].map((w: Json) => w['minutes'])).toEqual([10, 15]);
    expect(first['data']['telemetryDropped10m']).toBe(0);
    expect(first['data']['telemetryDroppedTotal']).toBe(0);
    expect(first['data']['poolWait']['minutes']).toBe(10);
    await fetch(`${api.base}/health/live`);
    await fetch(`${api.base}/health/ready`);
    const second = await read();
    expect(second['data']['windows'][0]['requests']).toBe(first['data']['windows'][0]['requests']);
    await fetch(`${api.base}/api/v1/nowhere`);
    const third = await read();
    expect(third['data']['windows'][0]['requests']).toBe(first['data']['windows'][0]['requests'] + 1);
    expect(third['data']['processStartedAt']).toBe(first['data']['processStartedAt']);
    expect(api.stderr()).not.toContain(METRICS);
  });
});

describe('API-901 with the database gone', () => {
  it('answers 503 while live stays 200', async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
    const ready = await fetch(`${api.base}/health/ready`);
    expect(ready.status).toBe(503);
    expect((await body(ready))['error']['code']).toBe('service_unavailable');
    expect((await fetch(`${api.base}/health/live`)).status).toBe(200);
  });
});
