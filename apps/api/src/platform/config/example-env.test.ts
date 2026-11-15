import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDotenv } from './env-source.js';
import { REGISTRY } from './registry.js';
import { loadConfigOrExit, EXIT_CONFIG } from './startup.js';
import type { ProcessKind } from './registry.js';

// DO-05 / TASK-009: the committed defaults of .env.example, completed by the generated local key material,
// start every process with no owner-supplied database URL, account or credential.

const root = join(import.meta.dirname, '..', '..', '..', '..', '..');
const script = join(root, 'scripts', 'ci', 'config-consistency.mjs');
let dir = '';
const envFor = (service: string) =>
  parseDotenv(readFileSync(join(dir, `${service}.env`), 'utf8')) as Record<string, string>;

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}
const exit = (code: number): never => {
  throw new Exited(code);
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'local-env-'));
  const run = spawnSync('node', [script, '--local-env', dir], { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('default-valued local environment', () => {
  for (const kind of ['api', 'worker', 'release'] as const satisfies readonly ProcessKind[]) {
    it(`${kind} starts from its generated file alone`, () => {
      const lines: string[] = [];
      const config = loadConfigOrExit(kind, {
        env: envFor(kind),
        stderr: (l) => lines.push(l),
        exit,
      });
      expect(lines).toEqual([]);
      expect(config.APP_ENV).toBe('development');
    });
  }

  it('the file for one process is refused by another when it carries a secret the other must not hold', () => {
    const lines: string[] = [];
    expect(() =>
      loadConfigOrExit('api', { env: envFor('worker'), stderr: (l) => lines.push(l), exit }),
    ).toThrow(new Exited(EXIT_CONFIG));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines)
      expect(line).toMatch(/^config error \(api\): [A-Z0-9_]+ is (forbidden|missing|invalid)$/);
  });

  it('every schema key is documented in .env.example', () => {
    const example = readFileSync(join(root, '.env.example'), 'utf8');
    for (const key of Object.keys(REGISTRY)) {
      expect(example, key).toMatch(new RegExp(`^#?\\s*${key}=`, 'm'));
    }
  });

  it('no generated value is committed: .env.example has no PEM block', () => {
    expect(readFileSync(join(root, '.env.example'), 'utf8')).not.toMatch(/-----BEGIN/);
  });
});
