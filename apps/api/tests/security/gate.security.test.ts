import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// TASK-116, wiring: the sink scanner is run through the real `submit_check.py` (the gate every code ticket passes) on a
// committed fixture that leaks (the gate must fail and name the rules without printing a value), on a committed clean
// fixture (the gate must pass), and on the tree itself: the reports this suite writes and the evidence it commits hold no
// canary, synthetic address, bearer token, JWT or signed-URL query (TC-LOG-03, SECT-LOG-04 for the suite's own output).

const SUITE = join(import.meta.dirname);
const REPO = resolve(SUITE, '..', '..', '..', '..');
const SCANNER = join(SUITE, 'support', 'scan-sinks.mjs');
const SUBMIT_CHECK =
  process.env['SUBMIT_CHECK'] ??
  join(process.env['AGENT_HOME'] ?? '/nonexistent', 'submit_check.py');
let work: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@invalid', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

/** A throwaway repository: `main` with a README, branch `ticket` with the scanner and one fixture committed on top. */
function ticketRepo(name: string, fixture: string): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'ticket');
  mkdirSync(join(dir, 'fixtures'));
  copyFileSync(SCANNER, join(dir, 'scan-sinks.mjs'));
  copyFileSync(join(SUITE, 'fixtures', fixture), join(dir, 'fixtures', fixture));
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'ticket');
  return dir;
}

function gate(dir: string, report: string) {
  return spawnSync(
    'python3',
    [
      SUBMIT_CHECK,
      '--base',
      'main',
      '--check',
      'node scan-sinks.mjs --out reports/sinks.sarif fixtures',
      '--secrets',
      'reports/sinks.sarif',
      '--out',
      report,
    ],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: '1' } },
  );
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'sec116-gate-'));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('the sink scanner through the real submit_check.py gate (TC-LOG-03)', () => {
  it('finds the real submit_check.py', () => {
    expect(
      existsSync(SUBMIT_CHECK),
      `set SUBMIT_CHECK or AGENT_HOME (looked for ${SUBMIT_CHECK})`,
    ).toBe(true);
  });

  it('fails on the committed leaking fixture, names the rules and never prints a value', () => {
    const dir = ticketRepo('leaky', 'leaky-journey.log');
    const report = join(work, 'leaky-report.md');
    const run = gate(dir, report);
    expect(run.status, run.stdout + run.stderr).toBe(1);
    const text = readFileSync(report, 'utf8');
    expect(text).toMatch(/sink-synthetic-email/);
    expect(text).toMatch(/sink-bearer-token/);
    expect(text).toMatch(/sink-signed-url/);
    expect(text).not.toContain('fixture.person');
    expect(text).not.toContain('0123456789abcdef0123456789abcdef');
    expect(text).not.toContain('X-Amz-Signature=00ff');
  });

  it('passes on the committed clean fixture', () => {
    const dir = ticketRepo('clean', 'clean-journey.log');
    const report = join(work, 'clean-report.md');
    const run = gate(dir, report);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(readFileSync(report, 'utf8')).toMatch(/PASS/);
  });

  it('passes on the tree: nothing this suite or its evidence wrote holds a canary, a synthetic address or a token', () => {
    for (const path of ['apps/api/reports/security', 'docs/evidence/TASK-116'])
      mkdirSync(join(REPO, path), { recursive: true });
    const run = spawnSync(
      'node',
      [
        SCANNER,
        '--out',
        join(work, 'tree.sarif'),
        join(REPO, 'apps/api/reports/security'),
        join(REPO, 'docs/evidence/TASK-116'),
      ],
      { cwd: REPO, encoding: 'utf8' },
    );
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });
});
