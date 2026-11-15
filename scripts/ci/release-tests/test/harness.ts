import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PS4, repoRoot, traceFile } from './trace.ts';

export const verifyScript = resolve(repoRoot, 'scripts/ci/verify-release-approval.sh');
export const releaseScript = resolve(repoRoot, 'scripts/ci/release-with-recovery.sh');
export const stubScript = resolve(repoRoot, 'scripts/ci/hosts/stub.sh');

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(
  script: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<Result> {
  mkdirSync(resolve(repoRoot, 'reports/release'), { recursive: true });
  const trace = openSync(traceFile, 'a');
  return new Promise((done, fail) => {
    const child = spawn('bash', [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe', trace],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        SHELLOPTS: 'xtrace',
        PS4,
        BASH_XTRACEFD: '3',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', fail);
    child.on('close', (code) => {
      closeSync(trace);
      done({ code: code ?? -1, stdout, stderr });
    });
  });
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export const digest = (name: string) => `sha256:${sha(name)}`;
export const SOURCE_SHA = 'a'.repeat(40);
export const NOW = Date.parse('2026-03-10T12:00:00Z') / 1000;

export interface Fixture {
  dir: string;
  args: string[];
  out: string;
  files: Record<'g3' | 'quality' | 'actual' | 'targets' | 'releases', string>;
  g3: Record<string, unknown>;
  quality: Record<string, unknown>;
  env: Record<string, string>;
}

export interface Overrides {
  environment?: string;
  g3?: Record<string, unknown>;
  quality?: Record<string, unknown>;
  actual?: Record<string, unknown>;
  targets?: Record<string, unknown>;
  releases?: unknown[];
  skipG3?: boolean;
}

/** A complete, valid set of release evidence for one environment; overrides break one thing at a time. */
export function fixture(o: Overrides = {}): Fixture {
  const environment = o.environment ?? 'staging';
  const dir = mkdtempSync(join(tmpdir(), 'release-'));
  const digests = { api: digest('api'), worker: digest('worker'), web: digest('web') };
  const targetValues = {
    hosts: ['api.example.test', 'web.example.test'],
    database: `db-${environment}`,
    bucket: `bucket-${environment}`,
  };
  const quality = { sourceSha: SOURCE_SHA, result: 'PASS', digests, ...o.quality };
  const qualityText = JSON.stringify(quality);
  const g3 = {
    decision: 'PASS',
    environment,
    sourceSha: SOURCE_SHA,
    digests,
    qualitySha256: sha(qualityText),
    planRevision: 'plan-rev-3',
    approvedAt: '2026-03-09T12:00:00Z',
    ref: 'g3-100',
    writtenBy: 'owner',
    targets: targetValues,
    ...o.g3,
  };
  const files = {
    g3: join(dir, 'g3.json'),
    quality: join(dir, 'quality.json'),
    actual: join(dir, 'actual.json'),
    targets: join(dir, 'targets.json'),
    releases: join(dir, 'releases.json'),
  };
  if (!o.skipG3) writeFileSync(files.g3, JSON.stringify(g3));
  writeFileSync(files.quality, qualityText);
  writeFileSync(files.actual, JSON.stringify({ ...digests, ...o.actual }));
  writeFileSync(files.targets, JSON.stringify({ [environment]: targetValues, ...o.targets }));
  const previous = {
    environment,
    runId: '50',
    g3Ref: 'g3-50',
    digests: { api: digest('old-api'), worker: digest('old-worker'), web: digest('old-web') },
  };
  writeFileSync(files.releases, JSON.stringify(o.releases ?? [previous]));
  const out = join(dir, 'out');
  const args = [
    '--environment',
    environment,
    '--source-sha',
    SOURCE_SHA,
    '--run-id',
    '100',
    '--ref',
    'refs/heads/main',
    '--g3-record',
    files.g3,
    '--quality',
    files.quality,
    '--actual-digests',
    files.actual,
    '--expected-targets',
    files.targets,
    '--release-record',
    files.releases,
    '--dispatcher',
    'devops',
  ];
  return {
    dir,
    args,
    out,
    files,
    g3,
    quality,
    env: { RELEASE_NOW: String(NOW), RELEASE_LOCK_DIR: join(dir, 'locks') },
  };
}

/** Replace an argument's value, e.g. withArg(f.args, '--ref', 'refs/heads/dev'). */
export function withArg(args: string[], name: string, value: string): string[] {
  const copy = [...args];
  copy[copy.indexOf(name) + 1] = value;
  return copy;
}

export function without(args: string[], name: string): string[] {
  const copy = [...args];
  copy.splice(copy.indexOf(name), 2);
  return copy;
}

export const callsOf = (file: string): string[] =>
  existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
export const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
