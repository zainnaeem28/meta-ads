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
import { createApiApp } from '../../bootstrap/api.module.js';
import { runSeed } from '../../database/seed.js';
import { DATABASE } from '../../platform/db/index.js';
import type { Database, DbTx } from '../../platform/db/index.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../platform/db/test-database.js';
import type { TestDatabase } from '../../platform/db/test-database.js';
import { installJobs } from '../../platform/jobs/test-support.js';
import { createHttpLogging } from '../../platform/logging/index.js';
import { priceTableSeedStep } from '../usage/index.js';
import { VideoJobsService } from './application/video-jobs.service.js';
import { VideoProgressReader } from './infrastructure/video-progress.reader.js';

// TASK-052 (production 1/6) through the real api composition root (`createApiApp`, the one `main.api.ts` runs) with
// `fastify.inject` on real PostgreSQL: API-060 to API-063, SB-D14 (key, cap, reservation, reuse), SB-D11 (out of date at
// read, NO ACTION segment guard), the owner scope, and the campaign progress reader. TC-CLP-03, 05, 09, 10, 13.

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
  testDb = await createTestDatabase({ label: 'task052', migrations: false });
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
    OWNER_EMAIL: 'owner52@example.test',
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

async function account(keys: 'wavespeed' | 'none' | 'disabled' = 'wavespeed') {
  const sub = `user_t52_${String(++seq)}`;
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
       values ($1, $2, 'wavespeed', $3, 1, $4, $5, $6, 1, 'cdef', $7, 1)`,
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

async function image(owner: string, state = 'ready') {
  const id = randomUUID();
  await pool.query(
    `insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, width, height) values ($1, $2, 'upload', $3, $4, 10, 'image/png', 1, 1)`,
    [id, owner, state, `u/${owner}/${id}`],
  );
  return id;
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

const count = async (table: string, where: string, params: unknown[]) =>
  (await pool.query(`select count(*)::int as n from ${table} where ${where}`, params)).rows[0]
    .n as number;
const reservations = (owner: string) => count('spend_reservations', 'owner_id = $1', [owner]);
const jobsOf = (owner: string) => count('video_jobs', 'owner_id = $1', [owner]);
const queued = async (jobId: string) =>
  (
    await pool.query(
      `select count(*)::int as n from pgboss.job where name = 'production.video-submit' and data->>'jobId' = $1`,
      [jobId],
    )
  ).rows[0].n as number;

describe('API-060 generate a segment clip', () => {
  const valid = contractValidator('VideoJobResponse');

  it('creates one pending job with its reservation and queue message, through the real entry point', async () => {
    const a = await account();
    const media = await image(a.id);
    const c = await campaign(a.id, { media });
    const res = await post(`/campaigns/${c.campaign}/segments/1/jobs`, a.token, 'gen-1');
    expect(res.status).toBe(202);
    expect(valid(res.body)).toBe(true);
    const job = res.body.data;
    expect(job).toMatchObject({
      state: 'pending',
      label: 'pending',
      reused: false,
      campaignId: c.campaign,
      segmentPosition: 1,
      segmentRevision: 1,
      outOfDate: false,
      outputMediaId: null,
      latestQc: null,
      qcHistory: [],
    });
    const row = (await pool.query('select * from video_jobs where id = $1', [job.id])).rows[0];
    expect(row.segment_id).toBe(c.segments[0]);
    expect(row.reference_media_id).toBe(media);
    expect(row.provider_model).toContain('image-to-video');
    expect(row.reuse_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.key_id).not.toBeNull();
    expect(row.options).toEqual({ durationSeconds: 15, resolution: '1080p', aspectRatio: '9:16' });
    const reservation = (
      await pool.query(
        `select job_type, remaining_calls from spend_reservations where job_id = $1`,
        [job.id],
      )
    ).rows;
    expect(reservation).toEqual([{ job_type: 'video', remaining_calls: 2 }]);
    expect(await queued(job.id)).toBe(1);
    expect(JSON.stringify(res.body)).not.toMatch(/wavespeed\.ai|https?:/);
  });

  it('a clip without a ready product image uses the text model; useProductImage=false does too', async () => {
    const a = await account();
    const c = await campaign(a.id, { media: await image(a.id, 'processing') });
    const text = await post(`/campaigns/${c.campaign}/segments/1/jobs`, a.token, 'k1');
    expect(text.status).toBe(202);
    const off = await campaign(a.id, { media: await image(a.id) });
    const without = await post(`/campaigns/${off.campaign}/segments/2/jobs`, a.token, 'k2', {
      useProductImage: false,
    });
    expect(without.status).toBe(202);
    for (const id of [text.body.data.id, without.body.data.id]) {
      const row = (
        await pool.query(
          'select provider_model, reference_media_id from video_jobs where id = $1',
          [id],
        )
      ).rows[0];
      expect(row.provider_model).toContain('text-to-video');
      expect(row.reference_media_id).toBeNull();
    }
    expect(
      (await post(`/campaigns/${off.campaign}/segments/1/jobs`, a.token, 'k3', { surprise: true }))
        .status,
    ).toBe(400);
  });

  it('a matching in-flight or completed job is returned with no new job or reservation (TC-CLP-03); a failed one is not', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const url = `/campaigns/${c.campaign}/segments/1/jobs`;
    const first = await post(url, a.token, 'same');
    const replay = await post(url, a.token, 'same');
    const other = await post(url, a.token, 'other-key');
    for (const again of [replay, other]) {
      expect(again.status).toBe(202);
      expect(again.body.data.id).toBe(first.body.data.id);
      expect(again.body.data.reused).toBe(true);
    }
    expect(await jobsOf(a.id)).toBe(1);
    expect(await reservations(a.id)).toBe(1);
    expect(await queued(first.body.data.id)).toBe(1);
    await pool.query(`update video_jobs set state = 'completed' where id = $1`, [
      first.body.data.id,
    ]);
    const done = await post(url, a.token, 'after-complete');
    expect([done.body.data.id, done.body.data.reused, done.body.data.state]).toEqual([
      first.body.data.id,
      true,
      'completed',
    ]);
    await pool.query(
      `update video_jobs set state = 'failed', cause_class = 'temporary', cause_message = 'The provider could not make the clip.' where id = $1`,
      [first.body.data.id],
    );
    const fresh = await post(url, a.token, 'after-failed');
    expect(fresh.status).toBe(202);
    expect(fresh.body.data.id).not.toBe(first.body.data.id);
    expect(fresh.body.data.reused).toBe(false);
    expect(await jobsOf(a.id)).toBe(2);
  });

  it('concurrent requests with the same or different keys make one job and one reservation', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const url = `/campaigns/${c.campaign}/segments/2/jobs`;
    const results = await Promise.all([
      ...Array.from({ length: 3 }, () => post(url, a.token, 'one')),
      ...Array.from({ length: 3 }, (_, i) => post(url, a.token, `diff-${String(i)}`)),
    ]);
    expect(results.map((r) => r.status)).toEqual([202, 202, 202, 202, 202, 202]);
    expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
    expect(results.filter((r) => !r.body.data.reused)).toHaveLength(1);
    expect(await jobsOf(a.id)).toBe(1);
    expect(await reservations(a.id)).toBe(1);
  });

  it('the running limit never refuses: six clips at once are six pending jobs (TC-CLP-10)', async () => {
    const a = await account();
    const c = await campaign(a.id, { segments: 4 });
    const other = await campaign(a.id, { segments: 2 });
    const calls = [1, 2, 3, 4]
      .map((n) =>
        post(`/campaigns/${c.campaign}/segments/${String(n)}/jobs`, a.token, `six-${String(n)}`),
      )
      .concat(
        [1, 2].map((n) =>
          post(
            `/campaigns/${other.campaign}/segments/${String(n)}/jobs`,
            a.token,
            `six-o${String(n)}`,
          ),
        ),
      );
    const results = await Promise.all(calls);
    expect(results.map((r) => [r.status, r.body.data.state])).toEqual(
      Array.from({ length: 6 }, () => [202, 'pending']),
    );
    expect(await count('video_jobs', `owner_id = $1 and state = 'pending'`, [a.id])).toBe(6);
  });

  it('the same key for another request is 409; a missing key is 400; bad parameters are 400; no token is 401', async () => {
    const a = await account();
    const c = await campaign(a.id);
    expect((await post(`/campaigns/${c.campaign}/segments/1/jobs`, a.token, 'k')).status).toBe(202);
    const clash = await post(`/campaigns/${c.campaign}/segments/2/jobs`, a.token, 'k');
    expect([clash.status, clash.body.error?.code]).toEqual([409, 'idempotency_key_reused']);
    expect((await post(`/campaigns/${c.campaign}/segments/2/jobs`, a.token)).status).toBe(400);
    expect((await post(`/campaigns/${c.campaign}/segments/5/jobs`, a.token, 'p5')).status).toBe(
      400,
    );
    expect((await post(`/campaigns/not-a-uuid/segments/1/jobs`, a.token, 'p6')).status).toBe(400);
    expect((await post(`/campaigns/${c.campaign}/segments/1/jobs`, undefined, 'p7')).status).toBe(
      401,
    );
    expect(await jobsOf(a.id)).toBe(1);
  });

  it('a stranger, a missing campaign, a missing segment and a deleting campaign all answer the single not-found', async () => {
    const a = await account();
    const b = await account();
    const c = await campaign(a.id);
    const deleting = await campaign(a.id);
    await pool.query(`update campaigns set state = 'deleting' where id = $1`, [deleting.campaign]);
    const answers = await Promise.all([
      post(`/campaigns/${c.campaign}/segments/1/jobs`, b.token, 'n1'),
      post(`/campaigns/${randomUUID()}/segments/1/jobs`, a.token, 'n2'),
      post(`/campaigns/${c.campaign}/segments/4/jobs`, a.token, 'n3'),
      post(`/campaigns/${deleting.campaign}/segments/1/jobs`, a.token, 'n4'),
    ]);
    for (const res of answers)
      expect([res.status, res.body.error?.code]).toEqual([404, 'not_found']);
    expect(new Set(answers.slice(0, 2).map((r) => r.body.error?.message)).size).toBe(1);
    expect((await jobsOf(a.id)) + (await jobsOf(b.id))).toBe(0);
  });

  it('needs an accepted brief and an active segment: 422 brief_not_accepted, nothing created', async () => {
    const a = await account();
    for (const state of ['generating', 'draft', 'failed']) {
      const c = await campaign(a.id, { brief: state });
      const res = await post(`/campaigns/${c.campaign}/segments/1/jobs`, a.token, `state-${state}`);
      expect([res.status, res.body.error?.code]).toEqual([422, 'brief_not_accepted']);
    }
    const c = await campaign(a.id);
    await pool.query(
      `update brief_segments set state = 'retired', revision = revision + 1 where id = $1`,
      [c.segments[1]],
    );
    const retired = await post(`/campaigns/${c.campaign}/segments/2/jobs`, a.token, 'retired');
    expect([retired.status, retired.body.error?.code]).toEqual([422, 'brief_not_accepted']);
    expect(retired.body.error?.message).toContain('no longer');
    expect(await jobsOf(a.id)).toBe(0);
    expect(await reservations(a.id)).toBe(0);
    expect(await count('idempotency_records', 'owner_id = $1', [a.id])).toBe(0);
  });

  it('a missing or disabled WaveSpeed key and a reached cap create no job and no reservation (TC-CLP-09)', async () => {
    for (const [keys, code] of [
      ['none', 'key_missing'],
      ['disabled', 'key_disabled'],
    ] as const) {
      const who = await account(keys);
      const c = await campaign(who.id);
      const res = await post(`/campaigns/${c.campaign}/segments/1/jobs`, who.token, `key-${code}`);
      expect([res.status, res.body.error?.code]).toEqual([422, code]);
      expect(JSON.stringify(res.body.error)).toContain('WaveSpeed');
      expect(await jobsOf(who.id)).toBe(0);
      expect(await reservations(who.id)).toBe(0);
      expect(await count('idempotency_records', 'owner_id = $1', [who.id])).toBe(0);
    }
    const capped = await account();
    const c = await campaign(capped.id);
    await pool.query(
      `insert into usage_events (id, owner_id, provider, operation, job_type, job_id, call_seq, outcome, estimated_cost_usd, cost_basis)
       values ($1, $2, 'wavespeed', 'x', 'video', $3, 1, 'succeeded', 49.99, 'estimate')`,
      [randomUUID(), capped.id, randomUUID()],
    );
    const over = await post(`/campaigns/${c.campaign}/segments/1/jobs`, capped.token, 'cap');
    expect([over.status, over.body.error?.code]).toEqual([422, 'spend_cap_reached']);
    expect(await jobsOf(capped.id)).toBe(0);
    expect(await reservations(capped.id)).toBe(0);
  });
});

describe('out of date (SB-D11) and the segment guard', () => {
  it('an edit after accept marks the clip out of date at read; a new request then makes a new clip', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const url = `/campaigns/${c.campaign}/segments/1/jobs`;
    const made = await post(url, a.token, 'first');
    await pool.query(`update video_jobs set state = 'completed' where id = $1`, [
      made.body.data.id,
    ]);
    expect(
      (await call('GET', `/video-jobs/${made.body.data.id}`, a.token)).body.data.outOfDate,
    ).toBe(false);
    await pool.query(
      `update brief_segments set prompt = 'A different kitchen', revision = revision + 1 where id = $1`,
      [c.segments[0]],
    );
    await pool.query(`update briefs set state = 'draft', accepted_at = null where id = $1`, [
      c.brief,
    ]);
    const stale = await call('GET', `/video-jobs/${made.body.data.id}`, a.token);
    expect(stale.body.data).toMatchObject({ outOfDate: true, segmentRevision: 1 });
    const blocked = await post(url, a.token, 'while-draft');
    expect([blocked.status, blocked.body.error?.code]).toEqual([422, 'brief_not_accepted']);
    await pool.query(`update briefs set state = 'accepted', accepted_at = now() where id = $1`, [
      c.brief,
    ]);
    const next = await post(url, a.token, 'after-accept');
    expect(next.status).toBe(202);
    expect(next.body.data).toMatchObject({ reused: false, segmentRevision: 2, outOfDate: false });
    expect(next.body.data.id).not.toBe(made.body.data.id);
    const list = await call('GET', `/campaigns/${c.campaign}/video-jobs`, a.token);
    expect(list.body.data[0].latestJob.id).toBe(next.body.data.id);
    expect(
      (await call('GET', `/video-jobs/${made.body.data.id}`, a.token)).body.data.outOfDate,
    ).toBe(true);
  });

  it('a direct delete of a segment that has jobs is refused by the foreign key; the campaign delete takes everything', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const made = await post(`/campaigns/${c.campaign}/segments/1/jobs`, a.token, 'fk');
    await expect(
      pool.query('delete from brief_segments where id = $1', [c.segments[0]]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(pool.query('delete from briefs where id = $1', [c.brief])).rejects.toMatchObject({
      code: '23503',
    });
    await pool.query('delete from brief_segments where id = $1', [c.segments[1]]);
    await pool.query(
      `insert into qc_runs (id, owner_id, video_job_id, reuse_hash, deadline_at) values ($1, $2, $3, $4, now() + interval '10 minutes')`,
      [randomUUID(), a.id, made.body.data.id, 'q'.repeat(64)],
    );
    await pool.query('delete from campaigns where id = $1', [c.campaign]);
    expect(await count('video_jobs', 'owner_id = $1', [a.id])).toBe(0);
    expect(await count('qc_runs', 'owner_id = $1', [a.id])).toBe(0);
    expect(await count('brief_segments', 'brief_id = $1', [c.brief])).toBe(0);
  });

  it('refuses options outside the three keys, a zero revision and an unknown state at the table', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const insert = (revision: number, options: string, state = 'pending') =>
      pool.query(
        `insert into video_jobs (id, owner_id, campaign_id, segment_id, segment_revision, provider_model, options, state, reuse_hash, deadline_at)
         values ($1, $2, $3, $4, $5, 'm', $6::jsonb, $7, $8, now())`,
        [
          randomUUID(),
          a.id,
          c.campaign,
          c.segments[0],
          revision,
          options,
          state,
          randomUUID().replace(/-/g, '').padEnd(64, 'a'),
        ],
      );
    await expect(insert(1, '{"extra":1}')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(0, '{}')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(1, '{}', 'bogus')).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert(1, '{"durationSeconds":15,"resolution":"720p","aspectRatio":"9:16"}'),
    ).resolves.toBeDefined();
  });
});

describe('API-061 and API-062 reads', () => {
  const list = contractValidator('SegmentJobsResponse');
  const one = contractValidator('VideoJobResponse');

  it('lists one entry per segment with the latest job and its QC history', async () => {
    const a = await account();
    const c = await campaign(a.id, { segments: 3 });
    await pool.query(`update brief_segments set state = 'retired', revision = 2 where id = $1`, [
      c.segments[2],
    ]);
    const first = await post(`/campaigns/${c.campaign}/segments/1/jobs`, a.token, 'r1');
    await pool.query(
      `update video_jobs set state = 'failed', cause_class = 'credit', cause_message = 'Your WaveSpeed account is out of credit.' where id = $1`,
      [first.body.data.id],
    );
    const second = await post(`/campaigns/${c.campaign}/segments/1/jobs`, a.token, 'r2');
    for (const [at, qcState, reason] of [
      [1, 'failed', 'missing: calm'],
      [2, 'passed', null],
    ] as const) {
      await pool.query(
        `insert into qc_runs (id, owner_id, video_job_id, qc_state, reason, state, reuse_hash, deadline_at, created_at) values ($1, $2, $3, $4, $5, 'completed', $6, now(), now() + make_interval(secs => $7))`,
        [
          randomUUID(),
          a.id,
          second.body.data.id,
          qcState,
          reason,
          randomUUID().replace(/-/g, '').padEnd(64, 'b'),
          at,
        ],
      );
    }
    const res = await call('GET', `/campaigns/${c.campaign}/video-jobs`, a.token);
    expect(res.status).toBe(200);
    expect(list(res.body)).toBe(true);
    expect(
      res.body.data.map(
        (e: { position: number; segmentState: string; segmentRevision: number }) => [
          e.position,
          e.segmentState,
          e.segmentRevision,
        ],
      ),
    ).toEqual([
      [1, 'active', 1],
      [2, 'active', 1],
      [3, 'retired', 2],
    ]);
    expect(res.body.data[0].latestJob.id).toBe(second.body.data.id);
    expect(res.body.data[0].latestJob.latestQc).toMatchObject({ qcState: 'passed', reason: null });
    expect(res.body.data[0].latestJob.qcHistory.map((q: { qcState: string }) => q.qcState)).toEqual(
      ['passed', 'failed'],
    );
    expect(res.body.data[1].latestJob).toBeNull();
    const read = await call('GET', `/video-jobs/${first.body.data.id}`, a.token);
    expect(one(read.body)).toBe(true);
    expect(read.body.data).toMatchObject({
      state: 'failed',
      label: 'failed',
      causeClass: 'credit',
      reused: false,
    });
    expect((await call('GET', `/campaigns/${c.campaign}/video-jobs`, a.token)).status).toBe(200);
  });

  it('is owner scoped: a stranger, an unknown ID and a deleting campaign are the single 404', async () => {
    const a = await account();
    const b = await account();
    const c = await campaign(a.id);
    const made = await post(`/campaigns/${c.campaign}/segments/1/jobs`, a.token, 's1');
    const answers = [
      await call('GET', `/video-jobs/${made.body.data.id}`, b.token),
      await call('GET', `/video-jobs/${randomUUID()}`, a.token),
      await call('GET', `/campaigns/${c.campaign}/video-jobs`, b.token),
      await call('GET', `/campaigns/${randomUUID()}/video-jobs`, a.token),
      await post(`/video-jobs/${made.body.data.id}/retry`, b.token, 's2'),
      await post(`/video-jobs/${randomUUID()}/retry`, a.token, 's3'),
    ];
    for (const res of answers)
      expect([res.status, res.body.error?.code]).toEqual([404, 'not_found']);
    await pool.query(`update campaigns set state = 'deleting' where id = $1`, [c.campaign]);
    expect((await call('GET', `/video-jobs/${made.body.data.id}`, a.token)).status).toBe(404);
    expect((await call('GET', `/campaigns/${c.campaign}/video-jobs`, a.token)).status).toBe(404);
    expect((await call('GET', `/video-jobs/not-a-uuid`, a.token)).status).toBe(400);
  });

  it('an accepted brief that has no segments yet lists nothing', async () => {
    const a = await account();
    const c = await campaign(a.id, { brief: 'generating', segments: 0 });
    const res = await call('GET', `/campaigns/${c.campaign}/video-jobs`, a.token);
    expect([res.status, res.body.data]).toEqual([200, []]);
  });
});

describe('API-063 retry', () => {
  const valid = contractValidator('VideoJobResponse');

  it('a failed or cancelled clip gets a new row and a new reservation; no automatic retry; other states are 409 (TC-CLP-05)', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const made = await post(`/campaigns/${c.campaign}/segments/1/jobs`, a.token, 'orig');
    const id = made.body.data.id as string;
    const early = await post(`/video-jobs/${id}/retry`, a.token, 'early');
    expect([early.status, early.body.error?.code]).toEqual([409, 'state_conflict']);
    await pool.query(
      `update video_jobs set state = 'failed', cause_class = 'temporary' where id = $1`,
      [id],
    );
    await pool.query(`delete from spend_reservations where job_id = $1`, [id]);
    expect(await jobsOf(a.id)).toBe(1);
    const retried = await post(`/video-jobs/${id}/retry`, a.token, 'retry-1');
    expect(retried.status).toBe(202);
    expect(valid(retried.body)).toBe(true);
    expect(retried.body.data).toMatchObject({ state: 'pending', reused: false });
    expect(retried.body.data.id).not.toBe(id);
    expect(await jobsOf(a.id)).toBe(2);
    expect(
      (await pool.query('select state from video_jobs where id = $1', [id])).rows[0].state,
    ).toBe('failed');
    expect(await reservations(a.id)).toBe(1);
    expect(await queued(retried.body.data.id)).toBe(1);
    const replay = await post(`/video-jobs/${id}/retry`, a.token, 'retry-1');
    expect([replay.body.data.id, replay.body.data.reused]).toEqual([retried.body.data.id, true]);
    const again = await post(`/video-jobs/${id}/retry`, a.token, 'retry-2');
    expect([again.body.data.id, again.body.data.reused]).toEqual([retried.body.data.id, true]);
    expect(await jobsOf(a.id)).toBe(2);
    await pool.query(
      `update video_jobs set state = 'cancelled', cause_class = 'cancelled_campaign_deleted' where id = $1`,
      [retried.body.data.id],
    );
    expect(
      (await post(`/video-jobs/${retried.body.data.id}/retry`, a.token, 'retry-3')).status,
    ).toBe(202);
    expect((await post(`/video-jobs/${id}/retry`, a.token)).status).toBe(400);
  });

  it('keeps the checks of a new job: accepted brief, active segment, key, cap and the current segment text', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const made = await post(`/campaigns/${c.campaign}/segments/1/jobs`, a.token, 'orig');
    const id = made.body.data.id as string;
    await pool.query(
      `update video_jobs set state = 'failed', cause_class = 'temporary' where id = $1`,
      [id],
    );
    await pool.query(`update brief_segments set prompt = 'Rewritten', revision = 2 where id = $1`, [
      c.segments[0],
    ]);
    await pool.query(`update briefs set state = 'draft', accepted_at = null where id = $1`, [
      c.brief,
    ]);
    const draft = await post(`/video-jobs/${id}/retry`, a.token, 'r-draft');
    expect([draft.status, draft.body.error?.code]).toEqual([422, 'brief_not_accepted']);
    await pool.query(`update briefs set state = 'accepted', accepted_at = now() where id = $1`, [
      c.brief,
    ]);
    await pool.query(`delete from provider_keys where owner_id = $1`, [a.id]);
    const none = await post(`/video-jobs/${id}/retry`, a.token, 'r-key');
    expect([none.status, none.body.error?.code]).toEqual([422, 'key_missing']);
    expect(await jobsOf(a.id)).toBe(1);
    await pool.query(
      `insert into provider_keys (id, owner_id, provider, status, version, ciphertext, nonce, wrapped_dek, kek_version, last4, fingerprint, fingerprint_pepper_version)
       values ($1, $2, 'wavespeed', 'active', 1, $3, $4, $5, 1, 'cdef', $6, 1)`,
      [
        randomUUID(),
        a.id,
        Buffer.alloc(32, 1),
        Buffer.alloc(12, 2),
        Buffer.alloc(384, 3),
        'c'.repeat(64),
      ],
    );
    const ok = await post(`/video-jobs/${id}/retry`, a.token, 'r-ok');
    expect(ok.status).toBe(202);
    expect(ok.body.data.segmentRevision).toBe(2);
  });
});

describe('service operations and the campaign progress reader', () => {
  it('derives progress for campaigns and the filters (TD-D12) from the same tables', async () => {
    const a = await account();
    const none = await campaign(a.id);
    const running = await campaign(a.id);
    const broken = await campaign(a.id);
    const failedBrief = await campaign(a.id, { brief: 'failed' });
    const made = await post(`/campaigns/${running.campaign}/segments/1/jobs`, a.token, 'p1');
    const lost = await post(`/campaigns/${broken.campaign}/segments/1/jobs`, a.token, 'p2');
    await pool.query(
      `update video_jobs set state = 'failed', cause_class = 'temporary' where id = $1`,
      [lost.body.data.id],
    );
    const reader = app.get(VideoProgressReader, { strict: false });
    const ids = [none, running, broken, failedBrief].map((c) => c.campaign);
    const snapshots = await reader.progressFor(a.id, ids);
    expect(
      [none, running, broken, failedBrief].map((c) => snapshots.get(c.campaign)?.progress),
    ).toEqual(['in_progress', 'processing', 'failed', 'failed']);
    expect(snapshots.get(running.campaign)?.jobCounts).toEqual({ pending: 1 });
    expect(snapshots.get(failedBrief.campaign)?.briefState).toBe('failed');
    expect([...(await reader.idsWithProgress(a.id, 'processing'))]).toEqual([running.campaign]);
    expect([...(await reader.idsWithProgress(a.id, 'failed'))].sort()).toEqual(
      [broken.campaign, failedBrief.campaign].sort(),
    );
    expect((await reader.idsWithProgress(a.id, 'completed')).size).toBe(0);
    expect((await reader.progressFor(a.id, [])).size).toBe(0);
    expect(made.status).toBe(202);
  });

  it('counts jobs in flight per key, cancels for a campaign and an owner with the reservations settled, and reports stats', async () => {
    const a = await account();
    const c = await campaign(a.id, { segments: 3 });
    const service = app.get(VideoJobsService, { strict: false });
    const pending = await post(`/campaigns/${c.campaign}/segments/1/jobs`, a.token, 'c1');
    const sent = await post(`/campaigns/${c.campaign}/segments/2/jobs`, a.token, 'c2');
    const done = await post(`/campaigns/${c.campaign}/segments/3/jobs`, a.token, 'c3');
    await pool.query(
      `update video_jobs set state = 'submitting', submitting_at = now(), call_count = 1 where id = $1`,
      [sent.body.data.id],
    );
    await pool.query(`update video_jobs set state = 'completed' where id = $1`, [
      done.body.data.id,
    ]);
    await pool.query(
      `insert into qc_runs (id, owner_id, video_job_id, state, reuse_hash, deadline_at) values ($1, $2, $3, 'pending', $4, now())`,
      [randomUUID(), a.id, done.body.data.id, 'z'.repeat(64)],
    );
    expect(await service.inFlightForKey(a.id, 'wavespeed')).toBe(2);
    expect(await service.inFlightForKey(a.id, 'openai')).toBe(1);
    const stats = await service.jobStats(new Date(Date.now() - 60_000));
    expect(stats.videoCreated).toBeGreaterThanOrEqual(3);
    expect(stats.qcCreated).toBeGreaterThanOrEqual(1);
    // jobStatsWindow: [from, to) boundaries, empty window and tenant isolation.
    const ids = [pending.body.data.id, sent.body.data.id, done.body.data.id];
    const stamp = new Date('2031-03-01T00:00:00.000Z');
    await pool.query(`update video_jobs set created_at = $2, updated_at = $2 where id = $1`, [
      ids[0],
      stamp.toISOString(),
    ]);
    await pool.query(`update video_jobs set created_at = $2, updated_at = $2 where id = $1`, [
      ids[2],
      new Date(stamp.getTime() + 1000).toISOString(),
    ]);
    const end = new Date(stamp.getTime() + 1000);
    const w1 = await service.jobStatsWindow(stamp, end, a.id);
    expect(w1.videoCreated).toBe(1); // `from` inclusive, `to` exclusive
    expect(w1.windowStart).toBe(stamp.toISOString());
    expect(w1.windowEnd).toBe(end.toISOString());
    expect(
      (await service.jobStatsWindow(stamp, new Date(end.getTime() + 1), a.id)).videoCompleted,
    ).toBe(1);
    expect(
      (await service.jobStatsWindow(new Date(stamp.getTime() + 1), end, a.id)).videoCreated,
    ).toBe(0);
    const empty = await service.jobStatsWindow(
      new Date('2040-01-01T00:00:00Z'),
      new Date('2040-01-02T00:00:00Z'),
      a.id,
    );
    expect(empty).toMatchObject({
      videoCreated: 0,
      videoCompleted: 0,
      videoFailed: 0,
      videoCancelled: 0,
      qcCreated: 0,
    });
    const other = await account();
    expect(
      (await service.jobStatsWindow(stamp, new Date(end.getTime() + 1), other.id)).videoCreated,
    ).toBe(0);
    const cancelled = await withTx((tx) => service.cancelForCampaign(tx, a.id, c.campaign));
    expect(cancelled).toBe(3);
    const rows = (
      await pool.query(`select id, state, cause_class from video_jobs where owner_id = $1`, [a.id])
    ).rows as { id: string; state: string; cause_class: string | null }[];
    expect(
      rows
        .filter((r) => r.state === 'cancelled')
        .map((r) => r.id)
        .sort(),
    ).toEqual([pending.body.data.id, sent.body.data.id].sort());
    expect(
      rows.every((r) => r.state !== 'cancelled' || r.cause_class === 'cancelled_campaign_deleted'),
    ).toBe(true);
    expect(
      (await pool.query(`select state from qc_runs where owner_id = $1`, [a.id])).rows[0].state,
    ).toBe('cancelled');
    // Only the clip the test forced to completed still holds its reservation (the worker settles that one).
    expect(
      (await pool.query(`select job_id from spend_reservations where owner_id = $1`, [a.id])).rows,
    ).toEqual([{ job_id: done.body.data.id }]);
    // The call that was in `submitting` keeps its estimate counted as unconfirmed; the pending one counts nothing.
    expect(
      (await pool.query(`select outcome, job_id from usage_events where owner_id = $1`, [a.id]))
        .rows,
    ).toEqual([{ outcome: 'unconfirmed', job_id: sent.body.data.id }]);
    const again = await post(`/campaigns/${c.campaign}/segments/1/jobs`, a.token, 'c4');
    expect(again.status).toBe(202);
    expect(
      await withTx((tx) => service.cancelForOwner(tx, a.id, 'cancelled_account_suspended')),
    ).toBe(1);
    expect(
      (await pool.query(`select cause_class from video_jobs where id = $1`, [again.body.data.id]))
        .rows[0].cause_class,
    ).toBe('cancelled_account_suspended');
    expect(await service.inFlightForKey(a.id, 'wavespeed')).toBe(0);
  });
});

const withTx = <T>(body: (tx: DbTx) => Promise<T>): Promise<T> =>
  app.get<Database>(DATABASE, { strict: false }).uow.run(body);
