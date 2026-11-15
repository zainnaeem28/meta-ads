import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const manifests = [
  'package.json',
  'apps/api/package.json',
  'apps/web/package.json',
  'packages/contracts/package.json',
  'packages/ui/package.json',
];
const children: ChildProcess[] = [];

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1' } });
}

async function waitFor(url: string, timeoutMs = 60_000): Promise<Response> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fetch(url);
    } catch (error) {
      if (Date.now() > end) throw error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

afterAll(() => {
  for (const c of children) c.kill('SIGTERM');
});

describe('foundation', () => {
  it('pins every dependency to an exact version and declares packageManager and engines', () => {
    for (const file of manifests) {
      const pkg = JSON.parse(readFileSync(join(root, file), 'utf8')) as Record<
        string,
        Record<string, string> | string
      >;
      for (const group of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const deps = (pkg[group] ?? {}) as Record<string, string>;
        for (const [name, range] of Object.entries(deps)) {
          expect(range, `${file} ${name}`).toMatch(/^(\d+\.\d+\.\d+|workspace:\*)$/);
        }
      }
    }
    const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      packageManager: string;
      engines: object;
    };
    expect(rootPkg.packageManager).toMatch(/^pnpm@10\.\d+\.\d+$/);
    expect(rootPkg.engines).toBeTruthy();
    expect(readFileSync(join(root, '.nvmrc'), 'utf8').trim()).toBe('26');
  });

  it('keeps TypeScript strict and below 7', () => {
    const base = JSON.parse(readFileSync(join(root, 'tsconfig.base.json'), 'utf8')) as {
      compilerOptions: { strict: boolean };
    };
    expect(base.compilerOptions.strict).toBe(true);
    expect(sh('pnpm', ['exec', 'tsc', '--version'])).toMatch(/Version 6\.0\./);
  });

  it('installs with a frozen lockfile and typechecks the workspace', () => {
    sh('pnpm', ['install', '--frozen-lockfile']);
    sh('pnpm', ['-w', 'typecheck']);
  });

  it('builds the api and answers GET /health/live from the built entry point', async () => {
    sh('pnpm', ['--filter', '@shroomap/api', 'build']);
    expect(existsSync(join(root, 'apps/api/dist/main.api.js'))).toBe(true);
    const child = spawn('node', ['dist/main.api.js'], {
      cwd: join(root, 'apps/api'),
      env: { ...process.env, PORT: '3911' },
      stdio: 'inherit',
    });
    children.push(child);
    const res = await waitFor('http://127.0.0.1:3911/health/live');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('builds the web app and serves its route from the built output', async () => {
    sh('pnpm', ['--filter', '@shroomap/web', 'build']);
    expect(readdirSync(join(root, 'apps/web/.next')).length).toBeGreaterThan(0);
    const child = spawn('node', ['.next/standalone/apps/web/server.js'], {
      cwd: join(root, 'apps/web'),
      env: { ...process.env, PORT: '3912', HOSTNAME: '127.0.0.1' },
      stdio: 'inherit',
    });
    children.push(child);
    const res = await waitFor('http://127.0.0.1:3912/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Shroomap foundation');
  });
});
