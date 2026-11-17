/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles; prettier reflow detached the per-line directives (AIU-256) */
// TASK-050 (brief 3/4) through the real api composition root (`createApiApp`, the one `main.api.ts` runs) with
// `fastify.inject` on real PostgreSQL, API-050 (read, ETag), API-051 (edit), API-052 (accept) and
// API-054 (clear). TC-REV-*, TC-BRF-*.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ModulesContainer } from '@nestjs/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../../bootstrap/api.module.js';
import { runSeed } from '../../../database/seed.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../../platform/db/test-database.js';
import type { TestDatabase } from '../../../platform/db/test-database.js';
import { installJobs } from '../../../platform/jobs/test-support.js';
import { createHttpLogging } from '../../../platform/logging/index.js';
import { brandRulesSeedStep } from '../infrastructure/repositories/brand-rules-file.js';

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

function tableStatements(file: string): string[] {
  const [tables = ''] = readFileSync(join(REAL_MIGRATIONS, file), 'utf8').split('-- Grants');
  return tables
    .split('--> statement-breakpoint')
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement !== '');
}

beforeAll(async () => {
  testDb = await createTestDatabase({ label: 'task050', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 6 });
  for (const statement of tableStatements('0001_task-025-platform.sql')) {
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
    '0040_task-041-media.sql',
    '0050_task-044-usage.sql',
    '0070_task-046-campaigns.sql',
    '0080_task-048-brief.sql',
  ];
  for (const file of files)
    for (const statement of tableStatements(file)) await pool.query(statement);
  await installJobs(testDb.url);
  await runSeed({
    dataset: 'reference',
    appEnv: 'development',
    databaseUrl: testDb.url,
    steps: [brandRulesSeedStep()],
  });
  const env: Record<string, string | undefined> = {
    KEK_PUBLIC_KEYS: undefined,
    KEK_PRIVATE_KEYS: undefined,
    R2_ENDPOINT: undefined,
    BRAND_RULES_FILE: undefined,
    OWNER_EMAIL: 'owner50@example.test',
    INVITE_EMAIL_DOMAINS: 'example.test',
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
});

const fastify = () => app.getHttpAdapter().getInstance();
interface Body {
  success: boolean;
  data?: any;
  error?: { code: string; details?: any[] };
  metaData: any;
}
async function call(
  method: 'GET' | 'POST' | 'PATCH',
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
    headers: res.headers,
    body: (res.body === '' ? { success: true, metaData: {} } : JSON.parse(res.body)) as Body,
  };
}

async function account() {
  const sub = `user_t50_${String(++seq)}`;
  const email = `b${String(seq)}@example.test`;
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

const CLEAN = `${Array.from({ length: 33 }, () => 'tea').join(' ')}.`;
const LAST = `${Array.from({ length: 28 }, () => 'tea').join(' ')}. Adults 21+ only. Take the free 2-minute quiz`;

/** A draft brief of two active segments with clean text, no issues. */
async function brief(ownerId: string, state = 'draft') {
  const campaignId = crypto.randomUUID();
  const briefId = crypto.randomUUID();
  await pool.query(
    `insert into campaigns (id, owner_id, product_name, product_description, segment_count) values ($1, $2, 'Tonic', 'd', 2)`,
    [campaignId, ownerId],
  );
  await pool.query(
    `insert into briefs (id, campaign_id, owner_id, state, accepted_at) values ($1, $2, $3, $4, case when $4 = 'accepted' then now() end)`,
    [briefId, campaignId, ownerId, state],
  );
  for (const [position, dialogue] of [
    [1, CLEAN],
    [2, LAST],
  ] as const) {
    await pool.query(
      `insert into brief_segments (id, brief_id, position, dialogue, prompt, word_count) values ($1, $2, $3, $4, 'A calm kitchen.', 30)`,
      [crypto.randomUUID(), briefId, position, dialogue],
    );
  }
  return { campaignId, briefId };
}

const etagOf = (res: { headers: Record<string, unknown> }) => String(res.headers['etag']);
const seg = (data: any, position: number) =>
  data.segments.find((s: any) => s.position === position);
const events = async (briefId: string) =>
  (
    await pool.query(
      `select class, outcome from claim_events where brief_id = $1 order by at, id`,
      [briefId],
    )
  ).rows as { class: string; outcome: string }[];

describe('API-050 read', () => {
  it('answers the Brief contract with an ETag, the latest generation job, and 404 for another owner', async () => {
    const a = await account();
    const b = await account();
    const { campaignId } = await brief(a.id);
    await pool.query(
      `insert into brief_jobs (id, owner_id, kind, campaign_id, state, reuse_hash, deadline_at) values ($1, $2, 'brief_generation', $3, 'completed', $4, now() + interval '1 hour')`,
      [crypto.randomUUID(), a.id, campaignId, 'a'.repeat(64)],
    );
    const res = await call('GET', `/campaigns/${campaignId}/brief`, a.token);
    expect(res.status).toBe(200);
    const valid = contractValidator('BriefResponse');
    expect(valid(res.body), JSON.stringify(valid.errors)).toBe(true);
    expect(etagOf(res)).toBe('"1"');
    expect(res.body.data.generationJob).toMatchObject({
      state: 'completed',
      label: 'completed',
      reused: false,
    });
    expect(res.body.data.segments.map((s: { position: number }) => s.position)).toEqual([1, 2]);
    expect(res.body.data.issues).toEqual([]);
    expect((await call('GET', `/campaigns/${campaignId}/brief`, b.token)).status).toBe(404);
    expect((await call('GET', `/campaigns/${crypto.randomUUID()}/brief`, a.token)).status).toBe(
      404,
    );
    expect((await call('GET', `/campaigns/${campaignId}/brief`)).status).toBe(401);
  });
});

describe('API-051 edit, API-052 accept, API-054 clear', () => {
  it('blocks accept on a high-risk issue until an edit closes it; a cleared other issue records reason and user', async () => {
    const a = await account();
    const { campaignId, briefId } = await brief(a.id);
    const url = `/campaigns/${campaignId}/brief`;
    const view = contractValidator('BriefResponse');

    // a stale version is 409; a missing or malformed one is 400
    expect(
      (
        await call(
          'PATCH',
          url,
          a.token,
          { segments: [{ position: 1, dialogue: 'x' }] },
          { 'if-match': '"7"' },
        )
      ).body.error?.code,
    ).toBe('version_conflict');
    expect(
      (await call('PATCH', url, a.token, { segments: [{ position: 1, dialogue: 'x' }] })).status,
    ).toBe(400);

    // a short, curing line raises a high-risk and an other issue on segment 1 only
    const edit = await call(
      'PATCH',
      url,
      a.token,
      { segments: [{ position: 1, dialogue: 'This cures anxiety.' }] },
      { 'if-match': '"1"' },
    );
    expect(edit.status).toBe(200);
    expect(view(edit.body), JSON.stringify(view.errors)).toBe(true);
    expect(etagOf(edit)).toBe('"2"');
    expect(edit.body.data.state).toBe('draft');
    expect(seg(edit.body.data, 1)).toMatchObject({ revision: 2, wordCount: 3 });
    expect(seg(edit.body.data, 2).revision).toBe(1);
    const issues = edit.body.data.issues as {
      id: string;
      ruleId: string;
      class: string;
      resolution: string;
      segmentPosition: number;
      span: unknown;
    }[];
    expect(issues.map((i) => i.ruleId).sort()).toEqual([
      'hr_treatment_cure',
      'other_word_count_min',
    ]);
    expect(issues.every((i) => i.resolution === 'open' && i.segmentPosition === 1)).toBe(true);
    const high = issues.find((i) => i.class === 'high_risk')!;
    const other = issues.find((i) => i.class === 'other')!;
    expect(high.span).toEqual({ start: 5, end: 18 });
    expect(await events(briefId)).toHaveLength(2);

    // accept is blocked, and no reason clears the high-risk issue
    const blocked = await call('POST', `${url}/accept`, a.token, undefined, { 'if-match': '"2"' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error?.code).toBe('open_claim_issues');
    const refused = await call('POST', `/claim-issues/${high.id}/clear`, a.token, {
      reason: 'I checked this claim',
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error?.code).toBe('claim_not_clearable');
    expect(
      (await pool.query(`select resolution from claim_issues where id = $1`, [high.id])).rows[0]
        .resolution,
    ).toBe('open');

    // the reason is required (3 to 500 characters)
    expect(
      (await call('POST', `/claim-issues/${other.id}/clear`, a.token, { reason: 'ok' })).status,
    ).toBe(400);
    expect((await call('POST', `/claim-issues/${other.id}/clear`, a.token, {})).status).toBe(400);
    const b = await account();
    expect(
      (
        await call('POST', `/claim-issues/${other.id}/clear`, b.token, {
          reason: 'not mine to clear',
        })
      ).status,
    ).toBe(404);

    // clear the other issue: reason and user are recorded; clearing again returns it unchanged
    const cleared = await call('POST', `/claim-issues/${other.id}/clear`, a.token, {
      reason: '  Short on purpose.  ',
    });
    expect(cleared.status).toBe(200);
    const one = contractValidator('ClaimIssueResponse');
    expect(one(cleared.body), JSON.stringify(one.errors)).toBe(true);
    expect(cleared.body.data).toMatchObject({
      id: other.id,
      resolution: 'cleared_with_reason',
      clearReason: 'Short on purpose.',
    });
    const row = (
      await pool.query(
        `select cleared_by, clear_reason, resolved_at from claim_issues where id = $1`,
        [other.id],
      )
    ).rows[0];
    expect(row).toMatchObject({ cleared_by: a.id, clear_reason: 'Short on purpose.' });
    expect(row.resolved_at).not.toBeNull();
    const again = await call('POST', `/claim-issues/${other.id}/clear`, a.token, {
      reason: 'a different reason',
    });
    expect(again.status).toBe(200);
    expect(again.body.data.clearReason).toBe('Short on purpose.');
    expect(
      (await call('POST', `${url}/accept`, a.token, undefined, { 'if-match': '"2"' })).body.error
        ?.code,
    ).toBe('open_claim_issues');

    // editing until the check stops firing closes the high-risk issue; the cleared one stays cleared
    const fixed = await call(
      'PATCH',
      url,
      a.token,
      { segments: [{ position: 1, dialogue: CLEAN }] },
      { 'if-match': '"2"' },
    );
    expect(fixed.status).toBe(200);
    const states = Object.fromEntries(
      (fixed.body.data.issues as { ruleId: string; resolution: string }[]).map((i) => [
        i.ruleId,
        i.resolution,
      ]),
    );
    expect(states).toEqual({
      hr_treatment_cure: 'closed_by_edit',
      other_word_count_min: 'cleared_with_reason',
    });
    expect(seg(fixed.body.data, 1).revision).toBe(3);
    expect((await events(briefId)).map((e) => `${e.class}:${e.outcome}`).sort()).toEqual([
      'high_risk:closed_by_edit',
      'high_risk:raised',
      'other:cleared_with_reason',
      'other:raised',
    ]);

    // all issues closed: accept gives Accepted; a repeat is harmless; a stale version is 409
    const accepted = await call('POST', `${url}/accept`, a.token, undefined, { 'if-match': '"3"' });
    expect(accepted.status).toBe(200);
    expect(view(accepted.body), JSON.stringify(view.errors)).toBe(true);
    expect(accepted.body.data.state).toBe('accepted');
    expect(accepted.body.data.acceptedAt).toMatch(/Z$/);
    expect(etagOf(accepted)).toBe('"4"');
    const repeat = await call('POST', `${url}/accept`, a.token, undefined, { 'if-match': '"4"' });
    expect(repeat.status).toBe(200);
    expect(etagOf(repeat)).toBe('"4"');
    expect(
      (await call('POST', `${url}/accept`, a.token, undefined, { 'if-match': '"3"' })).body.error
        ?.code,
    ).toBe('version_conflict');

    // an edit of an accepted brief returns it to draft and flags only the changed segment's revision
    const reopened = await call(
      'PATCH',
      url,
      a.token,
      { segments: [{ position: 2, prompt: 'A bright patio.' }] },
      { 'if-match': '"4"' },
    );
    expect(reopened.status).toBe(200);
    expect(reopened.body.data).toMatchObject({ state: 'draft', acceptedAt: null, version: 5 });
    expect(seg(reopened.body.data, 2)).toMatchObject({ revision: 2, prompt: 'A bright patio.' });
    expect(seg(reopened.body.data, 1).revision).toBe(3);

    // an edit that changes nothing writes nothing
    const same = await call(
      'PATCH',
      url,
      a.token,
      { segments: [{ position: 2, prompt: 'A bright patio.' }] },
      { 'if-match': '"5"' },
    );
    expect(same.status).toBe(200);
    expect(etagOf(same)).toBe('"5"');
  });

  it('re-runs the checks on the edited segment only and raises a cleared rule again on edited text', async () => {
    const a = await account();
    const { campaignId } = await brief(a.id);
    const url = `/campaigns/${campaignId}/brief`;
    // segment 2 gets an em dash; segment 1 is not touched and stays without issues
    const first = await call(
      'PATCH',
      url,
      a.token,
      { segments: [{ position: 2, dialogue: `${LAST} — now` }] },
      { 'if-match': '"1"' },
    );
    const raised = first.body.data.issues as {
      id: string;
      ruleId: string;
      class: string;
      segmentPosition: number;
    }[];
    expect(raised.map((i) => i.ruleId)).toContain('other_em_dash');
    expect(raised.every((i) => i.segmentPosition === 2)).toBe(true);
    const dash = raised.find((i) => i.ruleId === 'other_em_dash')!;
    expect(
      (await call('POST', `/claim-issues/${dash.id}/clear`, a.token, { reason: 'Brand quote' }))
        .status,
    ).toBe(200);
    // the same text edited elsewhere in the segment: the rule still fires on the edited text, so it is raised again
    const second = await call(
      'PATCH',
      url,
      a.token,
      { segments: [{ position: 2, dialogue: `${LAST} — later` }] },
      { 'if-match': '"2"' },
    );
    const dashes = (second.body.data.issues as { ruleId: string; resolution: string }[]).filter(
      (i) => i.ruleId === 'other_em_dash',
    );
    expect(dashes.map((i) => i.resolution).sort()).toEqual(['cleared_with_reason', 'open']);
    // removing the dash closes the open one
    const third = await call(
      'PATCH',
      url,
      a.token,
      { segments: [{ position: 2, dialogue: LAST }] },
      { 'if-match': '"3"' },
    );
    const final = (third.body.data.issues as { ruleId: string; resolution: string }[]).filter(
      (i) => i.ruleId === 'other_em_dash',
    );
    expect(final.map((i) => i.resolution).sort()).toEqual([
      'cleared_with_reason',
      'closed_by_edit',
    ]);
  });

  it('refuses edits and accepts in the wrong state, bad positions and retired segments', async () => {
    const a = await account();
    const { campaignId, briefId } = await brief(a.id);
    const url = `/campaigns/${campaignId}/brief`;
    const patch = (segments: unknown, version = '"1"') =>
      call('PATCH', url, a.token, { segments }, { 'if-match': version });
    expect((await patch([{ position: 3, dialogue: 'x' }])).body.error?.details?.[0]).toMatchObject({
      code: 'unknown_position',
    });
    expect((await patch([{ position: 1 }])).status).toBe(400);
    expect((await patch([{ position: 1, dialogue: '' }])).status).toBe(400);
    expect(
      (
        await patch([
          { position: 1, dialogue: 'x' },
          { position: 1, prompt: 'y' },
        ])
      ).body.error?.details?.[0],
    ).toMatchObject({ code: 'duplicate_position' });
    expect(
      (
        await patch([
          {
            position: 1,
            dialogue: Array.from({ length: 150 }, () => 'a')
              .join(' ')
              .slice(0, 599),
          },
        ])
      ).body.error?.details?.[0],
    ).toMatchObject({ code: 'too_long' });
    expect(
      (
        await call(
          'PATCH',
          url,
          a.token,
          { segments: [{ position: 1, dialogue: 'x' }], extra: 1 },
          { 'if-match': '"1"' },
        )
      ).status,
    ).toBe(400);
    await pool.query(
      `update brief_segments set state = 'retired' where brief_id = $1 and position = 2`,
      [briefId],
    );
    expect((await patch([{ position: 2, dialogue: 'x' }])).body.error?.code).toBe('state_conflict');
    for (const state of ['generating', 'failed']) {
      await pool.query(`update briefs set state = $2, accepted_at = null where id = $1`, [
        briefId,
        state,
      ]);
      expect((await patch([{ position: 1, dialogue: 'x' }])).status).toBe(409);
      expect(
        (await call('POST', `${url}/accept`, a.token, undefined, { 'if-match': '"1"' })).body.error
          ?.code,
      ).toBe('state_conflict');
    }
    expect((await call('POST', `${url}/accept`, a.token)).status).toBe(400);
  });

  it('serializes two edits on one version: one wins, the other is 409', async () => {
    const a = await account();
    const { campaignId } = await brief(a.id);
    const url = `/campaigns/${campaignId}/brief`;
    const results = await Promise.all(
      ['one', 'two'].map((word) =>
        call(
          'PATCH',
          url,
          a.token,
          { segments: [{ position: 1, prompt: word }] },
          { 'if-match': '"1"' },
        ),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await call('GET', url, a.token)).headers['etag']).toBe('"2"');
  });
});
