import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../bootstrap/api.module.js';
import { REAL_MIGRATIONS, adminUrl, createTestDatabase } from '../../platform/db/test-database.js';
import type { TestDatabase } from '../../platform/db/test-database.js';
import { DATABASE } from '../../platform/db/index.js';
import type { Database } from '../../platform/db/index.js';
import { DomainError } from '../../platform/http/domain-error.js';
import { createHttpLogging } from '../../platform/logging/index.js';
import type { BillableCall } from './domain/types.js';
import { UsageService } from './index.js';
import { AbuseMonitor } from './application/abuse.js';
import { UsageAggregator } from './application/aggregate.js';

// TASK-044 (usage 1/2) on real PostgreSQL: M0006 as written, its grants, the price table seed, the cap, the reservation
// lifecycle and the start-up price check, reached through the real api composition root (`createApiApp`, the one
// `main.api.ts` runs). A stub provider stands in for every paid call: no slice calls a paid provider before TC-CAP-04.

const U1 = '0197a1b2-0000-7000-8000-000000000001';
const U2 = '0197a1b2-0000-7000-8000-000000000002';
const U3 = '0197a1b2-0000-7000-8000-000000000003';
const U4 = '0197a1b2-0000-7000-8000-000000000004';
const U5 = '0197a1b2-0000-7000-8000-000000000005';
const CHEAP: BillableCall = { provider: 'openai', operation: 'cap-test-cheap' };

let testDb: TestDatabase;
let pool: pg.Pool;
let apiApp: Awaited<ReturnType<typeof createApiApp>>['app'];
let usage: UsageService;
let database: Database;
const roleNames = { api: '', worker: '' };
const rolePasswords = { api: '', worker: '' };
const savedEnv: Record<string, string | undefined> = {};

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function statementsOf(file: string, part: 'tables' | 'grants'): string[] {
  const text = readFileSync(join(REAL_MIGRATIONS, file), 'utf8');
  const [tables = '', grants = ''] = text.split('-- Grants');
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

beforeAll(async () => {
  testDb = await createTestDatabase({ label: 'task045', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 3 });
  const suffix = randomBytes(4).toString('hex');
  for (const role of ['api', 'worker'] as const) {
    roleNames[role] = `app_${role}_t045_${suffix}`;
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
  for (const file of ['0010_task-032-audit.sql', '0020_task-033-identity.sql', '0050_task-044-usage.sql']) {
    for (const statement of statementsOf(file, 'tables')) await pool.query(statement);
  }
  for (const statement of statementsOf('0050_task-044-usage.sql', 'grants')) await pool.query(statement);
  await pool.query(`GRANT USAGE ON SCHEMA public TO "${roleNames.api}", "${roleNames.worker}"`);
  const { installJobs } = await import('../../platform/jobs/test-support.js');
  await installJobs(testDb.url);
  for (const [n, id] of [['1', U1], ['2', U2], ['3', U3], ['4', U4], ['5', U5]] as const) {
    await pool.query(`INSERT INTO users (id, idp_subject, email, linked_via) VALUES ($1, $2, $3, 'first_admin')`, [id, `sub_${n}`, `u${n}@example.test`]);
  }
  // Rows of the price table the tests use, besides the file's own (seeded below through the release seed step).
  await pool.query(
    `INSERT INTO price_table (provider, operation, effective_from, unit, unit_price_usd, units_per_call) VALUES
       ('openai', 'cap-test-model', '2026-01-01', 'call', 0.25, 1),
       ('openai', 'cap-test-cheap', '2026-01-01', 'call', 0.01, 1),
       ('openai', 'cap-test-cheap', '2999-01-01', 'call', 9, 1)`,
  );
  const env: Record<string, string | undefined> = {
    KEK_PUBLIC_KEYS: undefined,
    KEK_PRIVATE_KEYS: undefined,
    R2_ENDPOINT: undefined,
    SPEND_CAP_DAILY_USD: '1',
    SPEND_CAP_MONTHLY_USD: '500',
    OPENAI_TEXT_MODEL: undefined,
    OPENAI_VISION_MODEL: undefined,
    OPENAI_IMAGE_MODEL: undefined,
    OPENAI_TRANSCRIBE_MODEL: undefined,
    WAVESPEED_MODEL_I2V: undefined,
    WAVESPEED_MODEL_T2V: undefined,
    ASSEMBLY_ADAPTER: undefined,
  };
  for (const [name, value] of Object.entries(env)) {
    savedEnv[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  ({ app: apiApp } = await createApiApp(
    {
      WEB_ORIGIN: 'http://localhost:3000',
      APP_ENV: 'development',
      DATABASE_URL: testDb.url,
      DATABASE_POOL_MAX: 12,
      DATABASE_ACQUIRE_TIMEOUT_MS: 15000,
      RATE_LIMIT_IP_KEY: 'r'.repeat(40),
    },
    createHttpLogging({ level: 'silent' }),
  ));
  usage = apiApp.get(UsageService, { strict: false });
  database = apiApp.get<Database>(DATABASE, { strict: false });
}, 300_000);

afterAll(async () => {
  await apiApp?.close();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await pool?.end();
  await testDb?.drop();
  for (const name of Object.values(roleNames)) {
    if (name !== '') await withClient(adminUrl(), (c) => c.query(`DROP ROLE IF EXISTS "${name}"`)).catch(() => undefined);
  }
});


// TASK-045 (usage 2/2) on real PostgreSQL through the real api composition root (`createApiApp`, the one `main.api.ts`
// runs): abuse thresholds raising alerts through the audit module's AlertPort, and the usage aggregate.

const uuid = (n: number): string => `0197a1b2-0000-7000-a000-${n.toString(16).padStart(12, '0')}`;
const monitor = (): AbuseMonitor => apiApp.get(AbuseMonitor, { strict: false });
const alertsOf = async (kind: string, owner: string): Promise<number> =>
  Number((await pool.query(`SELECT count(*) AS n FROM admin_alerts WHERE kind = $1 AND subject_user_id = $2`, [kind, owner])).rows[0]?.n);

async function reservations(owner: string, from: number, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await database.uow.run((tx) => usage.reserve(tx, { ownerId: owner, jobType: 'brief_generation', jobId: uuid(from + i), calls: [CHEAP] }));
  }
}

describe('abuse thresholds through the running app (TC-ALR-01..03)', () => {
  it('raises one job_burst alert for 21 jobs in 10 minutes, once even when checked again, and none at 20', async () => {
    await reservations(U1, 1, 20);
    expect(await monitor().checkAbuseThresholds(U1)).toMatchObject({ jobs: 20, jobBurst: false });
    expect(await alertsOf('job_burst', U1)).toBe(0);
    await reservations(U1, 21, 1);
    expect(await monitor().checkAbuseThresholds(U1)).toMatchObject({ jobs: 21, jobBurst: true });
    expect((await monitor().checkAbuseThresholds(U1)).jobBurst).toBe(false);
    expect(await alertsOf('job_burst', U1)).toBe(1);
    const row = (await pool.query(`SELECT counts FROM admin_alerts WHERE kind = 'job_burst' AND subject_user_id = $1`, [U1])).rows[0] as { counts: unknown };
    expect(row.counts).toEqual({ jobs: 21, window_min: 10 });
  });

  it('counts jobs from usage events too and ignores jobs older than the window', async () => {
    for (let i = 0; i < 21; i += 1) {
      await pool.query(
        `INSERT INTO usage_events (id, owner_id, provider, operation, job_type, job_id, call_seq, outcome, estimated_cost_usd, cost_basis, at)
         VALUES ($1, $2, 'openai', 'm', 'video', $3, 1, 'succeeded', 0.1, 'estimate', now() - interval '11 minutes')`,
        [crypto.randomUUID(), U2, uuid(100 + i)],
      );
    }
    expect(await monitor().checkAbuseThresholds(U2)).toMatchObject({ jobs: 0, jobBurst: false });
  });

  it('raises one provider_auth_spike alert at 5 provider 401/429 responses and none at 4', async () => {
    for (let i = 0; i < 4; i += 1) monitor().noteProviderAuthResponse(U3, i % 2 === 0 ? 401 : 429);
    expect((await monitor().checkAbuseThresholds(U3)).providerAuthSpike).toBe(false);
    expect(await alertsOf('provider_auth_spike', U3)).toBe(0);
    monitor().noteProviderAuthResponse(U3, 429);
    expect(await monitor().checkAbuseThresholds(U3)).toMatchObject({ providerAuthSpike: true, authResponses: 5 });
    expect(await alertsOf('provider_auth_spike', U3)).toBe(1);
  });
});

describe('aggregate through the running app (TC-USG)', () => {
  const aggregator = (): UsageAggregator => apiApp.get(UsageAggregator, { strict: false });
  const insert = (owner: string, provider: string, job: string, seq: number, outcome: string, cost: string, latency: number | null, daysAgo = 0) =>
    pool.query(
      `INSERT INTO usage_events (id, owner_id, provider, operation, job_type, job_id, call_seq, outcome, estimated_cost_usd, cost_basis, latency_ms, at)
       VALUES ($1, $2, $3, 'm', 'video', $4, $5, $6, $7, $8, $9, now() - make_interval(days => $10) - interval '1 hour')`,
      [crypto.randomUUID(), owner, provider, job, seq, outcome, cost, outcome === 'rejected' ? 'zero_rejected' : outcome === 'unconfirmed' ? 'unconfirmed_estimate' : 'estimate', latency, daysAgo],
    );

  it('is empty (not zeros) for an account-less window, then sums per account and provider without personal data', async () => {
    expect((await aggregator().aggregate()).rows.filter((r) => r.ownerId === U4)).toEqual([]);
    await insert(U4, 'openai', uuid(300), 1, 'succeeded', '0.2500', 100);
    await insert(U4, 'openai', uuid(300), 2, 'failed', '0.2500', 300);
    await insert(U4, 'openai', uuid(301), 1, 'succeeded', '0.5000', null);
    await insert(U4, 'wavespeed', uuid(302), 1, 'rejected', '0', 50);
    await insert(U4, 'openai', uuid(303), 1, 'succeeded', '9.0000', 10, 40);
    const result = await aggregator().aggregate();
    const mine = result.rows.filter((r) => r.ownerId === U4);
    expect(mine).toEqual([
      { ownerId: U4, provider: 'openai', calls: 3, successes: 2, failures: 1, rejected: 0, unconfirmed: 0, estimatedCostUsd: '1.0000', averageLatencyMs: 200,
        jobStates: { succeeded: 1, failed: 1, rejected: 0, unconfirmed: 0 } },
      { ownerId: U4, provider: 'wavespeed', calls: 1, successes: 0, failures: 0, rejected: 1, unconfirmed: 0, estimatedCostUsd: '0.0000', averageLatencyMs: 50,
        jobStates: { succeeded: 0, failed: 0, rejected: 1, unconfirmed: 0 } },
    ]);
    expect(JSON.stringify(result)).not.toContain('example.test');
    const wide = await aggregator().aggregate(60);
    expect(wide.rows.find((r) => r.ownerId === U4 && r.provider === 'openai')?.calls).toBe(4);
  });

  it('refuses a window above 366 days at the service naming the limit', async () => {
    const error = await aggregator().aggregate(367).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('report_window_too_large');
    expect(JSON.stringify((error as DomainError).details)).toContain('366');
    expect((await aggregator().aggregate(366)).rows).toBeDefined();
  });
});
