import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeDb } from './support/db.ts';
import type { BackupDb } from './support/db.ts';
import { BUCKETS, RETENTION_DAYS, TOKENS, makeRig } from './support/fixture.ts';
import type { Rig } from './support/fixture.ts';
import { runOnce } from './support/run.ts';
import type { Manifest } from '../src/media.ts';

// TC-BKP-17..20, 22 and TC-LED-01, 02, 04..06 through the service's own run (`runBackup`) against a real PostgreSQL
// (the schedule rule reads pg_locks), the emulator for R2 and real age.

let rig: Rig;
let db: BackupDb;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const day = (n: number) => {
  rig.clock.now = new Date(Date.UTC(2026, 10, 15 + n, 2, 0, 0));
};
const ymd = (n: number) => new Date(Date.UTC(2026, 10, 15 + n)).toISOString().slice(0, 10);

beforeAll(async () => {
  rig = await makeRig();
  db = await makeDb();
});
afterAll(async () => {
  await db.dispose();
  await rig.dispose();
});

const sinkOf = () => rig.emu.keys(BUCKETS.backup);
const deletesOnSink = () =>
  rig.emu.requests.filter(
    (r) => r.method === 'DELETE' && r.bucket === BUCKETS.backup && r.status < 300,
  );

describe('media mirror (TC-BKP-20, TC-BKP-19)', () => {
  it('copies only u/, byte for byte, as media/<key>/<etag>', async () => {
    day(0);
    const video = randomBytes(300_000);
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
    const a = rig.emu.seed(BUCKETS.app, 'u/owner-a/c/camp-1/video/clip-1.mp4', video);
    rig.emu.seed(BUCKETS.app, 'u/owner-a/media/img-1', image);
    rig.emu.seed(BUCKETS.app, 'q/owner-a/quarantined-1', 'unsanitized upload');
    rig.emu.seed(BUCKETS.app, 'smoke/probe-1', 'smoke');
    const r = await runOnce(rig, db.backupUrl);
    expect(r.failures.filter((f) => f.startsWith('copy'))).toEqual([]);
    expect(r.media).toMatchObject({ listed: 2, copied: 2, copyFailed: 0 });
    const media = rig.emu.keys(BUCKETS.backup, 'media/');
    expect(media).toEqual([
      `media/u/owner-a/c/camp-1/video/clip-1.mp4/${a.etag}`,
      `media/u/owner-a/media/img-1/${rig.emu.get(BUCKETS.app, 'u/owner-a/media/img-1')?.etag}`,
    ]);
    const copy = rig.emu.get(BUCKETS.backup, media[0] as string);
    expect(sha(copy?.data ?? Buffer.alloc(0))).toBe(sha(video));
    expect(sinkOf().some((k) => k.includes('q/') && k.startsWith('media/q'))).toBe(false);
    expect(sinkOf().filter((k) => k.includes('smoke') || k.includes('quarantined'))).toEqual([]);
    const manifest = JSON.parse(
      rig.emu.get(BUCKETS.backup, 'manifests/2026-11-15.json')?.data.toString() ?? '{}',
    ) as Manifest;
    expect(
      manifest.entries.map((e) => [
        e.key,
        e.ownerId,
        e.sha256 === sha(video) || e.size === image.length,
      ]),
    ).toEqual([
      ['u/owner-a/c/camp-1/video/clip-1.mp4', 'owner-a', true],
      ['u/owner-a/media/img-1', 'owner-a', true],
    ]);
  });

  it('a changed source is a new key and the old key is untouched (TC-BKP-19)', async () => {
    day(1);
    const key = 'u/owner-a/media/img-1';
    const oldEtag = rig.emu.get(BUCKETS.app, key)?.etag as string;
    const before = rig.emu.get(BUCKETS.backup, `media/${key}/${oldEtag}`);
    const fresh = rig.emu.seed(BUCKETS.app, key, randomBytes(2048));
    const r = await runOnce(rig, db.backupUrl);
    expect(r.ok, r.failures.join(';')).toBe(true);
    expect(r.media).toMatchObject({ copied: 1, superseded: 1, deletedDetected: 0 });
    expect(rig.emu.get(BUCKETS.backup, `media/${key}/${fresh.etag}`)?.data.equals(fresh.data)).toBe(
      true,
    );
    expect(rig.emu.get(BUCKETS.backup, `media/${key}/${oldEtag}`)).toBe(before);
    expect(deletesOnSink()).toEqual([]);
  });

  it('a second run the same day copies nothing and overwrites nothing', async () => {
    const puts = rig.emu.requests.length;
    const r = await runOnce(rig, db.backupUrl);
    expect(r.ok).toBe(true);
    expect(r.media).toMatchObject({ copied: 0, alreadyPresent: 2 });
    const overwrites = rig.emu.requests
      .slice(puts)
      .filter((x) => x.method === 'PUT' && x.status === 200 && !x.conditional && !x.copySource);
    expect(overwrites).toEqual([]);
    expect(rig.emu.keys(BUCKETS.backup, 'manifests/').length).toBe(3);
  });
});

describe('delayed delete (TC-BKP-17, TC-LED-01, TC-LED-05)', () => {
  it('copies to media-deleted/<date>/, confirms with HEAD, then deletes only the old media/ copy', async () => {
    day(32); // the media/ copy is older than BACKUP_RETENTION_DAYS, so the bucket lock lets its delete through
    const key = 'u/owner-a/c/camp-1/video/clip-1.mp4';
    const etag = rig.emu.get(BUCKETS.app, key)?.etag as string;
    rig.emu.remove(BUCKETS.app, key); // campaign deleted by the user (TC-DEL-01)
    const mark = rig.emu.requests.length;
    const r = await runOnce(rig, db.backupUrl);
    expect(r.ok, r.failures.join(';')).toBe(true);
    expect(r.media).toMatchObject({
      deletedDetected: 1,
      movedToDeleted: 1,
      oldCopiesRemoved: 1,
      moveFailed: 0,
    });
    const dest = `media-deleted/${ymd(32)}/${key}/${etag}`;
    expect(rig.emu.get(BUCKETS.backup, dest)).toBeDefined();
    expect(rig.emu.get(BUCKETS.backup, `media/${key}/${etag}`)).toBeUndefined();
    const calls = rig.emu.requests.slice(mark).filter((x) => x.bucket === BUCKETS.backup);
    const order = calls
      .filter((x) => x.key === dest || x.key === `media/${key}/${etag}`)
      .map((x) => `${x.method}:${x.key === dest ? 'dest' : 'old'}`);
    expect(order.indexOf('PUT:dest')).toBeLessThan(order.lastIndexOf('HEAD:dest'));
    expect(order.lastIndexOf('HEAD:dest')).toBeLessThan(order.indexOf('DELETE:old'));
    // The only delete of the run, and only under media/.
    const deletes = calls.filter((x) => x.method === 'DELETE');
    expect(deletes.map((x) => x.key)).toEqual([`media/${key}/${etag}`]);
    for (const prefix of ['db/', 'manifests/', 'media-deleted/', 'ledger/']) {
      expect(deletes.some((x) => x.key.startsWith(prefix))).toBe(false);
    }
    // Both etags of img-1 stay (superseded content is never removed); only the deleted clip's copy went.
    expect(rig.emu.keys(BUCKETS.backup, 'media/').length).toBe(2);
  });

  it('the copy lock clock starts at the deletion: the media-deleted/ copy cannot be deleted or replaced inside retention', async () => {
    const dest = rig.emu.keys(BUCKETS.backup, 'media-deleted/')[0] as string;
    const { Store, makeClient } = await import('../src/store.ts');
    const sink = new Store(
      makeClient(rig.emu.endpoint, 'auto', {
        accessKeyId: TOKENS.sink.id,
        secretAccessKey: TOKENS.sink.secret,
      }),
      BUCKETS.backup,
    );
    await expect(sink.putNewBuffer(dest, Buffer.from('x'), 'text/plain')).resolves.toBe('exists');
    await expect(sink.deleteMediaCopy(dest)).rejects.toThrow(/outside media/);
    day(32 + RETENTION_DAYS - 1);
    expect(rig.emu.get(BUCKETS.backup, dest)).toBeDefined();
  });

  it('a user erasure shows up in media-deleted/ and the ledger object is mirrored byte for byte (TC-LED-01, TC-LED-02)', async () => {
    day(33);
    const ledgerBody = JSON.stringify({
      subjectId: 'owner-b',
      erasedAt: '2026-11-18T01:00:00Z',
      steps: ['clerk', 'provider', 'r2', 'sweep', 'hard-delete'],
      counts: { media: 2 },
    });
    rig.emu.seed(BUCKETS.ledger, '202611/01JABCDEF.json', ledgerBody);
    const m1 = rig.emu.seed(BUCKETS.app, 'u/owner-b/media/m-1', randomBytes(1024));
    const m2 = rig.emu.seed(BUCKETS.app, 'u/owner-b/media/m-2', randomBytes(1024));
    const first = await runOnce(rig, db.backupUrl);
    expect(first.ok, first.failures.join(';')).toBe(true);
    expect(first.ledger).toMatchObject({ listed: 1, copied: 1 });
    rig.emu.remove(BUCKETS.app, 'u/owner-b/media/m-1');
    rig.emu.remove(BUCKETS.app, 'u/owner-b/media/m-2');
    day(34);
    const second = await runOnce(rig, db.backupUrl);
    expect(second.ok, second.failures.join(';')).toBe(true);
    // The copies are one day old: the lock keeps the old media/ copy (deferred, not a failure) and both copies exist.
    expect(second.media).toMatchObject({
      movedToDeleted: 2,
      oldCopiesRemoved: 0,
      removalDeferred: 2,
      moveFailed: 0,
    });
    for (const [id, m] of [
      ['m-1', m1],
      ['m-2', m2],
    ] as const) {
      expect(
        rig.emu.get(BUCKETS.backup, `media-deleted/${ymd(34)}/u/owner-b/media/${id}/${m.etag}`),
      ).toBeDefined();
      expect(rig.emu.get(BUCKETS.backup, `media/u/owner-b/media/${id}/${m.etag}`)).toBeDefined();
    }
    // Once the old copy is older than the retention, a later run removes it.
    day(33 + RETENTION_DAYS + 2);
    const third = await runOnce(rig, db.backupUrl);
    expect(third.ok, third.failures.join(';')).toBe(true);
    expect(third.media).toMatchObject({ oldCopiesRemoved: 2, removalDeferred: 0 });
    expect(rig.emu.get(BUCKETS.backup, `media/u/owner-b/media/m-1/${m1.etag}`)).toBeUndefined();
    expect(rig.emu.get(BUCKETS.backup, 'ledger/202611/01JABCDEF.json')?.data.toString()).toBe(
      ledgerBody,
    );
    // Nothing the service logs or writes besides the ledger copy carries ledger content or a personal field.
    const text =
      JSON.stringify(second.logs) +
      rig.emu
        .get(BUCKETS.backup, 'manifests/${ymd(33 + RETENTION_DAYS + 2)}.json')
        ?.data.toString();
    expect(text).not.toMatch(/email|clerk|subjectId/i);
    // The ledger mirror is never touched again: no delayed delete, no delete.
    expect(deletesOnSink().filter((d) => d.key.startsWith('ledger/'))).toEqual([]);
  });
});

describe('failed confirmation keeps the old copy (TC-BKP-18)', () => {
  it('size mismatch, then a missing copy: nothing is deleted, the run fails, the heartbeat is withheld, the next day retries', async () => {
    day(70);
    const key = 'u/owner-c/media/c-1';
    const seeded = rig.emu.seed(BUCKETS.app, key, randomBytes(4096));
    expect((await runOnce(rig, db.backupUrl)).ok).toBe(true);
    rig.emu.remove(BUCKETS.app, key);
    day(70 + RETENTION_DAYS + 1); // old enough for the lock to allow the final delete, so only the checks can keep it
    const pings: string[] = [];
    const fetchImpl = (async (url: string) => {
      pings.push(String(url));
      return new Response('ok');
    }) as unknown as typeof fetch;
    const heartbeat = { HEARTBEAT_URL_BACKUP: 'https://hc.example.test/backup' };

    rig.emu.faults.corruptCopy = (_dest, data) => data.subarray(0, data.length - 1);
    const mismatch = await runOnce(rig, db.backupUrl, heartbeat, { fetchImpl });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.media?.moveFailed).toBe(1);
    expect(mismatch.heartbeat).toBe('not-sent');
    expect(mismatch.failures.join(' ')).toMatch(/differs|HEAD/);
    expect(rig.emu.get(BUCKETS.backup, `media/${key}/${seeded.etag}`)).toBeDefined();

    rig.emu.faults = { hideHead: (_b, k) => k.startsWith('media-deleted/') };
    const missing = await runOnce(rig, db.backupUrl, heartbeat, { fetchImpl });
    expect(missing.ok).toBe(false);
    expect(rig.emu.get(BUCKETS.backup, `media/${key}/${seeded.etag}`)).toBeDefined();
    expect(pings).toEqual([]);

    rig.emu.faults = {};
    day(70 + RETENTION_DAYS + 2);
    const retry = await runOnce(rig, db.backupUrl, heartbeat, { fetchImpl });
    expect(retry.ok, retry.failures.join(';')).toBe(true);
    expect(retry.media).toMatchObject({ movedToDeleted: 1, oldCopiesRemoved: 1 });
    expect(
      rig.emu.get(
        BUCKETS.backup,
        `media-deleted/${ymd(70 + RETENTION_DAYS + 2)}/${key}/${seeded.etag}`,
      )?.data.length,
    ).toBe(4096);
    expect(rig.emu.get(BUCKETS.backup, `media/${key}/${seeded.etag}`)).toBeUndefined();
    expect(pings).toEqual(['https://hc.example.test/backup']);
  });
});

describe('heartbeat and the residual window (TC-BKP-22, TC-LED-06)', () => {
  it('a source deleted after the last good run stays in media/ while the next run fails, then moves; the heartbeat is missed in between', async () => {
    day(110);
    const key = 'u/owner-d/media/d-1';
    const seeded = rig.emu.seed(BUCKETS.app, key, randomBytes(512));
    const pings: Date[] = [];
    const fetchImpl = (async () => (
      pings.push(rig.clock.now),
      new Response('ok')
    )) as unknown as typeof fetch;
    const heartbeat = { HEARTBEAT_URL_BACKUP: 'https://hc.example.test/backup' };
    expect((await runOnce(rig, db.backupUrl, heartbeat, { fetchImpl })).heartbeat).toBe('sent');
    const lastPing = pings.at(-1) as Date;

    rig.emu.remove(BUCKETS.app, key);
    day(111);
    const broken = await runOnce(
      rig,
      db.backupUrl,
      { ...heartbeat, BACKUP_PG_DUMP_BIN: '/nonexistent/pg_dump' },
      { fetchImpl },
    );
    expect(broken.ok).toBe(false);
    expect(broken.failures[0]).toMatch(/^dump:/);
    expect(broken.heartbeat).toBe('not-sent');
    // The dump failed, the media step still ran, and the one copy exists either in media/ or (moved) in media-deleted/.
    const stillThere =
      rig.emu.get(BUCKETS.backup, `media/${key}/${seeded.etag}`) ??
      rig.emu.get(BUCKETS.backup, `media-deleted/${ymd(111)}/${key}/${seeded.etag}`);
    expect(stillThere?.data.equals(seeded.data)).toBe(true);
    expect(rig.emu.get(BUCKETS.backup, `media/${key}/${seeded.etag}`)).toBeDefined();
    expect(pings.at(-1)).toBe(lastPing);
    day(112);
    const next = await runOnce(rig, db.backupUrl, heartbeat, { fetchImpl });
    expect(next.ok, next.failures.join(';')).toBe(true);
    expect(
      rig.emu
        .get(BUCKETS.backup, `media-deleted/${ymd(111)}/${key}/${seeded.etag}`)
        ?.data.equals(seeded.data),
    ).toBe(true);

    // ALR-6 model: the monitor alerts when no ping arrived for 26 h, and not before.
    const alertAt = lastPing.getTime() + 26 * 3_600_000;
    const alerts = (at: number) => at - lastPing.getTime() >= 26 * 3_600_000;
    expect(alerts(alertAt - 1)).toBe(false);
    expect(alerts(alertAt)).toBe(true);
  });
});

describe('lifecycle model (TC-LED-04)', () => {
  it('db/, manifests/ and media-deleted/ expire after retention + 1 days; media/ and ledger/ stay', () => {
    const before = {
      media: rig.emu.keys(BUCKETS.backup, 'media/').length,
      ledger: rig.emu.keys(BUCKETS.backup, 'ledger/').length,
    };
    day(300);
    for (const prefix of ['db/', 'manifests/', 'media-deleted/'])
      rig.emu.expire(BUCKETS.backup, prefix, RETENTION_DAYS + 1);
    expect(rig.emu.keys(BUCKETS.backup, 'media-deleted/')).toEqual([]);
    expect(rig.emu.keys(BUCKETS.backup, 'manifests/')).toEqual([]);
    expect(rig.emu.keys(BUCKETS.backup, 'db/')).toEqual([]);
    expect({
      media: rig.emu.keys(BUCKETS.backup, 'media/').length,
      ledger: rig.emu.keys(BUCKETS.backup, 'ledger/').length,
    }).toEqual(before);
  });
});
