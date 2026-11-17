import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClaimModule from '../../../platform/jobs/claim.js';
import { classifyProviderFailure } from '../../../platform/egress/index.js';
import { QcKeySession, gateQcKey, NO_KEY_REASON } from './qc-key-session.js';
import type { AudioExtractor, QcRepository, QcRunContext, QcSettlement, TranscribePort } from './qc-ports.js';
import { QcRunJob } from './qc-run.job.js';
import { ProviderCallFailed, ProviderInvalidResponse } from './worker/ports.js';
import type { JobLog, KeyAuthReporter, KeyOpener, SealedKeyRow } from './worker/ports.js';

const claim = vi.hoisted(() => ({ kind: 'claimed' as 'claimed' | 'not_pending' }));
vi.mock('../../../platform/jobs/claim.js', async (original) => ({
  ...(await original<typeof ClaimModule>()),
  claimWithUserLimit: async () => (claim.kind === 'claimed' ? { kind: 'claimed', ownerId: 'owner' } : { kind: 'not_pending' }),
}));

const CANARY = 'canary-transcript-7f3a';
const key = (over: Partial<SealedKeyRow> = {}): SealedKeyRow => ({
  id: 'key-1', ownerId: 'owner', provider: 'openai', status: 'active', version: 1,
  sealed: { ciphertext: Buffer.alloc(1), nonce: Buffer.alloc(1), wrappedDek: Buffer.alloc(1), kekVersion: 1 }, ...over,
});
const context = (over: Partial<QcRunContext> = {}): QcRunContext => ({
  id: 'run-1', ownerId: 'owner', videoJobId: 'job-1', state: 'pending', keyId: 'key-1', keyVersion: 1, callCount: 0,
  clipState: 'completed', campaignId: 'c', campaignActive: true, storageKey: 'u/o/c/clip/job-1.mp4',
  segmentRevision: 1, currentRevision: 1, dialogue: 'A calm start to the day.', ...over,
});

interface Harness {
  job: QcRunJob;
  settled: QcSettlement[];
  usage: { record: ReturnType<typeof vi.fn>; convertUnconfirmed: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  transcribe: ReturnType<typeof vi.fn>;
  reported: boolean[];
  logs: string[];
}

function harness(opts: {
  run?: Partial<QcRunContext> | null;
  stamped?: SealedKeyRow | null;
  current?: SealedKeyRow | null;
  heard?: string | Error;
  audio?: Awaited<ReturnType<AudioExtractor['extract']>> | Error;
  started?: boolean;
  unseal?: 'ok' | 'fail';
  getFails?: boolean;
} = {}): Harness {
  const settled: QcSettlement[] = [];
  const logs: string[] = [];
  const reported: boolean[] = [];
  const repository: QcRepository = {
    findRun: async () => (opts.run === null ? null : context(opts.run)),
    findOwnerKey: async () => (opts.current === undefined ? key({ id: 'key-owner' }) : opts.current),
    findKey: async () => (opts.stamped === undefined ? key() : opts.stamped),
    startCall: async () => opts.started ?? true,
    settle: async (_tx, _id, settlement) => {
      settled.push(settlement);
      return true;
    },
  };
  const usage = { record: vi.fn(async () => ({ recorded: true, costUsd: '0' })), convertUnconfirmed: vi.fn(async () => ({ recorded: true, costUsd: '0' })), release: vi.fn(async () => true) };
  const transcribe = vi.fn(async (): Promise<{ text: string }> => {
    if (opts.heard instanceof Error) throw opts.heard;
    return { text: opts.heard ?? 'A calm start to the day.' };
  });
  const transcriber: TranscribePort = { transcribe };
  const audio: AudioExtractor = {
    extract: async () => {
      if (opts.audio instanceof Error) throw opts.audio;
      return opts.audio ?? { kind: 'audio', wav: Buffer.from('RIFF') };
    },
  };
  const opener: KeyOpener = { unseal: () => { if (opts.unseal === 'fail') throw new Error('bad'); return Buffer.from('sk-secret'); } };
  const auth: KeyAuthReporter = { report: async (_id, _version, ok) => { reported.push(ok); } };
  const storage = { get: async () => { if (opts.getFails === true) throw new Error('gone'); return Readable.from([Buffer.from('mp4')]); } };
  const database = { uow: { run: async <T,>(fn: (tx: never) => Promise<T>) => fn({} as never) } };
  const job = new QcRunJob(
    database as never, repository, usage as never, new QcKeySession(opener, auth), transcriber, audio, storage as never,
    { transcribeModel: 'gpt-transcribe', maxWordErrorRate: 0.2, deadlineMinutes: 10, idempotencyTtlHours: 24, orphanAfterSec: 300, requeueAfterSec: 120 },
  );
  return { job, settled, usage, transcribe, reported, logs };
}
const log = (sink: string[]): JobLog => ({ info: (_f, m) => sink.push(m), warn: (_f, m) => sink.push(m) });
const failed = (status: number, errorCode?: string) => new ProviderCallFailed(classifyProviderFailure('OpenAI', { kind: 'http', status, errorCode }), status);

beforeEach(() => {
  claim.kind = 'claimed';
});

describe('QcRunJob.run', () => {
  it('passes a clip whose words match, records the call and releases both reservations', async () => {
    const h = harness();
    expect(await h.job.run('run-1', log(h.logs))).toBe('passed');
    expect(h.settled).toEqual([{ qcState: 'passed', reason: null, wordErrorRate: 0, errorCode: null }]);
    expect(h.usage.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ jobType: 'qc', jobId: 'run-1', callSeq: 1, outcome: 'succeeded' }));
    expect(h.usage.release).toHaveBeenCalledWith(expect.anything(), { ownerId: 'owner', jobType: 'qc', jobId: 'run-1' });
    expect(h.usage.release).toHaveBeenCalledWith(expect.anything(), { ownerId: 'owner', jobType: 'video', jobId: 'job-1' });
    expect(h.reported).toEqual([true]);
  });

  it('fails a clip whose words differ and never logs the transcript', async () => {
    const h = harness({ heard: `${CANARY} something else entirely` });
    expect(await h.job.run('run-1', log(h.logs))).toBe('failed');
    expect(h.settled[0]?.qcState).toBe('failed');
    expect(h.settled[0]?.wordErrorRate).toBeGreaterThan(0.2);
    await h.job.handle({ id: 'j', data: { runId: 'run-1' } }, log(h.logs));
    expect(h.logs.join('\n')).not.toContain(CANARY);
  });

  it.each([
    ['not pending', { state: 'completed' }],
    ['unknown', null],
  ])('does nothing for a run that is %s', async (_name, run) => {
    const h = harness({ run: run as never });
    expect(await h.job.run('run-1', log(h.logs))).toBe('ignored');
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(h.settled).toEqual([]);
  });

  it('does nothing when another worker holds the claim', async () => {
    claim.kind = 'not_pending';
    const h = harness();
    expect(await h.job.run('run-1', log(h.logs))).toBe('ignored');
    expect(h.transcribe).not.toHaveBeenCalled();
  });

  it.each([
    ['the clip is not completed', { clipState: 'failed' }, 'This clip is not available to check.'],
    ['there is no stored clip', { storageKey: null }, 'This clip is not available to check.'],
    ['the campaign is going away', { campaignActive: false }, 'This clip is not available to check.'],
    ['the segment has no dialogue', { dialogue: ' ' }, 'This segment has no spoken text to check.'],
    ['the segment changed', { currentRevision: 2 }, 'The segment changed after this clip was made, so its audio was not compared.'],
  ])('skips with a reason, no call and the reservations released, when %s', async (_name, run, reason) => {
    const h = harness({ run });
    expect(await h.job.run('run-1', log(h.logs))).toBe('skipped');
    expect(h.settled[0]).toMatchObject({ qcState: 'skipped', reason });
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(h.usage.record).not.toHaveBeenCalled();
    expect(h.usage.convertUnconfirmed).not.toHaveBeenCalled();
    expect(h.usage.release).toHaveBeenCalledTimes(2);
  });

  it('skips with "add your OpenAI key" and no call when the owner has no usable key', async () => {
    const h = harness({ run: { keyId: null, keyVersion: null }, current: null });
    expect(await h.job.run('run-1', log(h.logs))).toBe('skipped');
    expect(h.settled[0]?.reason).toBe(NO_KEY_REASON);
    expect(h.transcribe).not.toHaveBeenCalled();
  });

  it('uses the owner\'s current key when none was stamped', async () => {
    const h = harness({ run: { keyId: null, keyVersion: null } });
    expect(await h.job.run('run-1', log(h.logs))).toBe('passed');
  });

  it('skips when the clip has no audio track, and when its audio cannot be read, without a call', async () => {
    const none = harness({ audio: { kind: 'none' } });
    expect(await none.job.run('run-1', log(none.logs))).toBe('skipped');
    expect(none.settled[0]?.reason).toBe('No audio track in this clip.');
    const bad = harness({ audio: new Error('ffmpeg failed') });
    expect(await bad.job.run('run-1', log(bad.logs))).toBe('skipped');
    expect(bad.settled[0]).toMatchObject({ qcState: 'skipped', errorCode: 'audio_unreadable' });
    expect(none.transcribe).not.toHaveBeenCalled();
    expect(bad.transcribe).not.toHaveBeenCalled();
  });

  it('skips when the key cannot be opened, nothing sent', async () => {
    const h = harness({ unseal: 'fail' });
    expect(await h.job.run('run-1', log(h.logs))).toBe('skipped');
    expect(h.settled[0]?.errorCode).toBe('key_unreadable');
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(h.usage.convertUnconfirmed).not.toHaveBeenCalled();
  });

  it('leaves a run that left submitting under it alone', async () => {
    const h = harness({ started: false });
    expect(await h.job.run('run-1', log(h.logs))).toBe('ignored');
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(h.settled).toEqual([]);
  });

  it('a 401 is skipped, recorded at zero, and counts against the key', async () => {
    const h = harness({ heard: failed(401) });
    expect(await h.job.run('run-1', log(h.logs))).toBe('skipped');
    expect(h.settled[0]).toMatchObject({ qcState: 'skipped', errorCode: 'configuration' });
    expect(h.usage.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: 'rejected' }));
    expect(h.reported).toEqual([false]);
  });

  it('out of credit is skipped with the credit reason', async () => {
    const h = harness({ heard: failed(429, 'insufficient_quota') });
    await h.job.run('run-1', log(h.logs));
    expect(h.settled[0]?.reason).toBe('Your OpenAI account has no credit left. Add credit, then re-run QC.');
  });

  it('a 5xx keeps the estimate counted (unconfirmed) and is skipped with a retry reason', async () => {
    const h = harness({ heard: failed(503) });
    await h.job.run('run-1', log(h.logs));
    expect(h.settled[0]).toMatchObject({ qcState: 'skipped', reason: 'The transcription service was not available. Re-run QC.' });
    expect(h.usage.convertUnconfirmed).toHaveBeenCalledOnce();
    expect(h.usage.record).not.toHaveBeenCalled();
  });

  it('an answer that is not a transcript is billed and skipped', async () => {
    const h = harness({ heard: new ProviderInvalidResponse('no transcript text') });
    await h.job.run('run-1', log(h.logs));
    expect(h.settled[0]).toMatchObject({ qcState: 'skipped', errorCode: 'invalid_response' });
    expect(h.usage.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: 'succeeded' }));
  });

  it('any other fault after the call was made is skipped and unconfirmed', async () => {
    const h = harness({ heard: new Error('socket closed') });
    await h.job.run('run-1', log(h.logs));
    expect(h.settled[0]).toMatchObject({ qcState: 'skipped', errorCode: 'qc_error' });
    expect(h.usage.convertUnconfirmed).toHaveBeenCalledOnce();
  });

  it('a clip that cannot be read from storage is skipped, nothing sent', async () => {
    const h = harness({ getFails: true });
    await h.job.run('run-1', log(h.logs));
    expect(h.settled[0]).toMatchObject({ qcState: 'skipped', errorCode: 'qc_error' });
    expect(h.usage.convertUnconfirmed).not.toHaveBeenCalled();
  });
});

describe('QcRunJob.handle', () => {
  it('needs a run ID', async () => {
    const h = harness();
    await expect(h.job.handle({ id: 'j', data: {} }, log(h.logs))).rejects.toThrow(TypeError);
  });
});

describe('gateQcKey', () => {
  const run = { ownerId: 'owner', keyId: 'key-1', keyVersion: 1 };
  it('accepts the stamped key of the same version', () => {
    expect(gateQcKey(run, key(), null)).toMatchObject({ ok: true });
  });
  it.each([
    ['a missing key', null, NO_KEY_REASON],
    ['another owner\'s key', key({ ownerId: 'other' }), NO_KEY_REASON],
    ['a WaveSpeed key', key({ provider: 'wavespeed' }), NO_KEY_REASON],
    ['a replaced key', key({ version: 2 }), 'Your OpenAI key was replaced while this check waited. Re-run QC.'],
    ['a disabled key', key({ status: 'disabled' }), 'Your OpenAI key is disabled. Enter it again in Settings, then re-run QC.'],
  ])('refuses %s', (_name, stamped, reason) => {
    expect(gateQcKey(run, stamped, null)).toEqual({ ok: false, reason });
  });
});
