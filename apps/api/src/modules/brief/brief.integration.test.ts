// TASK-048 (brief 1/4) on real PostgreSQL: M0009 as written (constraints, cascades, grants), the brand rules seed from
// `config/brand-rules.json`, and the claim-check rules reached through the real api composition root (`createApiApp`,
// the one `main.api.ts` runs), including the start-up refusal of a faulty rules file. TC-BRF-02, TC-REV-01 (schema).

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../bootstrap/api.module.js';
import { runSeed } from '../../database/seed.js';
import { REAL_MIGRATIONS, adminUrl, createTestDatabase } from '../../platform/db/test-database.js';
import type { TestDatabase } from '../../platform/db/test-database.js';
import { DATABASE } from '../../platform/db/index.js';
import type { Database } from '../../platform/db/index.js';
import { installJobs } from '../../platform/jobs/test-support.js';
import { createHttpLogging } from '../../platform/logging/index.js';
import { BrandRulesInvalidError } from './domain/brand-rules.js';
import { checkSegment } from './domain/claim-check.js';
import {
  DEFAULT_BRAND_RULES_FILE,
  brandRulesSeedStep,
  loadBrandRulesFile,
} from './infrastructure/repositories/brand-rules-file.js';
import { BrandRulesNotSeededError, BrandRulesReader } from './infrastructure/repositories/brand-rules.reader.js';
import { DrizzleBrandRulesRepository } from './infrastructure/repositories/brand-rules.repository.js';

const U1 = '0197a1b2-0000-7000-8000-000000000001';
const edge = (url: string) => ({
  WEB_ORIGIN: 'http://localhost:3000',
  APP_ENV: 'development' as const,
  DATABASE_URL: url,
  DATABASE_POOL_MAX: 8,
  DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
  RATE_LIMIT_IP_KEY: 'r'.repeat(40),
});

let testDb: TestDatabase;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof createApiApp>>['app'];
let database: Database;
let reader: BrandRulesReader;
let folder: string;
const role = { api: `app_api_t048_${randomBytes(4).toString('hex')}`, worker: `app_worker_t048_${randomBytes(4).toString('hex')}` };
const password = randomBytes(12).toString('hex');
const savedEnv: Record<string, string | undefined> = {};

function statementsOf(file: string, part: 'tables' | 'grants'): string[] {
  const [tables = '', grants = ''] = readFileSync(join(REAL_MIGRATIONS, file), 'utf8').split('-- Grants');
  const body = part === 'tables' ? tables : grants.slice(grants.indexOf('\n'));
  return body
    .split('--> statement-breakpoint')
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .replace(/\bapp_api\b/g, role.api)
        .replace(/\bapp_worker\b/g, role.worker)
        .trim(),
    )
    .filter((statement) => statement !== '');
}

async function tryQuery(client: pg.Pool | pg.Client, text: string, params: unknown[] = []) {
  try {
    return { ok: true as const, rows: (await client.query(text, params)).rows as Record<string, unknown>[] };
  } catch (error) {
    const { code = 'none', constraint } = error as { code?: string; constraint?: string };
    return { ok: false as const, code, constraint };
  }
}

async function asRole(name: string, text: string, params: unknown[] = []) {
  const url = new URL(testDb.url);
  url.username = name;
  url.password = password;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await tryQuery(client, text, params);
  } finally {
    await client.end();
  }
}

const id = (): string => crypto.randomUUID();
async function campaign(): Promise<string> {
  const campaignId = id();
  await pool.query(
    `insert into campaigns (id, owner_id, product_name, product_description, segment_count) values ($1, $2, 'p', 'd', 2)`,
    [campaignId, U1],
  );
  return campaignId;
}
async function brief(campaignId: string): Promise<{ briefId: string; segmentId: string }> {
  const briefId = id();
  const segmentId = id();
  await pool.query(`insert into briefs (id, campaign_id, owner_id) values ($1, $2, $3)`, [briefId, campaignId, U1]);
  await pool.query(`insert into brief_segments (id, brief_id, position) values ($1, $2, 1)`, [segmentId, briefId]);
  return { briefId, segmentId };
}
const issue = (briefId: string, segmentId: string, over: Record<string, unknown> = {}) => {
  const row = { cls: 'other', resolution: 'open', reason: null, start: null, end: null, field: 'dialogue', ...over };
  return tryQuery(
    pool,
    `insert into claim_issues (id, owner_id, brief_id, segment_id, field, rule_id, class, resolution, message, span_start, span_end, clear_reason)
     values ($1, $2, $3, $4, $5, 'r', $6, $7, 'm', $8, $9, $10)`,
    [id(), U1, briefId, segmentId, row.field, row.cls, row.resolution, row.start, row.end, row.reason],
  );
};

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'brief-t048-'));
  testDb = await createTestDatabase({ label: 'task048', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 4 });
  for (const name of Object.values(role)) {
    const admin = new pg.Client({ connectionString: adminUrl() });
    await admin.connect();
    await admin.query(`CREATE ROLE "${name}" LOGIN NOSUPERUSER PASSWORD '${password}'`);
    await admin.end();
  }
  for (const statement of statementsOf('0001_task-025-platform.sql', 'tables')) {
    if (/^CREATE (TABLE|INDEX|UNIQUE INDEX) "?(idempotency_records|rate_limit_buckets)/.test(statement)) await pool.query(statement);
  }
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  const files = ['0010_task-032-audit.sql', '0020_task-033-identity.sql', '0040_task-041-media.sql', '0050_task-044-usage.sql', '0070_task-046-campaigns.sql', '0080_task-048-brief.sql'];
  for (const file of files) for (const statement of statementsOf(file, 'tables')) await pool.query(statement);
  await pool.query(`GRANT USAGE ON SCHEMA public TO "${role.api}", "${role.worker}"`);
  for (const file of ['0050_task-044-usage.sql', '0070_task-046-campaigns.sql', '0080_task-048-brief.sql']) {
    for (const statement of statementsOf(file, 'grants')) await pool.query(statement);
  }
  await installJobs(testDb.url);
  await pool.query(`INSERT INTO users (id, idp_subject, email, linked_via) VALUES ($1, 'sub_1', 'u1@example.test', 'first_admin')`, [U1]);
  for (const name of ['KEK_PUBLIC_KEYS', 'KEK_PRIVATE_KEYS', 'R2_ENDPOINT', 'BRAND_RULES_FILE', 'OPENAI_TEXT_MODEL', 'OPENAI_VISION_MODEL', 'OPENAI_IMAGE_MODEL', 'OPENAI_TRANSCRIBE_MODEL', 'WAVESPEED_MODEL_I2V', 'WAVESPEED_MODEL_T2V', 'ASSEMBLY_ADAPTER']) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  ({ app } = await createApiApp(edge(testDb.url), createHttpLogging({ level: 'silent' })));
  database = app.get<Database>(DATABASE, { strict: false });
  reader = app.get(BrandRulesReader, { strict: false });
}, 300_000);

afterAll(async () => {
  await app?.close();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await pool?.end();
  await testDb?.drop();
  for (const name of Object.values(role)) {
    const admin = new pg.Client({ connectionString: adminUrl() });
    await admin.connect();
    await admin.query(`DROP ROLE IF EXISTS "${name}"`).catch(() => undefined);
    await admin.end();
  }
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
});

describe('the brand rules through the api composition root', () => {
  const seed = (path?: string) =>
    runSeed({ dataset: 'reference', appEnv: 'development', databaseUrl: testDb.url, steps: [brandRulesSeedStep(path)] });
  const rows = async () => (await pool.query('select * from brand_rules order by id')).rows as Record<string, unknown>[];

  it('stops claim checks, rather than passing text unchecked, while the table is not seeded', async () => {
    await expect(reader.activeRules()).rejects.toBeInstanceOf(BrandRulesNotSeededError);
    await expect(reader.activeRules()).rejects.toThrow('run the release seed');
  });

  it('seeds the file by id and a rerun changes nothing', async () => {
    const file = loadBrandRulesFile();
    expect(await seed()).toEqual([{ step: 'brand_rules', count: file.rules.length }]);
    const first = await rows();
    expect(first).toHaveLength(file.rules.length);
    expect(first.every((row) => row['rules_version'] === file.rulesVersion && row['active'] === true)).toBe(true);
    await seed();
    expect(await rows()).toEqual(first);
  });

  it('reads the seeded rules back and flags the fixtures through the engine (TC-BRF-02)', async () => {
    const rules = await reader.activeRules();
    const text = 'It cures anxiety. Take 2g, a microdose, for a psychedelic trip.';
    const found = checkSegment(rules, { dialogue: text, prompt: '', isLast: false });
    expect(found.filter((f) => f.class === 'high_risk').map((f) => f.ruleId).sort()).toEqual(['hr_dosing', 'hr_psychedelic', 'hr_treatment_cure']);
  });

  it('switches off a rule that left the file and brings it back with the file', async () => {
    const file = JSON.parse(readFileSync(DEFAULT_BRAND_RULES_FILE, 'utf8')) as { rules: { id: string }[] };
    const subset = join(folder, 'subset.json');
    writeFileSync(subset, JSON.stringify({ ...file, rules: file.rules.filter((rule) => rule.id !== 'other_tone_hype') }));
    await seed(subset);
    const off = (await rows()).find((row) => row['id'] === 'other_tone_hype');
    expect(off?.['active']).toBe(false);
    expect((await reader.activeRules()).some((compiled) => compiled.rule.id === 'other_tone_hype')).toBe(false);
    await seed();
    expect((await rows()).find((row) => row['id'] === 'other_tone_hype')?.['active']).toBe(true);
  });

  it('refuses rules older than the file it started with', async () => {
    const stale = new BrandRulesReader(database, new DrizzleBrandRulesRepository(), {
      ...loadBrandRulesFile(),
      rulesVersion: 2,
    });
    await expect(stale.activeRules()).rejects.toThrow('older than rules version 2');
  });

  it('refuses a stored rule that breaks the file rules', async () => {
    await pool.query(`update brand_rules set params = '{"phrases": []}'::jsonb where id = 'other_tone_hype'`);
    await expect(reader.activeRules()).rejects.toBeInstanceOf(BrandRulesInvalidError);
    await seed();
    await expect(reader.activeRules()).resolves.toBeDefined();
  });

  it('fails the api start-up for a missing, unreadable or invalid rules file', async () => {
    const bad = join(folder, 'bad.json');
    writeFileSync(bad, JSON.stringify({ version: 1, rulesVersion: 1, rules: [{ id: 'x', class: 'high_risk', clearable: true }] }));
    process.env['BRAND_RULES_FILE'] = bad;
    await expect(createApiApp(edge(testDb.url), createHttpLogging({ level: 'silent' }))).rejects.toBeInstanceOf(BrandRulesInvalidError);
    writeFileSync(bad, '{ not json');
    await expect(createApiApp(edge(testDb.url), createHttpLogging({ level: 'silent' }))).rejects.toThrow();
    process.env['BRAND_RULES_FILE'] = join(folder, 'missing.json');
    await expect(createApiApp(edge(testDb.url), createHttpLogging({ level: 'silent' }))).rejects.toThrow('ENOENT');
    delete process.env['BRAND_RULES_FILE'];
  });
});

describe('M0009 as written', () => {
  it('keeps the brand_rules dictionary: classes, kinds, high risk never clearable', async () => {
    const insert = (cls: string, clearable: boolean, kind = 'phrase', version = 1) =>
      tryQuery(pool, `insert into brand_rules (id, class, clearable, kind, params, message, rules_version) values ($1, $2, $3, $4, '{}', 'm', $5)`, [id(), cls, clearable, kind, version]);
    expect((await insert('high_risk', false)).ok).toBe(true);
    expect((await insert('other', true)).ok).toBe(true);
    expect(await insert('high_risk', true)).toMatchObject({ ok: false, constraint: 'brand_rules_clearable_ck' });
    expect(await insert('severe', false)).toMatchObject({ ok: false, constraint: 'brand_rules_class_ck' });
    expect(await insert('other', true, 'sentiment')).toMatchObject({ ok: false, constraint: 'brand_rules_kind_ck' });
    expect(await insert('other', true, 'phrase', 0)).toMatchObject({ ok: false, constraint: 'brand_rules_version_ck' });
  });

  it('keeps the job column contract: kind and parent, states, causes, reuse hash, completion', async () => {
    const campaignId = await campaign();
    const media = id();
    await pool.query(
      `insert into media_objects (id, owner_id, kind, state, storage_key) values ($1, $2, 'upload', 'ready', $3)`,
      [media, U1, `k/${media}`],
    );
    const job = (over: Record<string, unknown> = {}) => {
      const row = { kind: 'brief_generation', campaign: campaignId, media: null, state: 'pending', cause: null, hash: 'a'.repeat(64), task: null, completed: null, ...over };
      return tryQuery(
        pool,
        `insert into brief_jobs (id, owner_id, kind, campaign_id, media_id, state, cause_class, reuse_hash, deadline_at, provider_task_id, provider_completed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '1 hour', $9, $10)`,
        [id(), U1, row.kind, row.campaign, row.media, row.state, row.cause, row.hash, row.task, row.completed],
      );
    };
    expect((await job()).ok).toBe(true);
    expect((await job({ kind: 'image_analysis', campaign: null, media, hash: 'b'.repeat(64) })).ok).toBe(true);
    expect(await job({ kind: 'brief_generation', campaign: null, hash: 'c'.repeat(64) })).toMatchObject({ constraint: 'brief_jobs_parent_ck' });
    expect(await job({ kind: 'image_analysis', campaign: null, media: null, hash: 'c'.repeat(64) })).toMatchObject({ constraint: 'brief_jobs_parent_ck' });
    expect(await job({ kind: 'thumbnail', hash: 'c'.repeat(64) })).toMatchObject({ constraint: 'brief_jobs_kind_ck' });
    expect(await job({ state: 'queued', hash: 'c'.repeat(64) })).toMatchObject({ constraint: 'brief_jobs_state_ck' });
    expect(await job({ state: 'failed', cause: 'outcome_unknown', hash: 'c'.repeat(64) })).toMatchObject({ ok: true });
    expect(await job({ state: 'failed', cause: 'because', hash: 'd'.repeat(64) })).toMatchObject({ constraint: 'brief_jobs_cause_ck' });
    expect(await job({ completed: new Date().toISOString(), hash: 'e'.repeat(64) })).toMatchObject({ constraint: 'brief_jobs_completed_ck' });
    expect((await job({ completed: new Date().toISOString(), task: 't1', hash: 'e'.repeat(64) })).ok).toBe(true);
  });

  it('allows one live job per owner and reuse hash, and a retry after a failure', async () => {
    const campaignId = await campaign();
    const insert = (state: string) =>
      tryQuery(
        pool,
        `insert into brief_jobs (id, owner_id, kind, campaign_id, state, reuse_hash, deadline_at) values ($1, $2, 'brief_generation', $3, $4, $5, now())`,
        [id(), U1, campaignId, state, 'f'.repeat(64)],
      );
    expect((await insert('failed')).ok).toBe(true);
    expect((await insert('pending')).ok).toBe(true);
    expect(await insert('processing')).toMatchObject({ ok: false, code: '23505', constraint: 'brief_jobs_reuse_uq' });
    expect((await insert('cancelled')).ok).toBe(true);
  });

  it('keeps one brief per campaign, its states and the accepted pairing', async () => {
    const campaignId = await campaign();
    const { briefId } = await brief(campaignId);
    expect(await tryQuery(pool, `insert into briefs (id, campaign_id, owner_id) values ($1, $2, $3)`, [id(), campaignId, U1])).toMatchObject({ constraint: 'briefs_campaign_uq' });
    const update = (set: string) => tryQuery(pool, `update briefs set ${set} where id = $1`, [briefId]);
    expect(await update(`state = 'accepted'`)).toMatchObject({ constraint: 'briefs_accepted_ck' });
    expect(await update(`accepted_at = now()`)).toMatchObject({ constraint: 'briefs_accepted_ck' });
    expect((await update(`state = 'accepted', accepted_at = now()`)).ok).toBe(true);
    expect(await update(`state = 'done', accepted_at = null`)).toMatchObject({ constraint: 'briefs_state_ck' });
    expect(await update(`version = 0`)).toMatchObject({ constraint: 'briefs_version_ck' });
    expect(await update(`generation_seq = 0`)).toMatchObject({ constraint: 'briefs_generation_seq_ck' });
  });

  it('keeps segments stable: position 1 to 4, unique, revision above zero, states, word count', async () => {
    const campaignId = await campaign();
    const { briefId, segmentId } = await brief(campaignId);
    const insert = (position: number) => tryQuery(pool, `insert into brief_segments (id, brief_id, position) values ($1, $2, $3)`, [id(), briefId, position]);
    expect(await insert(1)).toMatchObject({ constraint: 'brief_segments_position_uq' });
    expect(await insert(5)).toMatchObject({ constraint: 'brief_segments_position_ck' });
    expect((await insert(4)).ok).toBe(true);
    const update = (set: string) => tryQuery(pool, `update brief_segments set ${set} where id = $1`, [segmentId]);
    expect(await update('revision = 0')).toMatchObject({ constraint: 'brief_segments_revision_ck' });
    expect(await update(`state = 'gone'`)).toMatchObject({ constraint: 'brief_segments_state_ck' });
    expect(await update('word_count = 121')).toMatchObject({ constraint: 'brief_segments_word_count_ck' });
    expect((await update(`revision = revision + 1, dialogue = 'x', word_count = 45`)).ok).toBe(true);
    expect((await pool.query('select revision, state from brief_segments where id = $1', [segmentId])).rows[0]).toEqual({ revision: 2, state: 'active' });
  });

  it('keeps claim issues: fields, classes, spans, and no clearing of a high-risk issue', async () => {
    const { briefId, segmentId } = await brief(await campaign());
    expect((await issue(briefId, segmentId)).ok).toBe(true);
    expect((await issue(briefId, segmentId, { start: 3, end: 3 })).ok).toBe(true);
    expect(await issue(briefId, segmentId, { field: 'title' })).toMatchObject({ constraint: 'claim_issues_field_ck' });
    expect(await issue(briefId, segmentId, { cls: 'minor' })).toMatchObject({ constraint: 'claim_issues_class_ck' });
    expect(await issue(briefId, segmentId, { resolution: 'ignored' })).toMatchObject({ constraint: 'claim_issues_resolution_ck' });
    expect(await issue(briefId, segmentId, { start: 5, end: 2 })).toMatchObject({ constraint: 'claim_issues_span_ck' });
    expect(await issue(briefId, segmentId, { start: -1, end: 2 })).toMatchObject({ constraint: 'claim_issues_span_ck' });
    expect(await issue(briefId, segmentId, { start: 1 })).toMatchObject({ constraint: 'claim_issues_span_ck' });
    // TC-REV-01: the database refuses a cleared high-risk issue whatever the service does.
    expect(await issue(briefId, segmentId, { cls: 'high_risk', resolution: 'cleared_with_reason', reason: 'ok' })).toMatchObject({ constraint: 'claim_issues_clear_ck' });
    expect(await issue(briefId, segmentId, { resolution: 'cleared_with_reason' })).toMatchObject({ constraint: 'claim_issues_clear_ck' });
    expect((await issue(briefId, segmentId, { resolution: 'cleared_with_reason', reason: 'approved wording' })).ok).toBe(true);
    expect((await issue(briefId, segmentId, { cls: 'high_risk', resolution: 'closed_by_edit' })).ok).toBe(true);
  });

  it('deletes a brief with its segments and issues, and a campaign with all of it, and keeps claim events', async () => {
    const campaignId = await campaign();
    const { briefId, segmentId } = await brief(campaignId);
    await issue(briefId, segmentId);
    await pool.query(
      `insert into brief_jobs (id, owner_id, kind, campaign_id, reuse_hash, deadline_at) values ($1, $2, 'brief_generation', $3, $4, now())`,
      [id(), U1, campaignId, '9'.repeat(64)],
    );
    await pool.query(`insert into claim_events (id, owner_id, brief_id, issue_id, class, outcome) values ($1, $2, $3, $4, 'other', 'raised')`, [id(), U1, briefId, id()]);
    expect(await tryQuery(pool, `insert into claim_events (id, owner_id, brief_id, issue_id, class, outcome) values ($1, $2, $3, $4, 'other', 'ignored')`, [id(), U1, briefId, id()])).toMatchObject({ constraint: 'claim_events_outcome_ck' });
    await pool.query('delete from campaigns where id = $1', [campaignId]);
    for (const [table, column] of [['briefs', 'id'], ['brief_segments', 'brief_id'], ['claim_issues', 'brief_id'], ['brief_jobs', 'campaign_id']] as const) {
      const key = column === 'campaign_id' ? campaignId : briefId;
      expect(Number((await pool.query(`select count(*) as n from ${table} where ${column} = $1`, [key])).rows[0]?.['n'])).toBe(0);
    }
    expect(Number((await pool.query('select count(*) as n from claim_events where brief_id = $1', [briefId])).rows[0]?.['n'])).toBe(1);
  });

  it('deletes the image-analysis jobs of a deleted media object', async () => {
    const media = id();
    await pool.query(`insert into media_objects (id, owner_id, kind, state, storage_key) values ($1, $2, 'upload', 'ready', $3)`, [media, U1, `k/${media}`]);
    await pool.query(`insert into brief_jobs (id, owner_id, kind, media_id, reuse_hash, deadline_at) values ($1, $2, 'image_analysis', $3, $4, now())`, [id(), U1, media, '8'.repeat(64)]);
    await pool.query('delete from media_objects where id = $1', [media]);
    expect(Number((await pool.query('select count(*) as n from brief_jobs where media_id = $1', [media])).rows[0]?.['n'])).toBe(0);
  });

  it('grants the runtime roles what ARCHITECTURE §2.2 says and nothing more', async () => {
    const campaignId = await campaign();
    const { briefId, segmentId } = await brief(campaignId);
    const insertEvent = `insert into claim_events (id, owner_id, brief_id, issue_id, class, outcome) values ($1, $2, $3, $4, 'other', 'raised')`;
    for (const name of Object.values(role)) {
      expect((await asRole(name, 'select count(*) from brief_segments')).ok).toBe(true);
      expect((await asRole(name, `update brief_segments set revision = revision + 1 where id = $1`, [segmentId])).ok).toBe(true);
      expect((await asRole(name, `update briefs set version = version + 1 where id = $1`, [briefId])).ok).toBe(true);
      expect((await asRole(name, insertEvent, [id(), U1, briefId, id()])).ok).toBe(true);
      expect(await asRole(name, `update claim_events set outcome = 'closed_by_edit'`)).toMatchObject({ ok: false, code: '42501' });
      expect(await asRole(name, 'delete from claim_events')).toMatchObject({ ok: false, code: '42501' });
      expect((await asRole(name, 'select count(*) from brand_rules')).ok).toBe(true);
      expect(await asRole(name, `update brand_rules set active = false`)).toMatchObject({ ok: false, code: '42501' });
      expect(await asRole(name, `insert into brand_rules (id, class, clearable, kind, params, message, rules_version) values ('z', 'other', true, 'phrase', '{}', 'm', 1)`)).toMatchObject({ ok: false, code: '42501' });
      expect(await asRole(name, 'delete from brand_rules')).toMatchObject({ ok: false, code: '42501' });
    }
  });
});
