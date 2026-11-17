import type { AppEnv } from '../config/index.js';

// The deployer's one-off commands of the release image (ARCHITECTURE §7.3). Each names the environment it is meant for
// with `--env=<name>` and refuses to run unless that is the `APP_ENV` of the process: a command typed into the wrong
// shell stops before it opens a database connection.

export const OPS_COMMANDS = [
  'first-admin:reopen',
  'keys:disable-all',
  'kek:rewrap',
  'erasure:resume',
] as const;
export type OpsCommand = (typeof OPS_COMMANDS)[number];

/**
 * Which process configuration (and so which database role) the command runs under. `kek:rewrap` needs the private keys
 * and `erasure:resume` the UPDATE on `deletion_runs`, which only `app_worker` holds (M0060); the others run as `app_api`.
 */
export const COMMAND_ROLE: Readonly<Record<OpsCommand, 'api' | 'worker'>> = {
  'first-admin:reopen': 'api',
  'keys:disable-all': 'api',
  'kek:rewrap': 'worker',
  'erasure:resume': 'worker',
};

export class OpsRefusedError extends Error {
  constructor(reason: string) {
    super(`ops refused: ${reason}`);
    this.name = 'OpsRefusedError';
  }
}

export interface OpsInvocation {
  readonly command: OpsCommand;
  readonly env: string;
  /** The positional arguments after the command (`erasure:resume` takes the run id). */
  readonly args: readonly string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isRunId = (value: string): boolean => UUID.test(value);

export function usage(): string {
  return [
    'usage: ops <command> --env=<APP_ENV> [argument]',
    `commands: ${OPS_COMMANDS.join(', ')}`,
    '  erasure:resume <runId>',
  ].join('\n');
}

export function parseArgs(argv: readonly string[]): OpsInvocation {
  const [command, ...rest] = argv;
  const known = OPS_COMMANDS.find((candidate) => candidate === command);
  if (known === undefined) throw new OpsRefusedError('unknown command');
  let env: string | undefined;
  const args: string[] = [];
  for (const item of rest) {
    if (item.startsWith('--env=')) env = item.slice('--env='.length);
    else if (item.startsWith('--')) throw new OpsRefusedError('unknown option');
    else args.push(item);
  }
  if (env === undefined || env === '') throw new OpsRefusedError('--env=<APP_ENV> is required');
  if (known === 'erasure:resume') {
    if (args.length !== 1 || !isRunId(args[0] ?? ''))
      throw new OpsRefusedError('erasure:resume takes one run id');
  } else if (args.length > 0) {
    throw new OpsRefusedError(`${known} takes no argument`);
  }
  return { command: known, env, args };
}

/** The named environment must be the one this process runs in. */
export function assertEnvironmentMatch(requested: string, appEnv: AppEnv): void {
  if (requested !== appEnv) throw new OpsRefusedError('--env does not match APP_ENV');
}
