import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { ModulesContainer } from '@nestjs/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../../bootstrap/api.module.js';
import { runSeed } from '../../../database/seed.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../../platform/db/test-database.js';
import type { TestDatabase } from '../../../platform/db/test-database.js';
import { installJobs } from '../../../platform/jobs/test-support.js';
import { createHttpLogging } from '../../../platform/logging/index.js';
import { priceTableSeedStep } from '../../usage/index.js';

const brandRulesFile = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'config', 'brand-rules.json'), 'utf8')) as {
  rulesVersion: number;
  rules: { id: string; class: string; clearable: boolean; kind: string; params: unknown; message: string; active: boolean }[];
};

// TASK-057 (production 6/6) through the real api composition root (`createApiApp`, the one `main.api.ts` runs) with
// `fastify.inject` on real PostgreSQL: API-075 generate the thumbstopper (job-creating: claim rules on the call-out, key, cap,
// reservation, reuse, idempotency) and API-076 read the latest one. TC-THM-01..04, 07, 08.

const ORIGIN = 'http://localhost:3000';
const contractsDir = join(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'packages', 'contracts');

const sink = new Writable({ write(_chunk: Buffer, _e, done) { done(); } });
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
  const Ajv2020 = (requireFromContracts('ajv/dist/2020') as { default: new (o: object) => any }).default; // eslint-disable-line @typescript-eslint/no-explicit-any
  const addFormats = (requireFromContracts('ajv-formats') as { default: (a: unknown) => void }).default;
  const yaml = requireFromContracts('js-yaml') as { load(text: string): { components: unknown } };
  const spec = yaml.load(readFileSync(join(contractsDir, 'openapi.yaml'), 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ components: spec.components }, 'spec');
  return ajv.compile({ $ref: `spec#/components/schemas/${schema}` }) as Validate;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ label: 'task057api', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 8 });
  const statements = (file: string): string[] =>
    (readFileSync(join(REAL_MIGRATIONS, file), 'utf8').split('-- Grants')[0] ?? '')
      .split('--> statement-breakpoint')
      .map((statement) => statement.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
      .filter((statement) => statement !== '');
  for (const statement of statements('0001_task-025-platform.sql')) {
    if (/^CREATE (TABLE|INDEX|UNIQUE INDEX) "?(idempotency_records|rate_limit_buckets)/.test(statement)) await pool.query(statement);
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
    '0100_task-055-production-assembly.sql',
    '0110_task-057-production-thumbstopper.sql',
  ];
  for (const file of files) for (const statement of statements(file)) await pool.query(statement);
  await installJobs(testDb.url);
  await runSeed({ dataset: 'reference', appEnv: 'development', databaseUrl: testDb.url, steps: [priceTableSeedStep()] });
  // The brand rules the claim check reads, as the release seed leaves them (the seed step itself is the brief module's).
  for (const rule of brandRulesFile.rules) {
    await pool.query(
      `insert into brand_rules (id, class, clearable, kind, params, message, rules_version, active) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [rule.id, rule.class, rule.clearable, rule.kind, JSON.stringify(rule.params), rule.message, brandRulesFile.rulesVersion, rule.active],
    );
  }
  const env: Record<string, string | undefined> = {
    KEK_PUBLIC_KEYS: undefined,
    R2_ENDPOINT: undefined,
    OPENAI_IMAGE_MODEL: 'local-stub-image',
    OWNER_EMAIL: 'owner57@example.test',
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
  const providers = [...app.get(ModulesContainer, { strict: false }).values()].flatMap((m) => [...m.providers.values()]);
  const found = providers.map((p) => p.instance as Partial<Local> | undefined).find((i) => typeof i?.issueToken === 'function');
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
interface Body { success: boolean; data?: any; error?: { code: string; message: string; details?: any[] }; metaData: any } // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(method: 'GET' | 'POST', url: string, token?: string, payload?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
  const res = await fastify().inject({ method, url: `/api/v1${url}`, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: res.statusCode, body: (res.body === '' ? { success: true, metaData: {} } : JSON.parse(res.body)) as Body };
}
const post = (url: string, token: string | undefined, key?: string, payload?: unknown) =>
  call('POST', url, token, payload, key === undefined ? {} : { 'idempotency-key': key });

async function account(keys: 'openai' | 'none' | 'disabled' = 'openai') {
  const sub = `user_t54_${String(++seq)}`;
  const email = `p${String(seq)}@example.test`;
  local.addUser(sub, email, true);
  await pool.query(`insert into invitations (id, email, expires_at) values (gen_random_uuid(), $1, now() + interval '1 day')`, [email]);
  const token = local.issueToken({ sub, azp: ORIGIN, fva: [1, 1] });
  expect((await call('GET', '/me', token)).status).toBe(200);
  const id = (await pool.query(`select id from users where idp_subject = $1`, [sub])).rows[0].id as string;
  if (keys !== 'none') {
    await pool.query(
      `insert into provider_keys (id, owner_id, provider, status, version, ciphertext, nonce, wrapped_dek, kek_version, last4, fingerprint, fingerprint_pepper_version)
       values ($1, $2, 'openai', $3, 1, $4, $5, $6, 1, 'cdef', $7, 1)`,
      [randomUUID(), id, keys === 'disabled' ? 'disabled' : 'active', Buffer.alloc(32, 1), Buffer.alloc(12, 2), Buffer.alloc(384, 3), 'b'.repeat(64)],
    );
  }
  return { id, token };
}

interface Setup { campaign: string; brief: string; segments: string[] }
async function campaign(owner: string, opts: { brief?: string; media?: string | null; segments?: number } = {}): Promise<Setup> {
  const campaignId = randomUUID();
  const briefId = randomUUID();
  const count = opts.segments ?? 2;
  await pool.query(
    `insert into campaigns (id, owner_id, product_name, product_description, product_media_id, segment_count) values ($1, $2, 'Calm Cap', 'A slow morning drink', $3, $4)`,
    [campaignId, owner, opts.media ?? null, Math.max(count, 1)],
  );
  const state = opts.brief ?? 'accepted';
  await pool.query(`insert into briefs (id, campaign_id, owner_id, state, accepted_at) values ($1, $2, $3, $4, ${state === 'accepted' ? 'now()' : 'null'})`, [briefId, campaignId, owner, state]);
  const segments: string[] = [];
  for (let position = 1; position <= count; position += 1) {
    const id = randomUUID();
    segments.push(id);
    await pool.query(
      `insert into brief_segments (id, brief_id, position, dialogue, prompt, word_count) values ($1, $2, $3, $4, $5, 30)`,
      [id, briefId, position, `Dialogue ${String(position)}`, `A calm kitchen ${String(position)}`],
    );
  }
  return { campaign: campaignId, brief: briefId, segments };
}




const count = async (table: string, where: string, params: unknown[]) =>
  (await pool.query(`select count(*)::int as n from ${table} where ${where}`, params)).rows[0].n as number;
const jobsOf = (campaignId: string) => count('thumbstopper_jobs', 'campaign_id = $1', [campaignId]);
const reservationOf = (job: string) => count('spend_reservations', "job_type = 'thumbstopper' and job_id = $1", [job]);
const queued = (job: string) => count('pgboss.job', "name = 'production.thumbstopper-submit' and data->>'jobId' = $1", [job]);
const thumb = (campaignId: string, token: string | undefined, key: string | undefined, calloutText: unknown = 'Mellow mornings') =>
  post(`/campaigns/${campaignId}/thumbstopper`, token, key, { calloutText });

describe('API-075 generate the thumbstopper', () => {
  const valid = contractValidator('ThumbstopperResponse');

  it('creates one pending job with its key, reservation and queue message, through the real entry point (TC-THM-01)', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const res = await thumb(c.campaign, a.token, 'th-1');
    expect(res.status).toBe(202);
    expect(valid(res.body)).toBe(true);
    expect(res.body.data).toMatchObject({ state: 'pending', label: 'pending', calloutText: 'Mellow mornings', campaignId: c.campaign, outputMediaId: null, reused: false, causeClass: null });
    const row = (await pool.query('select * from thumbstopper_jobs where id = $1', [res.body.data.id])).rows[0];
    expect(row).toMatchObject({ owner_id: a.id, campaign_id: c.campaign, state: 'pending', call_count: 0, provider_model: 'local-stub-image' });
    expect(row.key_id).not.toBeNull();
    expect(row.key_version).toBe(1);
    expect(await reservationOf(res.body.data.id)).toBe(1);
    expect(await queued(res.body.data.id)).toBe(1);
    const reservation = (await pool.query(`select remaining_calls, estimated_cost_usd::float as cost from spend_reservations where job_id = $1`, [res.body.data.id])).rows[0];
    expect(reservation.remaining_calls).toBe(1);
    // The price table row of the image model prices the estimate (TC-THM-07).
    expect(reservation.cost).toBeCloseTo(0.04, 6);
  });

  it('refuses call-out text with a high-risk phrase, naming calloutText and the rule, creating nothing (TC-THM-02)', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const res = await thumb(c.campaign, a.token, 'cl-1', 'This cures your anxiety');
    expect([res.status, res.body.error?.code]).toEqual([422, 'open_claim_issues']);
    expect(res.body.error?.details).toEqual([expect.objectContaining({ field: 'calloutText', code: 'hr_treatment_cure' })]);
    expect(await jobsOf(c.campaign)).toBe(0);
    expect(await count('spend_reservations', 'owner_id = $1', [a.id])).toBe(0);
    expect(await count('idempotency_records', 'owner_id = $1', [a.id])).toBe(0);
  });

  it('refuses any claim issue, other-class included, and one issue per rule; plain text passes (TC-THM-02)', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const hype = await thumb(c.campaign, a.token, 'cl-2', 'A game changer');
    expect([hype.status, hype.body.error?.code]).toEqual([422, 'open_claim_issues']);
    expect(hype.body.error?.details).toEqual([expect.objectContaining({ field: 'calloutText', code: 'other_tone_hype' })]);
    const dash = await thumb(c.campaign, a.token, 'cl-3', 'Slow — calm');
    expect(dash.body.error?.details?.map((d: { code: string }) => d.code)).toEqual(['other_em_dash']);
    // The brief's structural rules (word count, call to action, age framing) judge a script, not a call-out.
    expect((await thumb(c.campaign, a.token, 'cl-4', 'Hi')).status).toBe(202);
    expect(await jobsOf(c.campaign)).toBe(1);
  });

  it('replays the same key and request without a second job, reservation or message; the same key for another text is 409 (TC-THM-08)', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const first = await thumb(c.campaign, a.token, 'replay');
    const again = await thumb(c.campaign, a.token, 'replay');
    expect(again.status).toBe(202);
    expect(again.body.data).toMatchObject({ id: first.body.data.id, reused: true });
    expect(await jobsOf(c.campaign)).toBe(1);
    expect(await reservationOf(first.body.data.id)).toBe(1);
    expect(await queued(first.body.data.id)).toBe(1);
    const clash = await thumb(c.campaign, a.token, 'replay', 'Another text');
    expect([clash.status, clash.body.error?.code]).toEqual([409, 'idempotency_key_reused']);
    expect(await jobsOf(c.campaign)).toBe(1);
  });

  it('reuses a live job of the same text under a new key, and makes a new row once it failed, keeping the old (TC-THM-08)', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const first = await thumb(c.campaign, a.token, 'live-1');
    const live = await thumb(c.campaign, a.token, 'live-2');
    expect(live.body.data).toMatchObject({ id: first.body.data.id, reused: true });
    expect(await jobsOf(c.campaign)).toBe(1);
    const other = await thumb(c.campaign, a.token, 'live-3', 'Slow mornings');
    expect(other.body.data).toMatchObject({ reused: false });
    expect(other.body.data.id).not.toBe(first.body.data.id);
    await pool.query(`update thumbstopper_jobs set state = 'failed', cause_class = 'temporary', cause_message = 'OpenAI was not available. Try again.' where id = $1`, [first.body.data.id]);
    const next = await thumb(c.campaign, a.token, 'live-4');
    expect(next.body.data).toMatchObject({ reused: false, state: 'pending' });
    expect(next.body.data.id).not.toBe(first.body.data.id);
    expect(await jobsOf(c.campaign)).toBe(3);
  });

  it('refuses a missing or disabled OpenAI key before anything is reserved or queued (TC-THM-03)', async () => {
    for (const [keys, code] of [['none', 'key_missing'], ['disabled', 'key_disabled']] as const) {
      const who = await account(keys);
      const c = await campaign(who.id);
      const res = await thumb(c.campaign, who.token, `key-${keys}`);
      expect([res.status, res.body.error?.code]).toEqual([422, code]);
      expect(res.body.error?.details?.[0]).toMatchObject({ field: 'openaiKey' });
      expect(await jobsOf(c.campaign)).toBe(0);
      expect(await count('spend_reservations', 'owner_id = $1', [who.id])).toBe(0);
      expect(await count('idempotency_records', 'owner_id = $1', [who.id])).toBe(0);
    }
  });

  it('refuses when the spend cap is reached, creating no job, reservation or message (TC-THM-04)', async () => {
    const a = await account();
    const c = await campaign(a.id);
    await pool.query(
      `insert into usage_events (id, owner_id, provider, operation, job_type, job_id, call_seq, outcome, estimated_cost_usd, cost_basis)
       values ($1, $2, 'openai', 'x', 'qc', $3, 1, 'succeeded', 50.00, 'estimate')`,
      [randomUUID(), a.id, randomUUID()],
    );
    const res = await thumb(c.campaign, a.token, 'cap');
    expect([res.status, res.body.error?.code]).toEqual([422, 'spend_cap_reached']);
    expect(await jobsOf(c.campaign)).toBe(0);
    expect(await count('spend_reservations', 'owner_id = $1 and job_type = $2', [a.id, 'thumbstopper'])).toBe(0);
  });

  it('answers 404 for a missing campaign, another owner\'s campaign and a deleting one', async () => {
    const a = await account();
    const b = await account();
    const c = await campaign(a.id);
    expect((await thumb(randomUUID(), a.token, 'nf-1')).status).toBe(404);
    const foreign = await thumb(c.campaign, b.token, 'nf-2');
    expect([foreign.status, foreign.body.error?.code]).toEqual([404, 'not_found']);
    await pool.query(`update campaigns set state = 'deleting' where id = $1`, [c.campaign]);
    expect((await thumb(c.campaign, a.token, 'nf-3')).status).toBe(404);
    expect(await jobsOf(c.campaign)).toBe(0);
  });

  it('validates the key header, the body, the path and the session', async () => {
    const a = await account();
    const c = await campaign(a.id);
    expect((await thumb(c.campaign, a.token, undefined)).status).toBe(400);
    for (const [index, body] of [{}, { calloutText: '' }, { calloutText: 'x'.repeat(81) }, { calloutText: 5 }, { calloutText: 'ok', extra: 1 }].entries()) {
      const res = await post(`/campaigns/${c.campaign}/thumbstopper`, a.token, `val-${String(index)}`, body);
      expect([res.status, res.body.error?.code]).toEqual([400, 'validation_failed']);
    }
    expect((await post('/campaigns/not-a-uuid/thumbstopper', a.token, 'val-9', { calloutText: 'ok' })).status).toBe(400);
    expect((await thumb(c.campaign, undefined, 'val-10')).status).toBe(401);
    expect((await thumb(c.campaign, a.token, 'val-11', 'x'.repeat(80))).status).toBe(202);
    expect(await jobsOf(c.campaign)).toBe(1);
  });

  it('two requests with different keys for the same text at once make one job (TC-THM-08)', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const [x, y] = await Promise.all([thumb(c.campaign, a.token, 'race-1'), thumb(c.campaign, a.token, 'race-2')]);
    expect([x.status, y.status]).toEqual([202, 202]);
    expect(x.body.data.id).toBe(y.body.data.id);
    expect(await jobsOf(c.campaign)).toBe(1);
    expect(await reservationOf(x.body.data.id)).toBe(1);
  });
});

describe('API-076 read the thumbstopper', () => {
  const valid = contractValidator('ThumbstopperResponse');

  it('answers data null when the campaign has none, then the latest job (TC-THM-01)', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const none = await call('GET', `/campaigns/${c.campaign}/thumbstopper`, a.token);
    expect(none.status).toBe(200);
    expect(valid(none.body)).toBe(true);
    expect(none.body.data).toBeNull();
    const first = await thumb(c.campaign, a.token, 'rd-1');
    await pool.query(`update thumbstopper_jobs set state = 'failed', cause_class = 'credit', cause_message = 'Your OpenAI account has no credit left. Add credit, then try again.' where id = $1`, [first.body.data.id]);
    const failed = await call('GET', `/campaigns/${c.campaign}/thumbstopper`, a.token);
    expect(valid(failed.body)).toBe(true);
    expect(failed.body.data).toMatchObject({ id: first.body.data.id, state: 'failed', label: 'failed', causeClass: 'credit', causeMessage: 'Your OpenAI account has no credit left. Add credit, then try again.', reused: false });
    const next = await thumb(c.campaign, a.token, 'rd-2', 'Slow mornings');
    const latest = await call('GET', `/campaigns/${c.campaign}/thumbstopper`, a.token);
    expect(latest.body.data).toMatchObject({ id: next.body.data.id, calloutText: 'Slow mornings', state: 'pending', reused: false });
  });

  it('shows the output media of a completed job, and answers 404 for foreign, missing and deleting campaigns', async () => {
    const a = await account();
    const b = await account();
    const c = await campaign(a.id);
    const made = await thumb(c.campaign, a.token, 'rd-3');
    const mediaId = made.body.data.id as string;
    await pool.query(
      `insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, campaign_id) values ($1, $2, 'thumbstopper', 'ready', $3, 10, 'image/png', $4)`,
      [mediaId, a.id, `u/${a.id}/c/${c.campaign}/thumbstopper/${mediaId}.png`, c.campaign],
    );
    await pool.query(`update thumbstopper_jobs set state = 'completed', output_media_id = $1 where id = $1`, [mediaId]);
    const read = await call('GET', `/campaigns/${c.campaign}/thumbstopper`, a.token);
    expect(valid(read.body)).toBe(true);
    expect(read.body.data).toMatchObject({ state: 'completed', outputMediaId: mediaId });
    expect((await call('GET', `/campaigns/${randomUUID()}/thumbstopper`, a.token)).status).toBe(404);
    expect((await call('GET', `/campaigns/${c.campaign}/thumbstopper`, b.token)).status).toBe(404);
    expect((await call('GET', `/campaigns/${c.campaign}/thumbstopper`)).status).toBe(401);
    expect((await call('GET', '/campaigns/not-a-uuid/thumbstopper', a.token)).status).toBe(400);
    await pool.query(`update campaigns set state = 'deleting' where id = $1`, [c.campaign]);
    expect((await call('GET', `/campaigns/${c.campaign}/thumbstopper`, a.token)).status).toBe(404);
  });
});
