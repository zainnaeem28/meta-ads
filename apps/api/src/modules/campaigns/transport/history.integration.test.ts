/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles; prettier reflow detached the per-line directives (AIU-256) */
// TASK-047 (campaigns 2/2) through the real api composition root (`createApiApp`, the one `main.api.ts` runs) with
// `fastify.inject` on real PostgreSQL: API-040 (cursor, search, filter, deleting hidden) and API-041, assertOwner and isActive.
// TC-HIS-01..11.

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
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { HistoryService } from '../application/history.service.js';
import type { CampaignProgressReader } from '../application/progress-reader.js';
import { DrizzleHistoryRepository } from '../infrastructure/history.repository.js';

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
let seq = 0;
const roleName = `app_api_t047_${randomBytes(4).toString('hex')}`;
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
  testDb = await createTestDatabase({ label: 'task047', migrations: false });
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
    '0080_task-048-brief.sql',
    '0090_task-052-production-video.sql',
  ]) {
    for (const statement of statementsOf(file, 'tables')) await pool.query(statement);
  }
  await pool.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
  for (const file of [
    '0040_task-041-media.sql',
    '0070_task-046-campaigns.sql',
    '0080_task-048-brief.sql',
    '0090_task-052-production-video.sql',
  ]) {
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
    OWNER_EMAIL: 'owner47@example.test',
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
  const sub = `user_t47_${String(++seq)}`;
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

const seed = async (
  owner: string,
  name: string,
  description: string,
  over: { state?: string; updatedAt?: string } = {},
) => {
  const id = crypto.randomUUID();
  await pool.query(
    `insert into campaigns (id, owner_id, state, product_name, product_description, segment_count, updated_at)
     values ($1, $2, $3, $4, $5, 2, coalesce($6::timestamptz, now()))`,
    [id, owner, over.state ?? 'active', name, description, over.updatedAt ?? null],
  );
  await pool.query(
    `insert into drafts (id, owner_id, campaign_id, product_name) values ($1, $2, $3, $4)`,
    [crypto.randomUUID(), owner, id, name],
  );
  return id;
};
const list = (token: string, query = '') => call('GET', `/campaigns${query}`, token);
const ids = (res: { body: Body }) => (res.body.data as { id: string }[]).map((c) => c.id);

describe('API-040 history list through the real api', () => {
  it('pages N and N+1 campaigns without repeat or skip and answers the contract shape', async () => {
    const a = await account();
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1)
      made.push(
        await seed(a.id, `Tonic ${String(i)}`, 'x'.repeat(300), {
          updatedAt: `2026-11-1${String(i)}T10:00:00.000001Z`,
        }),
      );
    // two rows share one timestamp: the ID breaks the tie
    made.push(await seed(a.id, 'Tie A', 'd', { updatedAt: '2026-11-10T10:00:00.000001Z' }));
    const expected = (
      await pool.query(
        `select id from campaigns where owner_id = $1 order by updated_at desc, id desc`,
        [a.id],
      )
    ).rows.map((r) => r.id as string);
    const valid = contractValidator('CampaignPage');

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await list(
        a.token,
        `?limit=2${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      expect(res.status).toBe(200);
      expect(valid(res.body), JSON.stringify(valid.errors)).toBe(true);
      seen.push(...ids(res));
      cursor = res.body.metaData.pagination.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined);
    expect(pages).toBe(3);
    expect(seen).toEqual(expected);
    const first = (await list(a.token, '?limit=1')).body.data[0];
    expect(first.productDescriptionExcerpt.length).toBe(160);
    expect(first.progress).toBe('in_progress');

    // exactly N: one page, no next
    const exact = await list(a.token, '?limit=6');
    expect(exact.body.data).toHaveLength(6);
    expect(exact.body.metaData.pagination.hasNextPage).toBe(false);
    const n1 = await list(a.token, '?limit=5');
    expect(n1.body.metaData.pagination.hasNextPage).toBe(true);
  });

  it('refuses a cursor for another filter, search, owner or a forged one; a new first page works', async () => {
    const a = await account();
    const b = await account();
    for (let i = 0; i < 3; i += 1) await seed(a.id, `Serum ${String(i)}`, 'd');
    const cursor = (await list(a.token, '?limit=1')).body.metaData.pagination.nextCursor as string;
    expect(cursor).toBeTruthy();
    const use = (token: string, extra: string, c = cursor) =>
      list(token, `?limit=1&cursor=${encodeURIComponent(c)}${extra}`);
    expect((await use(a.token, '')).status).toBe(200);
    for (const res of [
      await use(a.token, '&filter=failed'),
      await use(a.token, '&q=Serum'),
      await use(b.token, ''),
      await use(a.token, '', `${cursor}x`),
    ]) {
      expect(res.status).toBe(400);
      expect(res.body.error?.details?.[0]).toMatchObject({
        field: 'cursor',
        code: 'cursor_invalid',
      });
    }
    expect((await list(a.token, '?limit=1&filter=failed')).status).toBe(200);
  });

  it('searches product name and description literally, case-insensitively, in the owner scope only', async () => {
    const a = await account();
    const b = await account();
    const pct = await seed(a.id, 'Discount 100% tonic', 'd');
    const under = await seed(a.id, 'Plain', 'snake_case oil');
    const slash = await seed(a.id, 'Back\\slash', 'd');
    const other = await seed(a.id, 'Other', 'nothing here');
    const foreign = await seed(b.id, 'Zebra only mine', 'zebra');
    expect(ids(await list(a.token, '?q=100%25'))).toEqual([pct]);
    expect(ids(await list(a.token, '?q=e_c'))).toEqual([under]);
    expect(ids(await list(a.token, '?q=%5Cs'))).toEqual([slash]);
    expect(ids(await list(a.token, '?q=SNAKE'))).toEqual([under]);
    expect(ids(await list(a.token, '?q=%25%25'))).toEqual([]);
    expect(ids(await list(a.token, '?q=%20nothing%20'))).toEqual([other]);
    // a search that matches only another user's records finds nothing
    const none = await list(a.token, '?q=zebra');
    expect(none.status).toBe(200);
    expect(none.body.data).toEqual([]);
    expect(ids(await list(b.token, '?q=zebra'))).toEqual([foreign]);
    for (const bad of [
      '?q=a',
      `?q=${'a'.repeat(101)}`,
      '?q=%20a%20',
      '?filter=done',
      '?limit=0',
      '?limit=51',
    ]) {
      const res = await list(a.token, bad);
      expect(res.status, bad).toBe(400);
    }
  });

  it('keeps the empty history apart from a search with no match', async () => {
    const fresh = await account();
    const empty = await list(fresh.token);
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual([]);
    expect(empty.body.metaData.pagination).toMatchObject({ hasNextPage: false, returnedCount: 0 });
    await seed(fresh.id, 'Tonic', 'd');
    expect((await list(fresh.token)).body.data).toHaveLength(1);
    const noMatch = await list(fresh.token, '?q=zzz');
    expect(noMatch.body.data).toEqual([]);
    // the client tells the two states by whether it sent a search: the same account has a history yet gets no rows
    expect((await list(fresh.token)).body.data).not.toEqual(noMatch.body.data);
  });

  it('never lists a deleting campaign and hides it from the detail', async () => {
    const a = await account();
    const live = await seed(a.id, 'Live', 'd');
    const gone = await seed(a.id, 'Going', 'd', { state: 'deleting' });
    expect(ids(await list(a.token))).toEqual([live]);
    expect(ids(await list(a.token, '?q=Going'))).toEqual([]);
    expect((await call('GET', `/campaigns/${gone}`, a.token)).status).toBe(404);
  });

  it('filters by the progress the reader derives and an unknown reader gives no jobs', async () => {
    const a = await account();
    const [one, two, three] = [
      await seed(a.id, 'One', 'd'),
      await seed(a.id, 'Two', 'd'),
      await seed(a.id, 'Three', 'd'),
    ];
    // through the real api no production reader exists yet: nothing is processing, failed or completed
    for (const filter of ['processing', 'completed', 'failed'])
      expect(ids(await list(a.token, `?filter=${filter}`))).toEqual([]);
    expect(ids(await list(a.token, '?filter=all'))).toHaveLength(3);
    // with a reader: same repository and database, the filter intersects the progress set with the page query
    const reader: CampaignProgressReader = {
      progressFor: (_o, campaignIds) =>
        Promise.resolve(
          new Map(
            campaignIds
              .filter((id) => id === two)
              .map((id) => [
                id,
                {
                  progress: 'failed' as const,
                  briefState: 'failed' as const,
                  finalAvailable: false,
                  jobCounts: { failed: 1 },
                  latestAssemblyId: null,
                  thumbstopperJobId: null,
                },
              ]),
          ),
        ),
      idsWithProgress: (_o, progress) =>
        Promise.resolve(
          new Set(progress === 'failed' ? [two, three] : progress === 'processing' ? [one] : []),
        ),
    };
    const service = new HistoryService(
      app.get<Database>(DATABASE, { strict: false }),
      new DrizzleHistoryRepository(),
      reader,
    );
    const failed = await service.list(a.id, 'failed', undefined, 10);
    expect(failed.map((r) => r.campaign.id).sort()).toEqual([two, three].sort());
    expect(failed.find((r) => r.campaign.id === two)?.snapshot.progress).toBe('failed');
    expect(failed.find((r) => r.campaign.id === three)?.snapshot.progress).toBe('in_progress');
    expect((await service.list(a.id, 'failed', 'Two', 10)).map((r) => r.campaign.id)).toEqual([
      two,
    ]);
    expect(await service.list(a.id, 'completed', undefined, 10)).toEqual([]);
    expect(
      (await service.list(a.id, 'processing', undefined, 10)).map((r) => r.campaign.id),
    ).toEqual([one]);
  });

  it('needs a signed-in account', async () => {
    expect((await list('')).status).toBe(401);
    expect((await call('GET', `/campaigns/${crypto.randomUUID()}`)).status).toBe(401);
  });
});

describe('API-041 campaign detail through the real api', () => {
  it('answers the owner with the full campaign and conceals foreign, deleting and unknown IDs behind one 404', async () => {
    const a = await account();
    const b = await account();
    const media = crypto.randomUUID();
    const id = await seed(a.id, 'Detail', 'long description');
    await pool.query(
      `insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, width, height) values ($1, $2, 'upload', 'ready', $3, 1, 'image/png', 8, 8)`,
      [media, a.id, `u/${a.id}/${media}`],
    );
    await pool.query(`update campaigns set product_media_id = $2 where id = $1`, [id, media]);
    const draftId = (await pool.query(`select id from drafts where campaign_id = $1`, [id])).rows[0]
      .id as string;
    const res = await call('GET', `/campaigns/${id}`, a.token);
    expect(res.status).toBe(200);
    expect(contractValidator('CampaignResponse')(res.body), 'schema').toBe(true);
    expect(res.body.data).toMatchObject({
      id,
      productName: 'Detail',
      productDescription: 'long description',
      productMediaId: media,
      draftId,
      segmentCount: 2,
      progress: 'in_progress',
      jobCounts: {},
      latestAssemblyId: null,
      thumbstopperJobId: null,
      finalAvailable: false,
    });
    const gone = await seed(a.id, 'Going', 'd', { state: 'deleting' });
    const foreign = await call('GET', `/campaigns/${id}`, b.token);
    const deleting = await call('GET', `/campaigns/${gone}`, a.token);
    const unknown = await call('GET', `/campaigns/${crypto.randomUUID()}`, a.token);
    for (const r of [foreign, deleting, unknown]) expect(r.status).toBe(404);
    expect(foreign.body.error).toEqual(unknown.body.error);
    expect(deleting.body.error).toEqual(unknown.body.error);
    expect((await call('GET', '/campaigns/not-a-uuid', a.token)).status).toBe(400);
  });
});

describe('assertOwner and isActive', () => {
  it('say 404 for a foreign or deleting campaign and report active state', async () => {
    const a = await account();
    const b = await account();
    const live = await seed(a.id, 'Live', 'd');
    const gone = await seed(a.id, 'Going', 'd', { state: 'deleting' });
    const service = app.get(HistoryService, { strict: false });
    const database = app.get<Database>(DATABASE, { strict: false });
    await database.uow.run(async (tx) => {
      await expect(service.assertOwner(tx, a.id, live)).resolves.toBeUndefined();
      await expect(service.assertOwner(tx, b.id, live)).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(service.assertOwner(tx, a.id, gone)).rejects.toMatchObject({
        code: 'not_found',
      });
      expect(await service.isActive(tx, live)).toBe(true);
      expect(await service.isActive(tx, gone)).toBe(false);
      expect(await service.isActive(tx, crypto.randomUUID())).toBe(false);
    });
  });
});
