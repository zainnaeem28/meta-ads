import { resolveEnvironment } from './env-source.js';
import type { EnvMap } from './env-source.js';
import type { ProcessKind } from './registry.js';
import { validateConfig } from './schema.js';
import type { ConfigIssue, ProcessConfig, SchemaOptions } from './schema.js';

/** EX_CONFIG (sysexits.h): the process cannot start because its configuration is wrong. */
export const EXIT_CONFIG = 78;

export interface StartupHooks {
  readonly env?: EnvMap;
  readonly cwd?: string;
  readonly stderr?: (line: string) => void;
  readonly exit?: (code: number) => never;
  readonly options?: SchemaOptions;
}

/** One line per fault, naming the key and the kind of fault, never a value. */
export function formatIssues(kind: ProcessKind, issues: readonly ConfigIssue[]): string[] {
  return issues.map((issue) => `config error (${kind}): ${issue.key} is ${issue.fault}`);
}

/**
 * Validate this process's configuration at startup. On any fault, name the keys on stderr and exit with 78.
 * Returns the frozen, typed configuration otherwise.
 */
export function loadConfigOrExit(kind: ProcessKind, hooks: StartupHooks = {}): ProcessConfig {
  const env = resolveEnvironment(
    hooks.env ?? process.env,
    hooks.cwd === undefined ? {} : { cwd: hooks.cwd },
  );
  const result = validateConfig(kind, env, hooks.options);
  if (result.ok) return result.config;
  const write = hooks.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  for (const line of formatIssues(kind, result.issues)) write(line);
  return (hooks.exit ?? ((code: number) => process.exit(code)))(EXIT_CONFIG);
}
