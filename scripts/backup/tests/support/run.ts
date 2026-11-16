import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { runBackup } from '../../src/run.ts';
import type { RunResult } from '../../src/run.ts';
import type { Logger } from '../../src/util.ts';
import { srcPackageDir } from './fixture.ts';
import type { Rig } from './fixture.ts';

export interface Captured {
  lines: Record<string, unknown>[];
  logger: Logger;
}

export function capture(): Captured {
  const lines: Record<string, unknown>[] = [];
  const push =
    (level: string) =>
    (event: string, fields: Record<string, unknown> = {}) =>
      void lines.push({ level, event, ...fields });
  return { lines, logger: { info: push('info'), warn: push('warn'), error: push('error') } };
}

/** One run in process with the rig's clock; `extra` overrides environment values. */
export async function runOnce(
  rig: Rig,
  databaseUrl: string,
  extra: Record<string, string> = {},
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<RunResult & { logs: Record<string, unknown>[] }> {
  const config = loadConfig({ ...rig.env(databaseUrl, extra), BACKUP_SPOOL_DIR: rig.work });
  const log = capture();
  const result = await runBackup(config, log.logger, { now: () => rig.clock.now, ...deps });
  return { ...result, logs: log.lines };
}

export interface Spawned {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The real entry point, `node src/main.ts`, in a clean environment (only `env` plus the PATH it needs). */
export function runMain(env: Record<string, string>): Promise<Spawned> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(srcPackageDir, 'src', 'main.ts')], {
      cwd: srcPackageDir,
      env: {
        PATH: process.env['PATH'] ?? '',
        LD_LIBRARY_PATH: process.env['LD_LIBRARY_PATH'] ?? '',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
