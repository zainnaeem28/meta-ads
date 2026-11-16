import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ModulesContainer } from '@nestjs/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../../bootstrap/api.module.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../../platform/db/test-database.js';
import type { TestDatabase } from '../../../platform/db/test-database.js';
import { installJobs } from '../../../platform/jobs/test-support.js';
import { createHttpLogging } from '../../../platform/logging/index.js';
import { STORAGE_PORT } from '../domain/storage.js';
import type { StoragePort } from '../domain/storage.js';
import { startTestBucket } from '../infrastructure/test-support.js';
import type { TestBucket } from '../infrastructure/test-support.js';

// TASK-042 (media 2/3): API-030, API-031 and API-032 through the real api composition root (`createApiApp`, the one
// `main.api.ts` runs) with `fastify.inject`, on real PostgreSQL and a real MinIO server. TC-UPL-01..25, TC-MED-*.

const ORIGIN = 'http://localhost:3000';
const MIB = 1024 * 1024;
const QUOTA = 100 * MIB;
const contractsDir = join(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'packages', 'contracts');
const UNKNOWN = '0197a1b2-0000-7000-8000-0000000000ee';

let testDb: TestDatabase;
let pool: pg.Pool;
let minio: TestBucket;
let app: Awaited<ReturnType<typeof createApiApp>>['app'];
let storage: StoragePort;
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

function statementsOf(file: string, filter?: RegExp): string[] {
  const tables = readFileSync(join(REAL_MIGRATIONS, file), 'utf8').split('-- Grants')[0] ?? '';
  return tables
    .split('--> statement-breakpoint')
    .map((x) => x.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
    .filter((x) => x !== '' && (filter === undefined || filter.test(x)));
}

beforeAll(async () => {
  minio = await startTestBucket();
  testDb = await createTestDatabase({ label: 'task042', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 4 });
  for (const [file, filter] of [
    ['0001_task-025-platform.sql', /^(CREATE TABLE|CREATE INDEX) "(idempotency_records|rate_limit_buckets|idempotency_records_expiry_idx)/],
    ['0010_task-032-audit.sql', undefined],
    ['0020_task-033-identity.sql', undefined],
    ['0040_task-041-media.sql', undefined],
  ] as const) {
    for (const statement of statementsOf(file, filter)) await pool.query(statement);
  }
  await installJobs(testDb.url);
  const env: Record<string, string | undefined> = {
    KEK_PUBLIC_KEYS: undefined,
    KEK_PRIVATE_KEYS: undefined,
    OWNER_EMAIL: 'owner42@example.test',
    INVITE_EMAIL_DOMAINS: 'example.test',
    R2_ENDPOINT: minio.endpoint,
    R2_BUCKET: minio.bucket,
    R2_ACCESS_KEY_ID: minio.accessKey,
    R2_SECRET_ACCESS_KEY: minio.secretKey,
    STORAGE_PUBLIC_ORIGIN: minio.endpoint,
    STORAGE_QUOTA_BYTES: String(QUOTA),
    MEDIA_MAX_UPLOAD_BYTES: undefined,
    MEDIA_BROWSER_URL_TTL_SEC: undefined,
    PROVIDER_FETCH_URL_TTL_SEC: undefined,
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
      DATABASE_POOL_MAX: 6,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      RATE_LIMIT_IP_KEY: 'r'.repeat(40),
    },
    createHttpLogging({ level: 'silent' }),
  ));
  const providers = [...app.get(ModulesContainer, { strict: false }).values()].flatMap((m) => [...m.providers.values()]);
  const found = providers.map((p) => p.instance as Partial<Local> | undefined).find((i) => typeof i?.issueToken === 'function');
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
  await minio?.stop();
});

const fastify = () => app.getHttpAdapter().getInstance();
interface Body { success: boolean; data?: any; error?: { code: string; details?: any[] }; metaData: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: 'GET' | 'POST', url: string, tok?: string, extra: { payload?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...extra.headers };
  if (tok !== undefined) headers['authorization'] = `Bearer ${tok}`;
  const res = await fastify().inject({
    method,
    url: `/api/v1${url}`,
    headers,
    ...(extra.payload === undefined ? {} : { payload: extra.payload as never }),
  });
  return {
    status: res.statusCode,
    headers: res.headers,
    body: (res.body === '' ? { success: true, metaData: {} } : JSON.parse(res.body)) as Body,
  };
}

async function account(): Promise<{ id: string; token: string }> {
  const sub = `user_t42_${String(++seq)}`;
  const email = `m${String(seq)}@example.test`;
  local.addUser(sub, email, true);
  await pool.query(`insert into invitations (id, email, expires_at) values (gen_random_uuid(), $1, now() + interval '1 day')`, [email]);
  const token = local.issueToken({ sub, azp: ORIGIN, fva: [1, 1] });
  expect((await call('GET', '/me', token)).status).toBe(200);
  const id = (await pool.query(`select id from users where idp_subject = $1`, [sub])).rows[0].id as string;
  return { id, token };
}

const HEADS: Record<string, { type: string; head: Buffer }> = {
  jpeg: { type: 'image/jpeg', head: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]) },
  png: { type: 'image/png', head: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]) },
  webp: { type: 'image/webp', head: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]) },
  gif: { type: 'image/gif', head: Buffer.from('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000', 'latin1') },
};
const withHead = (head: Buffer, size: number): Buffer => Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 9)]);

function multipart(file: Buffer | Readable, opts: { filename?: string; field?: string; length?: number; type?: string } = {}) {
  const boundary = `----t42${randomBytes(6).toString('hex')}`;
  const pre = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${opts.field ?? 'file'}"; filename="${opts.filename ?? 'photo.png'}"\r\n` +
      `Content-Type: ${opts.type ?? 'application/octet-stream'}\r\n\r\n`,
  );
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);
  const headers: Record<string, string> = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  if (Buffer.isBuffer(file)) {
    return { payload: Buffer.concat([pre, file, post]), headers };
  }
  async function* parts(): AsyncGenerator<Buffer> {
    yield pre;
    for await (const chunk of file) yield chunk as Buffer;
    yield post;
  }
  if (opts.length !== undefined) headers['content-length'] = String(opts.length);
  return { payload: Readable.from(parts()), headers };
}

const upload = (tok: string | undefined, file: Buffer | Readable, opts?: Parameters<typeof multipart>[1]) => call('POST', '/media', tok, multipart(file, opts));
const row = async (id: string) => (await pool.query('select * from media_objects where id = $1', [id])).rows[0] as Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
const usage = async (owner: string) => Number((await pool.query('select bytes_used from storage_usage where owner_id = $1', [owner])).rows[0]?.bytes_used ?? 0);
const rows = async (owner: string) => Number((await pool.query('select count(*) n from media_objects where owner_id = $1', [owner])).rows[0].n);
const jobs = async (id: string) => Number((await pool.query(`select count(*) n from pgboss.job where name = 'media.sanitize' and data->>'mediaId' = $1`, [id])).rows[0].n);
const code = (r: { body: Body }) => r.body.error?.code;

describe('API-030 upload', () => {
  const validateMedia = contractValidator('MediaResponse');

  for (const [name, { type, head }] of Object.entries(HEADS)) {
    it(`accepts a file of exactly 10 MiB as ${name}: quarantine object, processing row, queued job, contract-shaped answer`, async () => {
      const { id: owner, token } = await account();
      const size = 10 * MIB;
      const res = await upload(token, withHead(head, size), { filename: `photo.${name}` });
      expect(res.status).toBe(201);
      expect(validateMedia(res.body), JSON.stringify(validateMedia.errors)).toBe(true);
      expect(res.headers['location']).toBe(`/api/v1/media/${res.body.data.id}`);
      expect(res.body.data).toMatchObject({ kind: 'upload', state: 'processing', contentType: type, bytes: size, attached: false, rejectReason: null });
      const stored = await row(res.body.data.id);
      expect(stored).toMatchObject({ owner_id: owner, state: 'processing', storage_key: `q/${owner}/${res.body.data.id}`, content_type: type });
      expect(Number(stored?.bytes)).toBe(size);
      expect(await usage(owner)).toBe(size);
      expect(await jobs(res.body.data.id)).toBe(1);
      const object = await storage.get(`q/${owner}/${res.body.data.id}`);
      let length = 0;
      for await (const chunk of object) length += (chunk as Buffer).length;
      expect(length).toBe(size);
    });
  }

  it('rejects 10 MiB + 1 with 413 payload_too_large and leaves no row, object or reserved bytes', async () => {
    const { id: owner, token } = await account();
    const res = await upload(token, withHead(HEADS['png']!.head, 10 * MIB + 1));
    expect(res.status).toBe(413);
    expect(code(res)).toBe('payload_too_large');
    expect(await rows(owner)).toBe(0);
    expect(await usage(owner)).toBe(0);
  });

  it('refuses an announced length far above the cap before reading the body (413)', async () => {
    const { token } = await account();
    let pulled = 0;
    async function* body(): AsyncGenerator<Buffer> {
      for (let i = 0; i < 64; i += 1) {
        pulled += MIB;
        yield Buffer.alloc(MIB, 1);
      }
    }
    const res = await upload(token, Readable.from(body()), { length: 64 * MIB });
    expect(res.status).toBe(413);
    expect(code(res)).toBe('payload_too_large');
    expect(pulled).toBeLessThan(12 * MIB);
  });

  it('refuses PDF, a renamed executable, SVG and an empty file with 415 unsupported_media_type', async () => {
    const { id: owner, token } = await account();
    const cases: [string, Buffer, string][] = [
      ['PDF', Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'), 'doc.pdf'],
      ['renamed exe', withHead(Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00', 'latin1'), 2048), 'cat.png'],
      ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'), 'logo.svg'],
      ['SVG disguised as PNG', Buffer.from('<?xml version="1.0"?><svg onload="alert(1)"/>'), 'logo.png'],
      ['empty', Buffer.alloc(0), 'empty.png'],
    ];
    for (const [label, file, filename] of cases) {
      const res = await upload(token, file, { filename, type: 'image/png' });
      expect(res.status, label).toBe(415);
      expect(code(res), label).toBe('unsupported_media_type');
    }
    expect(await rows(owner)).toBe(0);
    expect(await usage(owner)).toBe(0);
  });

  it('wants multipart and a part named file (400 / 415)', async () => {
    const { token } = await account();
    const json = await call('POST', '/media', token, { payload: { file: 'x' } });
    expect([400, 415]).toContain(json.status);
    expect(json.body.success).toBe(false);
    const wrongField = await upload(token, withHead(HEADS['png']!.head, 100), { field: 'image' });
    expect(wrongField.status).toBe(400);
    expect(code(wrongField)).toBe('validation_failed');
  });

  it('ignores a traversal file name: the key and the row never carry it', async () => {
    const { id: owner, token } = await account();
    const res = await upload(token, withHead(HEADS['png']!.head, 300), { filename: '../../etc/passwd\u0000.png' });
    expect(res.status).toBe(201);
    const stored = await row(res.body.data.id);
    expect(stored?.storage_key).toBe(`q/${owner}/${res.body.data.id}`);
    expect(JSON.stringify(stored)).not.toMatch(/passwd|\.\./);
  });

  it('takes the type from the bytes, not from the claim', async () => {
    const { token } = await account();
    const res = await upload(token, withHead(HEADS['gif']!.head, 200), { filename: 'x.jpg', type: 'image/jpeg' });
    expect(res.status).toBe(201);
    expect(res.body.data.contentType).toBe('image/gif');
  });

  it('answers 422 storage_quota_reached with used and allowed when the file does not fit, and 401 without a session', async () => {
    const { id: owner, token } = await account();
    await pool.query('insert into storage_usage (owner_id, bytes_used) values ($1, $2)', [owner, QUOTA - 10]);
    const res = await upload(token, withHead(HEADS['png']!.head, 400));
    expect(res.status).toBe(422);
    expect(code(res)).toBe('storage_quota_reached');
    expect(await rows(owner)).toBe(0);
    expect(await usage(owner)).toBe(QUOTA - 10);
    expect((await upload(undefined, withHead(HEADS['png']!.head, 100))).status).toBe(401);
  });

  it('limits an account to 30 uploads in 10 minutes (429 with Retry-After)', async () => {
    const { token } = await account();
    const small = withHead(HEADS['png']!.head, 64);
    for (let i = 0; i < 30; i += 1) expect((await upload(token, small)).status).toBe(201);
    const limited = await upload(token, small);
    expect(limited.status).toBe(429);
    expect(code(limited)).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  }, 120_000);

  it('streams: a 400 MiB body over a real socket is cut off near the cap, never read whole, memory stays flat', async () => {
    const { id: owner, token } = await account();
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as { port: number };
    const boundary = '----t42stream';
    const pre = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.png"\r\nContent-Type: image/png\r\n\r\n`,
    );
    const chunk = Buffer.alloc(MIB, 3);
    let written = 0;
    global.gc?.();
    const before = process.memoryUsage().rss;
    let peak = before;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/api/v1/media', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}`, 'transfer-encoding': 'chunked' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', (error: NodeJS.ErrnoException) => {
        // The server hung up on a client that kept sending: fine, as long as an answer was not lost.
        if (error.code === 'ECONNRESET' || error.code === 'EPIPE') resolve(-1);
        else reject(error);
      });
      let total = 0;
      const pump = (): void => {
        while (total < 400) {
          const ok = req.write(total === 0 ? Buffer.concat([pre, HEADS['png']!.head, chunk]) : chunk);
          written += total === 0 ? pre.length + HEADS['png']!.head.length + chunk.length : chunk.length;
          total += 1;
          if (!ok) {
            req.once('drain', pump);
            return;
          }
        }
        req.end(`\r\n--${boundary}--\r\n`);
      };
      pump();
    });
    clearInterval(timer);
    expect([413, -1]).toContain(status);
    expect(written).toBeLessThan(80 * MIB);
    expect(peak - before).toBeLessThan(150 * MIB);
    expect(await rows(owner)).toBe(0);
    expect(await usage(owner)).toBe(0);
  }, 60_000);
});

describe('API-031 and API-032 reads', () => {
  const validateUrl = contractValidator('SignedUrlResponse');
  const validateMedia = contractValidator('MediaResponse');

  it('shows the owner the state and the reject reason', async () => {
    const { token } = await account();
    const created = await upload(token, withHead(HEADS['png']!.head, 500));
    const id = created.body.data.id as string;
    const processing = await call('GET', `/media/${id}`, token);
    expect(processing.status).toBe(200);
    expect(validateMedia(processing.body), JSON.stringify(validateMedia.errors)).toBe(true);
    expect(processing.body.data).toMatchObject({ id, state: 'processing', rejectReason: null });
    await pool.query(`update media_objects set state = 'rejected', reject_reason = 'decode_failed' where id = $1`, [id]);
    const rejected = await call('GET', `/media/${id}`, token);
    expect(rejected.body.data).toMatchObject({ state: 'rejected', rejectReason: 'decode_failed' });
    expect(rejected.headers['cache-control']).toBe('no-store');
  });

  it('gives a foreign id and an unknown id the same 404, on both reads', async () => {
    const owner = await account();
    const other = await account();
    const id = (await upload(owner.token, withHead(HEADS['png']!.head, 500))).body.data.id as string;
    await pool.query(`update media_objects set state = 'ready' where id = $1`, [id]);
    for (const path of [`/media/${id}`, `/media/${id}/url`]) {
      const foreign = await call('GET', path, other.token);
      const unknown = await call('GET', path.replace(id, UNKNOWN), other.token);
      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(code(foreign)).toBe('not_found');
      expect({ ...foreign.body.error }).toEqual({ ...unknown.body.error });
    }
    expect((await call('GET', '/media/not-a-uuid', owner.token)).status).toBe(400);
    expect((await call('GET', `/media/${id}`)).status).toBe(401);
  });

  it('signs only a ready object: 422 media_not_ready while processing, 404 once rejected, then a working short-lived URL', async () => {
    const { id: owner, token } = await account();
    const body = withHead(HEADS['png']!.head, 777);
    const id = (await upload(token, body)).body.data.id as string;
    const early = await call('GET', `/media/${id}/url`, token);
    expect(early.status).toBe(422);
    expect(code(early)).toBe('media_not_ready');
    await pool.query(`update media_objects set state = 'ready' where id = $1`, [id]);
    const res = await call('GET', `/media/${id}/url`, token);
    expect(res.status).toBe(200);
    expect(validateUrl(res.body), JSON.stringify(validateUrl.errors)).toBe(true);
    expect(res.headers['cache-control']).toBe('no-store');
    const ttl = Date.parse(res.body.data.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(280_000);
    expect(ttl).toBeLessThanOrEqual(300_500);
    const fetched = await fetch(res.body.data.url);
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(body)).toBe(true);
    expect(res.body.data.url).toContain(`q/${owner}/${id}`);
    await pool.query(`update media_objects set state = 'rejected', reject_reason = 'decode_failed' where id = $1`, [id]);
    expect((await call('GET', `/media/${id}/url`, token)).status).toBe(404);
  });

  it('a signed URL stops working after its expiry, and a new one needs the ownership check again', async () => {
    const owner = await account();
    const other = await account();
    const id = (await upload(owner.token, withHead(HEADS['png']!.head, 321))).body.data.id as string;
    await pool.query(`update media_objects set state = 'ready' where id = $1`, [id]);
    const key = (await row(id))?.storage_key as string;
    const shortLived = await storage.presignGet(key, 1, { type: 'inline' });
    expect((await fetch(shortLived)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect((await fetch(shortLived)).status).toBe(403);
    expect((await call('GET', `/media/${id}/url`, other.token)).status).toBe(404);
    const fresh = await call('GET', `/media/${id}/url`, owner.token);
    expect(fresh.status).toBe(200);
    expect((await fetch(fresh.body.data.url)).status).toBe(200);
  });
});
