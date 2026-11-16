import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { once } from 'node:events';
import type { BackupConfig } from './config.ts';

/** The exact `pg_dump` arguments. Row security stays off, pg_dump's default: the row-security option must never be added (SB 7.1 E, TC-BKP-09). */
export const PG_DUMP_ARGS: readonly string[] = [
  '--format=custom',
  '--schema=public',
  '--schema=pgboss',
  '--no-password',
  '--lock-wait-timeout=60s',
  '--no-sync',
];

/** Connection parameters as libpq variables, so the password never appears in a process list or a log line. */
export function libpqEnv(databaseUrl: string): Record<string, string> {
  const url = new URL(databaseUrl);
  const env: Record<string, string> = {
    PGHOST: decodeURIComponent(url.hostname),
    PGPORT: url.port === '' ? '5432' : url.port,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode !== null) env['PGSSLMODE'] = sslmode;
  return env;
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const passthrough = ['PATH', 'LD_LIBRARY_PATH', 'HOME', 'TMPDIR', 'LANG'];
  const env: NodeJS.ProcessEnv = {};
  for (const name of passthrough)
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...extra };
}

export interface DumpResult {
  file: string;
  bytes: number;
}

/**
 * One `pg_dump` (custom format, one connection, no `-j`) piped straight into `age` for the public recipient, written to
 * `file`. The plaintext dump never touches disk. A non-zero exit from either side fails the run and names the
 * program with its stderr (which names the table when row security or a missing grant stops the dump).
 */
export async function dumpEncrypted(config: BackupConfig, file: string): Promise<DumpResult> {
  const dump = spawn(config.pgDumpBin, [...PG_DUMP_ARGS], {
    env: childEnv(libpqEnv(config.databaseUrl)),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const age = spawn(config.ageBin, ['--recipient', config.ageRecipient], {
    env: childEnv({}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out = createWriteStream(file, { mode: 0o600 });
  dump.stdout.pipe(age.stdin);
  age.stdout.pipe(out);
  const stderr = { dump: '', age: '' };
  dump.stderr.on('data', (d: Buffer) => (stderr.dump += d.toString()));
  age.stderr.on('data', (d: Buffer) => (stderr.age += d.toString()));
  // An age that dies early closes its stdin; the resulting EPIPE on pg_dump's side is reported through its exit code.
  age.stdin.on('error', () => undefined);

  const exit = (name: string, child: ChildProcess): Promise<number | string> =>
    new Promise((resolve) => {
      child.on('error', (e) => resolve(`${name} could not start: ${e.message}`));
      child.on('close', (code, signal) => resolve(code ?? `signal ${signal ?? 'unknown'}`));
    });
  const [dumpExit, ageExit] = await Promise.all([exit('pg_dump', dump), exit('age', age)]);
  if (!out.writableFinished) await once(out, 'finish').catch(() => undefined);

  if (dumpExit !== 0) {
    throw new Error(`pg_dump failed (${String(dumpExit)}): ${stderr.dump.trim().slice(0, 2000)}`);
  }
  if (ageExit !== 0) {
    throw new Error(`age failed (${String(ageExit)}): ${stderr.age.trim().slice(0, 2000)}`);
  }
  return { file, bytes: (await stat(file)).size };
}
