/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles; prettier reflow detached the per-line directives (AIU-256) */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { ModulesContainer } from '@nestjs/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../bootstrap/api.module.js';
import { runSeed } from '../../database/seed.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../platform/db/test-database.js';
import type { TestDatabase } from '../../platform/db/test-database.js';
import { installJobs } from '../../platform/jobs/test-support.js';
import { createHttpLogging } from '../../platform/logging/index.js';
import { priceTableSeedStep } from '../usage/index.js';

// TASK-060 through the real api composition root (`createApiApp`, the one `main.api.ts` runs) with `fastify.inject` on
// real PostgreSQL: API-130 and API-131, admin only with recent authentication, the 366-day limit, empty state,
// 503 on a failed source, the CSV, its audit event and the no-secret scan, and the 150,000-event time budget. TC-USG-*.

const ORIGIN = 'http://localhost:3000';
const contractsDir = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages',
  'contracts',
);
const sink = new Writable({
  write(_chunk: Buffer, _e, done) {
    done();
  },
});
let testDb: TestDatabase;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof createApiApp>>['app'];
let seq = 0;
const savedEnv: Record<string, string | undefined> = {};

interface Local {
  addUser(sub: string, email: string, verified: boolean): void;
  issueToken(claims: { sub: string; azp: string; fva: [number, number] }): string;
}
let local: Local;

type Validate = ((value: unknown) => boolean) & { errors?: unknown };
function contractValidator(schema: string): Validate {
  const requireFromContracts = createRequire(join(contractsDir, 'package.json'));
  const Ajv2020 = (requireFromContracts('ajv/dist/2020') as { default: new (o: object) => any })
    .default;
  const addFormats = (requireFromContracts('ajv-formats') as { default: (a: unknown) => void })
    .default;
  const yaml = requireFromContracts('js-yaml') as { load(text: string): { components: unknown } };
  const spec = yaml.load(readFileSync(join(contractsDir, 'openapi.yaml'), 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ components: spec.components }, 'spec');
  return ajv.compile({ $ref: `spec#/components/schemas/${schema}` }) as Validate;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ label: 'task060', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 8 });
  const statements = (file: string): string[] =>
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
  for (const statement of statements('0001_task-025-platform.sql')) {
    if (
      /^CREATE (TABLE|INDEX|UNIQUE INDEX) "?(idempotency_records|rate_limit_buckets)/.test(
        statement,
      )
    )
      await pool.query(statement);
  }
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  const files = [
    '0010_task-032-audit.sql',
    '0020_task-033-identity.sql',
    '0030_task-039-provider-keys.sql',
    '0040_task-041-media.sql',
    '0050_task-044-usage.sql',
    '0070_task-046-campaigns.sql',
    '0080_task-048-brief.sql',
    '0090_task-052-production-video.sql',
  ];
  for (const file of files) for (const statement of statements(file)) await pool.query(statement);
  await installJobs(testDb.url);
  await runSeed({
    dataset: 'reference',
    appEnv: 'development',
    databaseUrl: testDb.url,
    steps: [priceTableSeedStep()],
  });
  const env: Record<string, string | undefined> = {
    KEK_PUBLIC_KEYS: undefined,
    R2_ENDPOINT: undefined,
    OWNER_EMAIL: 'owner60@example.test',
    INVITE_EMAIL_DOMAINS: 'example.test',
    CURSOR_SIGNING_KEY: 'k'.repeat(40),
  };
  for (const [name, value] of Object.entries(env)) {
    savedEnv[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  ({ app } = await createApiApp(
    {
      WEB_ORIGIN: ORIGIN,
      APP_ENV: 'development',
      DATABASE_URL: testDb.url,
      DATABASE_POOL_MAX: 8,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      RATE_LIMIT_IP_KEY: 'r'.repeat(40),
    },
    createHttpLogging({ level: 'silent', destination: sink }),
  ));
  const providers = [...app.get(ModulesContainer, { strict: false }).values()].flatMap((m) => [
    ...m.providers.values(),
  ]);
  const found = providers
    .map((p) => p.instance as Partial<Local> | undefined)
    .find((i) => typeof i?.issueToken === 'function');
  if (found === undefined) throw new Error('local identity provider not found');
  local = found as Local;
}, 300_000);

afterAll(async () => {
  await app?.close();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await pool?.end();
  await testDb?.drop();
});

const fastify = () => app.getHttpAdapter().getInstance();
interface Body {
  success: boolean;
  data?: any;
  error?: { code: string; message: string; details?: any[] };
  metaData: any;
}
async function call(url: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
  const res = await fastify().inject({ method: 'GET', url: `/api/v1${url}`, headers });
  return {
    status: res.statusCode,
    raw: res.body,
    headers: res.headers,
    json: () => JSON.parse(res.body) as Body,
  };
}

async function account(admin: boolean) {
  const sub = `user_t60_${String(++seq)}`;
  const email = `p${String(seq)}@example.test`;
  local.addUser(sub, email, true);
  await pool.query(
    `insert into invitations (id, email, expires_at) values (gen_random_uuid(), $1, now() + interval '1 day')`,
    [email],
  );
  const tok = (f: [number, number]) => local.issueToken({ sub, azp: ORIGIN, fva: f });
  expect((await call('/me', tok([1, 1]))).status).toBe(200);
  if (admin) await pool.query(`update users set role = 'admin' where idp_subject = $1`, [sub]);
  const id = (await pool.query(`select id from users where idp_subject = $1`, [sub])).rows[0]
    .id as string;
  return { id, token: tok([1, 1]), stale: tok([30, 30]) };
}

const count = async (action: string): Promise<number> =>
  Number(
    (await pool.query(`select count(*) n from audit_events where action = $1`, [action])).rows[0].n,
  );

const usageRow = (
  owner: string,
  provider: string,
  outcome: string,
  at: string,
  latency: number | null,
) => {
  const basis =
    outcome === 'rejected'
      ? 'zero_rejected'
      : outcome === 'unconfirmed'
        ? 'unconfirmed_estimate'
        : 'estimate';
  return pool.query(
    `insert into usage_events (id, owner_id, provider, operation, job_type, job_id, call_seq, outcome, estimated_cost_usd, cost_basis, latency_ms, at)
     values ($1, $2, $3, 'op', 'video', $4, 1, $5, $6, $7, $8, $9)`,
    [
      randomUUID(),
      owner,
      provider,
      randomUUID(),
      outcome,
      outcome === 'rejected' ? 0 : 0.01,
      basis,
      latency,
      at,
    ],
  );
};

describe('API-130 and API-131 through the api composition root', () => {
  it('denies anonymous (401), a non-admin and a stale-authentication admin (403), auditing the attributable denials', async () => {
    const user = await account(false);
    const admin = await account(true);
    const before = await count('auth.denied');
    for (const path of ['/admin/usage-report', '/admin/usage-report.csv']) {
      expect((await call(path)).status).toBe(401);
      const r = await call(path, user.token);
      expect([r.status, r.json().error?.code]).toEqual([403, 'forbidden_role']);
      const s = await call(path, admin.stale);
      expect([s.status, s.json().error?.code]).toEqual([403, 'recent_auth_required']);
    }
    expect(await count('auth.denied')).toBe(before + 4);
    // The old 16-digit key is not a session token: refused like an anonymous call.
    expect((await call('/admin/usage-report', '1234567890123456')).status).toBe(401);
  });

  it('returns the empty state (empty: true, empty arrays), then the report with counts, p50/p95 and claim checks', async () => {
    const admin = await account(true);
    const owner = admin.id;
    const empty = await call(
      '/admin/usage-report?from=2026-01-01T00:00:00Z&to=2026-01-08T00:00:00Z',
      admin.token,
    );
    expect(empty.status).toBe(200);
    expect(empty.json().data).toMatchObject({
      empty: true,
      accounts: [],
      providers: [],
      jobStates: {},
      claimChecks: [],
    });
    await usageRow(owner, 'openai', 'succeeded', '2026-01-02T00:00:00Z', 100);
    await usageRow(owner, 'openai', 'succeeded', '2026-01-03T00:00:00Z', 300);
    await usageRow(owner, 'openai', 'failed', '2026-01-04T00:00:00Z', null);
    await usageRow(owner, 'wavespeed', 'rejected', '2026-01-05T00:00:00Z', 5);
    await usageRow(owner, 'openai', 'succeeded', '2026-01-08T00:00:00Z', 999); // the upper bound is outside
    await pool.query(
      `insert into claim_events (id, owner_id, brief_id, issue_id, class, outcome, at) values ($1, $2, $3, $4, 'other', 'raised', '2026-01-03T00:00:00Z')`,
      [randomUUID(), owner, randomUUID(), randomUUID()],
    );
    const res = await call(
      '/admin/usage-report?from=2026-01-01T00:00:00Z&to=2026-01-08T00:00:00Z',
      admin.token,
    );
    const body = res.json();
    expect(res.status).toBe(200);
    expect(contractValidator('UsageReportResponse')(body)).toBe(true);
    expect(body.data.empty).toBe(false);
    const openai = body.data.providers.find((p: { provider: string }) => p.provider === 'openai');
    expect(openai).toMatchObject({
      calls: 3,
      succeeded: 2,
      failed: 1,
      estimatedCostUsd: '0.0300',
      latencyP50Ms: 100,
      latencyP95Ms: 300,
    });
    expect(body.data.accounts).toHaveLength(1);
    expect(body.data.accounts[0].userId).toBe(owner);
    expect(body.data.claimChecks).toContainEqual({
      class: 'other',
      raised: 1,
      closedByEdit: 0,
      clearedWithReason: 0,
    });
    expect(Number.isNaN(Date.parse(body.data.asOf))).toBe(false);
    // No email, key, hint or content anywhere in the body (REQ-027).
    expect(res.raw).not.toMatch(/@example\.test|ciphertext|last4|fingerprint|wrapped_dek/);
  });

  it('refuses more than 366 days with 422 report_window_too_large naming the limit, and a bad window with 400', async () => {
    const admin = await account(true);
    const big = await call(
      '/admin/usage-report?from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z',
      admin.token,
    );
    expect([big.status, big.json().error?.code]).toEqual([422, 'report_window_too_large']);
    expect(big.json().error?.message).toContain('366');
    const edge = await call(
      '/admin/usage-report?from=2025-01-01T00:00:00Z&to=2026-01-02T00:00:00Z',
      admin.token,
    );
    expect(edge.status).toBe(200); // 366 days exactly
    const csv = await call(
      '/admin/usage-report.csv?from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z',
      admin.token,
    );
    expect([csv.status, csv.json().error?.code]).toEqual([422, 'report_window_too_large']);
    for (const q of ['from=nope', 'from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z', 'x=1']) {
      const bad = await call(`/admin/usage-report?${q}`, admin.token);
      expect([bad.status, bad.json().error?.code]).toEqual([400, 'validation_failed']);
    }
  });

  it('exports the CSV with the contract header, neutralised cells, an audit event, and no secret', async () => {
    const admin = await account(true);
    await usageRow(admin.id, 'openai', 'succeeded', '2026-02-02T00:00:00Z', 50);
    const before = await count('usage_report.exported');
    const res = await call(
      '/admin/usage-report.csv?from=2026-02-01T00:00:00Z&to=2026-02-08T00:00:00Z',
      admin.token,
    );
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/csv');
    expect(String(res.headers['content-disposition'])).toContain('usage-2026-02-01-2026-02-08.csv');
    const lines = res.raw.trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'user_id,provider,calls,succeeded,failed,rejected,unconfirmed,estimated_cost_usd,latency_p50_ms,latency_p95_ms',
    );
    expect(lines).toContain(`${admin.id},openai,1,1,0,0,0,0.0100,50,50`);
    expect(res.raw).not.toMatch(/@example\.test|ciphertext|last4|fingerprint|wrapped_dek|sk-/);
    expect(await count('usage_report.exported')).toBe(before + 1);
    const event = (
      await pool.query(
        `select actor_id, outcome from audit_events where action = 'usage_report.exported' order by at desc limit 1`,
      )
    ).rows[0];
    expect(event).toEqual({ actor_id: admin.id, outcome: 'allowed' });
    // A refused export leaves no export event.
    await call('/admin/usage-report.csv?from=2020-01-01T00:00:00Z', admin.token);
    expect(await count('usage_report.exported')).toBe(before + 1);
  });

  it('limits the report to 10 a minute and the CSV to 5 a minute per administrator (429)', async () => {
    const admin = await account(true);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1)
      statuses.push((await call('/admin/usage-report', admin.token)).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    const csv: number[] = [];
    for (let i = 0; i < 6; i += 1)
      csv.push((await call('/admin/usage-report.csv', admin.token)).status);
    expect(csv.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(csv[5]).toBe(429);
  });

  it('answers 503 service_unavailable, not zeros, when a data source fails', async () => {
    const admin = await account(true);
    await pool.query('alter table claim_events rename to claim_events_off');
    try {
      const res = await call('/admin/usage-report', admin.token);
      expect([res.status, res.json().error?.code]).toEqual([503, 'service_unavailable']);
      expect(res.raw).not.toContain('claim_events');
      const csv = await call('/admin/usage-report.csv', admin.token);
      expect(csv.status).toBe(503);
    } finally {
      await pool.query('alter table claim_events_off rename to claim_events');
    }
  });

  it('serves a report over 150,000 events within the 2 s budget (p95 recorded)', async () => {
    const admin = await account(true);
    const owners = Array.from({ length: 50 }, () => randomUUID());
    await pool.query(
      `insert into usage_events (id, owner_id, provider, operation, job_type, job_id, call_seq, outcome, estimated_cost_usd, cost_basis, latency_ms, at)
       select gen_random_uuid(), ($1::uuid[])[1 + (g % 50)], (array['openai','wavespeed','assembly_vendor'])[1 + (g % 3)], 'op', 'video',
              gen_random_uuid(), 1, 'succeeded', 0.01, 'estimate', 50 + (g % 900), timestamptz '2025-09-01' + (g % 100000) * interval '1 minute'
         from generate_series(1, 150000) g`,
      [owners],
    );
    const url = '/admin/usage-report?from=2025-08-01T00:00:00Z&to=2026-01-01T00:00:00Z';
    const times: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      // A fresh administrator each time keeps clear of the 10-a-minute limit.
      const a = await account(true);
      const started = performance.now();
      const res = await call(url, a.token);
      times.push(performance.now() - started);
      expect(res.status).toBe(200);
      if (i === 0)
        expect(
          res.json().data.providers.reduce((n: number, p: { calls: number }) => n + p.calls, 0),
        ).toBeGreaterThanOrEqual(150000);
    }
    void admin;
    const sorted = [...times].sort((x, y) => x - y);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
    // Written under the ignored reports folder; the committed evidence quotes the numbers of the submitted run.
    const perfDir = join(import.meta.dirname, '..', '..', '..', 'reports', 'reporting');
    mkdirSync(perfDir, { recursive: true });
    writeFileSync(
      join(perfDir, 'perf.json'),
      `${JSON.stringify({ events: 150000, runs: times.length, p95Ms: Math.round(p95), maxMs: Math.round(sorted.at(-1) ?? 0), budgetMs: 2000 }, null, 2)}\n`,
    );
    expect(p95).toBeLessThan(2000);
  });
});
