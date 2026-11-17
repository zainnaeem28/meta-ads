import { COMMAND_ROLE, OpsRefusedError, assertEnvironmentMatch, parseArgs, usage } from './args.js';
import type { OpsInvocation } from './args.js';
import type { ProcessConfig } from '../config/index.js';
import type { OpsResult } from './commands.js';

/** What the runner needs from its surroundings; `runtime.ts` binds the real ones, the unit tests bind fakes. */
export interface OpsRuntime {
  /** The validated configuration of the process role the command runs under (exits 78 itself when it is invalid). */
  loadConfig(role: 'api' | 'worker'): ProcessConfig;
  /** Opens the connections the command needs, runs it and closes them again. */
  execute(invocation: OpsInvocation, config: ProcessConfig): Promise<OpsResult>;
  write(line: string): void;
}

export const EXIT_OK = 0;
export const EXIT_INCOMPLETE = 1;
export const EXIT_REFUSED = 2;

/**
 * Parses the command line, refuses unless `--env` is this process's `APP_ENV`, runs the command and prints counts as
 * `name=number` lines. Failures print the command and the kind of error, never its message (it could hold a value).
 */
export async function runOps(argv: readonly string[], runtime: OpsRuntime): Promise<number> {
  let invocation: OpsInvocation;
  try {
    invocation = parseArgs(argv);
  } catch (error) {
    runtime.write(error instanceof Error ? error.message : 'ops refused');
    for (const line of usage().split('\n')) runtime.write(line);
    return EXIT_REFUSED;
  }
  const { command } = invocation;
  try {
    const config = runtime.loadConfig(COMMAND_ROLE[command]);
    assertEnvironmentMatch(invocation.env, config.APP_ENV);
    const result = await runtime.execute(invocation, config);
    runtime.write(`ops ${command}: ${result.ok ? 'done' : 'incomplete'}`);
    for (const [name, value] of Object.entries(result.counts))
      runtime.write(`${name}=${String(value)}`);
    return result.ok ? EXIT_OK : EXIT_INCOMPLETE;
  } catch (error) {
    if (error instanceof OpsRefusedError) {
      runtime.write(error.message);
      return EXIT_REFUSED;
    }
    runtime.write(`ops ${command}: failed (${error instanceof Error ? error.name : 'error'})`);
    return EXIT_INCOMPLETE;
  }
}
