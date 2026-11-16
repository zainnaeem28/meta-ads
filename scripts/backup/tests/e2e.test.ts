import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMinio } from '../../../tools/foundation-tests/media/minio.ts';
import type { MinioHandle } from '../../../tools/foundation-tests/media/minio.ts';
import { makeDb } from './support/db.ts';
import type { BackupDb } from './support/db.ts';
import { BUCKETS, makeRig, pgDumpBin } from './support/fixture.ts';
import type { Rig } from './support/fixture.ts';
import { runMain } from './support/run.ts';

// The real entry point (`node src/main.ts`, the command of the backup image) end to end: a real MinIO, the shared test
// PostgreSQL with M0001 applied by the real migration CLI, real pg_dump and real age. Writes the run's output to
// EVIDENCE_FILE (docs/evidence/TASK-011/backup-run.txt) when that variable is set.

let minio: MinioHandle;
let rig: Rig;
let db: BackupDb;
let s3: S3Client;
const out: string[] = [];
const say = (line: string) => out.push(line);

beforeAll(async () => {
  minio = await startMinio();
  rig = await makeRig();
  db = await makeDb();
  s3 = new S3Client({
    endpoint: minio.endpoint,
    region: 'auto',
    forcePathStyle: true,
    credentials: { accessKeyId: minio.accessKey, secretAccessKey: minio.secretKey },
  });
  for (const Bucket of Object.values(BUCKETS)) await s3.send(new CreateBucketCommand({ Bucket }));
});
afterAll(async () => {
  const file = process.env['EVIDENCE_FILE'];
  if (file) writeFileSync(file, `${out.join('\n')}\n`);
  await db.dispose();
  await rig.dispose();
  await minio.stop();
});

const put = (Bucket: string, Key: string, body: Buffer | string) =>
  s3.send(
    new PutObjectCommand({
      Bucket,
      Key,
      Body: Buffer.from(body),
      ContentLength: Buffer.byteLength(body),
    }),
  );
const list = async (Bucket: string, Prefix = '') => {
  const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix }));
  return (r.Contents ?? []).map((c) => ({ key: c.Key as string, size: c.Size ?? 0 }));
};

const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...rig.env(db.backupUrl, {
    R2_ENDPOINT: minio.endpoint,
    R2_BACKUP_SOURCE_ACCESS_KEY_ID: minio.accessKey,
    R2_BACKUP_SOURCE_SECRET_ACCESS_KEY: minio.secretKey,
    R2_BACKUP_SINK_ACCESS_KEY_ID: minio.accessKey,
    R2_BACKUP_SINK_SECRET_ACCESS_KEY: minio.secretKey,
    BACKUP_ALLOW_SHARED_TOKEN: '1',
    BACKUP_SPOOL_DIR: rig.work,
    ...extra,
  }),
});

describe('the backup entry point against MinIO and the shared test PostgreSQL', () => {
  it('runs once end to end, then a second run performs the delayed delete', async () => {
    await put(BUCKETS.app, 'u/owner-1/media/clip-a.mp4', Buffer.alloc(200_000, 7));
    await put(
      BUCKETS.app,
      'u/owner-1/c/camp-1/thumbnail/t-1.jpg',
      Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3]),
    );
    await put(BUCKETS.app, 'u/owner-2/media/clip-b.mp4', Buffer.alloc(5_000, 9));
    await put(BUCKETS.app, 'q/owner-1/not-sanitized', 'quarantine');
    await put(BUCKETS.app, 'smoke/probe', 'smoke');
    await put(
      BUCKETS.ledger,
      '202611/01JTESTLEDGER0000000000000.json',
      JSON.stringify({
        subjectId: 'owner-9',
        erasedAt: '2026-11-15T01:00:00Z',
        counts: { media: 1 },
      }),
    );

    const resultFile = join(rig.work, 'run1.json');
    const first = await runMain({ ...env(), BACKUP_RESULT_FILE: resultFile });
    say('## run 1: node src/main.ts (the image command)');
    say(`exit status: ${String(first.status)}`);
    say(first.stdout.trim());
    expect(first.status, first.stderr + first.stdout).toBe(0);
    const r1 = JSON.parse(readFileSync(resultFile, 'utf8')) as {
      ok: boolean;
      dump: { key: string; bytes: number };
      media: Record<string, number>;
      ledger: Record<string, number>;
      durationMs: number;
    };
    expect(r1.ok).toBe(true);
    expect(r1.media).toMatchObject({ listed: 3, copied: 3, copyFailed: 0 });
    expect(r1.ledger).toMatchObject({ listed: 1, copied: 1 });

    const backupKeys = await list(BUCKETS.backup);
    say('\n## backup bucket after run 1 (key, bytes)');
    for (const o of backupKeys) say(`${o.key}  ${o.size}`);
    expect(
      backupKeys.filter((o) => o.key.startsWith('media/')).map((o) => o.key.split('/')[1]),
    ).toEqual(['u', 'u', 'u']);
    expect(backupKeys.some((o) => o.key.includes('q/owner-1') || o.key.includes('smoke/'))).toBe(
      false,
    );

    // The dump opens with the escrowed key and holds both schemas; this is the restore operator's side, not the service's.
    const dumpObject = await list(BUCKETS.backup, 'db/');
    expect(dumpObject.length).toBe(1);
    const downloaded = await (await import('@aws-sdk/client-s3')).GetObjectCommand;
    const body = await s3.send(
      new downloaded({ Bucket: BUCKETS.backup, Key: dumpObject[0]?.key as string }),
    );
    const encrypted = Buffer.from(
      await (body.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray(),
    );
    const plain = execFileSync(rig.ageBin, ['--decrypt', '--identity', rig.ageKey.identityFile], {
      input: encrypted,
      maxBuffer: 64 * 1024 * 1024,
    });
    const toc = execFileSync(pgDumpBin.replace(/pg_dump$/, 'pg_restore'), ['--list'], {
      input: plain,
      encoding: 'utf8',
    });
    expect(toc).toMatch(/TABLE public provider_keys/);
    expect(toc).toMatch(/TABLE pgboss job/);
    say(
      `\n## restore check: age --decrypt with the escrowed identity, pg_restore --list shows ${(toc.match(/TABLE /g) ?? []).length} tables (public and pgboss)`,
    );

    // A source is deleted; the next run copies it to media-deleted/, HEAD-confirms, and removes the old media/ copy.
    await s3.send(
      new DeleteObjectCommand({ Bucket: BUCKETS.app, Key: 'u/owner-2/media/clip-b.mp4' }),
    );
    await put(BUCKETS.app, 'u/owner-1/media/clip-c.mp4', Buffer.alloc(1_000, 3));
    const resultFile2 = join(rig.work, 'run2.json');
    const second = await runMain({ ...env(), BACKUP_RESULT_FILE: resultFile2 });
    say('\n## run 2 (a source was deleted, another added)');
    say(`exit status: ${String(second.status)}`);
    say(second.stdout.trim());
    expect(second.status, second.stderr + second.stdout).toBe(0);
    const r2 = JSON.parse(readFileSync(resultFile2, 'utf8')) as { media: Record<string, number> };
    expect(r2.media).toMatchObject({
      listed: 3,
      copied: 1,
      deletedDetected: 1,
      movedToDeleted: 1,
      oldCopiesRemoved: 1,
      moveFailed: 0,
    });
    const after = await list(BUCKETS.backup);
    say('\n## backup bucket after run 2 (key, bytes)');
    for (const o of after) say(`${o.key}  ${o.size}`);
    expect(after.filter((o) => o.key.startsWith('media-deleted/')).length).toBe(1);
    expect(after.some((o) => o.key.startsWith('media/u/owner-2/media/clip-b.mp4/'))).toBe(false);
    expect(after.filter((o) => o.key.startsWith('db/')).length).toBe(2);
    expect(after.filter((o) => o.key.startsWith('ledger/')).map((o) => o.key)).toEqual([
      'ledger/202611/01JTESTLEDGER0000000000000.json',
    ]);
    say(
      `\n## summary: run 1 ${r1.durationMs} ms, dump ${r1.dump.bytes} bytes, media ${JSON.stringify(r1.media)}, ledger ${JSON.stringify(r1.ledger)}`,
    );
  });

  it('exits 1 with no heartbeat when the dump fails, and the media copy still ran', async () => {
    const r = await runMain({
      ...env({ BACKUP_PG_DUMP_BIN: '/nonexistent/pg_dump' }),
      BACKUP_RESULT_FILE: join(rig.work, 'run3.json'),
    });
    expect(r.status).toBe(1);
    const result = JSON.parse(readFileSync(join(rig.work, 'run3.json'), 'utf8')) as {
      failures: string[];
      media: Record<string, number> | null;
    };
    expect(result.failures[0]).toMatch(/^dump:/);
    expect(result.media).not.toBeNull();
  });
});
