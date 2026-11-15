import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { jobsMigrate, provision, teardown, withClient } from '../db/harness.ts';
import type { Env, RoleKey } from '../db/harness.ts';

export { provision, teardown, withClient };
export type { Env, RoleKey };
export const repoRoot = join(import.meta.dirname, '..', '..', '..');

const q = (n: string) => `"${n}"`;

/** Slice tables as app_migrator, with only the DML the runtime roles need (no CREATE). */
export async function applySliceSchema(env: Env): Promise<void> {
  const api = q(env.roles.api);
  const worker = q(env.roles.worker);
  await withClient(env.urlFor('migrator'), async (c) => {
    await c.query(`
      CREATE SCHEMA IF NOT EXISTS pgboss;
      GRANT USAGE ON SCHEMA pgboss TO ${api}, ${worker};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${q(env.roles.migrator)} IN SCHEMA pgboss
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${api}, ${worker};
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        clerk_user_id text NOT NULL UNIQUE,
        email text NOT NULL,
        role text NOT NULL CHECK (role IN ('admin','user'))
      );
      CREATE TABLE campaigns (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        seq bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
        name text NOT NULL,
        version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX campaigns_seq_uq ON campaigns (seq);
      CREATE INDEX campaigns_owner_seq ON campaigns (owner_id, seq);
      CREATE TABLE job_log (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id text NOT NULL,
        note text NOT NULL
      );
      CREATE TABLE user_claims (
        user_id text PRIMARY KEY,
        active integer NOT NULL DEFAULT 0 CHECK (active >= 0)
      );
      GRANT USAGE ON SCHEMA public TO ${api}, ${worker};
      GRANT SELECT, INSERT, UPDATE, DELETE ON users, campaigns TO ${api};
      GRANT SELECT ON users, campaigns TO ${worker};
      GRANT SELECT, INSERT, UPDATE, DELETE ON job_log, user_claims TO ${api}, ${worker};
    `);
  });
}

export function createSliceQueues(env: Env): void {
  const r = jobsMigrate(env, [
    { name: 'slice-job', policy: 'standard', retryLimit: 0, expireInSeconds: 3 },
    { name: 'slice-short', policy: 'short', retryLimit: 0, expireInSeconds: 60 },
  ]);
  if (r.status !== 0) throw new Error(`jobs:migrate failed: ${r.stderr}`);
}

export interface Started {
  child: ChildProcess;
  output: () => string;
  stop: () => Promise<void>;
}

export async function startProcess(
  command: string,
  args: string[],
  env: Record<string, string>,
  readyUrl: string,
  cwd = repoRoot,
): Promise<Started> {
  let out = '';
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  const exited = new Promise<'exited'>((resolve) => child.once('exit', () => resolve('exited')));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(readyUrl);
      if (res.status < 500) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`${command} did not become ready:\n${out}`);
    const state = await Promise.race([
      exited,
      new Promise<'tick'>((r) => setTimeout(() => r('tick'), 250)),
    ]);
    if (state === 'exited') throw new Error(`${command} exited early:\n${out}`);
  }
  return {
    child,
    output: () => out,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}
