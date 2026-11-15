import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Precedence: host secret store / environment, and nothing else. No `.env` file is ever read; `.env.local`
// is read only when APP_ENV is `development`, and never overrides a variable the environment already sets.

export type EnvMap = Readonly<Record<string, string | undefined>>;
export type FileReader = (path: string) => string | undefined;

const defaultReader: FileReader = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null || line.trimStart().startsWith('#')) continue;
    let value = match[2] ?? '';
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    }
    out[match[1] as string] = value;
  }
  return out;
}

export function resolveEnvironment(
  processEnv: EnvMap,
  options: { readonly cwd?: string; readonly readFile?: FileReader } = {},
): EnvMap {
  if (processEnv['APP_ENV'] !== 'development') return processEnv;
  const read = options.readFile ?? defaultReader;
  const text = read(join(options.cwd ?? process.cwd(), '.env.local'));
  if (text === undefined) return processEnv;
  return { ...parseDotenv(text), ...definedOnly(processEnv) };
}

function definedOnly(env: EnvMap): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
