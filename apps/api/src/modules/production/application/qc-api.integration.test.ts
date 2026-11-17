/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles; prettier reflow detached the per-line directives (AIU-256) */
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

// TASK-054 (production 3/6) through the real api composition root (`createApiApp`, the one `main.api.ts` runs) with
// `fastify.inject` on real PostgreSQL: API-064 re-run QC (job-creating: key, cap, reservation, reuse, idempotency, history).
// TC-QC-03, TC-QC-01 (the read shows the latest result and the history).

const ORIGIN = 'http://localhost:3000';
const contractsDir = join(
  import.meta.dirname,
  '..',
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
  testDb = await createTestDatabase({ label: 'task054api', migrations: false });
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
    OWNER_EMAIL: 'owner54@example.test',
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
async function call(
  method: 'GET' | 'POST',
  url: string,
  token?: string,
  payload?: unknown,
  extra: Record<string, string> = {},
) {
  const headers: Record<string, string> = { ...extra };
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
  const res = await fastify().inject({
    method,
    url: `/api/v1${url}`,
    headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return {
    status: res.statusCode,
    body: (res.body === '' ? { success: true, metaData: {} } : JSON.parse(res.body)) as Body,
  };
}
const post = (url: string, token: string | undefined, key?: string, payload?: unknown) =>
  call('POST', url, token, payload, key === undefined ? {} : { 'idempotency-key': key });

async function account(keys: 'openai' | 'none' | 'disabled' = 'openai') {
  const sub = `user_t54_${String(++seq)}`;
  const email = `p${String(seq)}@example.test`;
  local.addUser(sub, email, true);
  await pool.query(
    `insert into invitations (id, email, expires_at) values (gen_random_uuid(), $1, now() + interval '1 day')`,
    [email],
  );
  const token = local.issueToken({ sub, azp: ORIGIN, fva: [1, 1] });
  expect((await call('GET', '/me', token)).status).toBe(200);
  const id = (await pool.query(`select id from users where idp_subject = $1`, [sub])).rows[0]
    .id as string;
  if (keys !== 'none') {
    await pool.query(
      `insert into provider_keys (id, owner_id, provider, status, version, ciphertext, nonce, wrapped_dek, kek_version, last4, fingerprint, fingerprint_pepper_version)
       values ($1, $2, 'openai', $3, 1, $4, $5, $6, 1, 'cdef', $7, 1)`,
      [
        randomUUID(),
        id,
        keys === 'disabled' ? 'disabled' : 'active',
        Buffer.alloc(32, 1),
        Buffer.alloc(12, 2),
        Buffer.alloc(384, 3),
        'b'.repeat(64),
      ],
    );
  }
  return { id, token };
}

interface Setup {
  campaign: string;
  brief: string;
  segments: string[];
}
async function campaign(
  owner: string,
  opts: { brief?: string; media?: string | null; segments?: number } = {},
): Promise<Setup> {
  const campaignId = randomUUID();
  const briefId = randomUUID();
  const count = opts.segments ?? 2;
  await pool.query(
    `insert into campaigns (id, owner_id, product_name, product_description, product_media_id, segment_count) values ($1, $2, 'Calm Cap', 'A slow morning drink', $3, $4)`,
    [campaignId, owner, opts.media ?? null, Math.max(count, 1)],
  );
  const state = opts.brief ?? 'accepted';
  await pool.query(
    `insert into briefs (id, campaign_id, owner_id, state, accepted_at) values ($1, $2, $3, $4, ${state === 'accepted' ? 'now()' : 'null'})`,
    [briefId, campaignId, owner, state],
  );
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

async function completedClip(owner: string, setup: Setup, state = 'completed'): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into video_jobs (id, owner_id, campaign_id, segment_id, segment_revision, provider_model, options, state, reuse_hash, deadline_at, provider_task_id, provider_completed_at)
     values ($1, $2, $3, $4, 1, 'bytedance/seedance-2.0/text-to-video', '{"durationSeconds":15,"resolution":"1080p","aspectRatio":"9:16"}', $5, $6, now(), 'task-1', now())`,
    [
      id,
      owner,
      setup.campaign,
      setup.segments[0],
      state,
      randomUUID().replace(/-/g, '').padEnd(64, '0'),
    ],
  );
  if (state === 'completed') {
    await pool.query(
      `insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, campaign_id) values ($1, $2, 'clip', 'ready', $3, 10, 'video/mp4', $4)`,
      [id, owner, `u/${owner}/c/${setup.campaign}/clip/${id}.mp4`, setup.campaign],
    );
    await pool.query('update video_jobs set output_media_id = $1 where id = $1', [id]);
  }
  return id;
}

const count = async (table: string, where: string, params: unknown[]) =>
  (await pool.query(`select count(*)::int as n from ${table} where ${where}`, params)).rows[0]
    .n as number;
const runsOf = (job: string) => count('qc_runs', 'video_job_id = $1', [job]);
const reservationOf = (run: string) =>
  count('spend_reservations', "job_type = 'qc' and job_id = $1", [run]);
const queuedRun = (run: string) =>
  count('pgboss.job', "name = 'production.qc-run' and data->>'runId' = $1", [run]);

describe('API-064 re-run QC', () => {
  const valid = contractValidator('QcRunResponse');
  const validJob = contractValidator('VideoJobResponse');

  it('creates one pending run with its key, reservation and queue message, through the real entry point (TC-QC-03)', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const job = await completedClip(a.id, c);
    const res = await post(`/video-jobs/${job}/qc`, a.token, 'qc-1');
    expect(res.status).toBe(202);
    expect(valid(res.body)).toBe(true);
    expect(res.body.data).toMatchObject({
      state: 'pending',
      label: 'pending',
      qcState: 'pending',
      reason: null,
      videoJobId: job,
      reused: false,
      causeClass: null,
    });
    const row = (await pool.query('select * from qc_runs where id = $1', [res.body.data.id]))
      .rows[0];
    expect(row).toMatchObject({
      owner_id: a.id,
      video_job_id: job,
      qc_state: 'pending',
      state: 'pending',
      call_count: 0,
    });
    expect(row.key_id).not.toBeNull();
    expect(row.key_version).toBe(1);
    expect(await reservationOf(res.body.data.id)).toBe(1);
    expect(await queuedRun(res.body.data.id)).toBe(1);
    const reservation = (
      await pool.query(
        `select remaining_calls, estimated_cost_usd::float as cost from spend_reservations where job_id = $1`,
        [res.body.data.id],
      )
    ).rows[0];
    expect(reservation.remaining_calls).toBe(1);
    expect(reservation.cost).toBeGreaterThan(0);
  });

  it('replays the same key and request without a second run, reservation or message; the same key for another clip is 409', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const job = await completedClip(a.id, c);
    const first = await post(`/video-jobs/${job}/qc`, a.token, 'replay');
    const again = await post(`/video-jobs/${job}/qc`, a.token, 'replay');
    expect(again.status).toBe(202);
    expect(again.body.data).toMatchObject({ id: first.body.data.id, reused: true });
    expect(await runsOf(job)).toBe(1);
    expect(await reservationOf(first.body.data.id)).toBe(1);
    expect(await queuedRun(first.body.data.id)).toBe(1);
    const other = await completedClip(a.id, c);
    const clash = await post(`/video-jobs/${other}/qc`, a.token, 'replay');
    expect([clash.status, clash.body.error?.code]).toEqual([409, 'idempotency_key_reused']);
    expect(await runsOf(other)).toBe(0);
  });

  it('reuses a run that is still live (a new key, the same clip), and makes a new row once it has finished, keeping the old (TC-QC-03)', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const job = await completedClip(a.id, c);
    const first = await post(`/video-jobs/${job}/qc`, a.token, 'live-1');
    const live = await post(`/video-jobs/${job}/qc`, a.token, 'live-2');
    expect(live.status).toBe(202);
    expect(live.body.data).toMatchObject({ id: first.body.data.id, reused: true });
    expect(await runsOf(job)).toBe(1);
    expect(await reservationOf(first.body.data.id)).toBe(1);

    await pool.query(
      `update qc_runs set state = 'completed', qc_state = 'failed', reason = '40% of the words differ from the script.' where id = $1`,
      [first.body.data.id],
    );
    const next = await post(`/video-jobs/${job}/qc`, a.token, 'live-3');
    expect(next.status).toBe(202);
    expect(next.body.data).toMatchObject({ reused: false, qcState: 'pending' });
    expect(next.body.data.id).not.toBe(first.body.data.id);
    expect(await runsOf(job)).toBe(2);

    const read = await call('GET', `/video-jobs/${job}`, a.token);
    expect(validJob(read.body)).toBe(true);
    expect(read.body.data.latestQc).toMatchObject({ id: next.body.data.id, qcState: 'pending' });
    expect(
      read.body.data.qcHistory.map((run: { id: string; qcState: string }) => [run.id, run.qcState]),
    ).toEqual([
      [next.body.data.id, 'pending'],
      [first.body.data.id, 'failed'],
    ]);
    expect(read.body.data.qcHistory[1].reason).toBe('40% of the words differ from the script.');
  });

  it('refuses a clip that is not completed (422 clip_not_completed), creating nothing', async () => {
    const a = await account();
    const c = await campaign(a.id);
    for (const state of ['pending', 'processing', 'failed', 'cancelled']) {
      const job = await completedClip(a.id, c, state);
      const res = await post(`/video-jobs/${job}/qc`, a.token, `nc-${state}`);
      expect([res.status, res.body.error?.code]).toEqual([422, 'clip_not_completed']);
      expect(await runsOf(job)).toBe(0);
    }
    expect(await count('spend_reservations', 'owner_id = $1', [a.id])).toBe(0);
  });

  it('refuses a missing or disabled OpenAI key before anything is reserved or queued (TC-KEY)', async () => {
    for (const [keys, code] of [
      ['none', 'key_missing'],
      ['disabled', 'key_disabled'],
    ] as const) {
      const who = await account(keys);
      const c = await campaign(who.id);
      const job = await completedClip(who.id, c);
      const res = await post(`/video-jobs/${job}/qc`, who.token, `key-${keys}`);
      expect([res.status, res.body.error?.code]).toEqual([422, code]);
      expect(res.body.error?.details?.[0]).toMatchObject({ field: 'openaiKey' });
      expect(await runsOf(job)).toBe(0);
      expect(await count('spend_reservations', 'owner_id = $1', [who.id])).toBe(0);
      expect(await count('idempotency_records', 'owner_id = $1', [who.id])).toBe(0);
    }
  });

  it('refuses when the spend cap is reached, creating no run, reservation or message', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const job = await completedClip(a.id, c);
    await pool.query(
      `insert into usage_events (id, owner_id, provider, operation, job_type, job_id, call_seq, outcome, estimated_cost_usd, cost_basis)
       values ($1, $2, 'openai', 'x', 'qc', $3, 1, 'succeeded', 50.00, 'estimate')`,
      [randomUUID(), a.id, randomUUID()],
    );
    const res = await post(`/video-jobs/${job}/qc`, a.token, 'cap');
    expect([res.status, res.body.error?.code]).toEqual([422, 'spend_cap_reached']);
    expect(await runsOf(job)).toBe(0);
    expect(await count('spend_reservations', 'owner_id = $1', [a.id])).toBe(0);
  });

  it("answers 404 for a missing clip, another owner's clip and a clip of a deleting campaign", async () => {
    const a = await account();
    const b = await account();
    const c = await campaign(a.id);
    const job = await completedClip(a.id, c);
    expect((await post(`/video-jobs/${randomUUID()}/qc`, a.token, 'nf-1')).status).toBe(404);
    const foreign = await post(`/video-jobs/${job}/qc`, b.token, 'nf-2');
    expect([foreign.status, foreign.body.error?.code]).toEqual([404, 'not_found']);
    await pool.query(`update campaigns set state = 'deleting' where id = $1`, [c.campaign]);
    expect((await post(`/video-jobs/${job}/qc`, a.token, 'nf-3')).status).toBe(404);
    expect(await runsOf(job)).toBe(0);
  });

  it('validates the key header, the path and the session', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const job = await completedClip(a.id, c);
    expect((await post(`/video-jobs/${job}/qc`, a.token)).status).toBe(400);
    expect((await post('/video-jobs/not-a-uuid/qc', a.token, 'v-1')).status).toBe(400);
    expect((await post(`/video-jobs/${job}/qc`, undefined, 'v-2')).status).toBe(401);
    expect(await runsOf(job)).toBe(0);
  });

  it('two requests with different keys at once make one run (TC-IDM: the clip row serializes them)', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const job = await completedClip(a.id, c);
    const [x, y] = await Promise.all([
      post(`/video-jobs/${job}/qc`, a.token, 'race-1'),
      post(`/video-jobs/${job}/qc`, a.token, 'race-2'),
    ]);
    expect([x.status, y.status]).toEqual([202, 202]);
    expect(x.body.data.id).toBe(y.body.data.id);
    expect(await runsOf(job)).toBe(1);
    expect(await reservationOf(x.body.data.id)).toBe(1);
  });
});
