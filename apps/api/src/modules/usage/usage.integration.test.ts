import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiApp } from '../../bootstrap/api.module.js';
import { runSeed } from '../../database/seed.js';
import { REAL_MIGRATIONS, adminUrl, createTestDatabase } from '../../platform/db/test-database.js';
import type { TestDatabase } from '../../platform/db/test-database.js';
import { DATABASE } from '../../platform/db/index.js';
import type { Database } from '../../platform/db/index.js';
import { DomainError } from '../../platform/http/domain-error.js';
import { createHttpLogging } from '../../platform/logging/index.js';
import { toUnits } from './domain/money.js';
import type { BillableCall } from './domain/types.js';
import { UsageModule, UsageService } from './index.js';
import { USAGE_CONFIG, USAGE_REPOSITORY } from './application/ports.js';
import type { UsageConfig, UsageRepository } from './application/ports.js';
import { priceTableSeedStep } from './infrastructure/price-table-file.js';

// TASK-044 (usage 1/2) on real PostgreSQL: M0006 as written, its grants, the price table seed, the cap, the reservation
// lifecycle and the start-up price check, reached through the real api composition root (`createApiApp`, the one
// `main.api.ts` runs). A stub provider stands in for every paid call: no slice calls a paid provider before TC-CAP-04.

const U1 = '0197a1b2-0000-7000-8000-000000000001';
const U2 = '0197a1b2-0000-7000-8000-000000000002';
const U3 = '0197a1b2-0000-7000-8000-000000000003';
const U4 = '0197a1b2-0000-7000-8000-000000000004';
const U5 = '0197a1b2-0000-7000-8000-000000000005';
const STUB: BillableCall = { provider: 'openai', operation: 'cap-test-model' };
const CHEAP: BillableCall = { provider: 'openai', operation: 'cap-test-cheap' };
const jobId = (n: number): string => `0197a1b2-0000-7000-9000-${n.toString(16).padStart(12, '0')}`;

let testDb: TestDatabase;
let pool: pg.Pool;
let apiApp: Awaited<ReturnType<typeof createApiApp>>['app'];
let usage: UsageService;
let database: Database;
const roleNames = { api: '', worker: '' };
const rolePasswords = { api: '', worker: '' };
const savedEnv: Record<string, string | undefined> = {};

const roleUrl = (role: 'api' | 'worker'): string => {
  const url = new URL(testDb.url);
  url.username = roleNames[role];
  url.password = rolePasswords[role];
  return url.toString();
};

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function tryQuery(url: string, sql: string, params: unknown[] = []) {
  try {
    return { ok: true as const, rows: (await withClient(url, (c) => c.query(sql, params))).rows as Record<string, unknown>[] };
  } catch (error) {
    return { ok: false as const, code: (error as { code?: string }).code ?? 'none' };
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

async function denial(promise: Promise<unknown>): Promise<DomainError> {
  const error: unknown = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

const reserve = (service: UsageService, ownerId: string, n: number, calls: BillableCall[] = [STUB], jobType: 'brief_generation' | 'video' = 'brief_generation') =>
  database.uow.run((tx) => service.reserve(tx, { ownerId, jobType, jobId: jobId(n), calls }));

const count = async (table: string, owner?: string): Promise<number> =>
  Number((await pool.query(`SELECT count(*) AS n FROM ${table}${owner === undefined ? '' : ' WHERE owner_id = $1'}`, owner === undefined ? [] : [owner])).rows[0]?.n);

/** A second service over the same database with its own clock, for the windows of TC-CAP-02. */
function serviceAt(now: Date, caps: UsageConfig): UsageService {
  const repository = apiApp.get<UsageRepository>(USAGE_REPOSITORY, { strict: false });
  return new UsageService(database, repository, caps, () => now);
}

beforeAll(async () => {
  testDb = await createTestDatabase({ label: 'task044', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 3 });
  const suffix = randomBytes(4).toString('hex');
  for (const role of ['api', 'worker'] as const) {
    roleNames[role] = `app_${role}_t044_${suffix}`;
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

describe('M0006 as written', () => {
  const event = (over: Record<string, unknown> = {}) => {
    const row = { id: crypto.randomUUID(), job: crypto.randomUUID(), seq: 1, provider: 'openai', jobType: 'video', outcome: 'succeeded', basis: 'estimate', cost: '0.2500', latency: 10, ...over };
    return tryQuery(
      testDb.url,
      `INSERT INTO usage_events (id, owner_id, provider, operation, job_type, job_id, call_seq, outcome, estimated_cost_usd, cost_basis, latency_ms)
       VALUES ($1, $2, $3, 'm', $4, $5, $6, $7, $8, $9, $10)`,
      [row.id, U5, row.provider, row.jobType, row.job, row.seq, row.outcome, row.cost, row.basis, row.latency],
    );
  };

  it('keeps the dictionary constraints: outcome and basis pairing, enums, call_seq, costs, unique call', async () => {
    expect((await event()).ok).toBe(true);
    expect((await event({ outcome: 'rejected', basis: 'zero_rejected', cost: '0' })).ok).toBe(true);
    expect((await event({ outcome: 'unconfirmed', basis: 'unconfirmed_estimate' })).ok).toBe(true);
    for (const bad of [
      { outcome: 'rejected', basis: 'estimate' },
      { outcome: 'rejected', basis: 'zero_rejected', cost: '0.01' },
      { outcome: 'succeeded', basis: 'zero_rejected', cost: '0' },
      { outcome: 'unconfirmed', basis: 'estimate' },
      { outcome: 'succeeded', basis: 'unconfirmed_estimate' },
      { outcome: 'weird' },
      { provider: 'acme' },
      { jobType: 'other' },
      { seq: 0 },
      { cost: '-1' },
      { latency: -1 },
    ]) {
      const r = await event(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(!r.ok && r.code).toBe('23514');
    }
    const job = crypto.randomUUID();
    expect((await event({ job })).ok).toBe(true);
    const dup = await event({ job });
    expect(!dup.ok && dup.code).toBe('23505');
    expect((await event({ job, seq: 2 })).ok).toBe(true);
  });

  it('has no foreign key on usage_events and cascades reservations from users', async () => {
    const ghost = '0197a1b2-0000-7000-8000-0000000000e1';
    const noFk = await tryQuery(
      testDb.url,
      `INSERT INTO usage_events (id, owner_id, provider, operation, job_type, job_id, call_seq, outcome, estimated_cost_usd, cost_basis)
       VALUES ($1, $2, 'openai', 'm', 'qc', $3, 1, 'succeeded', 0, 'estimate')`,
      [crypto.randomUUID(), ghost, crypto.randomUUID()],
    );
    expect(noFk.ok).toBe(true);
    const reservation = (owner: string, over: Record<string, unknown> = {}) =>
      tryQuery(
        testDb.url,
        `INSERT INTO spend_reservations (id, owner_id, job_type, job_id, estimated_cost_usd, remaining_calls) VALUES ($1, $2, $3, $4, $5, $6)`,
        [crypto.randomUUID(), owner, over['type'] ?? 'qc', over['job'] ?? crypto.randomUUID(), over['cost'] ?? '1', over['calls'] ?? 1],
      );
    const orphan = await reservation(ghost);
    expect(!orphan.ok && orphan.code).toBe('23503');
    for (const bad of [{ calls: 0 }, { cost: '-1' }, { type: 'nope' }]) {
      const r = await reservation(U5, bad);
      expect(!r.ok && r.code, JSON.stringify(bad)).toBe('23514');
    }
    const job = crypto.randomUUID();
    expect((await reservation(U5, { job })).ok).toBe(true);
    const dup = await reservation(U5, { job });
    expect(!dup.ok && dup.code).toBe('23505');
    await pool.query(`DELETE FROM users WHERE id = $1`, [U5]);
    expect(await count('spend_reservations', U5)).toBe(0);
    expect(await count('usage_events', U5)).toBeGreaterThan(0);
    await pool.query(`INSERT INTO users (id, idp_subject, email, linked_via) VALUES ($1, 'sub_5', 'u5@example.test', 'first_admin')`, [U5]);
  });

  it('grants both runtime roles what they need and no more', async () => {
    for (const role of ['api', 'worker'] as const) {
      const url = roleUrl(role);
      const id = crypto.randomUUID();
      const ins = await tryQuery(
        url,
        `INSERT INTO usage_events (id, owner_id, provider, operation, job_type, job_id, call_seq, outcome, estimated_cost_usd, cost_basis)
         VALUES ($1, $2, 'openai', 'm', 'qc', $3, 1, 'succeeded', 0, 'estimate')`,
        [id, U4, crypto.randomUUID()],
      );
      expect(ins.ok, role).toBe(true);
      expect((await tryQuery(url, 'SELECT count(*) FROM usage_events')).ok).toBe(true);
      for (const sql of [
        `UPDATE usage_events SET latency_ms = 1 WHERE id = '${id}'`,
        `DELETE FROM usage_events WHERE id = '${id}'`,
        `INSERT INTO price_table VALUES ('openai', 'x', '2026-01-01', 'u', 1, 1)`,
        `UPDATE price_table SET unit = 'u'`,
        `DELETE FROM price_table`,
        'TRUNCATE spend_reservations',
        'CREATE TABLE usage_extra (id int)',
      ]) {
        const r = await tryQuery(url, sql);
        expect(r.ok, `${role}: ${sql}`).toBe(false);
        expect(!r.ok && r.code).toBe('42501');
      }
      expect((await tryQuery(url, 'SELECT count(*) FROM price_table')).ok).toBe(true);
      const jid = crypto.randomUUID();
      expect((await tryQuery(url, `INSERT INTO spend_reservations (id, owner_id, job_type, job_id, estimated_cost_usd, remaining_calls) VALUES ($1, $2, 'qc', $3, 1, 1)`, [crypto.randomUUID(), U4, jid])).ok).toBe(true);
      expect((await tryQuery(url, `UPDATE spend_reservations SET remaining_calls = 2 WHERE job_id = $1`, [jid])).ok).toBe(true);
      expect((await tryQuery(url, `DELETE FROM spend_reservations WHERE job_id = $1`, [jid])).ok).toBe(true);
    }
  });
});

describe('release seed of config/price-table.json', () => {
  it('upserts the file by natural key and a rerun changes nothing', async () => {
    const run = () => runSeed({ dataset: 'reference', appEnv: 'development', databaseUrl: testDb.url, steps: [priceTableSeedStep()] });
    const first = await run();
    const rows = await pool.query('SELECT * FROM price_table ORDER BY provider, operation, effective_from');
    const second = await run();
    expect(second).toEqual(first);
    expect(first[0]?.count).toBeGreaterThanOrEqual(7);
    expect((await pool.query('SELECT * FROM price_table ORDER BY provider, operation, effective_from')).rows).toEqual(rows.rows);
    const file = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', '..', 'config', 'price-table.json'), 'utf8')) as { rows: unknown[] };
    expect(rows.rows.length).toBe(file.rows.length + 3);
  });

  it('refuses an invalid file and writes nothing', async () => {
    const before = await count('price_table');
    const bad = join(import.meta.dirname, 'does-not-exist.json');
    await expect(runSeed({ dataset: 'reference', appEnv: 'development', databaseUrl: testDb.url, steps: [priceTableSeedStep(bad)] })).rejects.toThrow();
    expect(await count('price_table')).toBe(before);
  });
});

describe('estimate lookup', () => {
  it('uses the row in force today and ignores one that starts later', async () => {
    expect(await usage.estimate(CHEAP)).toBe('0.0100');
    expect(await usage.estimate({ provider: 'wavespeed', operation: 'bytedance/seedance-2.0/image-to-video' })).toBe('1.5000');
  });

  it('is 503 service_unavailable with nothing created when a row is missing (TC-THM-03)', async () => {
    const missing: BillableCall = { provider: 'openai', operation: 'unpriced-model' };
    const before = [await count('spend_reservations'), await count('usage_events')];
    const error = await denial(reserve(usage, U1, 900, [missing]));
    expect(error.code).toBe('service_unavailable');
    expect([await count('spend_reservations'), await count('usage_events')]).toEqual(before);
  });
});

describe('TC-CAP-01: the cap is checked at creation and a running job may pass it by its own estimate only', () => {
  it('allows reservations up to the cap, refuses the next naming the limit and the basis', async () => {
    for (const n of [1, 2, 3, 4]) expect((await reserve(usage, U1, n)).created).toBe(true); // 4 × 0.25 = the US$1.00 cap
    const error = await denial(reserve(usage, U1, 5));
    expect(error.code).toBe('spend_cap_reached');
    expect(error.status).toBe(422);
    expect(error.safeMessage).toMatch(/daily spending limit of US\$1\.00/);
    expect(error.details?.map((d) => d.field)).toEqual(['limit', 'estimateBasis']);
    expect(await count('spend_reservations', U1)).toBe(4);
    // Recorded cost counts like a reservation: the first job's call is made, the reservation turns into an event.
    await database.uow.run((tx) => usage.record(tx, { ownerId: U1, call: STUB, jobType: 'brief_generation', jobId: jobId(1), callSeq: 1, outcome: 'succeeded' }));
    expect((await denial(reserve(usage, U1, 5))).code).toBe('spend_cap_reached');
    // Cap minus a cent: a cheap call still fits only while the total stays at or under the cap.
    await database.uow.run((tx) => usage.release(tx, { ownerId: U1, jobType: 'brief_generation', jobId: jobId(2) }));
    // 0.25 recorded + 0.50 reserved; 25 cheap calls of 0.01 bring the total to exactly the cap, which is allowed.
    expect((await reserve(usage, U1, 6, Array.from({ length: 25 }, () => CHEAP))).created).toBe(true);
    // One more cent is over it.
    expect((await denial(reserve(usage, U1, 7, [CHEAP]))).code).toBe('spend_cap_reached');
  });
});

describe('TC-CAP-02: windows reset at the UTC day and month boundaries', () => {
  it('counts yesterday against the month, not the day, and nothing across a month', async () => {
    const caps = { dailyCapUnits: toUnits('1'), monthlyCapUnits: toUnits('1.5') };
    const evening = serviceAt(new Date('2026-03-31T23:59:00Z'), caps);
    for (const n of [0, 1, 2, 3]) {
      await database.uow.run((tx) => evening.record(tx, { ownerId: U2, call: STUB, jobType: 'qc', jobId: jobId(100 + n), callSeq: 1, outcome: 'succeeded' }));
    }
    expect((await denial(database.uow.run((tx) => evening.checkCap(tx, U2, '0.25')))).details?.[0]?.code).toBe('daily');
    const nextDay = serviceAt(new Date('2026-03-31T23:59:59Z'), caps);
    expect((await denial(database.uow.run((tx) => nextDay.checkCap(tx, U2, '0.25')))).code).toBe('spend_cap_reached');
    const midnight = serviceAt(new Date('2026-04-01T00:01:00Z'), caps);
    await database.uow.run((tx) => midnight.checkCap(tx, U2, '0.25')); // a new day and month: both windows are empty
    // Same month, next day: the daily window resets, the monthly one still holds the US$1.00.
    const other = serviceAt(new Date('2026-04-01T23:59:00Z'), caps);
    await database.uow.run((tx) => other.record(tx, { ownerId: U3, call: STUB, jobType: 'qc', jobId: jobId(200), callSeq: 1, outcome: 'succeeded' }));
    for (const n of [1, 2, 3]) await database.uow.run((tx) => other.record(tx, { ownerId: U3, call: STUB, jobType: 'qc', jobId: jobId(200 + n), callSeq: 1, outcome: 'succeeded' }));
    const nextMorning = serviceAt(new Date('2026-04-02T00:01:00Z'), caps);
    await database.uow.run((tx) => nextMorning.checkCap(tx, U3, '0.25'));
    expect((await denial(database.uow.run((tx) => nextMorning.checkCap(tx, U3, '0.75')))).details?.[0]?.code).toBe('monthly');
  });
});

describe('TC-CAP-03: ten concurrent job creations at one job below the cap', () => {
  it('lets at most one pass', async () => {
    for (const n of [1, 2, 3]) await reserve(usage, U3, 300 + n); // 0.75 reserved of US$1.00
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => reserve(usage, U3, 310 + i)));
    const passed = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(passed).toHaveLength(1);
    expect(refused).toHaveLength(9);
    for (const r of refused) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'spend_cap_reached' });
    expect(await count('spend_reservations', U3)).toBe(4);
  });
});

describe('reservation lifecycle and idempotency (TC-CAP-05..07)', () => {
  it('turns each returned call into one event, reduces the reservation and deletes it with the last call', async () => {
    const id = jobId(400);
    const reserved = await reserve(usage, U4, 400, [STUB, CHEAP], 'video');
    expect(reserved).toMatchObject({ estimatedCostUsd: '0.2600', remainingCalls: 2 });
    expect((await reserve(usage, U4, 400, [STUB, CHEAP], 'video')).created).toBe(false);
    await database.uow.run((tx) => usage.record(tx, { ownerId: U4, call: STUB, jobType: 'video', jobId: id, callSeq: 1, outcome: 'succeeded', latencyMs: 12 }));
    expect((await pool.query(`SELECT estimated_cost_usd::text AS c, remaining_calls FROM spend_reservations WHERE job_id = $1`, [id])).rows[0]).toEqual({ c: '0.0100', remaining_calls: 1 });
    // The same call again: no second event, no second reduction.
    expect((await database.uow.run((tx) => usage.record(tx, { ownerId: U4, call: STUB, jobType: 'video', jobId: id, callSeq: 1, outcome: 'succeeded' }))).recorded).toBe(false);
    expect((await pool.query(`SELECT remaining_calls FROM spend_reservations WHERE job_id = $1`, [id])).rows[0]).toEqual({ remaining_calls: 1 });
    // A definitive rejection of the last call: zero cost, reservation gone.
    await database.uow.run((tx) => usage.record(tx, { ownerId: U4, call: CHEAP, jobType: 'video', jobId: id, callSeq: 2, outcome: 'rejected' }));
    expect(await count('spend_reservations', U4)).toBe(0);
    const rows = (await pool.query(`SELECT call_seq, outcome, cost_basis, estimated_cost_usd::text AS c FROM usage_events WHERE job_id = $1 ORDER BY call_seq`, [id])).rows;
    expect(rows).toEqual([
      { call_seq: 1, outcome: 'succeeded', cost_basis: 'estimate', c: '0.2500' },
      { call_seq: 2, outcome: 'rejected', cost_basis: 'zero_rejected', c: '0.0000' },
    ]);
  });

  it('converts an unknown outcome in one transaction, idempotently, and a late response changes nothing', async () => {
    const id = jobId(410);
    await reserve(usage, U4, 410, [STUB]);
    const input = { ownerId: U4, call: STUB, jobType: 'brief_generation' as const, jobId: id, callSeq: 1 };
    expect(await database.uow.run((tx) => usage.convertUnconfirmed(tx, input))).toEqual({ recorded: true, costUsd: '0.2500' });
    expect(await database.uow.run((tx) => usage.convertUnconfirmed(tx, input))).toMatchObject({ recorded: false });
    expect((await database.uow.run((tx) => usage.record(tx, { ...input, outcome: 'succeeded' }))).recorded).toBe(false);
    expect((await pool.query(`SELECT outcome, cost_basis FROM usage_events WHERE job_id = $1`, [id])).rows).toEqual([{ outcome: 'unconfirmed', cost_basis: 'unconfirmed_estimate' }]);
    expect(await count('spend_reservations', U4)).toBe(0);
  });

  it('rolls the event back with the reservation change when the transaction fails', async () => {
    const id = jobId(420);
    await reserve(usage, U4, 420, [STUB]);
    await expect(
      database.uow.run(async (tx) => {
        await usage.record(tx, { ownerId: U4, call: STUB, jobType: 'brief_generation', jobId: id, callSeq: 1, outcome: 'succeeded' });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect((await pool.query(`SELECT 1 FROM usage_events WHERE job_id = $1`, [id])).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM spend_reservations WHERE job_id = $1`, [id])).rowCount).toBe(1);
    expect(await database.uow.run((tx) => usage.release(tx, { ownerId: U4, jobType: 'brief_generation', jobId: id }))).toBe(true);
  });
});

describe('TC-CAP-04: caps are enforced before any paid call, proven with a stub provider', () => {
  it('never reaches the stub provider for a refused job and reaches it once for an admitted one', async () => {
    const provider = { calls: 0, call: () => (provider.calls += 1) };
    const create = async (n: number): Promise<void> => {
      await reserve(usage, U2, n); // the cap check is the first step of job creation
      provider.call();
      await database.uow.run((tx) => usage.record(tx, { ownerId: U2, call: STUB, jobType: 'brief_generation', jobId: jobId(n), callSeq: 1, outcome: 'succeeded' }));
    };
    // The windows test recorded events for U2 under its own clock; start this one clean.
    await pool.query(`DELETE FROM usage_events WHERE owner_id = $1`, [U2]);
    for (const n of [500, 501, 502, 503]) await create(n);
    expect(provider.calls).toBe(4);
    const error = await denial(create(504));
    expect(error.code).toBe('spend_cap_reached');
    expect(provider.calls).toBe(4);
    expect(await count('spend_reservations', U2)).toBe(0);
  });
});

describe('start-up price check through the real api composition root (TD-D39)', () => {
  const edge = () => ({
    WEB_ORIGIN: 'http://localhost:3000',
    APP_ENV: 'development' as const,
    DATABASE_URL: testDb.url,
    DATABASE_POOL_MAX: 4,
    DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
    RATE_LIMIT_IP_KEY: 'r'.repeat(40),
  });
  const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>): Promise<void> => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it('starts when every configured model has a row effective now', async () => {
    await withEnv({ OPENAI_TEXT_MODEL: 'cap-test-model', WAVESPEED_MODEL_I2V: 'bytedance/seedance-2.0/image-to-video' }, async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const { app } = await createApiApp(edge(), createHttpLogging({ level: 'silent' }));
      await app.close();
      expect(exit).not.toHaveBeenCalled();
      exit.mockRestore();
    });
  });

  it('exits 78 naming only the provider and operation when a configured model has no row', async () => {
    await withEnv({ OPENAI_IMAGE_MODEL: 'gpt-image-not-priced' }, async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { app } = await createApiApp(edge(), createHttpLogging({ level: 'silent' }));
      await app.close();
      const written = stderr.mock.calls.map((c) => String(c[0])).join('');
      stderr.mockRestore();
      expect(exit).toHaveBeenCalledWith(78);
      expect(written).toContain('price_table has no row effective now for openai gpt-image-not-priced');
      expect(written).not.toContain(testDb.url);
      exit.mockRestore();
    });
  });

  it('treats a row that starts in the future as missing', async () => {
    await pool.query(`INSERT INTO price_table VALUES ('openai', 'future-model', '2999-01-01', 'call', 1, 1)`);
    await withEnv({ OPENAI_TEXT_MODEL: 'future-model' }, async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { app } = await createApiApp(edge(), createHttpLogging({ level: 'silent' }));
      await app.close();
      stderr.mockRestore();
      expect(exit).toHaveBeenCalledWith(78);
      exit.mockRestore();
    });
  });

  it('exits 1, not 78, when the price table cannot be read', async () => {
    await pool.query('ALTER TABLE price_table RENAME TO price_table_away');
    try {
      await withEnv({ OPENAI_TEXT_MODEL: 'cap-test-model' }, async () => {
        const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const { app } = await createApiApp(edge(), createHttpLogging({ level: 'silent' }));
        await app.close();
        const written = stderr.mock.calls.map((c) => String(c[0])).join('');
        stderr.mockRestore();
        expect(exit).toHaveBeenCalledWith(1);
        expect(exit).not.toHaveBeenCalledWith(78);
        expect(written).not.toContain('price_table_away');
        exit.mockRestore();
      });
    } finally {
      await pool.query('ALTER TABLE price_table_away RENAME TO price_table');
    }
  });

  it('refuses at start-up a cap setting out of range', () => {
    expect(() => UsageModule.register({ SPEND_CAP_DAILY_USD: '0' })).toThrow('SPEND_CAP_DAILY_USD');
    expect(() => UsageModule.register({ SPEND_CAP_DAILY_USD: '10', SPEND_CAP_MONTHLY_USD: '5' })).toThrow('SPEND_CAP_MONTHLY_USD');
    expect(() => UsageModule.register({ SPEND_CAP_MONTHLY_USD: 'abc' })).toThrow('SPEND_CAP_MONTHLY_USD');
    expect(() => UsageModule.register({})).not.toThrow();
  });

  it('reads the caps the api composition root was given', () => {
    const config = apiApp.get<UsageConfig>(USAGE_CONFIG, { strict: false });
    expect(config).toEqual({ dailyCapUnits: toUnits('1'), monthlyCapUnits: toUnits('500') });
  });
});
