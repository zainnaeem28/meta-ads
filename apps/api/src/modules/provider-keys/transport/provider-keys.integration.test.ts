/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles; prettier reflow detached the per-line directives (AIU-256) */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { ModulesContainer } from '@nestjs/core';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiApp } from '../../../bootstrap/api.module.js';
import {
  REAL_MIGRATIONS,
  adminUrl,
  createTestDatabase,
} from '../../../platform/db/test-database.js';
import type { TestDatabase } from '../../../platform/db/test-database.js';
import { EGRESS, EgressError } from '../../../platform/egress/index.js';
import type { Egress } from '../../../platform/egress/index.js';
import { installJobs } from '../../../platform/jobs/test-support.js';
import { createHttpLogging } from '../../../platform/logging/index.js';
import { IN_FLIGHT_JOB_READER } from '../application/ports.js';
import type { Executor, InFlightJobReader } from '../application/ports.js';
import { ProviderKeysService } from '../application/provider-keys.service.js';
import { KEY_WRAP_PORT } from '../domain/key-wrap.js';
import type { KeyAad, Sealed } from '../domain/key-wrap.js';
import {
  DrizzleKeyEventRepository,
  DrizzleProviderKeyRepository,
} from '../infrastructure/provider-keys.repositories.js';
import { KeyUnsealer } from '../infrastructure/key-unsealer.js';
import { generateKek, kekEnv } from '../infrastructure/test-support.js';

// TASK-040 (provider-keys 2/2) through the real api composition root (`createApiApp`, the one `main.api.ts` runs) with
// `fastify.inject` on real PostgreSQL: API-010 to API-013, the probe, sealing, the attempt limit, replacement and
// deletion, key events and audit, the auto-disable, and the repositories under the `app_api` column grants.
// TC-KEY-01..06, 15..17, 19..21; TC-KEY-13 (canary).

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
const PEPPER = randomBytes(32).toString('base64');
const OPENAI_KEY = ['sk', 'canary-OPENAI-0123456789abcdefghij'].join('-'); // assembled so no scanner reads it as a real key
const OPENAI_KEY_2 = ['sk', 'canary-OPENAI-second-9876543210zz'].join('-');
const WAVE_KEY = 'wavecanary_0123456789_abcdefghij';

let testDb: TestDatabase;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof createApiApp>>['app'];
let kek: ReturnType<typeof generateKek>;
let unsealer: KeyUnsealer;
let seq = 0;
const logLines: string[] = [];
const roleName = `app_api_t040_${randomBytes(4).toString('hex')}`;
const rolePassword = randomBytes(12).toString('hex');

interface Local {
  addUser(sub: string, email: string, verified: boolean): void;
  issueToken(claims: { sub: string; azp: string; fva: [number, number] }): string;
}
let local: Local;
/** What the stubbed provider answers to a probe: a status, or an egress failure. */
let providerAnswer: number | 'timeout' = 200;
const probeCalls: { provider: string; url: string; authorization: string | undefined }[] = [];

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

async function applyStatements(
  file: string,
  part: 'tables' | 'grants',
  only?: RegExp,
): Promise<void> {
  const [tables = '', grants = ''] = readFileSync(join(REAL_MIGRATIONS, file), 'utf8').split(
    '-- Grants',
  );
  const body = part === 'tables' ? tables : grants.slice(grants.indexOf('\n'));
  for (const statement of body.split('--> statement-breakpoint')) {
    const text = statement
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .replace(/\bapp_api\b/g, roleName)
      .trim();
    if (text !== '' && (only === undefined || only.test(text))) await pool.query(text);
  }
}

beforeAll(async () => {
  kek = generateKek();
  unsealer = KeyUnsealer.fromEnv(kekEnv({ 1: kek }, 1, true));
  testDb = await createTestDatabase({ label: 'task040', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 4 });
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE ROLE "${roleName}" LOGIN NOSUPERUSER PASSWORD '${rolePassword}'`);
  await admin.end();
  await applyStatements(
    '0001_task-025-platform.sql',
    'tables',
    /^(CREATE TABLE|CREATE INDEX) "(idempotency_records|rate_limit_buckets|idempotency_records_expiry_idx)/,
  );
  await applyStatements('0010_task-032-audit.sql', 'tables');
  await applyStatements('0020_task-033-identity.sql', 'tables');
  await applyStatements('0030_task-039-provider-keys.sql', 'tables');
  await pool.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
  await applyStatements(
    '0030_task-039-provider-keys.sql',
    'grants',
    new RegExp(`TO "?${roleName}`),
  );
  await installJobs(testDb.url);
  Object.assign(process.env, {
    ...kekEnv({ 1: kek }, 1, false),
    KEY_FINGERPRINT_PEPPERS: JSON.stringify({ '1': PEPPER }),
    KEY_FINGERPRINT_PEPPER_ACTIVE: '1',
    OWNER_EMAIL: 'owner40@example.test',
    INVITE_EMAIL_DOMAINS: 'example.test',
    CURSOR_SIGNING_KEY: 'k'.repeat(40),
  });
  ({ app } = await createApiApp(
    {
      WEB_ORIGIN: ORIGIN,
      APP_ENV: 'development',
      DATABASE_URL: testDb.url,
      DATABASE_POOL_MAX: 6,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      RATE_LIMIT_IP_KEY: 'r'.repeat(40),
    },
    createHttpLogging({
      level: 'debug',
      destination: new Writable({
        write(chunk: Buffer, _enc, done) {
          logLines.push(chunk.toString());
          done();
        },
      }),
    }),
  ));
  const providers = [...app.get(ModulesContainer, { strict: false }).values()].flatMap((m) => [
    ...m.providers.values(),
  ]);
  const found = providers
    .map((p) => p.instance as Partial<Local> | undefined)
    .find((i) => typeof i?.issueToken === 'function');
  if (found === undefined) throw new Error('local identity provider not found');
  local = found as Local;
  // The provider is a stub behind the real egress client: the probe adapter, its URL and its headers are the real ones.
  const egress = app.get<Pick<Egress, 'fetch'>>(EGRESS, { strict: false });
  vi.spyOn(egress, 'fetch').mockImplementation((provider, req) => {
    probeCalls.push({ provider, url: req.url, authorization: req.headers?.['authorization'] });
    if (providerAnswer === 'timeout')
      return Promise.reject(new EgressError('timeout', 'after_send', 'the time limit passed'));
    return Promise.resolve({
      status: providerAnswer,
      headers: {},
      // A provider error body that echoes the key (TC-KEY-06).
      body: Buffer.from(
        JSON.stringify({ error: `bad key ${req.headers?.['authorization'] ?? ''}` }),
      ),
    });
  });
}, 240_000);

afterAll(async () => {
  for (const name of [
    'KEK_PUBLIC_KEYS',
    'KEK_ACTIVE_VERSION',
    'KEY_FINGERPRINT_PEPPERS',
    'KEY_FINGERPRINT_PEPPER_ACTIVE',
    'OWNER_EMAIL',
    'INVITE_EMAIL_DOMAINS',
    'CURSOR_SIGNING_KEY',
  ]) {
    delete process.env[name];
  }
  vi.restoreAllMocks();
  await app?.close();
  await pool?.end();
  await testDb?.drop();
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`DROP ROLE IF EXISTS "${roleName}"`).catch(() => undefined);
  await admin.end();
});

const fastify = () => app.getHttpAdapter().getInstance();
interface Body {
  success: boolean;
  data?: any;
  error?: { code: string; details?: any[] };
  metaData: any;
}
async function call(
  method: 'GET' | 'PUT' | 'DELETE',
  url: string,
  tok?: string,
  payload?: unknown,
) {
  const headers: Record<string, string> = {};
  if (tok !== undefined) headers['authorization'] = `Bearer ${tok}`;
  const res = await fastify().inject({
    method,
    url: `/api/v1${url}`,
    headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  const text = res.body;
  return {
    status: res.statusCode,
    raw: text,
    headers: res.headers,
    body: (text === '' ? { success: true, metaData: {} } : JSON.parse(text)) as Body,
  };
}

/** Links an account through an invitation. Returns its user ID and tokens: fresh, and stale (sign-in 30 minutes old). */
async function account() {
  const sub = `user_t40_${String(++seq)}`;
  const email = `k${String(seq)}@example.test`;
  local.addUser(sub, email, true);
  await pool.query(
    `insert into invitations (id, email, expires_at) values (gen_random_uuid(), $1, now() + interval '1 day')`,
    [email],
  );
  const tok = (f: [number, number] = [1, 1]) => local.issueToken({ sub, azp: ORIGIN, fva: f });
  expect((await call('GET', '/me', tok())).status).toBe(200);
  const id = (await pool.query(`select id from users where idp_subject = $1`, [sub])).rows[0]
    .id as string;
  return { id, token: tok(), stale: tok([30, 30]) };
}

const put = (token: string, provider: string, apiKey: unknown) =>
  call('PUT', `/me/provider-keys/${provider}`, token, { apiKey });
const row = async (owner: string, provider: string) =>
  (
    await pool.query(`select * from provider_keys where owner_id = $1 and provider = $2`, [
      owner,
      provider,
    ])
  ).rows[0] as Record<string, any> | undefined;
const kinds = async (owner: string, provider?: string) =>
  (
    await pool.query(
      `select kind from key_events where owner_id = $1 and ($2::text is null or provider = $2) order by at, id`,
      [owner, provider ?? null],
    )
  ).rows.map((r: { kind: string }) => r.kind);
const audits = async (owner: string) =>
  (
    await pool.query(
      `select action from audit_events where actor_id = $1 and action like 'key.%' order by id`,
      [owner],
    )
  ).rows.map((r: { action: string }) => r.action);
const service = () => app.get(ProviderKeysService, { strict: false });

describe('API-010 to API-013 through the api composition root', () => {
  it('refuses without a token, and a stale sign-in on PUT and DELETE but not on the reads (TC-KEY-05)', async () => {
    const a = await account();
    expect((await call('GET', '/me/provider-keys')).status).toBe(401);
    expect((await call('GET', '/me/key-events')).status).toBe(401);
    const r = await put(a.stale, 'openai', OPENAI_KEY);
    expect([r.status, r.body.error?.code]).toEqual([403, 'recent_auth_required']);
    const d = await call('DELETE', '/me/provider-keys/openai', a.stale);
    expect([d.status, d.body.error?.code]).toEqual([403, 'recent_auth_required']);
    expect((await call('GET', '/me/provider-keys', a.stale)).status).toBe(200);
    expect((await call('GET', '/me/key-events', a.stale)).status).toBe(200);
    expect(await row(a.id, 'openai')).toBeUndefined();
  });

  it('lists one unconfigured entry per provider, then a stored key by hint and fingerprint only (TC-KEY-01)', async () => {
    const a = await account();
    const isList = contractValidator('ProviderKeyListResponse');
    const before = await call('GET', '/me/provider-keys', a.token);
    expect(before.status).toBe(200);
    expect(isList(before.body)).toBe(true);
    expect(
      before.body.data.map((k: { provider: string; configured: boolean }) => [
        k.provider,
        k.configured,
      ]),
    ).toEqual([
      ['openai', false],
      ['wavespeed', false],
    ]);
    providerAnswer = 200;
    probeCalls.length = 0;
    const stored = await put(a.token, 'openai', `${OPENAI_KEY}  \n`);
    expect(stored.status).toBe(200);
    expect(contractValidator('ProviderKeyPutResponse')(stored.body)).toBe(true);
    expect(stored.body.data).toMatchObject({
      provider: 'openai',
      configured: true,
      status: 'active',
      last4: OPENAI_KEY.slice(-4),
      version: 1,
      probe: 'valid',
      inFlightJobCount: 0,
    });
    expect(stored.body.data.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(probeCalls).toEqual([
      {
        provider: 'openai',
        url: 'https://api.openai.com/v1/models',
        authorization: `Bearer ${OPENAI_KEY}`,
      },
    ]);
    const after = await call('GET', '/me/provider-keys', a.token);
    expect(isList(after.body)).toBe(true);
    expect(after.body.data[0]).toMatchObject({
      provider: 'openai',
      status: 'active',
      last4: OPENAI_KEY.slice(-4),
    });
    expect(after.body.data[1]).toMatchObject({
      provider: 'wavespeed',
      configured: false,
      status: null,
      fingerprint: null,
    });
    expect(await kinds(a.id)).toEqual(['test_passed', 'added']);
    expect(await audits(a.id)).toEqual(['key.added']);
    // Sealed for real: the stored bytes are not the key, and only the worker-side unsealer opens them, bound to the row.
    const stored1 = (await pool.query(`select * from provider_keys where owner_id = $1`, [a.id]))
      .rows[0];
    expect(stored1.ciphertext.toString('latin1')).not.toContain(OPENAI_KEY);
    expect(stored1.fingerprint).toHaveLength(64);
    const sealed: Sealed = {
      ciphertext: stored1.ciphertext,
      nonce: stored1.nonce,
      wrappedDek: stored1.wrapped_dek,
      kekVersion: stored1.kek_version,
    };
    const aad: KeyAad = { userId: a.id, provider: 'openai', keyId: stored1.id, version: 1 };
    expect(unsealer.unseal(sealed, aad).toString('utf8')).toBe(OPENAI_KEY);
    expect(() => unsealer.unseal(sealed, { ...aad, version: 2 })).toThrow();
  });

  it('refuses a key the provider rejects with 422 key_invalid, stores nothing and leaves an old key unchanged (TC-KEY-02, 17)', async () => {
    const a = await account();
    providerAnswer = 401;
    const first = await put(a.token, 'openai', OPENAI_KEY);
    expect([first.status, first.body.error?.code]).toEqual([422, 'key_invalid']);
    expect(first.body.error?.details?.[0]).toMatchObject({ field: 'apiKey', code: 'rejected' });
    expect(first.raw).not.toContain(OPENAI_KEY);
    expect(await row(a.id, 'openai')).toBeUndefined();
    expect(await kinds(a.id)).toEqual(['test_failed']);

    providerAnswer = 200;
    expect((await put(a.token, 'openai', OPENAI_KEY)).status).toBe(200);
    const before = await row(a.id, 'openai');
    providerAnswer = 401;
    const second = await put(a.token, 'openai', OPENAI_KEY_2);
    expect([second.status, second.body.error?.code]).toEqual([422, 'key_invalid']);
    const after = await row(a.id, 'openai');
    expect(after?.version).toBe(1);
    expect(after?.ciphertext.equals(before?.ciphertext)).toBe(true);
    expect(after?.fingerprint).toBe(before?.fingerprint);
    expect(after?.status).toBe('active');
  });

  it('refuses a malformed, wrong-provider or too short key with a reason class and never echoes it (TC-KEY-02, 06)', async () => {
    const a = await account();
    providerAnswer = 200;
    const calls = probeCalls.length;
    const cases: [string, string, string][] = [
      ['wavespeed', OPENAI_KEY, 'wrong_provider'],
      ['openai', WAVE_KEY, 'format'],
      ['openai', 'sk-short', 'format'],
      ['openai', '   ', 'format'],
    ];
    for (const [provider, key, code] of cases) {
      const r = await put(a.token, provider, key);
      expect([r.status, r.body.error?.code, r.body.error?.details?.[0]?.code]).toEqual([
        422,
        'key_invalid',
        code,
      ]);
      expect(r.raw).not.toContain(key.trim() === '' ? 'never' : key.trim());
    }
    expect(probeCalls.length).toBe(calls); // refused before any provider call
    for (const bad of [
      {},
      { apiKey: 5 },
      { apiKey: 'x'.repeat(513) },
      { apiKey: OPENAI_KEY, extra: 1 },
    ]) {
      const r = await call('PUT', '/me/provider-keys/openai', a.token, bad);
      expect([r.status, r.body.error?.code]).toEqual([400, 'validation_failed']);
      expect(r.raw).not.toContain(OPENAI_KEY);
    }
    const unknown = await put(a.token, 'anthropic', OPENAI_KEY);
    expect([unknown.status, unknown.body.error?.code]).toEqual([400, 'validation_failed']);
    expect(await row(a.id, 'openai')).toBeUndefined();
  });

  it('stores a key as untested when the provider times out or answers 403, 429 or 500 (TC-KEY-03)', async () => {
    const a = await account();
    // Each outcome is a different account's first key, so the 5-attempt window is not what is being tested.
    for (const [answer, provider, key] of [
      ['timeout', 'openai', OPENAI_KEY],
      [403, 'wavespeed', WAVE_KEY],
    ] as const) {
      providerAnswer = answer;
      const r = await put(a.token, provider, key);
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({
        provider,
        status: 'untested',
        probe: 'unknown',
        lastValidatedAt: null,
      });
      expect((await row(a.id, provider))?.status).toBe('untested');
    }
    const b = await account();
    for (const answer of [429, 500]) {
      providerAnswer = answer;
      const r = await put(b.token, 'openai', OPENAI_KEY);
      expect(r.body.data).toMatchObject({ status: 'untested', probe: 'unknown' });
    }
    expect(await kinds(a.id, 'openai')).toEqual(['stored_untested', 'added']);
    expect(await kinds(b.id, 'openai')).toEqual([
      'stored_untested',
      'added',
      'stored_untested',
      'replaced',
    ]);
  });

  it('allows five attempts in ten minutes, refuses the sixth with 429 and one event, and allows again after the window (TC-KEY-04)', async () => {
    const a = await account();
    providerAnswer = 401;
    for (let i = 0; i < 5; i += 1)
      expect((await put(a.token, 'openai', OPENAI_KEY)).status).toBe(422);
    const sixth = await put(a.token, 'openai', OPENAI_KEY);
    expect([sixth.status, sixth.body.error?.code]).toEqual([429, 'rate_limited']);
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await put(a.token, 'openai', OPENAI_KEY)).status).toBe(429);
    expect((await kinds(a.id)).filter((k) => k === 'attempt_rate_limited')).toHaveLength(1);
    // The other provider shares the account's limit; another account does not.
    expect((await put(a.token, 'wavespeed', WAVE_KEY)).status).toBe(429);
    expect((await put((await account()).token, 'openai', OPENAI_KEY)).status).toBe(422);
    // The window passes: the account's counters move ten minutes back.
    await pool.query(
      `update rate_limit_buckets set window_start = window_start - interval '11 minutes' where scope = 'key-entry' and subject = $1`,
      [a.id],
    );
    providerAnswer = 200;
    expect((await put(a.token, 'openai', OPENAI_KEY)).status).toBe(200);
  });

  it('replaces atomically: version + 1, the old sealed bytes overwritten, an event and an audit entry, the warning count (TC-KEY-15, 16)', async () => {
    const a = await account();
    providerAnswer = 200;
    expect((await put(a.token, 'openai', OPENAI_KEY)).status).toBe(200);
    const old = await row(a.id, 'openai');
    const reader = app.get<InFlightJobReader>(IN_FLIGHT_JOB_READER, { strict: false });
    const count = vi.spyOn(reader, 'countForKey').mockResolvedValue(2);
    const warned = await call('GET', '/me/provider-keys', a.token);
    expect(warned.body.data[0].inFlightJobCount).toBe(2);
    expect(warned.body.data[1].inFlightJobCount).toBe(0);
    const replaced = await put(a.token, 'openai', OPENAI_KEY_2);
    count.mockRestore();
    expect(replaced.status).toBe(200);
    expect(replaced.body.data).toMatchObject({
      version: 2,
      status: 'active',
      last4: OPENAI_KEY_2.slice(-4),
    });
    expect(replaced.body.data.fingerprint).not.toBe(warned.body.data[0].fingerprint);
    const now = await row(a.id, 'openai');
    expect(now?.id).toBe(old?.id);
    expect(now?.version).toBe(2);
    expect(now?.ciphertext.equals(old?.ciphertext)).toBe(false);
    expect(now?.wrapped_dek.equals(old?.wrapped_dek)).toBe(false);
    const aad: KeyAad = { userId: a.id, provider: 'openai', keyId: now?.id, version: 2 };
    expect(
      unsealer
        .unseal(
          {
            ciphertext: now?.ciphertext,
            nonce: now?.nonce,
            wrappedDek: now?.wrapped_dek,
            kekVersion: now?.kek_version,
          },
          aad,
        )
        .toString('utf8'),
    ).toBe(OPENAI_KEY_2);
    expect(await kinds(a.id)).toEqual(['test_passed', 'added', 'test_passed', 'replaced']);
    expect(await audits(a.id)).toEqual(['key.added', 'key.replaced']);
  });

  it('serialises two simultaneous first stores: both succeed, one row, version 2 (conditional write on version)', async () => {
    const a = await account();
    providerAnswer = 200;
    const [x, y] = await Promise.all([
      put(a.token, 'openai', OPENAI_KEY),
      put(a.token, 'openai', OPENAI_KEY_2),
    ]);
    expect([x.status, y.status]).toEqual([200, 200]);
    const rows = (await pool.query(`select version from provider_keys where owner_id = $1`, [a.id]))
      .rows;
    expect(rows).toEqual([{ version: 2 }]);
    expect((await kinds(a.id)).filter((k) => k === 'added' || k === 'replaced').sort()).toEqual([
      'added',
      'replaced',
    ]);
  });

  it("hard-deletes a key with 204, then 404; one account cannot see or delete another account's key (TC-KEY-19, TC-ZT)", async () => {
    const a = await account();
    const b = await account();
    providerAnswer = 200;
    expect((await put(a.token, 'wavespeed', WAVE_KEY)).status).toBe(200);
    const foreign = await call('DELETE', '/me/provider-keys/wavespeed', b.token);
    expect([foreign.status, foreign.body.error?.code]).toEqual([404, 'not_found']);
    expect(
      (await call('GET', '/me/provider-keys', b.token)).body.data.every(
        (k: { configured: boolean }) => !k.configured,
      ),
    ).toBe(true);
    expect(await row(a.id, 'wavespeed')).toBeDefined();
    const gone = await call('DELETE', '/me/provider-keys/wavespeed', a.token);
    expect(gone.status).toBe(204);
    expect(gone.raw).toBe('');
    expect(await row(a.id, 'wavespeed')).toBeUndefined();
    expect(
      Number(
        (await pool.query(`select count(*) n from provider_keys where owner_id = $1`, [a.id]))
          .rows[0].n,
      ),
    ).toBe(0);
    const again = await call('DELETE', '/me/provider-keys/wavespeed', a.token);
    expect([again.status, again.body.error?.code]).toEqual([404, 'not_found']);
    expect(await kinds(a.id, 'wavespeed')).toEqual(['test_passed', 'added', 'deleted']);
    expect(await audits(a.id)).toEqual(['key.added', 'key.deleted']);
    expect((await call('DELETE', '/me/provider-keys/nope', a.token)).status).toBe(400);
  });

  it('lists key events newest first, filters by provider, pages with a signed cursor and shows no values (API-013)', async () => {
    const a = await account();
    providerAnswer = 200;
    await put(a.token, 'openai', OPENAI_KEY);
    await put(a.token, 'wavespeed', WAVE_KEY);
    await put(a.token, 'openai', OPENAI_KEY_2);
    await call('DELETE', '/me/provider-keys/wavespeed', a.token);
    const expected = (
      await pool.query(`select id from key_events where owner_id = $1 order by at desc, id desc`, [
        a.id,
      ])
    ).rows.map((r: { id: string }) => r.id);
    expect(expected).toHaveLength(7);
    const isPage = contractValidator('KeyEventPage');
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: Awaited<ReturnType<typeof call>> = await call(
        'GET',
        `/me/key-events?limit=3${cursor === null ? '' : `&cursor=${cursor}`}`,
        a.token,
      );
      expect(r.status).toBe(200);
      expect(isPage(r.body)).toBe(true);
      seen.push(...r.body.data.map((e: { id: string }) => e.id));
      cursor = r.body.metaData.pagination.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(expected);
    const filtered = await call('GET', '/me/key-events?provider=wavespeed', a.token);
    expect(filtered.body.data.map((e: { kind: string }) => e.kind)).toEqual([
      'deleted',
      'added',
      'test_passed',
    ]);
    const page = await call('GET', '/me/key-events?limit=2', a.token);
    const next = page.body.metaData.pagination.nextCursor as string;
    for (const url of [
      `/me/key-events?provider=openai&cursor=${next}`,
      `/me/key-events?cursor=${next}x`,
      '/me/key-events?cursor=garbage',
    ]) {
      const r = await call('GET', url, a.token);
      expect([r.status, r.body.error?.code]).toEqual([400, 'validation_failed']);
    }
    // Another account's cursor is refused too.
    const b = await account();
    expect((await call('GET', `/me/key-events?cursor=${next}`, b.token)).status).toBe(400);
    for (const url of [
      '/me/key-events?limit=0',
      '/me/key-events?limit=51',
      '/me/key-events?provider=x',
    ]) {
      expect((await call('GET', url, a.token)).status).toBe(400);
    }
    expect((await call('GET', '/me/key-events', b.token)).body.data).toEqual([]);
  });

  it('never returns, logs or stores a key anywhere: canary scan of responses, logs and every table (TC-KEY-06, 13)', async () => {
    const a = await account();
    providerAnswer = 401;
    await put(a.token, 'openai', OPENAI_KEY);
    providerAnswer = 200;
    await put(a.token, 'openai', OPENAI_KEY);
    await put(a.token, 'openai', OPENAI_KEY_2);
    const bodies = [
      (await call('GET', '/me/provider-keys', a.token)).raw,
      (await call('GET', '/me/key-events', a.token)).raw,
      (await call('GET', '/me/key-events?limit=1', a.token)).raw,
    ];
    const tables = (
      await pool.query(
        `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
      )
    ).rows.map((r: { table_name: string }) => r.table_name);
    for (const table of tables) {
      const dump = (
        await pool.query(
          `select coalesce(string_agg(t::text, E'\\n'), '') as text from "${table}" t`,
        )
      ).rows[0].text as string;
      bodies.push(dump);
    }
    const logs = logLines.join('');
    for (const secret of [OPENAI_KEY, OPENAI_KEY_2, 'canary-OPENAI']) {
      for (const text of [...bodies, logs]) expect(text).not.toContain(secret);
      expect(bodies.join('')).not.toContain(Buffer.from(secret).toString('hex'));
    }
    expect(logs).toContain('/api/v1/me/provider-keys'); // the request lines exist: the scan looked at something
  });
});

describe('auto-disable, operator disable and account erasure on the service', () => {
  const makeKey = async (provider: 'openai' | 'wavespeed' = 'openai', status = 200) => {
    const a = await account();
    providerAnswer = status;
    expect(
      (await put(a.token, provider, provider === 'openai' ? OPENAI_KEY : WAVE_KEY)).status,
    ).toBe(200);
    const stored = (await row(a.id, provider)) as Record<string, any>;
    return { ...a, keyId: stored['id'] as string };
  };

  it('disables a key at the fifth consecutive failure, resets on success, and a replacement re-enables it (TC-KEY-20)', async () => {
    const a = await makeKey();
    for (let i = 0; i < 4; i += 1) await service().recordAuthResult(a.keyId, 1, false);
    expect((await row(a.id, 'openai'))?.consecutive_auth_failures).toBe(4);
    await service().recordAuthResult(a.keyId, 1, true);
    expect((await row(a.id, 'openai'))?.consecutive_auth_failures).toBe(0);
    for (let i = 0; i < 4; i += 1) await service().recordAuthResult(a.keyId, 1, false);
    expect((await row(a.id, 'openai'))?.status).toBe('active');
    await service().recordAuthResult(a.keyId, 1, false);
    const disabled = await row(a.id, 'openai');
    expect([disabled?.status, disabled?.consecutive_auth_failures]).toEqual(['disabled', 5]);
    expect(disabled?.disabled_at).not.toBeNull();
    expect((await call('GET', '/me/provider-keys', a.token)).body.data[0].status).toBe('disabled');
    expect((await kinds(a.id)).filter((k) => k === 'auth_failed')).toHaveLength(9);
    expect((await kinds(a.id)).filter((k) => k === 'disabled')).toHaveLength(1);
    expect(await audits(a.id)).toEqual(['key.added']);
    expect(
      (
        await pool.query(
          `select count(*) n from audit_events where action = 'key.disabled' and object_id = $1`,
          [a.keyId],
        )
      ).rows[0].n,
    ).toBe('1');
    // Later reports on a disabled key change nothing; a failure of an older version counts for nothing.
    await service().recordAuthResult(a.keyId, 1, false);
    await service().recordAuthResult(a.keyId, 1, true);
    expect((await row(a.id, 'openai'))?.consecutive_auth_failures).toBe(5);
    providerAnswer = 200;
    const replaced = await put(a.token, 'openai', OPENAI_KEY_2);
    expect(replaced.body.data).toMatchObject({ status: 'active', version: 2 });
    const live = await row(a.id, 'openai');
    expect([live?.consecutive_auth_failures, live?.disabled_at]).toEqual([0, null]);
    await service().recordAuthResult(a.keyId, 1, false);
    expect((await row(a.id, 'openai'))?.consecutive_auth_failures).toBe(0);
  });

  it('activates an untested key on the first job that authenticates (TC-KEY-03)', async () => {
    const a = await account();
    providerAnswer = 'timeout';
    await put(a.token, 'wavespeed', WAVE_KEY);
    const id = (await row(a.id, 'wavespeed'))?.id as string;
    await service().recordAuthResult(id, 1, true);
    const live = await row(a.id, 'wavespeed');
    expect(live?.status).toBe('active');
    expect(live?.last_validated_at).not.toBeNull();
    expect(await kinds(a.id)).toEqual(['stored_untested', 'added', 'validated_by_job']);
    await service().recordAuthResult(id, 1, true);
    expect((await kinds(a.id)).filter((k) => k === 'validated_by_job')).toHaveLength(1);
    await service().recordAuthResult('0197a1b2-0000-7000-8000-0000000000ff', 1, true);
    await service().recordAuthResult('0197a1b2-0000-7000-8000-0000000000ff', 1, false);
  });

  it('disables every key for the operator with an event each, an audit entry and one alert (TC-KEY, keys:disable-all)', async () => {
    const a = await makeKey('openai');
    const b = await makeKey('wavespeed');
    expect(await service().disableAll()).toBeGreaterThanOrEqual(2);
    expect((await row(a.id, 'openai'))?.status).toBe('disabled');
    expect((await row(b.id, 'wavespeed'))?.status).toBe('disabled');
    expect(await kinds(a.id)).toContain('disabled_by_operator');
    expect(
      (
        await pool.query(
          `select count(*) n from audit_events where action = 'key.disabled_all' and actor_type = 'operator'`,
        )
      ).rows[0].n,
    ).toBe('1');
    expect(
      (await pool.query(`select count(*) n from admin_alerts where kind = 'keys_disabled_all'`))
        .rows[0].n,
    ).toBe('1');
    expect(await service().disableAll()).toBe(0);
  });

  it("deletes every key of an owner inside the caller's transaction and leaves one event each (account erasure)", async () => {
    const a = await makeKey('openai');
    providerAnswer = 200;
    await put(a.token, 'wavespeed', WAVE_KEY);
    const db = (
      app.get(ProviderKeysService, { strict: false }) as unknown as {
        database: { uow: { run<T>(fn: (tx: Executor) => Promise<T>): Promise<T> } };
      }
    ).database;
    expect(await db.uow.run((tx) => service().deleteAllForOwner(tx, a.id))).toBe(2);
    expect(await row(a.id, 'openai')).toBeUndefined();
    expect((await kinds(a.id)).filter((k) => k === 'deleted')).toHaveLength(2);
    expect(await db.uow.run((tx) => service().deleteAllForOwner(tx, a.id))).toBe(0);
  });
});

describe('the repositories under the app_api column grants (ADR-009)', () => {
  it('store, replace, read, count failures and delete without ever selecting a sealed column', async () => {
    const url = new URL(testDb.url);
    url.username = roleName;
    url.password = rolePassword;
    const apiPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
    try {
      const db = drizzle(apiPool) as unknown as Executor;
      const keys = new DrizzleProviderKeyRepository();
      const events = new DrizzleKeyEventRepository();
      const owner = await account();
      const id = '0197a1b2-0000-7000-8000-0000000000b1';
      const sealed: Sealed = {
        ciphertext: Buffer.alloc(40, 1),
        nonce: Buffer.alloc(12, 2),
        wrappedDek: Buffer.alloc(384, 3),
        kekVersion: 1,
      };
      const write = {
        status: 'untested' as const,
        version: 1,
        sealed,
        last4: 'abcd',
        fingerprint: 'f'.repeat(64),
        fingerprintPepperVersion: 1,
        validatedAt: null,
      };
      expect(await keys.insert(db, id, owner.id, 'openai', write)).toBe(true);
      expect(await keys.insert(db, id, owner.id, 'openai', write)).toBe(false);
      expect(await keys.find(db, owner.id, 'openai')).toMatchObject({
        id,
        status: 'untested',
        version: 1,
        last4: 'abcd',
      });
      expect((await keys.list(db, owner.id)).map((k) => k.provider)).toEqual(['openai']);
      expect(await keys.replace(db, id, 7, { ...write, version: 8 })).toBe(false);
      expect(await keys.replace(db, id, 1, { ...write, version: 2, status: 'untested' })).toBe(
        true,
      );
      expect((await keys.recordSuccess(db, id, 2))?.activated).toBe(true);
      expect((await keys.recordSuccess(db, id, 2))?.activated).toBe(false);
      expect(await keys.recordSuccess(db, id, 1)).toBeNull();
      expect((await keys.recordFailure(db, id, 2, 2))?.status).toBe('active');
      expect((await keys.recordFailure(db, id, 2, 2))?.status).toBe('disabled');
      expect(await keys.recordFailure(db, id, 2, 2)).toBeNull();
      expect(await keys.disableAll(db)).toEqual(
        expect.not.arrayContaining([expect.objectContaining({ id })]),
      );
      await events.insert(db, { ownerId: owner.id, keyId: id, provider: 'openai', kind: 'added' });
      expect((await events.list(db, owner.id, { limit: 5 })).map((e) => e.kind)).toEqual(['added']);
      // The grants really do refuse a read of a sealed column, so the repositories above could not have made one.
      await expect(apiPool.query('select ciphertext from provider_keys')).rejects.toMatchObject({
        code: '42501',
      });
      expect(await keys.delete(db, owner.id, 'openai')).toBe(id);
      expect(await keys.delete(db, owner.id, 'openai')).toBeNull();
      expect(await keys.deleteAll(db, owner.id)).toEqual([]);
    } finally {
      await apiPool.end();
    }
  });
});

void KEY_WRAP_PORT;
