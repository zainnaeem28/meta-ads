import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { MediaRecord, MediaRepository } from '../application/ports.js';
import { quarantineKey, uploadKey } from '../domain/keys.js';
import { StorageKeyExists, StorageNotFound, StorageUnavailable } from '../domain/storage.js';
import type { StoragePort } from '../domain/storage.js';
import { mediaJobHandlers, workerMediaConfigFrom } from '../media.module.js';
import { ImageRejected } from './image-sanitize.port.js';
import type { ImageSanitizePort } from './image-sanitize.port.js';
import type { JobLog, MediaMaintenanceRepository } from './maintenance.js';
import { MediaDeletion } from './media-deletion.js';
import { SanitizeJob } from './sanitize.job.js';
import { UnattachedSweep } from './unattached-sweep.job.js';

// The decisions of the worker jobs on in-memory fakes: retry, rerun and crash windows. The same code runs on real
// PostgreSQL, MinIO and sharp in media-worker.integration.test.ts.

const OWNER = '0197a1b2-0000-7000-8000-000000000001';
const ID = '0197a1b2-0000-7000-8000-000000000002';
const log: JobLog = { info: vi.fn(), warn: vi.fn() };

function record(over: Partial<MediaRecord> = {}): MediaRecord {
  return {
    id: ID, ownerId: OWNER, kind: 'upload', state: 'processing', storageKey: quarantineKey(OWNER, ID), bytes: 100,
    contentType: 'image/png', width: null, height: null, campaignId: null, attachedAt: null, rejectReason: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), ...over,
  };
}

function world(initial: MediaRecord[] = [record()]) {
  const rows = new Map(initial.map((r) => [r.id, r]));
  const objects = new Map<string, Buffer>();
  const usage = { bytes: 1000 };
  const calls: string[] = [];
  const tx = {} as never;
  const database = { uow: { run: <T>(fn: (t: never) => Promise<T>) => fn(tx) } };
  const repository = {
    find: (_t: never, id: string) => Promise.resolve(rows.get(id) ?? null),
    lockUsage: () => Promise.resolve(usage.bytes),
    addUsage: (_t: never, _o: string, delta: number) => { usage.bytes += delta; return Promise.resolve(); },
    remove: (_t: never, id: string) => { calls.push(`row:${id}`); const r = rows.get(id) ?? null; rows.delete(id); return Promise.resolve(r); },
  } as unknown as MediaRepository;
  const maintenance = {
    lockRow: (_t: never, id: string) => Promise.resolve(rows.get(id) ?? null),
    markReady: (_t: never, id: string, r: Partial<MediaRecord> & { storageKey: string }) => { rows.set(id, { ...rows.get(id)!, ...r, state: 'ready' }); return Promise.resolve(); },
    markRejected: (_t: never, id: string, reason: MediaRecord['rejectReason']) => { rows.set(id, { ...rows.get(id)!, state: 'rejected', rejectReason: reason, bytes: 0 }); return Promise.resolve(); },
    listUnattachedBefore: (_t: never, cutoff: Date, limit: number) =>
      Promise.resolve([...rows.values()].filter((r) => r.kind === 'upload' && r.attachedAt === null && r.createdAt < cutoff).slice(0, limit)),
    listByCampaign: (_t: never, c: string, limit: number) => Promise.resolve([...rows.values()].filter((r) => r.campaignId === c).slice(0, limit)),
    jobAttempts: vi.fn(() => Promise.resolve({ retryCount: 0, retryLimit: 3 } as { retryCount: number; retryLimit: number } | null)),
  } as unknown as MediaMaintenanceRepository & { jobAttempts: ReturnType<typeof vi.fn> };
  const storage = {
    put: vi.fn((key: string, body: Buffer) => {
      if (objects.has(key)) return Promise.reject(new StorageKeyExists());
      objects.set(key, body);
      return Promise.resolve({ bytes: body.length });
    }),
    get: vi.fn((key: string) => {
      const o = objects.get(key);
      return o === undefined ? Promise.reject(new StorageNotFound()) : Promise.resolve(Readable.from([o]));
    }),
    delete: vi.fn((key: string) => { calls.push(`object:${key}`); objects.delete(key); return Promise.resolve(); }),
    deletePrefix: vi.fn(() => Promise.resolve(3)),
  } as unknown as StoragePort & { put: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  const sanitizer: ImageSanitizePort & { inspect: ReturnType<typeof vi.fn>; reencode: ReturnType<typeof vi.fn> } = {
    inspect: vi.fn(() => Promise.resolve({ format: 'png', width: 7, height: 5 })),
    reencode: vi.fn(() => Promise.resolve(Buffer.from('clean'))),
  } as never;
  return { rows, objects, usage, calls, database, repository, maintenance, storage, sanitizer };
}

const sanitizeJob = (w: ReturnType<typeof world>) =>
  new SanitizeJob(w.database as never, w.repository, w.maintenance, w.storage, w.sanitizer);
const deletion = (w: ReturnType<typeof world>) => new MediaDeletion(w.database as never, w.repository, w.maintenance, w.storage);

describe('SanitizeJob', () => {
  it('stores the clean copy, marks the row ready with its facts and the quota delta, then drops quarantine', async () => {
    const w = world();
    w.objects.set(quarantineKey(OWNER, ID), Buffer.from('dirty-original'));
    expect(await sanitizeJob(w).handle({ id: 'j1', data: { mediaId: ID } }, log)).toBe('ready');
    expect(w.rows.get(ID)).toMatchObject({ state: 'ready', storageKey: uploadKey(OWNER, ID), bytes: 5, width: 7, height: 5, contentType: 'image/png' });
    expect(w.usage.bytes).toBe(1000 + 5 - 100);
    expect(w.objects.has(quarantineKey(OWNER, ID))).toBe(false);
    expect(w.objects.get(uploadKey(OWNER, ID))?.toString()).toBe('clean');
  });

  it('rejects with the reason of an ImageRejected, returns the reservation, never retries', async () => {
    const w = world();
    w.objects.set(quarantineKey(OWNER, ID), Buffer.from('x'));
    w.sanitizer.inspect.mockRejectedValue(new ImageRejected('pixel_cap_exceeded'));
    expect(await sanitizeJob(w).run(ID, false, log)).toBe('rejected');
    expect(w.rows.get(ID)).toMatchObject({ state: 'rejected', rejectReason: 'pixel_cap_exceeded', bytes: 0 });
    expect(w.usage.bytes).toBe(900);
    expect(w.objects.size).toBe(0);
  });

  it('throws a transient failure while retries remain and rejects decode_failed on the last attempt', async () => {
    const w = world();
    w.objects.set(quarantineKey(OWNER, ID), Buffer.from('x'));
    w.sanitizer.reencode.mockRejectedValue(new Error('timeout'));
    await expect(sanitizeJob(w).handle({ id: 'j1', data: { mediaId: ID } }, log)).rejects.toThrow('timeout');
    expect(w.rows.get(ID)?.state).toBe('processing');
    w.maintenance.jobAttempts.mockResolvedValue({ retryCount: 3, retryLimit: 3 });
    expect(await sanitizeJob(w).handle({ id: 'j1', data: { mediaId: ID } }, log)).toBe('rejected');
    expect(w.rows.get(ID)).toMatchObject({ state: 'rejected', rejectReason: 'decode_failed' });
  });

  it('skips an unknown row and a row that is not processing; a ready row has its leftover quarantine removed', async () => {
    const w = world([record({ state: 'ready', storageKey: uploadKey(OWNER, ID) })]);
    w.objects.set(quarantineKey(OWNER, ID), Buffer.from('left'));
    expect(await sanitizeJob(w).run(ID, false, log)).toBe('skipped');
    expect(w.objects.has(quarantineKey(OWNER, ID))).toBe(false);
    expect(await sanitizeJob(w).run('0197a1b2-0000-7000-8000-0000000000ff', false, log)).toBe('skipped');
    w.rows.set(ID, record({ state: 'rejected', rejectReason: 'decode_failed', bytes: 0 }));
    expect(await sanitizeJob(w).run(ID, false, log)).toBe('skipped');
  });

  it('a job without a mediaId is a bug and fails', async () => {
    await expect(sanitizeJob(world()).handle({ id: 'j', data: {} }, log)).rejects.toThrow(TypeError);
  });

  it('reuses a clean copy an earlier attempt stored (conditional put found the key taken)', async () => {
    const w = world();
    w.objects.set(quarantineKey(OWNER, ID), Buffer.from('x'));
    w.objects.set(uploadKey(OWNER, ID), Buffer.from('stored-earlier'));
    expect(await sanitizeJob(w).run(ID, false, log)).toBe('ready');
    expect(w.objects.get(uploadKey(OWNER, ID))?.toString()).toBe('stored-earlier');
    expect(w.rows.get(ID)?.bytes).toBe('stored-earlier'.length);
  });

  it('with no quarantine object it finishes from the earlier copy, or rejects when there is none', async () => {
    const w = world();
    expect(await sanitizeJob(w).run(ID, false, log)).toBe('rejected');
    const v = world();
    v.objects.set(uploadKey(OWNER, ID), Buffer.from('stored-earlier'));
    expect(await sanitizeJob(v).run(ID, false, log)).toBe('ready');
  });

  it('a storage outage is thrown (retry); a key taken whose object vanished is thrown too', async () => {
    const w = world();
    w.storage.get.mockRejectedValue(new StorageUnavailable('get'));
    await expect(sanitizeJob(w).run(ID, false, log)).rejects.toBeInstanceOf(StorageUnavailable);
    const v = world();
    v.objects.set(quarantineKey(OWNER, ID), Buffer.from('x'));
    v.storage.put.mockRejectedValue(new StorageKeyExists());
    await expect(sanitizeJob(v).run(ID, false, log)).rejects.toBeInstanceOf(StorageKeyExists);
    const u = world();
    u.objects.set(quarantineKey(OWNER, ID), Buffer.from('x'));
    u.storage.put.mockRejectedValue(new StorageUnavailable('put'));
    await expect(sanitizeJob(u).run(ID, false, log)).rejects.toBeInstanceOf(StorageUnavailable);
    const t = world();
    t.maintenance.jobAttempts.mockResolvedValue(null);
    t.objects.set(quarantineKey(OWNER, ID), Buffer.from('x'));
    expect(await sanitizeJob(t).handle({ id: 'gone', data: { mediaId: ID } }, log)).toBe('ready');
  });

  it('a quarantine object that cannot be deleted does not fail the job', async () => {
    const w = world();
    w.objects.set(quarantineKey(OWNER, ID), Buffer.from('x'));
    w.storage.delete.mockRejectedValue(new StorageUnavailable('delete'));
    expect(await sanitizeJob(w).run(ID, false, log)).toBe('ready');
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('MediaDeletion and UnattachedSweep', () => {
  it('deletes the object before the row and returns the bytes', async () => {
    const w = world([record({ state: 'ready', storageKey: uploadKey(OWNER, ID) })]);
    expect(await deletion(w).deleteObjects([ID, ID])).toBe(1);
    expect(w.calls).toEqual([`object:${uploadKey(OWNER, ID)}`, `row:${ID}`]);
    expect(w.usage.bytes).toBe(900);
  });

  it('a failed object delete leaves the row', async () => {
    const w = world([record({ state: 'ready', storageKey: uploadKey(OWNER, ID) })]);
    w.storage.delete.mockRejectedValue(new StorageUnavailable('delete'));
    await expect(deletion(w).deleteObjects([ID])).rejects.toBeInstanceOf(StorageUnavailable);
    expect(w.rows.has(ID)).toBe(true);
  });

  it('a processing upload also loses a half-written clean copy', async () => {
    const w = world();
    await deletion(w).deleteObjects([ID]);
    expect(w.calls).toContain(`object:${uploadKey(OWNER, ID)}`);
  });

  it('deleteForCampaign loops until empty, sweeps each owner prefix, and stops when nothing could be deleted', async () => {
    const campaign = '0197a1b2-0000-7000-8000-0000000000c1';
    const w = world([record({ campaignId: campaign, kind: 'final', state: 'ready', bytes: 0 })]);
    expect(await deletion(w).deleteForCampaign(campaign)).toEqual({ rows: 1, objects: 3 });
    expect(w.storage.deletePrefix).toHaveBeenCalledWith(`u/${OWNER}/c/${campaign}/`, 1000);
    const v = world([record({ campaignId: campaign, kind: 'final', state: 'ready' })]);
    v.maintenance.lockRow = () => Promise.resolve(null);
    expect((await deletion(v).deleteForCampaign(campaign)).rows).toBe(0);
  });

  it('sweepPrefix accepts owner and campaign prefixes only', async () => {
    const w = world();
    await expect(deletion(w).sweepPrefix('u/')).rejects.toThrow(TypeError);
    expect(await deletion(w).sweepPrefix(`q/${OWNER}/`)).toBe(3);
  });

  it('the sweep removes only unattached uploads past the TTL, re-checks under the lock, and counts failures', async () => {
    const now = new Date('2026-01-03T00:00:00Z');
    const old = record({ id: '0197a1b2-0000-7000-8000-0000000000a1', createdAt: new Date('2026-01-01T00:00:00Z') });
    const w = world([old, record({ id: '0197a1b2-0000-7000-8000-0000000000a2', createdAt: new Date('2026-01-02T23:00:00Z') })]);
    const sweep = new UnattachedSweep(w.database as never, w.maintenance, deletion(w), { unattachedTtlHours: 24 });
    expect(await sweep.run(now)).toEqual({ deleted: 1, failed: 0 });
    expect([...w.rows.keys()]).toEqual(['0197a1b2-0000-7000-8000-0000000000a2']);
    // attached between the list and the lock: kept
    const racy = world([old]);
    const lock = racy.maintenance.lockRow.bind(racy.maintenance);
    racy.maintenance.lockRow = async (t, id) => { const r = await lock(t, id); return r === null ? r : { ...r, attachedAt: now }; };
    expect(await new UnattachedSweep(racy.database as never, racy.maintenance, deletion(racy), { unattachedTtlHours: 24 }).run(now)).toEqual({ deleted: 0, failed: 0 });
    const failing = world([old]);
    failing.storage.delete.mockRejectedValue(new Error('down'));
    expect(await new UnattachedSweep(failing.database as never, failing.maintenance, deletion(failing), { unattachedTtlHours: 24 }).run(now)).toEqual({ deleted: 0, failed: 1 });
  });
});

describe('worker wiring', () => {
  it('maps the two queues to the two jobs; a sweep with failures fails the job', async () => {
    const sanitize = { handle: vi.fn(() => Promise.resolve('ready')) };
    const sweep = { run: vi.fn(() => Promise.resolve({ deleted: 2, failed: 0 })) };
    const handlers = mediaJobHandlers({ sanitize: () => sanitize as never, sweep: () => sweep as never });
    expect(Object.keys(handlers).sort()).toEqual(['media.sanitize', 'media.unattached-sweep']);
    await handlers['media.sanitize']!({ id: 'j', data: { mediaId: ID } }, log);
    expect(sanitize.handle).toHaveBeenCalled();
    await handlers['media.unattached-sweep']!({ id: 'j', data: {} }, log);
    sweep.run.mockResolvedValue({ deleted: 0, failed: 2 });
    await expect(handlers['media.unattached-sweep']!({ id: 'j', data: {} }, log)).rejects.toThrow('2 uploads');
  });

  it('reads the worker settings with defaults and refuses a value out of range', () => {
    expect(workerMediaConfigFrom({})).toEqual({ maxDimension: 8000, maxPixels: 40_000_000, unattachedTtlHours: 24 });
    expect(() => workerMediaConfigFrom({ MEDIA_UNATTACHED_TTL_HOURS: '0' })).toThrow('MEDIA_UNATTACHED_TTL_HOURS');
    expect(() => workerMediaConfigFrom({ MEDIA_MAX_PIXELS: 'many' })).toThrow('MEDIA_MAX_PIXELS');
  });
});
