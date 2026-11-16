import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeClient } from '../src/store.ts';
import { blockingFindings, verifyLocks } from '../src/verify-locks.ts';
import { BUCKETS, RETENTION_DAYS, TOKENS, makeRig } from './support/fixture.ts';
import type { Rig } from './support/fixture.ts';
import { S3Emulator } from './support/s3-emulator.ts';

// TC-BKP-14, 15, 16, 25 on the emulator, which models R2's token scopes and lock rules (SB v6 7.1 C). Whether the real
// R2 account enforces them is TC-H-15, which the owner's test account answers with `verify-locks.ts`.

let rig: Rig;
let source: S3Client;
let sink: S3Client;
let api: S3Client;
let ledgerWriter: S3Client;

const client = (t: { id: string; secret: string }) =>
  makeClient(rig.emu.endpoint, 'auto', { accessKeyId: t.id, secretAccessKey: t.secret });
const status = async (p: Promise<unknown>): Promise<number> => {
  try {
    await p;
    return 200;
  } catch (e) {
    return (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0;
  }
};
const put = (c: S3Client, bucket: string, key: string, body = 'x', conditional = true) =>
  c.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Buffer.from(body),
      ContentLength: body.length,
      ...(conditional ? { IfNoneMatch: '*' } : {}),
    }),
  );

beforeAll(async () => {
  rig = await makeRig();
  source = client(TOKENS.source);
  sink = client(TOKENS.sink);
  api = client(TOKENS.api);
  ledgerWriter = client(TOKENS.ledgerWriter);
  rig.emu.seed(BUCKETS.app, 'u/o/media/1', 'live');
  rig.emu.seed(BUCKETS.ledger, '202611/a.json', '{}');
});
afterAll(() => rig.dispose());

describe('two scoped tokens (TC-BKP-14)', () => {
  it('source token: read on app and erasure-ledger only; every write, delete and overwrite refused; backup unreachable', async () => {
    const read = await source.send(
      new GetObjectCommand({ Bucket: BUCKETS.app, Key: 'u/o/media/1' }),
    );
    expect(await read.Body?.transformToString()).toBe('live');
    expect(await status(source.send(new ListObjectsV2Command({ Bucket: BUCKETS.ledger })))).toBe(
      200,
    );
    for (const bucket of [BUCKETS.app, BUCKETS.ledger]) {
      expect(await status(put(source, bucket, 'new-key'))).toBe(403);
      expect(
        await status(
          put(source, bucket, bucket === BUCKETS.app ? 'u/o/media/1' : '202611/a.json', 'y', false),
        ),
      ).toBe(403);
      expect(
        await status(
          source.send(
            new DeleteObjectCommand({
              Bucket: bucket,
              Key: bucket === BUCKETS.app ? 'u/o/media/1' : '202611/a.json',
            }),
          ),
        ),
      ).toBe(403);
    }
    expect(rig.emu.get(BUCKETS.app, 'u/o/media/1')?.data.toString()).toBe('live');
    for (const run of [
      () => source.send(new ListObjectsV2Command({ Bucket: BUCKETS.backup })),
      () => source.send(new HeadObjectCommand({ Bucket: BUCKETS.backup, Key: 'db/x' })),
      () => put(source, BUCKETS.backup, 'db/x'),
    ])
      expect(await status(run())).toBe(403);
  });

  it('sink token: backup only; everything on app and erasure-ledger refused', async () => {
    expect(await status(put(sink, BUCKETS.backup, 'db/2026-11-15/a.dump.age'))).toBe(200);
    for (const bucket of [BUCKETS.app, BUCKETS.ledger]) {
      expect(await status(sink.send(new ListObjectsV2Command({ Bucket: bucket })))).toBe(403);
      expect(
        await status(sink.send(new GetObjectCommand({ Bucket: bucket, Key: 'u/o/media/1' }))),
      ).toBe(403);
      expect(await status(put(sink, bucket, 'anything'))).toBe(403);
      expect(
        await status(sink.send(new DeleteObjectCommand({ Bucket: bucket, Key: 'u/o/media/1' }))),
      ).toBe(403);
    }
  });
});

describe('bucket lock rules and conditional put (TC-BKP-15, TC-BKP-16)', () => {
  it('fresh db/ and media/ objects cannot be deleted or overwritten with the sink token', async () => {
    for (const key of [
      'db/2026-11-15/b.dump.age',
      'media/u/o/media/1/abc',
      'manifests/2026-11-15.json',
      'media-deleted/2026-11-15/u/o/media/1/abc',
    ]) {
      expect(await status(put(sink, BUCKETS.backup, key, 'first'))).toBe(200);
      expect(await status(put(sink, BUCKETS.backup, key, 'second'))).toBe(412); // conditional put: nothing created or replaced
      expect(await status(put(sink, BUCKETS.backup, key, 'second', false))).toBe(403); // the lock refuses a plain overwrite
      expect(
        await status(sink.send(new DeleteObjectCommand({ Bucket: BUCKETS.backup, Key: key }))),
      ).toBe(403);
      expect(rig.emu.get(BUCKETS.backup, key)?.data.toString()).toBe('first');
    }
  });

  it('an object older than BACKUP_RETENTION_DAYS can be deleted (the residual), a ledger/ object never', async () => {
    await put(sink, BUCKETS.backup, 'ledger/202611/a.json', 'ledger');
    await put(sink, BUCKETS.backup, 'db/old.dump.age', 'old');
    rig.clock.now = new Date(rig.clock.now.getTime() + (RETENTION_DAYS + 1) * 86_400_000);
    expect(
      await status(
        sink.send(new DeleteObjectCommand({ Bucket: BUCKETS.backup, Key: 'db/old.dump.age' })),
      ),
    ).toBe(200);
    for (const age of [0, 400, 4000]) {
      rig.clock.now = new Date(rig.clock.now.getTime() + age * 86_400_000);
      expect(
        await status(
          sink.send(
            new DeleteObjectCommand({ Bucket: BUCKETS.backup, Key: 'ledger/202611/a.json' }),
          ),
        ),
      ).toBe(403);
      expect(
        await status(put(sink, BUCKETS.backup, 'ledger/202611/a.json', 'rewritten', false)),
      ).toBe(403);
    }
    expect(rig.emu.get(BUCKETS.backup, 'ledger/202611/a.json')?.data.toString()).toBe('ledger');
  });
});

describe('erasure ledger is write-once and private to token C (TC-BKP-25)', () => {
  it('a second write is refused, token C writes and reads, token A has no access', async () => {
    expect(await status(put(ledgerWriter, BUCKETS.ledger, '202611/b.json', 'one'))).toBe(200);
    expect(await status(put(ledgerWriter, BUCKETS.ledger, '202611/b.json', 'two'))).toBe(412);
    expect(await status(put(ledgerWriter, BUCKETS.ledger, '202611/b.json', 'two', false))).toBe(
      403,
    );
    expect(
      await status(
        ledgerWriter.send(
          new DeleteObjectCommand({ Bucket: BUCKETS.ledger, Key: '202611/b.json' }),
        ),
      ),
    ).toBe(403);
    expect(
      await (
        await ledgerWriter.send(
          new GetObjectCommand({ Bucket: BUCKETS.ledger, Key: '202611/b.json' }),
        )
      ).Body?.transformToString(),
    ).toBe('one');
    for (const run of [
      () => api.send(new GetObjectCommand({ Bucket: BUCKETS.ledger, Key: '202611/b.json' })),
      () => put(api, BUCKETS.ledger, '202611/c.json'),
      () => api.send(new ListObjectsV2Command({ Bucket: BUCKETS.ledger })),
    ])
      expect(await status(run())).toBe(403);
  });
});

describe('lock verification for the owner (DO-07, TC-H-15)', () => {
  it('passes against a bucket with lock rules and raises blocking findings against one without', async () => {
    const good = await verifyLocks({
      endpoint: rig.emu.endpoint,
      bucket: BUCKETS.backup,
      accessKeyId: TOKENS.sink.id,
      secretAccessKey: TOKENS.sink.secret,
    });
    expect(blockingFindings(good)).toEqual([]);
    expect(good.length).toBe(9);

    const bare = new S3Emulator();
    bare.createBucket(BUCKETS.backup);
    bare.tokens.set(TOKENS.sink.id, { buckets: [BUCKETS.backup], write: true });
    await bare.start();
    try {
      const bad = await verifyLocks({
        endpoint: bare.endpoint,
        bucket: BUCKETS.backup,
        accessKeyId: TOKENS.sink.id,
        secretAccessKey: TOKENS.sink.secret,
      });
      const blocking = blockingFindings(bad);
      expect(blocking.length).toBeGreaterThanOrEqual(6);
      expect(blocking[0]).toMatch(/^BLOCKING \(DO-07\).*bucket lock is not in force/);
    } finally {
      await bare.stop();
    }
  });
});
