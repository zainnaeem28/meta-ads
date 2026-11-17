/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles; prettier reflow detached the per-line directives (AIU-256) */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { ModulesContainer } from '@nestjs/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../../bootstrap/api.module.js';
import {
  REAL_MIGRATIONS,
  adminUrl,
  createTestDatabase,
} from '../../../platform/db/test-database.js';
import type { TestDatabase } from '../../../platform/db/test-database.js';
import { installJobs } from '../../../platform/jobs/test-support.js';
import { createHttpLogging } from '../../../platform/logging/index.js';
import { STORAGE_PORT, uploadKey } from '../../media/index.js';
import type { StoragePort } from '../../media/index.js';

// TASK-046 (campaigns 1/2) through the real api composition root (`createApiApp`, the one `main.api.ts` runs) with
// `fastify.inject` on real PostgreSQL and a real MinIO server: M0008 as written, API-020 to API-023 and API-025, the
// ETag and If-Match rules, owner concealment, media attach and detach, deletion of the draft and its image, the
// 30/min and 60/min limits and the runtime grants. TC-INT-01..07, TC-DEL (draft), TC-AUT (draft ownership).

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

interface TestBucket {
  readonly endpoint: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly bucket: string;
  stop(): Promise<void>;
}

/** A throwaway MinIO server with one private bucket; the server start-up is the foundation tests' (`tools/`), loaded at run time. */
async function startTestBucket(bucket = 'app'): Promise<TestBucket> {
  const url = pathToFileURL(
    join(contractsDir, '..', '..', 'tools', 'foundation-tests', 'media', 'minio.ts'),
  ).href;
  const { startMinio } = (await import(/* @vite-ignore */ url)) as {
    startMinio(): Promise<Omit<TestBucket, 'bucket'>>;
  };
  const minioServer = await startMinio();
  const admin = new S3Client({
    region: 'us-east-1',
    endpoint: minioServer.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: minioServer.accessKey, secretAccessKey: minioServer.secretKey },
  });
  await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  admin.destroy();
  return { ...minioServer, bucket };
}

let testDb: TestDatabase;
let pool: pg.Pool;
let minio: TestBucket;
let app: Awaited<ReturnType<typeof createApiApp>>['app'];
let storage: StoragePort;
let seq = 0;
const roleName = `app_api_t046_${randomBytes(4).toString('hex')}`;
const rolePassword = randomBytes(12).toString('hex');
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

/** A migration's statements, `tables` before `-- Grants` and `grants` after it, with the runtime role renamed. */
function statementsOf(file: string, part: 'tables' | 'grants'): string[] {
  const [tables = '', grants = ''] = readFileSync(join(REAL_MIGRATIONS, file), 'utf8').split(
    '-- Grants',
  );
  const body = part === 'tables' ? tables : grants.slice(grants.indexOf('\n'));
  return body
    .split('--> statement-breakpoint')
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .replace(/\bapp_api\b/g, roleName)
        .replace(/, app_worker\b/g, '')
        .trim(),
    )
    .filter((statement) => statement !== '');
}

beforeAll(async () => {
  minio = await startTestBucket();
  testDb = await createTestDatabase({ label: 'task046', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 6 });
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE ROLE "${roleName}" LOGIN NOSUPERUSER PASSWORD '${rolePassword}'`);
  await admin.end();
  for (const statement of statementsOf('0001_task-025-platform.sql', 'tables')) {
    if (
      /^CREATE (TABLE|INDEX|UNIQUE INDEX) "?(idempotency_records|rate_limit_buckets)/.test(
        statement,
      )
    )
      await pool.query(statement);
  }
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm'); // M0001 creates it; this suite applies only the tables it needs
  for (const file of [
    '0010_task-032-audit.sql',
    '0020_task-033-identity.sql',
    '0040_task-041-media.sql',
    '0070_task-046-campaigns.sql',
  ]) {
    for (const statement of statementsOf(file, 'tables')) await pool.query(statement);
  }
  await pool.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
  for (const file of ['0040_task-041-media.sql', '0070_task-046-campaigns.sql']) {
    for (const statement of statementsOf(file, 'grants')) await pool.query(statement);
  }
  await installJobs(testDb.url);
  const env: Record<string, string | undefined> = {
    KEK_PUBLIC_KEYS: undefined,
    KEK_PRIVATE_KEYS: undefined,
    R2_ENDPOINT: minio.endpoint,
    R2_BUCKET: minio.bucket,
    R2_ACCESS_KEY_ID: minio.accessKey,
    R2_SECRET_ACCESS_KEY: minio.secretKey,
    STORAGE_PUBLIC_ORIGIN: minio.endpoint,
    OWNER_EMAIL: 'owner46@example.test',
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
    createHttpLogging({ level: 'silent' }),
  ));
  const providers = [...app.get(ModulesContainer, { strict: false }).values()].flatMap((m) => [
    ...m.providers.values(),
  ]);
  const found = providers
    .map((p) => p.instance as Partial<Local> | undefined)
    .find((i) => typeof i?.issueToken === 'function');
  if (found === undefined) throw new Error('local identity provider not found');
  local = found as Local;
  storage = app.get<StoragePort>(STORAGE_PORT, { strict: false });
}, 300_000);

afterAll(async () => {
  await app?.close();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await pool?.end();
  await testDb?.drop();
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`DROP ROLE IF EXISTS "${roleName}"`).catch(() => undefined);
  await admin.end();
  await minio?.stop();
});

const fastify = () => app.getHttpAdapter().getInstance();
interface Body {
  success: boolean;
  data?: any;
  error?: { code: string; details?: any[] };
  metaData: any;
}
async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
    raw: res.body,
    headers: res.headers,
    body: (res.body === '' ? { success: true, metaData: {} } : JSON.parse(res.body)) as Body,
  };
}

/** Links an account through an invitation; returns its user ID and a fresh token. */
async function account() {
  const sub = `user_t46_${String(++seq)}`;
  const email = `d${String(seq)}@example.test`;
  local.addUser(sub, email, true);
  await pool.query(
    `insert into invitations (id, email, expires_at) values (gen_random_uuid(), $1, now() + interval '1 day')`,
    [email],
  );
  const token = local.issueToken({ sub, azp: ORIGIN, fva: [1, 1] });
  expect((await call('GET', '/me', token)).status).toBe(200);
  const id = (await pool.query(`select id from users where idp_subject = $1`, [sub])).rows[0]
    .id as string;
  return { id, token };
}

/** A stored upload of the owner: the object in the bucket and its `media_objects` row. */
async function image(owner: string, state: 'ready' | 'processing' | 'rejected' = 'ready') {
  const id = crypto.randomUUID();
  const key = uploadKey(owner, id);
  const bytes = 64;
  await storage.put(key, Buffer.alloc(bytes, 1), 'image/png', bytes);
  await pool.query(
    `insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, width, height, reject_reason)
     values ($1, $2, 'upload', $3, $4, $5, 'image/png', 8, 8, $6)`,
    [id, owner, state, key, bytes, state === 'rejected' ? 'decode_failed' : null],
  );
  await pool.query(
    `insert into storage_usage (owner_id, bytes_used) values ($1, $2) on conflict (owner_id) do update set bytes_used = storage_usage.bytes_used + $2`,
    [owner, bytes],
  );
  return { id, key };
}
const exists = async (key: string) => {
  try {
    await storage.get(key);
    return true;
  } catch {
    return false;
  }
};
const draftRow = async (id: string) =>
  (await pool.query(`select * from drafts where id = $1`, [id])).rows[0] as
    Record<string, any> | undefined;
const create = (token: string, body: unknown = {}) => call('POST', '/drafts', token, body);
const patch = (token: string, id: string, version: number | string, body: unknown) =>
  call('PATCH', `/drafts/${id}`, token, body, {
    'if-match': typeof version === 'number' ? `"${String(version)}"` : version,
  });

describe('M0008 as written', () => {
  it('has the dictionary constraints on drafts and campaigns', async () => {
    const owner = (await account()).id;
    const insert = async (sql: string, params: unknown[]): Promise<string> => {
      try {
        await pool.query(sql, params);
        return 'ok';
      } catch (error) {
        return (error as { constraint?: string }).constraint ?? 'other';
      }
    };
    const draft = (column: string, value: unknown) =>
      insert(`insert into drafts (id, owner_id, ${column}) values ($1, $2, $3)`, [
        crypto.randomUUID(),
        owner,
        value,
      ]);
    expect(await draft('step', 3)).toBe('ok');
    expect(await draft('step', 0)).toBe('drafts_step_ck');
    expect(await draft('step', 6)).toBe('drafts_step_ck');
    expect(await draft('intake_mode', 'voice')).toBe('drafts_intake_mode_ck');
    expect(await draft('ad_style', 'cartoon')).toBe('drafts_ad_style_ck');
    expect(await draft('segment_count', 5)).toBe('drafts_segment_count_ck');
    expect(await draft('segment_count', 0)).toBe('drafts_segment_count_ck');
    expect(await draft('audience_age_min', 20)).toBe('drafts_age_min_ck');
    expect(await draft('audience_gender', 'x')).toBe('drafts_gender_ck');
    expect(await draft('direction_goal', 'sales')).toBe('drafts_goal_ck');
    expect(await draft('product_name', '   ')).toBe('drafts_product_name_ck');
    expect(await draft('version', 0)).toBe('drafts_version_ck');
    expect(await draft('audience_interests', new Array(11).fill('a'))).toBe('drafts_interests_ck');
    expect(
      await insert(
        `insert into drafts (id, owner_id, audience_age_min, audience_age_max) values ($1, $2, 40, 30)`,
        [crypto.randomUUID(), owner],
      ),
    ).toBe('drafts_age_range_ck');
    const campaign = (state: string, count: number) =>
      insert(
        `insert into campaigns (id, owner_id, state, product_name, product_description, segment_count) values ($1, $2, $3, 'p', 'd', $4)`,
        [crypto.randomUUID(), owner, state, count],
      );
    expect(await campaign('active', 4)).toBe('ok');
    expect(await campaign('deleting', 1)).toBe('ok');
    expect(await campaign('hidden', 1)).toBe('campaigns_state_ck');
    expect(await campaign('active', 5)).toBe('campaigns_segment_count_ck');
  });

  it('keeps one draft per campaign and one image per draft, and cascades from the campaign and the owner', async () => {
    const a = await account();
    const campaignId = crypto.randomUUID();
    await pool.query(
      `insert into campaigns (id, owner_id, product_name, product_description, segment_count) values ($1, $2, 'p', 'd', 2)`,
      [campaignId, a.id],
    );
    const d1 = (await create(a.token)).body.data.id as string;
    const d2 = (await create(a.token)).body.data.id as string;
    await pool.query(`update drafts set campaign_id = $2 where id = $1`, [d1, campaignId]);
    await expect(
      pool.query(`update drafts set campaign_id = $2 where id = $1`, [d2, campaignId]),
    ).rejects.toMatchObject({ constraint: 'drafts_campaign_uq' });
    const img = await image(a.id);
    await pool.query(`update drafts set product_media_id = $2 where id = $1`, [d2, img.id]);
    await expect(
      pool.query(`update drafts set product_media_id = $2 where id = $1`, [d1, img.id]),
    ).rejects.toMatchObject({ constraint: 'drafts_product_media_uq' });
    await pool.query(`delete from media_objects where id = $1`, [img.id]);
    expect((await draftRow(d2))?.['product_media_id']).toBeNull(); // SET NULL, the draft stays
    await pool.query(`delete from campaigns where id = $1`, [campaignId]);
    expect(await draftRow(d1)).toBeUndefined(); // the campaign takes its draft with it
    await pool.query(`delete from users where id = $1`, [a.id]);
    expect(await draftRow(d2)).toBeUndefined(); // so does the owner
  });

  it('lets the app_api role read and write both tables (grants)', async () => {
    const url = new URL(testDb.url);
    url.username = roleName;
    url.password = rolePassword;
    const owner = (await account()).id;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      const id = crypto.randomUUID();
      await client.query(`insert into drafts (id, owner_id) values ($1, $2)`, [id, owner]);
      await client.query(`update drafts set step = 2 where id = $1`, [id]);
      expect((await client.query(`select step from drafts where id = $1`, [id])).rows[0].step).toBe(
        2,
      );
      await client.query(`delete from drafts where id = $1`, [id]);
      const campaignId = crypto.randomUUID();
      await client.query(
        `insert into campaigns (id, owner_id, product_name, product_description, segment_count) values ($1, $2, 'p', 'd', 1)`,
        [campaignId, owner],
      );
      await client.query(`delete from campaigns where id = $1`, [campaignId]);
    } finally {
      await client.end();
    }
  });
});

describe('API-020 to API-025 through the api composition root', () => {
  it('refuses every operation without a session (401)', async () => {
    const id = crypto.randomUUID();
    for (const [method, url] of [
      ['GET', '/drafts'],
      ['POST', '/drafts'],
      ['GET', `/drafts/${id}`],
      ['PATCH', `/drafts/${id}`],
      ['DELETE', `/drafts/${id}`],
    ] as const) {
      const res = await call(
        method,
        url,
        undefined,
        method === 'POST' || method === 'PATCH' ? {} : undefined,
      );
      expect([method, res.status, res.body.error?.code]).toEqual([method, 401, 'unauthenticated']);
    }
  });

  it('creates, reads and saves a complete intake and restores it (TC-INT-01)', async () => {
    const a = await account();
    const isResponse = contractValidator('DraftResponse');
    const created = await create(a.token, {
      step: 2,
      adStyle: 'ugc',
      intakeMode: 'description',
      productName: 'Test Tonic',
      audience: { ageMin: 35, ageMax: 52, gender: 'all', interests: ['wellness'] },
      direction: { goal: 'awareness', segmentCount: 2 },
      concept: 'A calm morning ritual',
    });
    expect(created.status).toBe(201);
    expect(isResponse(created.body)).toBe(true);
    expect(created.headers['etag']).toBe('"1"');
    expect(created.headers['location']).toBe(`/api/v1/drafts/${created.body.data.id as string}`);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.body.data).toMatchObject({
      version: 1,
      step: 2,
      productName: 'Test Tonic',
      durationSeconds: 30,
      campaignId: null,
      productMediaId: null,
      script: null,
    });
    const id = created.body.data.id as string;
    const saved = await patch(a.token, id, 1, {
      step: 3,
      productDescription: 'A tonic',
      direction: { goal: 'awareness', tone: 'warm', segmentCount: 4 },
    });
    expect(saved.status).toBe(200);
    expect(isResponse(saved.body)).toBe(true);
    expect(saved.headers['etag']).toBe('"2"');
    const back = await call('GET', `/drafts/${id}`, a.token);
    expect(back.status).toBe(200);
    expect(isResponse(back.body)).toBe(true);
    expect(back.headers['etag']).toBe('"2"');
    expect(back.body.data).toMatchObject({
      version: 2,
      step: 3,
      productName: 'Test Tonic',
      productDescription: 'A tonic',
      concept: 'A calm morning ritual',
      audience: { ageMin: 35, ageMax: 52, gender: 'all', interests: ['wellness'] },
      direction: { goal: 'awareness', tone: 'warm', segmentCount: 4 },
      durationSeconds: 60,
    });
  });

  it('starts over with a new draft and leaves the old one as it was (TC-INT-06)', async () => {
    const a = await account();
    const first = (await create(a.token, { productName: 'Old' })).body.data.id as string;
    const second = await create(a.token, {});
    expect(second.status).toBe(201);
    expect(second.body.data.id).not.toBe(first);
    expect(second.body.data.productName).toBeNull();
    expect((await call('GET', `/drafts/${first}`, a.token)).body.data.productName).toBe('Old');
  });

  it('rejects segment count 0, 5, -1 and 4.5 and keeps the stored values; 4 gives 60 s (TC-INT-02)', async () => {
    const a = await account();
    const id = (await create(a.token, { direction: { segmentCount: 1 } })).body.data.id as string;
    for (const segmentCount of [0, 5, -1, 4.5]) {
      const res = await patch(a.token, id, 1, { direction: { segmentCount } });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('validation_failed');
      expect(res.body.error?.details?.[0]).toMatchObject({ field: 'direction.segmentCount' });
    }
    expect((await create(a.token, { direction: { segmentCount: 5 } })).status).toBe(400);
    const stored = await call('GET', `/drafts/${id}`, a.token);
    expect(stored.body.data).toMatchObject({ version: 1, durationSeconds: 15 }); // nothing was written
    const four = await patch(a.token, id, 1, { direction: { segmentCount: 4 } });
    expect([four.status, four.body.data.durationSeconds, four.body.data.version]).toEqual([
      200, 60, 2,
    ]);
  });

  it('refuses a stale If-Match with 409 and no overwrite (TC-INT-05)', async () => {
    const a = await account();
    const id = (await create(a.token, { productName: 'v1' })).body.data.id as string;
    expect((await patch(a.token, id, 1, { productName: 'tab 1' })).status).toBe(200);
    const stale = await patch(a.token, id, 1, { productName: 'tab 2' });
    expect([stale.status, stale.body.error?.code]).toEqual([409, 'version_conflict']);
    const stored = await call('GET', `/drafts/${id}`, a.token);
    expect([stored.body.data.productName, stored.body.data.version]).toEqual(['tab 1', 2]);
  });

  it('lets exactly one of two saves with the same version win (no lost update)', async () => {
    const a = await account();
    const id = (await create(a.token)).body.data.id as string;
    const results = await Promise.all([
      patch(a.token, id, 1, { productName: 'one' }),
      patch(a.token, id, 1, { productName: 'two' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409);
    expect(loser?.body.error?.code).toBe('version_conflict');
    const row = await draftRow(id);
    expect(row?.['version']).toBe(2);
    expect(row?.['product_name']).toBe(
      results.find((r) => r.status === 200)?.body.data.productName,
    );
  });

  it('requires a well-formed If-Match and at least one field (TC-INT-07)', async () => {
    const a = await account();
    const id = (await create(a.token)).body.data.id as string;
    for (const header of [undefined, 'abc', '3', '"0"', 'W/"1"']) {
      const res = await call(
        'PATCH',
        `/drafts/${id}`,
        a.token,
        { step: 2 },
        header === undefined ? {} : { 'if-match': header },
      );
      expect([header, res.status, res.body.error?.code]).toEqual([
        header,
        400,
        'validation_failed',
      ]);
    }
    expect((await patch(a.token, id, 1, {})).status).toBe(400);
    expect(
      (await call('PATCH', `/drafts/not-a-uuid`, a.token, { step: 2 }, { 'if-match': '"1"' }))
        .status,
    ).toBe(400);
    expect((await call('GET', '/drafts/not-a-uuid', a.token)).status).toBe(400);
  });

  it('rejects malformed, unknown and oversized fields with safe errors and stores nothing (TC-INT-07)', async () => {
    const a = await account();
    const before = Number(
      (await pool.query(`select count(*) from drafts where owner_id = $1`, [a.id])).rows[0].count,
    );
    for (const body of [
      { nope: 1 },
      { productName: 7 },
      { productName: ' ' },
      { concept: 'x'.repeat(4001) },
      { audience: { ageMin: 20 } },
      { audience: { ageMin: 50, ageMax: 40 } },
      { step: 9 },
      { adStyle: 'cartoon' },
    ]) {
      const res = await create(a.token, body);
      expect([JSON.stringify(body).slice(0, 30), res.status, res.body.error?.code]).toEqual([
        JSON.stringify(body).slice(0, 30),
        400,
        'validation_failed',
      ]);
      expect(res.raw).not.toContain('x'.repeat(100));
    }
    const malformed = await fastify().inject({
      method: 'POST',
      url: '/api/v1/drafts',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
      payload: '{"productName":',
    });
    expect(malformed.statusCode).toBe(400);
    const huge = await fastify().inject({
      method: 'POST',
      url: '/api/v1/drafts',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ concept: 'y'.repeat(2_000_000) }),
    });
    expect(huge.statusCode).toBe(413);
    expect(
      Number(
        (await pool.query(`select count(*) from drafts where owner_id = $1`, [a.id])).rows[0].count,
      ),
    ).toBe(before);
  });

  it('answers a foreign draft and a deleted one with the same not found (TC-AUT)', async () => {
    const a = await account();
    const b = await account();
    const id = (await create(a.token, { productName: 'secret' })).body.data.id as string;
    const gone = (await create(a.token)).body.data.id as string;
    expect((await call('DELETE', `/drafts/${gone}`, a.token)).status).toBe(204);
    const missing = crypto.randomUUID();
    const shapes = new Set<string>();
    for (const target of [id, gone, missing]) {
      for (const res of [
        await call('GET', `/drafts/${target}`, b.token),
        await patch(b.token, target, 1, { productName: 'stolen' }),
        await call('DELETE', `/drafts/${target}`, b.token),
      ]) {
        expect(res.status).toBe(404);
        shapes.add(JSON.stringify({ ...res.body, metaData: undefined }));
      }
    }
    expect((await call('GET', `/drafts/${gone}`, a.token)).status).toBe(404);
    expect(shapes.size).toBe(1);
    expect((await draftRow(id))?.['product_name']).toBe('secret');
  });

  it('lists only my open drafts, newest first, with a stable cursor (API-020)', async () => {
    const a = await account();
    const b = await account();
    const ids: string[] = [];
    for (let n = 0; n < 5; n++)
      ids.push((await create(a.token, { productName: `d${String(n)}` })).body.data.id as string);
    await create(b.token, { productName: 'not mine' });
    const campaignId = crypto.randomUUID();
    await pool.query(
      `insert into campaigns (id, owner_id, product_name, product_description, segment_count) values ($1, $2, 'p', 'd', 1)`,
      [campaignId, a.id],
    );
    await pool.query(`update drafts set campaign_id = $2 where id = $1`, [ids[4], campaignId]); // submitted: not listed
    await patch(a.token, ids[0] as string, 1, { step: 4 }); // touched last: first in the list
    const isPage = contractValidator('DraftPage');
    const first = await call('GET', '/drafts?limit=2', a.token);
    expect(first.status).toBe(200);
    expect(isPage(first.body)).toBe(true);
    expect(first.body.data.map((d: { id: string }) => d.id)).toEqual([ids[0], ids[3]]);
    expect(first.body.metaData.pagination).toMatchObject({
      type: 'cursor',
      limit: 2,
      returnedCount: 2,
      hasNextPage: true,
    });
    const second = await call(
      'GET',
      `/drafts?limit=2&cursor=${encodeURIComponent(first.body.metaData.pagination.nextCursor as string)}`,
      a.token,
    );
    expect(second.body.data.map((d: { id: string }) => d.id)).toEqual([ids[2], ids[1]]);
    expect(second.body.metaData.pagination).toMatchObject({ hasNextPage: false, nextCursor: null });
    const forged = await call(
      'GET',
      `/drafts?cursor=${encodeURIComponent(first.body.metaData.pagination.nextCursor as string)}`,
      b.token,
    );
    expect([forged.status, forged.body.error?.code]).toEqual([400, 'validation_failed']);
    expect((await call('GET', '/drafts?limit=0', a.token)).status).toBe(400);
    expect((await call('GET', '/drafts?limit=51', a.token)).status).toBe(400);
    const mineOnly = await call('GET', '/drafts?limit=50', b.token);
    expect(mineOnly.body.data.map((d: { productName: string }) => d.productName)).toEqual([
      'not mine',
    ]);
  });

  it('shows a submitted draft read-only with its campaign and refuses to change or delete it (SB-D13)', async () => {
    const a = await account();
    const id = (await create(a.token, { productName: 'sent' })).body.data.id as string;
    const campaignId = crypto.randomUUID();
    await pool.query(
      `insert into campaigns (id, owner_id, product_name, product_description, segment_count) values ($1, $2, 'sent', 'd', 1)`,
      [campaignId, a.id],
    );
    await pool.query(`update drafts set campaign_id = $2 where id = $1`, [id, campaignId]);
    const read = await call('GET', `/drafts/${id}`, a.token);
    expect([read.status, read.body.data.campaignId]).toEqual([200, campaignId]);
    expect(contractValidator('DraftResponse')(read.body)).toBe(true);
    const save = await patch(a.token, id, 1, { productName: 'changed' });
    expect([save.status, save.body.error?.code]).toEqual([409, 'state_conflict']);
    const stale = await patch(a.token, id, 7, { productName: 'changed' });
    expect([stale.status, stale.body.error?.code]).toEqual([409, 'state_conflict']);
    const del = await call('DELETE', `/drafts/${id}`, a.token);
    expect([del.status, del.body.error?.code]).toEqual([409, 'state_conflict']);
    expect((await draftRow(id))?.['product_name']).toBe('sent');
  });

  it('attaches a ready image, refuses the others and frees it again on detach (API-021, API-023)', async () => {
    const a = await account();
    const b = await account();
    const ready = await image(a.id);
    const created = await create(a.token, { productMediaId: ready.id });
    expect([created.status, created.body.data.productMediaId]).toEqual([201, ready.id]);
    expect(
      (await pool.query(`select attached_at from media_objects where id = $1`, [ready.id])).rows[0]
        .attached_at,
    ).not.toBeNull();
    const second = (await create(a.token)).body.data.id as string;
    const taken = await patch(a.token, second, 1, { productMediaId: ready.id });
    expect([taken.status, taken.body.error?.code]).toEqual([409, 'state_conflict']);
    const takenOnCreate = await create(a.token, { productMediaId: ready.id });
    expect([takenOnCreate.status, takenOnCreate.body.error?.code]).toEqual([409, 'state_conflict']);
    const processing = await image(a.id, 'processing');
    const notReady = await create(a.token, { productMediaId: processing.id });
    expect([notReady.status, notReady.body.error?.code]).toEqual([422, 'media_not_ready']);
    const foreign = await image(b.id);
    const hidden = await create(a.token, { productMediaId: foreign.id });
    expect([hidden.status, hidden.body.error?.code]).toEqual([404, 'not_found']);
    expect((await create(a.token, { productMediaId: crypto.randomUUID() })).status).toBe(404);
    const detach = await patch(a.token, created.body.data.id, 1, { productMediaId: null });
    expect([detach.status, detach.body.data.productMediaId]).toEqual([200, null]);
    const reuse = await patch(a.token, second, 1, { productMediaId: ready.id });
    expect([reuse.status, reuse.body.data.productMediaId]).toEqual([200, ready.id]);
    expect(await draftRow(second)).toMatchObject({ product_media_id: ready.id });
  });

  it('deletes the draft, its image object and row, returns the quota and audits (API-025, TC-DEL)', async () => {
    const a = await account();
    const img = await image(a.id);
    const id = (await create(a.token, { productMediaId: img.id })).body.data.id as string;
    expect(await exists(img.key)).toBe(true);
    const used = async () =>
      Number(
        (await pool.query(`select bytes_used from storage_usage where owner_id = $1`, [a.id]))
          .rows[0].bytes_used,
      );
    expect(await used()).toBe(64);
    const res = await call('DELETE', `/drafts/${id}`, a.token);
    expect(res.status).toBe(204);
    expect(res.raw).toBe('');
    expect(await draftRow(id)).toBeUndefined();
    expect((await pool.query(`select 1 from media_objects where id = $1`, [img.id])).rowCount).toBe(
      0,
    );
    expect(await exists(img.key)).toBe(false);
    expect(await used()).toBe(0);
    const audit = await pool.query(
      `select actor_id, object_type, object_id, outcome from audit_events where action = 'draft.deleted' and object_id = $1`,
      [id],
    );
    expect(audit.rows).toEqual([
      { actor_id: a.id, object_type: 'draft', object_id: id, outcome: 'allowed' },
    ]);
    expect((await call('DELETE', `/drafts/${id}`, a.token)).status).toBe(404);
  });

  it('deletes a draft that has no image', async () => {
    const a = await account();
    const id = (await create(a.token)).body.data.id as string;
    expect((await call('DELETE', `/drafts/${id}`, a.token)).status).toBe(204);
    expect(await draftRow(id)).toBeUndefined();
  });

  it('keeps the draft and the image when the storage delete fails (503), and a retry succeeds', async () => {
    const a = await account();
    const img = await image(a.id);
    const id = (await create(a.token, { productMediaId: img.id })).body.data.id as string;
    const original = storage.delete.bind(storage);
    let failing = true;
    storage.delete = async (key: string) => {
      if (failing) throw new Error('storage down');
      return original(key);
    };
    try {
      const res = await call('DELETE', `/drafts/${id}`, a.token);
      expect([res.status, res.body.error?.code]).toEqual([503, 'service_unavailable']);
      expect(await draftRow(id)).toBeDefined();
      expect(
        (await pool.query(`select 1 from media_objects where id = $1`, [img.id])).rowCount,
      ).toBe(1);
      failing = false;
      expect((await call('DELETE', `/drafts/${id}`, a.token)).status).toBe(204);
      expect(await exists(img.key)).toBe(false);
    } finally {
      storage.delete = original;
    }
  });

  it('limits creation to 30 a minute and saves to 60 a minute, per user, with Retry-After (429)', async () => {
    const a = await account();
    const other = await account();
    let last = await create(a.token);
    const id = last.body.data.id as string;
    for (let n = 1; n < 30; n++) last = await create(a.token);
    expect(last.status).toBe(201);
    const refused = await create(a.token);
    expect([refused.status, refused.body.error?.code]).toEqual([429, 'rate_limited']);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await create(other.token)).status).toBe(201); // another user is not affected
    expect((await call('GET', `/drafts/${id}`, a.token)).status).toBe(200); // reads are not counted against creation
    let version = 1;
    for (let n = 0; n < 60; n++) {
      const res = await patch(a.token, id, version, { step: (n % 5) + 1 });
      expect(res.status).toBe(200);
      version += 1;
    }
    const over = await patch(a.token, id, version, { step: 1 });
    expect([over.status, over.body.error?.code]).toEqual([429, 'rate_limited']);
    expect(Number(over.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });
});
