import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  StorageKeyExists,
  StorageNotFound,
  StorageTooLarge,
  StorageUnavailable,
} from '../domain/storage.js';
import type {
  ContentDisposition,
  ListPage,
  StoragePort,
  StoredObjectInfo,
} from '../domain/storage.js';

export interface S3StorageConfig {
  /** The account endpoint (R2) or the MinIO address, used for every call the process makes itself. */
  readonly endpoint: string;
  /** The origin presigned URLs point at (reachable by the browser or provider); the endpoint when absent. */
  readonly publicOrigin?: string | undefined;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** R2 accepts any region name and routes by account; `auto` is its documented value. MinIO ignores it. */
export type StorageFlavour = 'r2' | 'minio';

const MAX_KEYS_PER_DELETE = 1000;
const R2_HOST = /\.r2\.cloudflarestorage\.com$/;

export function flavourOf(endpoint: string): StorageFlavour {
  return R2_HOST.test(new URL(endpoint).hostname) ? 'r2' : 'minio';
}

function clientOf(config: S3StorageConfig, endpoint: string, flavour: StorageFlavour): S3Client {
  return new S3Client({
    region: flavour === 'r2' ? 'auto' : 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // R2 does not implement the SDK's default additional checksums; send them only where an operation requires them.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 3,
  });
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}

function nameOf(error: unknown): string {
  return (error as { name?: string }).name ?? '';
}

function isMissing(error: unknown): boolean {
  return nameOf(error) === 'NoSuchKey' || nameOf(error) === 'NotFound' || statusOf(error) === 404;
}

function dispositionHeader({ type, filename }: ContentDisposition): string {
  if (filename === undefined) return type;
  // RFC 6266: an ASCII fallback plus the percent-encoded UTF-8 name; quotes and control characters never pass.
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function collect(body: Readable | Buffer, maxBytes: number): Promise<Buffer> {
  if (Buffer.isBuffer(body)) {
    if (body.length > maxBytes) throw new StorageTooLarge(maxBytes);
    return body;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += piece.length;
      if (total > maxBytes) throw new StorageTooLarge(maxBytes);
      chunks.push(piece);
    }
  } catch (error) {
    body.destroy();
    throw error;
  }
  return Buffer.concat(chunks, total);
}

/**
 * StoragePort over the S3 API: Cloudflare R2 (AWS SDK v3, `region: auto`, account endpoint) and MinIO (local, CI)
 * differ only in the region name; everything else is the same wire protocol, so one class serves both and the
 * contract tests run it against MinIO.
 */
export class S3Storage implements StoragePort {
  readonly flavour: StorageFlavour;
  private readonly client: S3Client;
  /** Signs against the public origin; presigning makes no network call. */
  private readonly signer: S3Client;

  constructor(
    private readonly config: S3StorageConfig,
    flavour: StorageFlavour = flavourOf(config.endpoint),
  ) {
    this.flavour = flavour;
    this.client = clientOf(config, config.endpoint, flavour);
    this.signer = clientOf(config, config.publicOrigin ?? config.endpoint, flavour);
  }

  async put(
    key: string,
    body: Readable | Buffer,
    contentType: string,
    maxBytes: number,
  ): Promise<{ bytes: number }> {
    const data = await collect(body, maxBytes);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: data,
          ContentLength: data.length,
          ContentType: contentType,
          IfNoneMatch: '*',
        }),
      );
    } catch (error) {
      if (statusOf(error) === 412 || nameOf(error) === 'PreconditionFailed') throw new StorageKeyExists();
      throw new StorageUnavailable('put', { cause: error });
    }
    return { bytes: data.length };
  }

  async get(key: string): Promise<Readable> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
      if (out.Body === undefined) throw new StorageNotFound();
      return out.Body as Readable;
    } catch (error) {
      if (error instanceof StorageNotFound) throw error;
      if (isMissing(error)) throw new StorageNotFound();
      throw new StorageUnavailable('get', { cause: error });
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
    } catch (error) {
      if (isMissing(error)) return;
      throw new StorageUnavailable('delete', { cause: error });
    }
  }

  async deletePrefix(prefix: string, batch: number): Promise<number> {
    if (prefix === '') throw new TypeError('deletePrefix needs a non-empty prefix');
    const size = Math.min(Math.max(1, Math.trunc(batch)), MAX_KEYS_PER_DELETE);
    let deleted = 0;
    try {
      for (;;) {
        // Always the first page: what was just deleted is gone, so no cursor is carried between rounds.
        const page = await this.client.send(
          new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: prefix, MaxKeys: size }),
        );
        const keys = (page.Contents ?? []).flatMap((o) => (o.Key === undefined ? [] : [o.Key]));
        if (keys.length === 0) return deleted;
        const result = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.config.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        if ((result.Errors ?? []).length > 0) throw new Error('delete refused for some keys');
        deleted += keys.length;
      }
    } catch (error) {
      throw new StorageUnavailable('deletePrefix', { cause: error });
    }
  }

  async list(prefix: string, cursor?: string): Promise<ListPage> {
    try {
      const out = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          ...(cursor === undefined ? {} : { ContinuationToken: cursor }),
        }),
      );
      const objects: StoredObjectInfo[] = (out.Contents ?? []).flatMap((o) =>
        o.Key === undefined
          ? []
          : [{ key: o.Key, bytes: o.Size ?? 0, lastModified: o.LastModified ?? new Date(0) }],
      );
      return out.NextContinuationToken === undefined
        ? { objects }
        : { objects, nextCursor: out.NextContinuationToken };
    } catch (error) {
      throw new StorageUnavailable('list', { cause: error });
    }
  }

  async presignGet(key: string, ttlSec: number, disposition: ContentDisposition): Promise<string> {
    if (!Number.isInteger(ttlSec) || ttlSec < 1 || ttlSec > 604_800) {
      throw new RangeError('ttlSec must be an integer from 1 to 604800');
    }
    try {
      return await getSignedUrl(
        this.signer,
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          ResponseContentDisposition: dispositionHeader(disposition),
        }),
        { expiresIn: ttlSec },
      );
    } catch (error) {
      throw new StorageUnavailable('presign', { cause: error });
    }
  }
}

/** Cloudflare R2 (token A in the api, token B in the worker): region `auto`, the account endpoint. */
export class R2Storage extends S3Storage {
  constructor(config: S3StorageConfig) {
    super(config, 'r2');
  }
}

/** MinIO for local runs and CI. */
export class MinioStorage extends S3Storage {
  constructor(config: S3StorageConfig) {
    super(config, 'minio');
  }
}

/** The adapter for the configured endpoint: R2 for an account endpoint, MinIO otherwise. */
export function createStorage(config: S3StorageConfig): S3Storage {
  return flavourOf(config.endpoint) === 'r2' ? new R2Storage(config) : new MinioStorage(config);
}
