import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { S3Credentials } from './config.ts';

export interface ObjectInfo {
  key: string;
  /** The ETag without its quotes. */
  etag: string;
  size: number;
  lastModified: Date | null;
}

export type PutResult = 'created' | 'exists';

function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

function codeOf(error: unknown): string {
  const e = error as { name?: string; Code?: string };
  return e.Code ?? e.name ?? '';
}

/** The bucket's lock refused the request (R2 answers 403 for a delete inside a lock). */
export function isLocked(error: unknown): boolean {
  return statusOf(error) === 403 || codeOf(error) === 'AccessDenied';
}

export const unquote = (etag: string | undefined): string => (etag ?? '').replace(/^"|"$/g, '');

export function makeClient(endpoint: string, region: string, credentials: S3Credentials): S3Client {
  return new S3Client({
    endpoint,
    region,
    credentials,
    forcePathStyle: true,
    // R2 and MinIO both reject or ignore the optional checksum trailers newer SDKs add on their own.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 4,
  });
}

/** One bucket seen through one token. The methods are the only S3 calls the service ever makes. */
export class Store {
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(client: S3Client, bucket: string) {
    this.client = client;
    this.bucket = bucket;
  }

  async *list(prefix: string): AsyncGenerator<ObjectInfo> {
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const item of page.Contents ?? []) {
        if (item.Key === undefined) continue;
        yield {
          key: item.Key,
          etag: unquote(item.ETag),
          size: item.Size ?? 0,
          lastModified: item.LastModified ?? null,
        };
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        key,
        etag: unquote(r.ETag),
        size: r.ContentLength ?? 0,
        lastModified: r.LastModified ?? null,
      };
    } catch (error) {
      if (statusOf(error) === 404 || codeOf(error) === 'NotFound') return null;
      throw error;
    }
  }

  /** A source object read as a stream, or null when it is gone. */
  async get(key: string): Promise<{ body: Readable; etag: string; size: number } | null> {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return { body: r.Body as Readable, etag: unquote(r.ETag), size: r.ContentLength ?? 0 };
    } catch (error) {
      if (statusOf(error) === 404 || codeOf(error) === 'NoSuchKey') return null;
      throw error;
    }
  }

  async getText(key: string): Promise<string | null> {
    const r = await this.get(key);
    if (r === null) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of r.body) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks).toString('utf8');
  }

  /** Every write is a new key with a conditional put (`If-None-Match: *`); an existing key is never replaced. */
  async putNew(
    key: string,
    file: string,
    size: number,
    contentType = 'application/octet-stream',
  ): Promise<PutResult> {
    return this.putBody(key, createReadStream(file), size, contentType);
  }

  async putNewBuffer(key: string, data: Buffer, contentType: string): Promise<PutResult> {
    return this.putBody(key, data, data.length, contentType);
  }

  private async putBody(
    key: string,
    body: Readable | Buffer,
    size: number,
    contentType: string,
  ): Promise<PutResult> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: size,
          ContentType: contentType,
          IfNoneMatch: '*',
        }),
      );
      return 'created';
    } catch (error) {
      if (statusOf(error) === 412 || codeOf(error) === 'PreconditionFailed') return 'exists';
      throw error;
    }
  }

  /** Server-side copy inside this bucket; the destination is a new upload, so its lock clock starts now. */
  async copyWithin(sourceKey: string, destinationKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destinationKey,
        CopySource: `${this.bucket}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`,
        MetadataDirective: 'COPY',
      }),
    );
  }

  /**
   * The service's only delete: the `media/` copy of a source object, after the `media-deleted/` copy was confirmed.
   * The prefix guard makes any other delete a programming error.
   */
  async deleteMediaCopy(key: string): Promise<void> {
    if (!key.startsWith('media/')) throw new Error(`refusing to delete outside media/: ${key}`);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
