import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// A small S3 emulator for what R2 can be asked here and a local MinIO cannot express: tokens scoped to buckets with a
// read-only or read-write level (SB v6 7.1 C), lock rules (age and indefinite, by prefix) that refuse deletes and
// overwrites, `If-None-Match: *` on put, server-side copy that counts as a new upload, a lifecycle model, an injectable
// clock and fault hooks. It speaks the subset of the S3 wire protocol the service uses; signatures are not checked.

export interface StoredObject {
  data: Buffer;
  etag: string;
  lastModified: Date;
}

export interface LockRule {
  prefix: string;
  /** Age in days since upload, or `indefinite`. */
  retention: number | 'indefinite';
}

export interface Token {
  buckets: readonly string[];
  write: boolean;
}

export interface RequestRecord {
  method: string;
  bucket: string;
  key: string;
  accessKey: string;
  status: number;
  copySource?: string;
  conditional?: boolean;
}

export interface Faults {
  /** Change the bytes a server-side copy produces (a damaged copy). */
  corruptCopy?: (destinationKey: string, data: Buffer) => Buffer;
  /** Make HEAD answer 404 for a key. */
  hideHead?: (bucket: string, key: string) => boolean;
  /** Make GET fail with 503. */
  failGet?: (bucket: string, key: string) => boolean;
}

const md5 = (data: Buffer): string => createHash('md5').update(data).digest('hex');
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class S3Emulator {
  readonly buckets = new Map<string, Map<string, StoredObject>>();
  readonly tokens = new Map<string, Token>();
  readonly locks = new Map<string, LockRule[]>();
  readonly requests: RequestRecord[] = [];
  faults: Faults = {};
  now: () => Date = () => new Date();
  endpoint = '';
  private server: Server | null = null;

  createBucket(name: string): Map<string, StoredObject> {
    const bucket = new Map<string, StoredObject>();
    this.buckets.set(name, bucket);
    return bucket;
  }

  /** Test-side write that bypasses tokens and locks (the application writing to `app`, the worker to the ledger). */
  seed(bucket: string, key: string, data: Buffer | string, at?: Date): StoredObject {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const object = { data: buf, etag: md5(buf), lastModified: at ?? this.now() };
    this.must(bucket).set(key, object);
    return object;
  }

  remove(bucket: string, key: string): void {
    this.must(bucket).delete(key);
  }

  get(bucket: string, key: string): StoredObject | undefined {
    return this.must(bucket).get(key);
  }

  keys(bucket: string, prefix = ''): string[] {
    return [...this.must(bucket).keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  /** Lifecycle model: expire objects under `prefix` older than `days` (Admin-configured, never the service). */
  expire(bucket: string, prefix: string, days: number): string[] {
    const gone: string[] = [];
    for (const [key, object] of this.must(bucket)) {
      if (
        key.startsWith(prefix) &&
        this.now().getTime() - object.lastModified.getTime() > days * 86_400_000
      ) {
        this.must(bucket).delete(key);
        gone.push(key);
      }
    }
    return gone;
  }

  private must(bucket: string): Map<string, StoredObject> {
    const found = this.buckets.get(bucket);
    if (found === undefined) throw new Error(`no bucket ${bucket}`);
    return found;
  }

  private protectedBy(bucket: string, key: string, object: StoredObject): boolean {
    for (const rule of this.locks.get(bucket) ?? []) {
      if (!key.startsWith(rule.prefix)) continue;
      if (rule.retention === 'indefinite') return true;
      if (this.now().getTime() - object.lastModified.getTime() < rule.retention * 86_400_000)
        return true;
    }
    return false;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error: Error) => {
        res
          .writeHead(500)
          .end(`<Error><Code>InternalError</Code><Message>${esc(error.message)}</Message></Error>`);
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.endpoint = `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://emulator');
    const [, bucket = '', ...rest] = url.pathname.split('/');
    const key = rest.map(decodeURIComponent).join('/');
    const method = req.method ?? 'GET';
    const accessKey =
      /Credential=([^/]+)\//.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
    const record: RequestRecord = { method, bucket, key, accessKey, status: 0 };
    const copySource = req.headers['x-amz-copy-source'];
    if (typeof copySource === 'string') record.copySource = decodeURIComponent(copySource);
    if (req.headers['if-none-match'] === '*') record.conditional = true;
    const reply = (
      status: number,
      body = '',
      headers: Record<string, string | number> = {},
    ): void => {
      record.status = status;
      this.requests.push(record);
      res.writeHead(status, { 'content-type': 'application/xml', ...headers });
      res.end(method === 'HEAD' ? undefined : body);
    };
    const fail = (status: number, code: string): void =>
      reply(
        status,
        `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
      );

    const body = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

    const token = this.tokens.get(accessKey);
    if (token === undefined) return fail(403, 'InvalidAccessKeyId');
    const isRead = method === 'GET' || method === 'HEAD';
    if (!token.buckets.includes(bucket)) return fail(403, 'AccessDenied');
    if (!isRead && !token.write) return fail(403, 'AccessDenied');
    const store = this.buckets.get(bucket);
    if (store === undefined) return fail(404, 'NoSuchBucket');

    if (method === 'GET' && key === '') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const after = url.searchParams.get('continuation-token') ?? '';
      const all = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix) && k > after)
        .sort(([a], [b]) => (a < b ? -1 : 1));
      const page = all.slice(0, 2);
      const truncated = all.length > page.length;
      const items = page
        .map(
          ([k, o]) =>
            `<Contents><Key>${esc(k)}</Key><LastModified>${o.lastModified.toISOString()}</LastModified><ETag>"${o.etag}"</ETag><Size>${o.data.length}</Size></Contents>`,
        )
        .join('');
      const next = truncated
        ? `<NextContinuationToken>${esc(page.at(-1)?.[0] ?? '')}</NextContinuationToken>`
        : '';
      return reply(
        200,
        `<?xml version="1.0"?><ListBucketResult><Name>${bucket}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${items}${next}</ListBucketResult>`,
      );
    }

    const existing = store.get(key);
    if (method === 'HEAD' || method === 'GET') {
      if (method === 'GET' && this.faults.failGet?.(bucket, key) === true)
        return fail(503, 'ServiceUnavailable');
      if (
        existing === undefined ||
        (method === 'HEAD' && this.faults.hideHead?.(bucket, key) === true)
      ) {
        return fail(404, method === 'HEAD' ? 'NotFound' : 'NoSuchKey');
      }
      const headers = {
        etag: `"${existing.etag}"`,
        'last-modified': existing.lastModified.toUTCString(),
        'content-length': existing.data.length,
      };
      record.status = 200;
      this.requests.push(record);
      res.writeHead(200, { ...headers, 'content-type': 'application/octet-stream' });
      return void res.end(method === 'HEAD' ? undefined : existing.data);
    }

    if (method === 'DELETE') {
      if (existing !== undefined && this.protectedBy(bucket, key, existing))
        return fail(403, 'AccessDenied');
      store.delete(key);
      return reply(204);
    }

    if (method === 'PUT') {
      if (req.headers['if-none-match'] === '*' && existing !== undefined)
        return fail(412, 'PreconditionFailed');
      if (existing !== undefined && this.protectedBy(bucket, key, existing))
        return fail(403, 'AccessDenied');
      let data = body;
      if (typeof copySource === 'string') {
        const [srcBucket = '', ...srcKey] = decodeURIComponent(copySource)
          .replace(/^\//, '')
          .split('/');
        const source = this.buckets.get(srcBucket)?.get(srcKey.join('/'));
        if (source === undefined || !token.buckets.includes(srcBucket))
          return fail(404, 'NoSuchKey');
        data = this.faults.corruptCopy?.(key, source.data) ?? source.data;
      }
      const object = { data, etag: md5(data), lastModified: this.now() };
      store.set(key, object);
      const result =
        typeof copySource === 'string'
          ? `<?xml version="1.0"?><CopyObjectResult><ETag>"${object.etag}"</ETag><LastModified>${object.lastModified.toISOString()}</LastModified></CopyObjectResult>`
          : '';
      return reply(200, result, { etag: `"${object.etag}"` });
    }
    return fail(405, 'MethodNotAllowed');
  }
}
