import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';

// Test-only: a throwaway MinIO server (random ports, its own data folder and credentials) with one private bucket.
// The server start-up and the checksum-verified binary download are the foundation tests' (`tools/foundation-tests/media`),
// loaded at run time so the product tree never imports from `tools/`.

interface MinioHandle {
  readonly endpoint: string;
  readonly accessKey: string;
  readonly secretKey: string;
  stop(): Promise<void>;
}

export interface TestBucket extends MinioHandle {
  readonly bucket: string;
}

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..', '..');

export async function startTestBucket(bucket = 'app'): Promise<TestBucket> {
  const url = pathToFileURL(join(REPO_ROOT, 'tools', 'foundation-tests', 'media', 'minio.ts')).href;
  const { startMinio } = (await import(/* @vite-ignore */ url)) as { startMinio(): Promise<MinioHandle> };
  const minio = await startMinio();
  const admin = new S3Client({
    region: 'us-east-1',
    endpoint: minio.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: minio.accessKey, secretAccessKey: minio.secretKey },
  });
  await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  admin.destroy();
  return { ...minio, bucket };
}
