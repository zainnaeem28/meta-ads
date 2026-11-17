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

// TASK-055 (production 4/6) through the real api composition root (`createApiApp`, the one `main.api.ts` runs) with
// `fastify.inject` on real PostgreSQL: API-070 create an assembly and API-071 read it.
// TC-ASM-02, 03, 05, 07, with the QC confirmation rules (REQ-010, TD-D35, TD-D36) and the daily render limit (NFR-11).

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
  testDb = await createTestDatabase({ label: 'task055api', migrations: false });
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
  ];
  for (const file of files) for (const statement of statements(file)) await pool.query(statement);
  await installJobs(testDb.url);
  await runSeed({ dataset: 'reference', appEnv: 'development', databaseUrl: testDb.url, steps: [priceTableSeedStep()] });
  const env: Record<string, string | undefined> = {
    KEK_PUBLIC_KEYS: undefined,
    R2_ENDPOINT: undefined,
    OWNER_EMAIL: 'owner55@example.test',
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

async function account(keys: 'openai' | 'none' | 'disabled' = 'openai') {
  const sub = `user_t55_${String(++seq)}`;
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



async function completedClip(owner: string, setup: Setup, state = 'completed'): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into video_jobs (id, owner_id, campaign_id, segment_id, segment_revision, provider_model, options, state, reuse_hash, deadline_at, provider_task_id, provider_completed_at)
     values ($1, $2, $3, $4, 1, 'bytedance/seedance-2.0/text-to-video', '{"durationSeconds":15,"resolution":"1080p","aspectRatio":"9:16"}', $5, $6, now(), 'task-1', now())`,
    [id, owner, setup.campaign, setup.segments[0], state, randomUUID().replace(/-/g, '').padEnd(64, '0')],
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
  (await pool.query(`select count(*)::int as n from ${table} where ${where}`, params)).rows[0].n as number;
const queued = (assembly: string) => count('pgboss.job', "name = 'production.assembly-render' and data->>'jobId' = $1", [assembly]);

async function qc(job: string, state: 'pending' | 'passed' | 'failed' | 'skipped', ageSeconds = 0): Promise<void> {
  await pool.query(
    `insert into qc_runs (id, owner_id, video_job_id, qc_state, state, reuse_hash, deadline_at, created_at)
     select $1, owner_id, id, $2, 'completed', $3, now(), now() - make_interval(secs => $4) from video_jobs where id = $5`,
    [randomUUID(), state, randomUUID().replace(/-/g, '').padEnd(64, '0'), ageSeconds, job],
  );
}

const postAsm = (campaignId: string, token: string | undefined, key: string | undefined, payload: unknown) =>
  call('POST', `/campaigns/${campaignId}/assemblies`, token, payload, key === undefined ? {} : { 'idempotency-key': key });

/** A completed clip of segment `index` of the campaign (a new one for the same segment is a regenerated clip). */
async function clip(owner: string, setup: Setup, index = 0, createdAgoSeconds = 0): Promise<string> {
  const id = await completedClip(owner, setup);
  await pool.query(`update video_jobs set segment_id = $2, created_at = now() - make_interval(secs => $3) where id = $1`, [id, setup.segments[index], createdAgoSeconds]);
  return id;
}

describe('API-070 create an assembly, API-071 read it', () => {
  const valid = contractValidator('AssemblyResponse');

  it('creates one pending assembly with its clips in order and a queue message, through the real entry point (TC-ASM-01)', async () => {
    const a = await account();
    const c = await campaign(a.id, { segments: 4 });
    const clips = [await clip(a.id, c, 2), await clip(a.id, c, 0), await clip(a.id, c, 3), await clip(a.id, c, 1)];
    const res = await postAsm(c.campaign, a.token, 'asm-1', { clips });
    expect(res.status).toBe(202);
    expect(valid(res.body)).toBe(true);
    expect(res.body.data).toMatchObject({ campaignId: c.campaign, state: 'pending', thumbstopperJobId: null, outputMediaId: null, outOfDate: false, causeClass: null, reused: false });
    expect(res.body.data.clips).toEqual(clips.map((videoJobId, i) => ({ position: i + 1, videoJobId, outOfDate: false, qcOverrideConfirmed: false })));
    const row = (await pool.query('select * from assembly_jobs where id = $1', [res.body.data.id])).rows[0];
    expect(row).toMatchObject({ owner_id: a.id, campaign_id: c.campaign, state: 'pending', attempts: 0 });
    expect(row.render_day.toISOString().slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    expect(await count('assembly_clips', 'assembly_job_id = $1', [row.id])).toBe(4);
    expect(await queued(row.id)).toBe(1);

    const read = await call('GET', `/assemblies/${row.id}`, a.token);
    expect(read.status).toBe(200);
    expect(valid(read.body)).toBe(true);
    expect(read.body.data).toMatchObject({ id: row.id, state: 'pending', reused: false, outOfDate: false });
    expect(read.body.data.clips.map((x: { videoJobId: string }) => x.videoJobId)).toEqual(clips);
  });

  it('reuses a matching assembly that is not failed, and makes a new one after a failure (TC-ASM-02, TC-ASM-04)', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const clips = [await clip(a.id, c, 0), await clip(a.id, c, 1)];
    const first = await postAsm(c.campaign, a.token, 'reuse-1', { clips });
    const same = await postAsm(c.campaign, a.token, 'reuse-2', { clips });
    expect(same.status).toBe(202);
    expect(same.body.data).toMatchObject({ id: first.body.data.id, reused: true });
    expect(await count('assembly_jobs', 'campaign_id = $1', [c.campaign])).toBe(1);
    expect(await queued(first.body.data.id)).toBe(1);
    const other = await postAsm(c.campaign, a.token, 'reuse-3', { clips: [...clips].reverse() });
    expect(other.body.data.reused).toBe(false);
    expect(other.body.data.id).not.toBe(first.body.data.id);

    await pool.query(`update assembly_jobs set state = 'failed', cause_class = 'render_failed', cause_message = 'The clip could not be read.' where id = $1`, [first.body.data.id]);
    const failed = await call('GET', `/assemblies/${first.body.data.id}`, a.token);
    expect(valid(failed.body)).toBe(true);
    expect(failed.body.data).toMatchObject({ state: 'failed', causeClass: 'render_failed', causeMessage: 'The clip could not be read.' });
    const again = await postAsm(c.campaign, a.token, 'reuse-4', { clips });
    expect(again.body.data).toMatchObject({ reused: false, state: 'pending' });
    expect(again.body.data.id).not.toBe(first.body.data.id);
  });

  it('replays a key and request without a second row; the same key for another request is 409', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const [x, y] = [await clip(a.id, c, 0), await clip(a.id, c, 1)];
    const first = await postAsm(c.campaign, a.token, 'idem', { clips: [x] });
    const again = await postAsm(c.campaign, a.token, 'idem', { clips: [x] });
    expect(again.status).toBe(202);
    expect(again.body.data).toMatchObject({ id: first.body.data.id, reused: true });
    const clash = await postAsm(c.campaign, a.token, 'idem', { clips: [y] });
    expect([clash.status, clash.body.error?.code]).toEqual([409, 'idempotency_key_reused']);
    expect(await count('assembly_jobs', 'campaign_id = $1', [c.campaign])).toBe(1);
  });

  it('refuses a clip that is not completed, missing, of another campaign or another owner (422 clip_not_completed, TC-ASM-03)', async () => {
    const a = await account();
    const b = await account();
    const c = await campaign(a.id);
    const other = await campaign(a.id);
    const good = await clip(a.id, c, 0);
    const stranger = await clip(b.id, await campaign(b.id), 0);
    const elsewhere = await clip(a.id, other, 0);
    const unfinished: string[] = [];
    for (const state of ['pending', 'processing', 'failed', 'cancelled']) unfinished.push(await completedClip(a.id, c, state));
    for (const bad of [...unfinished, stranger, elsewhere, randomUUID()]) {
      const res = await postAsm(c.campaign, a.token, `nc-${bad}`, { clips: [good, bad] });
      expect([res.status, res.body.error?.code]).toEqual([422, 'clip_not_completed']);
      expect(res.body.error?.details).toEqual([expect.objectContaining({ field: 'clips[1]', code: 'clip_not_completed' })]);
    }
    expect(await count('assembly_jobs', 'owner_id = $1', [a.id])).toBe(0);
    expect(await count('idempotency_records', 'owner_id = $1', [a.id])).toBe(0);
  });

  it('answers 404 for a missing, foreign or deleting campaign, and for a thumbstopper that cannot exist yet', async () => {
    const a = await account();
    const b = await account();
    const c = await campaign(a.id);
    const good = await clip(a.id, c, 0);
    expect((await postAsm(randomUUID(), a.token, 'nf-1', { clips: [good] })).status).toBe(404);
    expect((await postAsm(c.campaign, b.token, 'nf-2', { clips: [good] })).status).toBe(404);
    const thumb = await postAsm(c.campaign, a.token, 'nf-3', { clips: [good], thumbstopperJobId: randomUUID() });
    expect([thumb.status, thumb.body.error?.code]).toEqual([404, 'not_found']);
    await pool.query(`update campaigns set state = 'deleting' where id = $1`, [c.campaign]);
    expect((await postAsm(c.campaign, a.token, 'nf-4', { clips: [good] })).status).toBe(404);
    expect(await count('assembly_jobs', 'owner_id = $1', [a.id])).toBe(0);
  });

  describe('QC confirmation (REQ-010)', () => {
    it('refuses a failed or skipped latest QC without a confirmation, naming the clip (422 qc_confirmation_required)', async () => {
      const a = await account();
      const c = await campaign(a.id, { segments: 4 });
      const ok = await clip(a.id, c, 0);
      for (const [i, state] of (['failed', 'skipped'] as const).entries()) {
        const bad = await clip(a.id, c, i + 1);
        await qc(bad, state);
        const res = await postAsm(c.campaign, a.token, `qc-${state}`, { clips: [ok, bad] });
        expect([res.status, res.body.error?.code]).toEqual([422, 'qc_confirmation_required']);
        expect(res.body.error?.details).toEqual([expect.objectContaining({ field: 'clips[1]' })]);
      }
      expect(await count('assembly_jobs', 'owner_id = $1', [a.id])).toBe(0);
    });

    it('records the confirmation of a failed or skipped clip, and only of those', async () => {
      const a = await account();
      const c = await campaign(a.id, { segments: 4 });
      const [failed, skipped, passed, pending] = [await clip(a.id, c, 0), await clip(a.id, c, 1), await clip(a.id, c, 2), await clip(a.id, c, 3)];
      await qc(failed, 'failed');
      await qc(skipped, 'skipped');
      await qc(passed, 'passed');
      await qc(pending, 'pending');
      const res = await postAsm(c.campaign, a.token, 'qc-ok', { clips: [failed, skipped, passed, pending], confirmations: { qcOverride: [failed, skipped, passed, pending] } });
      expect(res.status).toBe(202);
      expect(res.body.data.clips.map((x: { qcOverrideConfirmed: boolean }) => x.qcOverrideConfirmed)).toEqual([true, true, false, false]);
      const stored = await pool.query('select position, qc_override_confirmed from assembly_clips where assembly_job_id = $1 order by position', [res.body.data.id]);
      expect(stored.rows.map((r) => r.qc_override_confirmed)).toEqual([true, true, false, false]);
    });

    it('needs no confirmation for a pending QC or a clip with no QC row; a confirmation sent anyway is ignored', async () => {
      const a = await account();
      const c = await campaign(a.id, { segments: 3 });
      const [pending, bare, passed] = [await clip(a.id, c, 0), await clip(a.id, c, 1), await clip(a.id, c, 2)];
      await qc(pending, 'pending');
      await qc(passed, 'passed');
      const res = await postAsm(c.campaign, a.token, 'qc-pending', { clips: [pending, bare, passed], confirmations: { qcOverride: [pending, passed] } });
      expect(res.status).toBe(202);
      expect(res.body.data.clips.every((x: { qcOverrideConfirmed: boolean }) => !x.qcOverrideConfirmed)).toBe(true);
    });

    it('reads the latest QC, so a re-run that passed after a failure needs no confirmation', async () => {
      const a = await account();
      const c = await campaign(a.id);
      const job = await clip(a.id, c, 0);
      await qc(job, 'failed', 60);
      await qc(job, 'passed', 0);
      expect((await postAsm(c.campaign, a.token, 'qc-latest', { clips: [job] })).status).toBe(202);
      const second = await clip(a.id, c, 1);
      await qc(second, 'passed', 60);
      await qc(second, 'failed', 0);
      expect((await postAsm(c.campaign, a.token, 'qc-latest-2', { clips: [second] })).status).toBe(422);
    });

    it('answers 400 at confirmations.qcOverride[i] for an ID that is not in clips, creating nothing', async () => {
      const a = await account();
      const c = await campaign(a.id);
      const job = await clip(a.id, c, 0);
      const foreign = randomUUID();
      const res = await postAsm(c.campaign, a.token, 'qc-foreign', { clips: [job], confirmations: { qcOverride: [job, foreign] } });
      expect([res.status, res.body.error?.code]).toEqual([400, 'validation_failed']);
      expect(res.body.error?.details).toEqual([expect.objectContaining({ field: 'confirmations.qcOverride[1]' })]);
      expect(await count('assembly_jobs', 'owner_id = $1', [a.id])).toBe(0);
    });
  });

  describe('daily render limit (NFR-11, TC-ASM-07)', () => {
    const seed = async (owner: string, setup: Setup, n: number, day: string) => {
      for (let i = 0; i < n; i += 1) {
        await pool.query(
          `insert into assembly_jobs (id, owner_id, campaign_id, state, reuse_hash, render_day) values ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), owner, setup.campaign, i % 2 === 0 ? 'done' : 'failed', randomUUID().replace(/-/g, '').padEnd(64, '1'), day],
        );
      }
    };
    const today = () => new Date().toISOString().slice(0, 10);

    it('refuses the 21st new render in a UTC day, counting failed ones; reuse is not counted; yesterday is not', async () => {
      const a = await account();
      const c = await campaign(a.id, { segments: 4 });
      const clips = [await clip(a.id, c, 0), await clip(a.id, c, 1), await clip(a.id, c, 2)];
      await seed(a.id, c, 5, '2000-01-01');
      await seed(a.id, c, 18, today());
      expect((await postAsm(c.campaign, a.token, 'lim-1', { clips: [clips[0]] })).status).toBe(202);
      const last = await postAsm(c.campaign, a.token, 'lim-2', { clips: [clips[1]] });
      expect(last.status).toBe(202);
      expect(await count('assembly_jobs', 'owner_id = $1 and render_day = $2', [a.id, today()])).toBe(20);
      const refused = await postAsm(c.campaign, a.token, 'lim-3', { clips: [clips[2]] });
      expect([refused.status, refused.body.error?.code]).toEqual([422, 'assembly_daily_limit']);
      expect(refused.body.error?.message).toContain('20 renders');
      expect(await count('assembly_jobs', 'owner_id = $1', [a.id])).toBe(25);
      expect(await count('idempotency_records', "owner_id = $1 and key = 'lim-3'", [a.id])).toBe(0);
      // The same work again is the existing assembly, not a new render.
      const reused = await postAsm(c.campaign, a.token, 'lim-4', { clips: [clips[1]] });
      expect(reused.body.data).toMatchObject({ id: last.body.data.id, reused: true });
      // The next UTC day starts again from zero.
      await pool.query(`update assembly_jobs set render_day = '2000-01-02' where owner_id = $1 and render_day = $2`, [a.id, today()]);
      expect((await postAsm(c.campaign, a.token, 'lim-5', { clips: [clips[2]] })).status).toBe(202);
    });

    it('counts each owner on their own, and two requests at once cannot pass the limit together', async () => {
      const a = await account();
      const b = await account();
      const c = await campaign(a.id, { segments: 4 });
      const d = await campaign(b.id);
      const clips = [await clip(a.id, c, 0), await clip(a.id, c, 1)];
      await seed(a.id, c, 19, today());
      const [x, y] = await Promise.all([postAsm(c.campaign, a.token, 'race-1', { clips: [clips[0]] }), postAsm(c.campaign, a.token, 'race-2', { clips: [clips[1]] })]);
      expect([x.status, y.status].sort()).toEqual([202, 422]);
      expect(await count('assembly_jobs', 'owner_id = $1 and render_day = $2', [a.id, today()])).toBe(20);
      expect((await postAsm(d.campaign, b.token, 'other-owner', { clips: [await clip(b.id, d, 0)] })).status).toBe(202);
    });
  });

  it('two requests with different keys for the same clips make one assembly', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const clips = [await clip(a.id, c, 0), await clip(a.id, c, 1)];
    const [x, y] = await Promise.all([postAsm(c.campaign, a.token, 'same-1', { clips }), postAsm(c.campaign, a.token, 'same-2', { clips })]);
    expect([x.status, y.status]).toEqual([202, 202]);
    expect(x.body.data.id).toBe(y.body.data.id);
    expect(await count('assembly_jobs', 'campaign_id = $1', [c.campaign])).toBe(1);
    expect(await queued(x.body.data.id)).toBe(1);
  });

  describe('out of date, derived at read (SB-D11, TC-ASM-05)', () => {
    it('is false until a selected segment moves on, then true for that clip and the assembly', async () => {
      const a = await account();
      const c = await campaign(a.id);
      const [one, two] = [await clip(a.id, c, 0, 100), await clip(a.id, c, 1, 100)];
      const made = await postAsm(c.campaign, a.token, 'ood-1', { clips: [one, two] });
      const path = `/assemblies/${made.body.data.id}`;
      expect((await call('GET', path, a.token)).body.data.outOfDate).toBe(false);
      await pool.query('update brief_segments set revision = revision + 1 where id = $1', [c.segments[1]]);
      const stale = (await call('GET', path, a.token)).body.data;
      expect(stale.outOfDate).toBe(true);
      expect(stale.clips.map((x: { outOfDate: boolean }) => x.outOfDate)).toEqual([false, true]);
    });

    it('is true when a newer clip of a selected segment has completed', async () => {
      const a = await account();
      const c = await campaign(a.id);
      const one = await clip(a.id, c, 0, 100);
      const made = await postAsm(c.campaign, a.token, 'ood-2', { clips: [one] });
      await clip(a.id, c, 1, 0);
      expect((await call('GET', `/assemblies/${made.body.data.id}`, a.token)).body.data.outOfDate).toBe(false);
      await clip(a.id, c, 0, 0);
      expect((await call('GET', `/assemblies/${made.body.data.id}`, a.token)).body.data.outOfDate).toBe(true);
    });
  });

  it('shows the output media ID once the assembly is done (TC-ASM-01)', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const made = await postAsm(c.campaign, a.token, 'done-1', { clips: [await clip(a.id, c, 0)] });
    const media = randomUUID();
    await pool.query(`insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, campaign_id) values ($1, $2, 'final', 'ready', $3, 10, 'video/mp4', $4)`, [media, a.id, `u/${a.id}/c/${c.campaign}/final/${media}.mp4`, c.campaign]);
    await pool.query(`update assembly_jobs set state = 'done', output_media_id = $2 where id = $1`, [made.body.data.id, media]);
    const read = await call('GET', `/assemblies/${made.body.data.id}`, a.token);
    expect(valid(read.body)).toBe(true);
    expect(read.body.data).toMatchObject({ state: 'done', outputMediaId: media });
  });

  it('answers 404 on read for a missing, foreign or deleting-campaign assembly', async () => {
    const a = await account();
    const b = await account();
    const c = await campaign(a.id);
    const made = await postAsm(c.campaign, a.token, 'read-1', { clips: [await clip(a.id, c, 0)] });
    expect((await call('GET', `/assemblies/${randomUUID()}`, a.token)).status).toBe(404);
    const foreign = await call('GET', `/assemblies/${made.body.data.id}`, b.token);
    expect([foreign.status, foreign.body.error?.code]).toEqual([404, 'not_found']);
    await pool.query(`update campaigns set state = 'deleting' where id = $1`, [c.campaign]);
    expect((await call('GET', `/assemblies/${made.body.data.id}`, a.token)).status).toBe(404);
  });

  it('validates the body, the key header, the paths and the session', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const job = await clip(a.id, c, 0);
    const bad: unknown[] = [
      {},
      { clips: [] },
      { clips: [job, job] },
      { clips: [job], extra: 1 },
      { clips: ['nope'] },
      { clips: [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()] },
      { clips: [job], confirmations: { qcOverride: [job, job] } },
      { clips: [job], confirmations: { other: [] } },
    ];
    for (const [i, payload] of bad.entries()) {
      const res = await postAsm(c.campaign, a.token, `v-${String(i)}`, payload);
      expect([res.status, res.body.error?.code]).toEqual([400, 'validation_failed']);
    }
    expect((await postAsm(c.campaign, a.token, undefined, { clips: [job] })).status).toBe(400);
    expect((await postAsm('not-a-uuid', a.token, 'v-p', { clips: [job] })).status).toBe(400);
    expect((await call('GET', '/assemblies/not-a-uuid', a.token)).status).toBe(400);
    expect((await postAsm(c.campaign, undefined, 'v-s', { clips: [job] })).status).toBe(401);
    expect((await call('GET', `/assemblies/${randomUUID()}`)).status).toBe(401);
    expect(await count('assembly_jobs', 'owner_id = $1', [a.id])).toBe(0);
  });
});
