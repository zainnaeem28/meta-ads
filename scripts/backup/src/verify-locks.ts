import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { makeClient } from './store.ts';
import { ulid } from './util.ts';

// DO-07 verification of the backup bucket's lock rules (SB v6 7.1 C, TC-H-15). The service never sets or changes a lock:
// the owner's Admin credential does, at provisioning. This check, run once per environment against the sink token,
// proves the rules are in force. If a probe object can be deleted or overwritten inside its lock, the host offers no
// usable lock and the result is a BLOCKING finding for Cybersecurity (through the Orchestrator), never an accepted
// state. Each probe object is small, stays under its lock until it expires, and is named `<prefix>_lockprobe/<ulid>`.

export interface LockFinding {
  prefix: string;
  check: string;
  holds: boolean;
  detail: string;
}

export interface VerifyOptions {
  endpoint: string;
  region?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Prefixes the rules cover: `ledger/` (indefinite) and `db/` (whole-bucket age rule). */
  prefixes?: readonly string[];
}

const statusOf = (e: unknown): number | undefined =>
  (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

export async function verifyLocks(options: VerifyOptions): Promise<LockFinding[]> {
  const client = makeClient(options.endpoint, options.region ?? 'auto', {
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
  });
  const findings: LockFinding[] = [];
  for (const prefix of options.prefixes ?? ['ledger/', 'db/', 'media/']) {
    const key = `${prefix}_lockprobe/${ulid(new Date())}`;
    const put = (conditional: boolean) =>
      client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: key,
          Body: Buffer.from('lock probe'),
          ContentLength: 10,
          ...(conditional ? { IfNoneMatch: '*' } : {}),
        }),
      );
    await put(true);
    const outcome = async (
      check: string,
      run: () => Promise<unknown>,
      refused: (s: number | undefined) => boolean,
    ) => {
      try {
        await run();
        findings.push({
          prefix,
          check,
          holds: false,
          detail: 'the request succeeded inside the lock',
        });
      } catch (error) {
        const status = statusOf(error);
        findings.push({
          prefix,
          check,
          holds: refused(status),
          detail: `refused with HTTP ${String(status)}`,
        });
      }
    };
    await outcome(
      'conditional put on an existing key',
      () => put(true),
      (s) => s === 412 || s === 403,
    );
    await outcome(
      'overwrite with a plain put',
      () => put(false),
      (s) => s === 403,
    );
    await outcome(
      'delete',
      () => client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key })),
      (s) => s === 403,
    );
  }
  return findings;
}

export function blockingFindings(findings: readonly LockFinding[]): string[] {
  return findings
    .filter((f) => !f.holds)
    .map(
      (f) =>
        `BLOCKING (DO-07): ${f.check} under ${f.prefix} is not refused (${f.detail}); the bucket lock is not in force`,
    );
}

if (import.meta.main) {
  const env = process.env;
  const need = (n: string) =>
    env[n] ??
    (() => {
      throw new Error(`${n} is required`);
    })();
  if (env['APP_ENV'] === 'production')
    throw new Error(
      'refusing to leave probe objects in a production bucket; run against the environment test bucket',
    );
  const findings = await verifyLocks({
    endpoint: need('R2_ENDPOINT'),
    bucket: need('R2_BACKUP_BUCKET'),
    accessKeyId: need('R2_BACKUP_SINK_ACCESS_KEY_ID'),
    secretAccessKey: need('R2_BACKUP_SINK_SECRET_ACCESS_KEY'),
  });
  for (const f of findings)
    process.stdout.write(`${f.holds ? 'ok  ' : 'FAIL'} ${f.prefix} ${f.check}: ${f.detail}\n`);
  const blocking = blockingFindings(findings);
  for (const b of blocking) process.stderr.write(`${b}\n`);
  process.exit(blocking.length === 0 ? 0 : 3);
}
