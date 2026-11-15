import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  CreateBucketCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMinio, type MinioHandle } from './minio.ts';

// StoragePort behaviours (ARCHITECTURE §1.3, §9.3) against a real MinIO server on this host.
// R2 itself is a deployment-time owner item and is recorded NOT_RUN in the stack-validation document.

const BUCKET = 'app';
let minio: MinioHandle;
let s3: S3Client;

beforeAll(async () => {
  minio = await startMinio();
  s3 = new S3Client({
    region: 'auto',
    endpoint: minio.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: minio.accessKey, secretAccessKey: minio.secretKey },
  });
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  console.log(`MinIO ${minio.version}`);
});
afterAll(async () => {
  s3?.destroy();
  await minio?.stop();
});

const put = (key: string, body: string, extra: Record<string, unknown> = {}) =>
  s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: 'image/png',
      ...extra,
    }),
  );

describe('storage slice on MinIO', () => {
  it('conditional put: If-None-Match * creates once, then refuses with 412', async () => {
    await put('q/owner1/m1', 'first', { IfNoneMatch: '*' });
    await expect(put('q/owner1/m1', 'second', { IfNoneMatch: '*' })).rejects.toMatchObject({
      $metadata: { httpStatusCode: 412 },
      name: 'PreconditionFailed',
    });
    const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'q/owner1/m1' }));
    expect(await got.Body?.transformToString()).toBe('first');
  });

  it('concurrent conditional puts on one key: exactly one wins', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        put('q/owner1/race', `writer-${i}`, { IfNoneMatch: '*' }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(5);
  });

  it('presigned GET carries response-content-disposition and works without credentials', async () => {
    await put('u/owner1/c/camp1/video/v1.mp4', 'video-bytes');
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: 'u/owner1/c/camp1/video/v1.mp4',
        ResponseContentDisposition: 'attachment; filename="ad.mp4"',
        ResponseContentType: 'video/mp4',
      }),
      { expiresIn: 60 },
    );
    expect(url).toContain('response-content-disposition=');
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="ad.mp4"');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(await res.text()).toBe('video-bytes');
    // tampering with the signed disposition invalidates the signature
    const tampered = url.replace('attachment', 'inline');
    expect((await fetch(tampered)).status).toBe(403);
  });

  it('presigned GET expires', async () => {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: 'q/owner1/m1' }),
      { expiresIn: 1 },
    );
    expect((await fetch(url)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 2500));
    expect((await fetch(url)).status).toBe(403);
  });

  it('prefix delete removes every object under the prefix in batches and nothing else', async () => {
    for (let i = 0; i < 25; i++) await put(`u/owner2/media/${i}`, `m${i}`);
    await put('u/owner20/media/keep', 'sibling-prefix-must-survive');
    await put('u/owner1/c/camp1/video/v1.mp4', 'other-owner');

    let token: string | undefined;
    let deleted = 0;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: 'u/owner2/',
          MaxKeys: 10,
          ContinuationToken: token,
        }),
      );
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key as string }));
      if (keys.length) {
        const out = await s3.send(
          new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys } }),
        );
        expect(out.Errors ?? []).toHaveLength(0);
        deleted += keys.length;
      }
      token = page.NextContinuationToken;
    } while (token);
    // the delete above ran while paging; a second sweep finds nothing left
    const rest = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'u/owner2/' }));
    expect(deleted).toBeGreaterThanOrEqual(10);
    expect(rest.KeyCount).toBe(0);
    await expect(
      s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'u/owner20/media/keep' })),
    ).resolves.toBeTruthy();
    await expect(
      s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'u/owner1/c/camp1/video/v1.mp4' })),
    ).resolves.toBeTruthy();
  });

  it('missing key and missing credentials map to typed failures', async () => {
    await expect(
      s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'nope' })),
    ).rejects.toMatchObject({ name: 'NoSuchKey' });
    const bad = new S3Client({
      region: 'auto',
      endpoint: minio.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: minio.accessKey, secretAccessKey: 'wrong' },
    });
    await expect(bad.send(new ListObjectsV2Command({ Bucket: BUCKET }))).rejects.toMatchObject({
      $metadata: { httpStatusCode: 403 },
    });
    bad.destroy();
  });
});
