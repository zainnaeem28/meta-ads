import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Emulator } from './s3-emulator.ts';
import { ensureAge, generateAgeKey } from './tools.ts';
import type { AgeKey } from './tools.ts';

export const srcPackageDir = join(import.meta.dirname, '..', '..');
export const repoRoot = join(srcPackageDir, '..', '..');

export const BUCKETS = { app: 'app', ledger: 'erasure-ledger', backup: 'backup' } as const;
export const TOKENS = {
  source: { id: 'SOURCEKEY', secret: 'source-secret' },
  sink: { id: 'SINKKEY', secret: 'sink-secret' },
  api: { id: 'TOKENA', secret: 'a-secret' },
  worker: { id: 'TOKENB', secret: 'b-secret' },
  ledgerWriter: { id: 'TOKENC', secret: 'c-secret' },
} as const;

const clientRoot = process.env['PG_CLIENT_ROOT'];
export const pgDumpBin = clientRoot
  ? join(clientRoot, 'usr/lib/postgresql/17/bin/pg_dump')
  : 'pg_dump';
if (clientRoot) {
  process.env['LD_LIBRARY_PATH'] = [
    join(clientRoot, 'usr/lib/x86_64-linux-gnu'),
    process.env['LD_LIBRARY_PATH'],
  ]
    .filter(Boolean)
    .join(':');
}

export const RETENTION_DAYS = 30;

export interface Rig {
  emu: S3Emulator;
  work: string;
  agePath: string;
  ageKey: AgeKey;
  ageBin: string;
  clock: { now: Date };
  env: (databaseUrl: string, extra?: Record<string, string>) => Record<string, string>;
  dispose: () => Promise<void>;
}

/** The emulator with its three buckets, the two backup tokens, the lock rules of SB v6 7.1 C and an age key pair. */
export async function makeRig(): Promise<Rig> {
  const work = mkdtempSync(join(tmpdir(), 'backup-test-'));
  const { age, keygen } = await ensureAge();
  const ageKey = generateAgeKey(keygen, work);
  const clock = { now: new Date('2026-11-15T02:00:00Z') };
  const emu = new S3Emulator();
  emu.now = () => clock.now;
  for (const b of Object.values(BUCKETS)) emu.createBucket(b);
  emu.tokens.set(TOKENS.source.id, { buckets: [BUCKETS.app, BUCKETS.ledger], write: false });
  emu.tokens.set(TOKENS.sink.id, { buckets: [BUCKETS.backup], write: true });
  emu.tokens.set(TOKENS.api.id, { buckets: [BUCKETS.app], write: true });
  emu.tokens.set(TOKENS.worker.id, { buckets: [BUCKETS.app], write: true });
  emu.tokens.set(TOKENS.ledgerWriter.id, { buckets: [BUCKETS.ledger], write: true });
  emu.locks.set(BUCKETS.backup, [
    { prefix: 'ledger/', retention: 'indefinite' },
    { prefix: '', retention: RETENTION_DAYS },
  ]);
  emu.locks.set(BUCKETS.ledger, [{ prefix: '', retention: 'indefinite' }]);
  await emu.start();
  const env = (
    databaseUrl: string,
    extra: Record<string, string> = {},
  ): Record<string, string> => ({
    APP_ENV: 'test',
    BACKUP_DATABASE_URL: databaseUrl,
    R2_ENDPOINT: emu.endpoint,
    R2_BUCKET: BUCKETS.app,
    R2_LEDGER_BUCKET: BUCKETS.ledger,
    R2_BACKUP_BUCKET: BUCKETS.backup,
    R2_BACKUP_SOURCE_ACCESS_KEY_ID: TOKENS.source.id,
    R2_BACKUP_SOURCE_SECRET_ACCESS_KEY: TOKENS.source.secret,
    R2_BACKUP_SINK_ACCESS_KEY_ID: TOKENS.sink.id,
    R2_BACKUP_SINK_SECRET_ACCESS_KEY: TOKENS.sink.secret,
    BACKUP_AGE_RECIPIENT: ageKey.recipient,
    BACKUP_RETENTION_DAYS: String(RETENTION_DAYS),
    BACKUP_PG_DUMP_BIN: pgDumpBin,
    BACKUP_AGE_BIN: age,
    BACKUP_MIGRATION_WAIT_SECONDS: '0',
    BACKUP_MIGRATION_POLL_SECONDS: '1',
    ...extra,
  });
  return {
    emu,
    work,
    agePath: age,
    ageKey,
    ageBin: age,
    clock,
    env,
    dispose: async () => {
      await emu.stop();
      rmSync(work, { recursive: true, force: true });
    },
  };
}

/** Decrypt an encrypted dump with the escrowed identity (the test plays the restore operator). */
export function decryptDump(rig: Rig, encrypted: Buffer): Buffer {
  return execFileSync(rig.ageBin, ['--decrypt', '--identity', rig.ageKey.identityFile], {
    input: encrypted,
    maxBuffer: 256 * 1024 * 1024,
  });
}
