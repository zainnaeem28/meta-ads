import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { CampaignErasureLedger } from '../application/campaign-deletion-ports.js';

export interface ErasureLedgerConfig {
  readonly endpoint: string;
  readonly bucket: string;
  /** Token C: write and read in the `erasure-ledger` bucket only (SB v5 §7.1). */
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

const R2_HOST = /\.r2\.cloudflarestorage\.com$/;

/**
 * The write-once erasure ledger (SEC-D §10.8): one object per run, put with `If-None-Match: *`. A second put of the same key
 * (a retried step) answers 412 and is success, because the ledger already holds the entry.
 */
export class S3ErasureLedger implements CampaignErasureLedger {
  private readonly client: S3Client;

  constructor(private readonly config: ErasureLedgerConfig) {
    const r2 = R2_HOST.test(new URL(config.endpoint).hostname);
    this.client = new S3Client({
      region: r2 ? 'auto' : 'us-east-1',
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
    });
  }

  async record(key: string, body: string): Promise<void> {
    const data = Buffer.from(body, 'utf8');
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: data,
          ContentLength: data.length,
          ContentType: 'application/json',
          IfNoneMatch: '*',
        }),
      );
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (status === 412 || (error as { name?: string }).name === 'PreconditionFailed') return;
      throw new Error('erasure ledger put failed', { cause: error });
    }
  }
}
