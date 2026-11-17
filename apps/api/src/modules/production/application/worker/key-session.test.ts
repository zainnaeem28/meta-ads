import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../../platform/db/index.js';
import { KeySession, followUpKey, gateKey } from './key-session.js';
import type { KeyAuthReporter, KeyOpener, SealedKeyRow, VideoJobRow, VideoWorkerRepository } from './ports.js';

const job = (over: Partial<VideoJobRow> = {}): VideoJobRow => ({
  id: 'j', ownerId: 'o', campaignId: 'c', segmentId: 's', segmentRevision: 1, referenceMediaId: null, providerModel: 'm',
  options: { durationSeconds: 15, resolution: '1080p', aspectRatio: '9:16' }, state: 'pending', keyId: 'k', keyVersion: 1,
  providerTaskId: null, providerCompletedAt: null, outputMediaId: null, ...over,
});
const key = (over: Partial<SealedKeyRow> = {}): SealedKeyRow => ({
  id: 'k', ownerId: 'o', provider: 'wavespeed', status: 'active', version: 1,
  sealed: { ciphertext: Buffer.alloc(1), nonce: Buffer.alloc(1), wrappedDek: Buffer.alloc(1), kekVersion: 1 }, ...over,
});
const log = { info: vi.fn(), warn: vi.fn() };

describe('gateKey', () => {
  it('lets a live key of the same version through', () => {
    expect(gateKey(job(), key()).ok).toBe(true);
    expect(gateKey(job(), key({ status: 'untested' })).ok).toBe(true);
  });

  it.each([
    ['no key id on the job', job({ keyId: null }), key(), 'key_deleted'],
    ['the key row is gone', job(), null, 'key_deleted'],
    ['another owner', job(), key({ ownerId: 'x' }), 'key_deleted'],
    ['an OpenAI key', job(), key({ provider: 'openai' }), 'configuration'],
    ['a replaced key', job(), key({ version: 2 }), 'key_replaced'],
    ['a job with no key version', job({ keyVersion: null }), key(), 'key_replaced'],
    ['a disabled key', job(), key({ status: 'disabled' }), 'configuration'],
  ])('refuses %s', (_name, j, k, cause) => {
    const gate = gateKey(j, k);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.cause).toBe(cause);
  });
});

describe('followUpKey', () => {
  it('keeps the key whatever its version or status, and drops a foreign or missing one', () => {
    expect(followUpKey(job(), key({ version: 9, status: 'disabled' }))?.id).toBe('k');
    expect(followUpKey(job(), null)).toBeNull();
    expect(followUpKey(job({ keyId: null }), key())).toBeNull();
    expect(followUpKey(job(), key({ ownerId: 'x' }))).toBeNull();
    expect(followUpKey(job(), key({ provider: 'openai' }))).toBeNull();
  });
});

describe('KeySession', () => {
  const repository = { findKey: async () => key() } as unknown as VideoWorkerRepository;
  const database = { uow: { run: async <T>(fn: (tx: never) => Promise<T>) => fn(undefined as never) } } as unknown as Pick<Database, 'uow'>;

  it('opens the key by id, passes it to the call and zeroes it afterwards', async () => {
    const buffer = Buffer.from('secret');
    const opener: KeyOpener = { unseal: vi.fn(() => buffer) };
    const session = new KeySession(database, repository, opener, { report: vi.fn() });
    const seen = await session.with(key(), log, async (credential) => credential.apiKey.toString());
    expect(seen).toBe('secret');
    expect(buffer.equals(Buffer.alloc(6))).toBe(true);
    expect(opener.unseal).toHaveBeenCalledWith(key().sealed, { userId: 'o', provider: 'wavespeed', keyId: 'k', version: 1 });
  });

  it('zeroes the key when the call throws, and reports an unreadable key without calling', async () => {
    const buffer = Buffer.from('secret');
    const session = new KeySession(database, repository, { unseal: () => buffer }, { report: vi.fn() });
    await expect(session.with(key(), log, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(buffer.equals(Buffer.alloc(6))).toBe(true);
    const broken = new KeySession(database, repository, { unseal: () => { throw new Error('bad'); } }, { report: vi.fn() });
    const call = vi.fn();
    expect(await broken.with(key(), log, call)).toBe('unreadable');
    expect(call).not.toHaveBeenCalled();
  });

  it('reports the auth result and swallows a failure to record it', async () => {
    const auth: KeyAuthReporter = { report: vi.fn(async () => { throw new Error('db'); }) };
    const session = new KeySession(database, repository, { unseal: () => Buffer.alloc(1) }, auth);
    await expect(session.report(key(), false, log)).resolves.toBeUndefined();
    expect(auth.report).toHaveBeenCalledWith('k', 1, false);
    expect(await session.keyOf('k')).toMatchObject({ id: 'k' });
  });
});
