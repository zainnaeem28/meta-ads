import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DbTx } from '../../../../platform/db/index.js';
import { DomainError } from '../../../../platform/http/domain-error.js';
import { parseBrandRules } from '../../domain/brand-rules.js';
import { compileRules } from '../../domain/claim-check.js';
import { countWords } from '../../domain/words.js';
import { BriefGenerationJob } from './brief-generation.job.js';
import { ImageAnalysisJob } from './image-analysis.job.js';
import { gateKey } from './key-gate.js';
import { CALL_TO_ACTION } from './post-process.js';
import { ProviderCallRunner } from './provider-call.js';
import type {
  BriefContext,
  BriefJobRepository,
  BriefJobRow,
  JobCause,
  MediaFacts,
  NewIssue,
  SealedKeyRow,
  WrittenSegment,
} from './ports.js';
import { ProviderCallFailed, ProviderInvalidResponse } from './text-ai.port.js';
import type { BriefDraft, DraftSegment, TextAIPort } from './text-ai.port.js';

// The two worker handlers against in-memory ports: ordering (cap check before any adapter call), at-most-once calls,
// usage settlement per outcome, key guards and the clean-up of the generated text. The SQL, the unsealer and the
// provider are proven on PostgreSQL through the worker composition root by brief-ai.integration.test.ts.

const set = parseBrandRules(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', '..', '..', '..', 'config', 'brand-rules.json'), 'utf8')) as unknown);
const RULES = compileRules(set.rules);
const OWNER = '0197a1b2-0000-7000-8000-000000000001';
const KEY_ID = '0197a1b2-0000-7000-8000-0000000000a1';
const JOB = '0197a1b2-0000-7000-8000-0000000000b1';
const CAMPAIGN = '0197a1b2-0000-7000-8000-0000000000c1';
const MEDIA = '0197a1b2-0000-7000-8000-0000000000d1';
const log = { info: () => undefined, warn: () => undefined };
const calm = (n: number): string =>
  Array.from({ length: n }, (_, i) => (i % 5 === 4 || i === n - 1 ? `calm${String(i)}.` : `calm${String(i)}`)).join(' ');

const key = (over: Partial<SealedKeyRow> = {}): SealedKeyRow => ({
  id: KEY_ID,
  ownerId: OWNER,
  provider: 'openai',
  status: 'active',
  version: 3,
  sealed: { ciphertext: Buffer.from('c'), nonce: Buffer.from('n'), wrappedDek: Buffer.from('w'), kekVersion: 1 },
  ...over,
});
const generation = (over: Partial<BriefJobRow> = {}): BriefJobRow => ({
  id: JOB, ownerId: OWNER, kind: 'brief_generation', campaignId: CAMPAIGN, mediaId: null, generationSeq: 1,
  state: 'pending', keyId: KEY_ID, keyVersion: 3, callCount: 0, ...over,
});
const analysis = (over: Partial<BriefJobRow> = {}): BriefJobRow => ({
  ...generation(), kind: 'image_analysis', campaignId: null, mediaId: MEDIA, ...over,
});
const context = (over: Partial<BriefContext> = {}): BriefContext => ({
  briefId: 'brief-1', briefState: 'generating', briefGenerationSeq: 1,
  input: {
    productName: 'Calm Cap', productDescription: 'drink', audience: { ageMin: 25, ageMax: 40, gender: null, interests: [] },
    direction: { goal: null, tone: null }, segmentCount: 2, mode: 'description', source: 'x', callToAction: CALL_TO_ACTION,
  },
  segments: [], issues: [], ...over,
});

class Fakes implements BriefJobRepository {
  log: string[] = [];
  job: BriefJobRow | null = generation();
  keyRow: SealedKeyRow | null = key();
  media: MediaFacts | null = { id: MEDIA, ownerId: OWNER, state: 'ready', storageKey: 'u/o/media/1', contentType: 'image/png' };
  ctx: BriefContext | null = context();
  startOk = true;
  claimOk = true;
  written: { segments: readonly WrittenSegment[]; close: readonly string[]; raise: readonly NewIssue[] } | null = null;
  failed: { cause: JobCause; message: string; code?: string | undefined; from: string } | null = null;
  analysisText: string | null = null;
  completeKind: 'written' | 'superseded' = 'written';
  findJob = () => Promise.resolve(this.job);
  findKey = () => Promise.resolve(this.keyRow);
  findMedia = () => Promise.resolve(this.media);
  findContext = () => Promise.resolve(this.ctx);
  claim = () => { this.log.push('claim'); return Promise.resolve(this.claimOk); };
  failPending = (_tx: DbTx, _id: string, cause: JobCause, message: string) => {
    this.failed = { cause, message, from: 'pending' }; this.log.push('failPending'); return Promise.resolve(true);
  };
  failSubmitting = (_tx: DbTx, _id: string, cause: JobCause, message: string, code?: string) => {
    this.failed = { cause, message, code, from: 'submitting' }; this.log.push('failSubmitting'); return Promise.resolve(true);
  };
  startCall = (_tx: DbTx, _id: string, seq: number) => { this.log.push(`startCall${String(seq)}`); return Promise.resolve(this.startOk); };
  completeGeneration = (_tx: DbTx, _job: BriefJobRow, _c: BriefContext, write: NonNullable<Fakes['written']>) => {
    this.written = write; this.log.push('completeGeneration'); return Promise.resolve({ kind: this.completeKind });
  };
  completeAnalysis = (_tx: DbTx, _id: string, text: string) => { this.analysisText = text; this.log.push('completeAnalysis'); return Promise.resolve(true); };
  settleBriefAfterFailure = () => { this.log.push('settleBrief'); return Promise.resolve(); };
}

interface Setup {
  fakes: Fakes;
  usage: Record<string, unknown>;
  events: string[];
  reports: boolean[];
  ai: { generate: (() => Promise<BriefDraft>)[]; shorten: (() => Promise<readonly DraftSegment[]>)[]; describe: (() => Promise<string>)[] };
  opened: Buffer[];
  rulesFail: boolean;
  capError: Error | null;
  unsealFails: boolean;
  gen: BriefGenerationJob;
  img: ImageAnalysisJob;
  readFails: boolean;
}

function setup(): Setup {
  const fakes = new Fakes();
  const s = { fakes, events: [] as string[], reports: [] as boolean[], opened: [] as Buffer[], rulesFail: false, capError: null as Error | null, unsealFails: false, readFails: false,
    ai: { generate: [], shorten: [], describe: [] } } as unknown as Setup;
  s.usage = {
    reserve: () => { s.events.push('reserve'); fakes.log.push('reserve'); return s.capError === null ? Promise.resolve({}) : Promise.reject(s.capError); },
    record: (_tx: unknown, input: { outcome: string; callSeq: number }) => { s.events.push(`record:${input.outcome}:${String(input.callSeq)}`); return Promise.resolve({ recorded: true }); },
    convertUnconfirmed: (_tx: unknown, input: { callSeq: number }) => { s.events.push(`unconfirmed:${String(input.callSeq)}`); return Promise.resolve({ recorded: true }); },
    release: () => { s.events.push('release'); return Promise.resolve(true); },
  };
  const database = { uow: { run: <T>(fn: (tx: DbTx) => Promise<T>) => fn({} as DbTx) } } as never;
  const next = <T>(queue: (() => Promise<T>)[]) => () => {
    fakes.log.push('ai');
    const step = queue.shift();
    if (step === undefined) throw new Error('unexpected provider call');
    return step();
  };
  const ai: TextAIPort = {
    generateBrief: next(s.ai.generate),
    shortenSegments: next(s.ai.shorten),
    describeProduct: next(s.ai.describe),
  };
  const opener = { unseal: () => { if (s.unsealFails) throw new Error('nope'); const b = Buffer.from('unit-secret-key'); s.opened.push(b); return b; } };
  const reporter = { report: (_k: string, _v: number, ok: boolean) => { s.reports.push(ok); return Promise.resolve(); } };
  const runner = new ProviderCallRunner(database, fakes, s.usage as never, opener, reporter);
  const rules = { activeRules: () => (s.rulesFail ? Promise.reject(new Error('not seeded')) : Promise.resolve(RULES)) };
  const config = { textModel: 'text-m', visionModel: 'vision-m', sensitiveTerms: set.sensitiveTerms };
  s.gen = new BriefGenerationJob(database, fakes, s.usage as never, runner, ai, rules, config);
  s.img = new ImageAnalysisJob(database, fakes, s.usage as never, runner, ai, { read: () => (s.readFails ? Promise.reject(new Error('gone')) : Promise.resolve(Buffer.from([1, 2, 3]))) }, config);
  return s;
}

const brief = (a: string, b: string): BriefDraft => ({
  segments: [
    { position: 1, dialogue: a, prompt: 'pa — scene' },
    { position: 2, dialogue: b, prompt: 'pb' },
  ],
});
const callFailed = (status: 401 | 429 | 500) =>
  new ProviderCallFailed(
    status === 401
      ? { causeClass: 'configuration', message: 'your OpenAI key was not accepted', countsAsAuthFailure: true, countsTowardRateAlert: false, usageEvent: 'rejected_zero', final: true }
      : status === 429
        ? { causeClass: 'temporary', message: 'provider is busy, try again', countsAsAuthFailure: false, countsTowardRateAlert: true, usageEvent: 'rejected_zero', final: true }
        : { causeClass: 'outcome_unknown', message: 'check your provider account before retrying', countsAsAuthFailure: false, countsTowardRateAlert: false, usageEvent: 'unconfirmed', final: true },
  );

describe('gateKey', () => {
  it('passes a live key of the owner at the job version', () => {
    expect(gateKey(generation(), key()).ok).toBe(true);
  });
  it.each([
    ['no key on the job', generation({ keyId: null }), key(), 'key_deleted'],
    ['a deleted key', generation(), null, 'key_deleted'],
    ['a key of another owner', generation(), key({ ownerId: 'other' }), 'key_deleted'],
    ['another provider', generation(), key({ provider: 'wavespeed' }), 'configuration'],
    ['a replaced key', generation(), key({ version: 4 }), 'key_replaced'],
    ['a job with no key version', generation({ keyVersion: null }), key(), 'key_replaced'],
    ['a disabled key', generation(), key({ status: 'disabled' }), 'configuration'],
  ] as const)('refuses %s', (_name, job, row, cause) => {
    const gate = gateKey(job, row);
    expect(gate.ok).toBe(false);
    expect(gate.ok ? '' : gate.cause).toBe(cause);
  });
});

describe('brief.generate', () => {
  it('checks the cap, claims, calls once, cleans the text, writes it in place and releases the reservation', async () => {
    const s = setup();
    s.ai.generate.push(() => Promise.resolve(brief(`${calm(34)} — fine`, calm(30))));
    const outcome = await s.gen.run(JOB, log);
    expect(outcome).toBe('completed');
    // The cap check (reserve) precedes the claim and the adapter call.
    expect(s.fakes.log.indexOf('reserve')).toBeLessThan(s.fakes.log.indexOf('claim'));
    expect(s.fakes.log.indexOf('claim')).toBeLessThan(s.fakes.log.indexOf('ai'));
    expect(s.events).toEqual(['reserve', 'record:succeeded:1', 'release']);
    const write = s.fakes.written;
    expect(write?.segments).toHaveLength(2);
    expect(write?.segments[0]?.dialogue).not.toMatch(/[—–]/u);
    expect(write?.segments[0]?.prompt).toBe('pa, scene');
    expect(write?.segments[1]?.dialogue.endsWith(`${CALL_TO_ACTION}.`)).toBe(true);
    // the key was opened for the call and zeroed afterwards
    expect(s.opened).toHaveLength(1);
    expect(s.opened[0]?.every((byte) => byte === 0)).toBe(true);
    // under the word band and without the 21+ framing: other-class issues, nothing high risk
    expect(write?.raise.length).toBeGreaterThan(0);
    expect(write?.raise.every((issue) => issue.class === 'other')).toBe(true);
  });

  it('makes call 2 for an over-long segment and uses its text', async () => {
    const s = setup();
    s.ai.generate.push(() => Promise.resolve(brief(calm(60), calm(30))));
    s.ai.shorten.push(() => Promise.resolve([{ position: 1, dialogue: calm(40), prompt: 'pa' }]));
    expect(await s.gen.run(JOB, log)).toBe('completed');
    expect(s.events).toEqual(['reserve', 'record:succeeded:1', 'record:succeeded:2', 'release']);
    expect(countWords(s.fakes.written?.segments[0]?.dialogue ?? '')).toBe(40);
    expect(s.fakes.written?.raise.some((issue) => issue.ruleId === 'word_count_trimmed')).toBe(false);
  });

  it('trims what call 2 left over 45 words and raises word_count_trimmed; a failed call 2 is trimmed the same way', async () => {
    const s = setup();
    s.ai.generate.push(() => Promise.resolve(brief(calm(60), calm(30))));
    s.ai.shorten.push(() => Promise.resolve([{ position: 1, dialogue: calm(50), prompt: 'pa' }]));
    await s.gen.run(JOB, log);
    expect(countWords(s.fakes.written?.segments[0]?.dialogue ?? '')).toBeLessThanOrEqual(45);
    expect(s.fakes.written?.raise.filter((issue) => issue.ruleId === 'word_count_trimmed')).toHaveLength(1);

    const t = setup();
    t.ai.generate.push(() => Promise.resolve(brief(calm(60), calm(30))));
    t.ai.shorten.push(() => Promise.reject(callFailed(429)));
    expect(await t.gen.run(JOB, log)).toBe('completed');
    expect(t.events).toEqual(['reserve', 'record:succeeded:1', 'record:rejected:2', 'release']);
    expect(t.fakes.written?.raise.some((issue) => issue.ruleId === 'word_count_trimmed')).toBe(true);
  });

  it('reconciles with the issues already on the brief and keeps stable segment rows', async () => {
    const s = setup();
    s.fakes.ctx = context({
      segments: [{ id: 'seg-1', position: 1, state: 'active', revision: 2, dialogue: 'old', prompt: 'old' }],
      issues: [{ id: 'issue-1', segmentId: 'seg-1', field: 'dialogue', ruleId: 'hr_dosing', resolution: 'open' }],
    });
    s.ai.generate.push(() => Promise.resolve(brief(calm(36), calm(30))));
    await s.gen.run(JOB, log);
    expect(s.fakes.written?.segments[0]?.id).toBe('seg-1');
    expect(s.fakes.written?.segments[1]?.id).not.toBe('seg-1');
    expect(s.fakes.written?.close).toContain('issue-1');
  });

  it('does nothing for a job that is not pending, not a brief job, or has no campaign', async () => {
    for (const job of [generation({ state: 'submitting' }), analysis(), generation({ campaignId: null }), null]) {
      const s = setup();
      s.fakes.job = job;
      expect(await s.gen.run(JOB, log)).toBe('skipped');
      expect(s.fakes.log).toEqual([]);
    }
    const s = setup();
    s.fakes.claimOk = false;
    expect(await s.gen.run(JOB, log)).toBe('skipped');
    expect(s.fakes.log).not.toContain('ai');
  });

  it('refuses over the spend cap before any adapter call, with no usage event (TC-CAP ordering)', async () => {
    const s = setup();
    s.capError = new DomainError('spend_cap_reached', 'This would pass your daily spending limit.');
    expect(await s.gen.run(JOB, log)).toBe('failed');
    expect(s.fakes.log).not.toContain('ai');
    expect(s.fakes.log).not.toContain('claim');
    expect(s.fakes.failed).toMatchObject({ cause: 'temporary', from: 'pending' });
    expect(s.events).toEqual(['reserve', 'release']);
    expect(s.fakes.log).toContain('settleBrief');
  });

  it('lets an unexpected reservation error through', async () => {
    const s = setup();
    s.capError = new Error('database down');
    await expect(s.gen.run(JOB, log)).rejects.toThrow('database down');
  });

  it.each([
    ['a deleted key', (): SealedKeyRow | null => null, 'key_deleted'],
    ['a replaced key', () => key({ version: 9 }), 'key_replaced'],
    ['a disabled key', () => key({ status: 'disabled' }), 'configuration'],
  ] as const)('creates no charge for %s', async (_name, row, cause) => {
    const s = setup();
    s.fakes.keyRow = row();
    expect(await s.gen.run(JOB, log)).toBe('failed');
    expect(s.fakes.failed?.cause).toBe(cause);
    expect(s.fakes.log).not.toContain('ai');
    expect(s.events).toEqual(['release']);
  });

  it('fails when the campaign is gone or the rules are not seeded, without a call', async () => {
    const s = setup();
    s.fakes.ctx = null;
    expect(await s.gen.run(JOB, log)).toBe('failed');
    expect(s.fakes.failed?.cause).toBe('cancelled_campaign_deleted');

    const t = setup();
    t.rulesFail = true;
    expect(await t.gen.run(JOB, log)).toBe('failed');
    expect(t.fakes.failed?.cause).toBe('temporary');
    expect(t.fakes.log).not.toContain('ai');

    const u = setup();
    u.rulesFail = true;
    u.fakes.job = generation({ state: 'completed' });
    expect(await u.gen.run(JOB, log)).toBe('skipped');
  });

  it('401: configuration, rejected at zero, the key auth failure is reported, the brief settles', async () => {
    const s = setup();
    s.ai.generate.push(() => Promise.reject(callFailed(401)));
    expect(await s.gen.run(JOB, log)).toBe('failed');
    expect(s.events).toEqual(['reserve', 'record:rejected:1', 'release']);
    expect(s.reports).toEqual([false]);
    expect(s.fakes.failed).toMatchObject({ cause: 'configuration', from: 'submitting' });
    expect(s.fakes.log).toContain('settleBrief');
  });

  it('429: temporary and no auth report; 5xx: outcome_unknown with the estimate converted', async () => {
    const s = setup();
    s.ai.generate.push(() => Promise.reject(callFailed(429)));
    await s.gen.run(JOB, log);
    expect(s.fakes.failed?.cause).toBe('temporary');
    expect(s.reports).toEqual([]);

    const t = setup();
    t.ai.generate.push(() => Promise.reject(callFailed(500)));
    await t.gen.run(JOB, log);
    expect(t.fakes.failed?.cause).toBe('outcome_unknown');
    expect(t.events).toEqual(['reserve', 'unconfirmed:1', 'release']);
  });

  it('an invalid provider answer fails temporary and is billed as a failed call', async () => {
    const s = setup();
    s.ai.generate.push(() => Promise.reject(new ProviderInvalidResponse('bad')));
    expect(await s.gen.run(JOB, log)).toBe('failed');
    expect(s.events).toEqual(['reserve', 'record:failed:1', 'release']);
    expect(s.fakes.failed).toMatchObject({ cause: 'temporary', code: 'invalid_response' });
  });

  it('an unexpected error after the key was opened keeps the estimate counted', async () => {
    const s = setup();
    s.ai.generate.push(() => Promise.reject(new Error('socket exploded')));
    expect(await s.gen.run(JOB, log)).toBe('failed');
    expect(s.events).toEqual(['reserve', 'unconfirmed:1', 'release']);
    expect(s.fakes.failed?.cause).toBe('outcome_unknown');
    expect(s.opened[0]?.every((byte) => byte === 0)).toBe(true);
  });

  it('a key that cannot be opened makes no call and no usage event', async () => {
    const s = setup();
    s.unsealFails = true;
    expect(await s.gen.run(JOB, log)).toBe('failed');
    expect(s.fakes.log).not.toContain('ai');
    expect(s.fakes.failed?.cause).toBe('configuration');
    expect(s.events).toEqual(['reserve', 'release']);
  });

  it('a job another worker already settled makes no call', async () => {
    const s = setup();
    s.fakes.startOk = false;
    expect(await s.gen.run(JOB, log)).toBe('failed');
    expect(s.fakes.log).not.toContain('ai');
  });

  it('fails an answer whose text does not fit its columns', async () => {
    const s = setup();
    s.ai.generate.push(() => Promise.resolve(brief('x'.repeat(700), 'short')));
    expect(await s.gen.run(JOB, log)).toBe('failed');
    expect(s.fakes.failed?.code).toBe('too_long');
  });

  it('handle reads the job ID from the payload and refuses a payload without one', async () => {
    const s = setup();
    s.fakes.job = null;
    expect(await s.gen.handle({ id: 'q1', data: { jobId: JOB } }, log)).toBe('skipped');
    await expect(s.gen.handle({ id: 'q1', data: {} }, log)).rejects.toThrow(TypeError);
    await expect(s.gen.handle({ id: 'q1', data: null }, log)).rejects.toThrow(TypeError);
  });

  it('a superseded generation writes nothing but still releases', async () => {
    const s = setup();
    s.fakes.completeKind = 'superseded';
    s.ai.generate.push(() => Promise.resolve(brief(calm(36), calm(30))));
    expect(await s.gen.run(JOB, log)).toBe('completed');
    expect(s.events.at(-1)).toBe('release');
  });
});

describe('brief.analyze-image', () => {
  const described = (text: string) => () => Promise.resolve(text);

  it('sends the sanitized bytes after the cap check and stores a description with no sensitive inference', async () => {
    const s = setup();
    s.fakes.job = analysis();
    s.ai.describe.push(described('A small amber jar with a silver lid. A young woman of Asian descent holds it. She looks healthy.'));
    expect(await s.img.run(JOB, log)).toBe('completed');
    expect(s.fakes.analysisText).toBe('A small amber jar with a silver lid.');
    expect(s.fakes.log.indexOf('reserve')).toBeLessThan(s.fakes.log.indexOf('ai'));
    expect(s.events).toEqual(['reserve', 'record:succeeded:1', 'release']);
    expect(s.opened[0]?.every((byte) => byte === 0)).toBe(true);
  });

  it('fails temporary when nothing is left after the filter, so the owner continues without a description', async () => {
    const s = setup();
    s.fakes.job = analysis();
    s.ai.describe.push(described('An elderly patient holds the jar.'));
    expect(await s.img.run(JOB, log)).toBe('failed');
    expect(s.fakes.analysisText).toBeNull();
    expect(s.fakes.failed).toMatchObject({ cause: 'temporary', code: 'empty_description' });
  });

  it.each([
    ['no media row', (): MediaFacts | null => null],
    ['another owner', () => ({ id: MEDIA, ownerId: 'other', state: 'ready', storageKey: 'k', contentType: 'image/png' })],
    ['a media object not ready', () => ({ id: MEDIA, ownerId: OWNER, state: 'processing', storageKey: 'k', contentType: 'image/png' })],
    ['no content type', () => ({ id: MEDIA, ownerId: OWNER, state: 'ready', storageKey: 'k', contentType: null })],
  ] as const)('makes no call and no charge for %s', async (_name, row) => {
    const s = setup();
    s.fakes.job = analysis();
    s.fakes.media = row();
    expect(await s.img.run(JOB, log)).toBe('failed');
    expect(s.fakes.log).not.toContain('ai');
    expect(s.events).toEqual(['release']);
    expect(s.fakes.failed?.from).toBe('pending');
  });

  it('refuses a missing key and an unreadable image without a charge', async () => {
    const s = setup();
    s.fakes.job = analysis();
    s.fakes.keyRow = null;
    expect(await s.img.run(JOB, log)).toBe('failed');
    expect(s.fakes.failed?.cause).toBe('key_deleted');

    const t = setup();
    t.fakes.job = analysis();
    t.readFails = true;
    expect(await t.img.run(JOB, log)).toBe('failed');
    expect(t.fakes.log).not.toContain('ai');
    expect(t.fakes.log).not.toContain('claim');
  });

  it('is stopped by the cap before any adapter call', async () => {
    const s = setup();
    s.fakes.job = analysis();
    s.capError = new DomainError('spend_cap_reached', 'cap');
    expect(await s.img.run(JOB, log)).toBe('failed');
    expect(s.fakes.log).not.toContain('ai');
    expect(s.events).toEqual(['reserve', 'release']);
    s.capError = new Error('db');
    await expect(s.img.run(JOB, log)).rejects.toThrow('db');
  });

  it('401 counts against the key; the job fails configuration with no description', async () => {
    const s = setup();
    s.fakes.job = analysis();
    s.ai.describe.push(() => Promise.reject(callFailed(401)));
    expect(await s.img.run(JOB, log)).toBe('failed');
    expect(s.reports).toEqual([false]);
    expect(s.events).toEqual(['reserve', 'record:rejected:1', 'release']);
    expect(s.fakes.failed?.cause).toBe('configuration');
  });

  it('skips jobs that are not pending analyses and claims lost to another worker', async () => {
    for (const job of [analysis({ state: 'completed' }), generation(), analysis({ mediaId: null }), null]) {
      const s = setup();
      s.fakes.job = job;
      expect(await s.img.run(JOB, log)).toBe('skipped');
    }
    const s = setup();
    s.fakes.job = analysis();
    s.fakes.claimOk = false;
    expect(await s.img.run(JOB, log)).toBe('skipped');
    expect(s.fakes.log).not.toContain('ai');
  });

  it('handle reads the job ID from the payload', async () => {
    const s = setup();
    s.fakes.job = null;
    expect(await s.img.handle({ id: 'q', data: { jobId: JOB } }, log)).toBe('skipped');
    await expect(s.img.handle({ id: 'q', data: {} }, log)).rejects.toThrow(TypeError);
  });
});
