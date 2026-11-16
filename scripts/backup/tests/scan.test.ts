import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FORBIDDEN_NAMES } from '../src/forbidden.ts';
import { repoRoot, srcPackageDir } from './support/fixture.ts';

// TC-BKP-13 (the image and the CI definitions hold none of the forbidden names or code) and TC-BKP-09 (b) (the dump
// command never carries `--enable-row-security`). Static checks on the files that define and feed the image, plus the
// exact payload `pnpm deploy` puts into it.

const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), 'utf8');
const dockerfile = read('docker', 'Dockerfile');
const stages = dockerfile.split(/^(?=FROM )/m).filter((s) => s.startsWith('FROM'));
const stage = (name: string) =>
  stages.find((s) => new RegExp(`\\sAS ${name}\\s*$`, 'm').test(s.split('\n')[0] ?? ''));
const backupStages = ['backup-build', 'backup'].map((n) => stage(n) ?? '');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe('the backup image definition (TC-BKP-13)', () => {
  it('has a backup target built from the script alone: no application code, no forbidden name or secret-like variable', () => {
    expect(backupStages.every((s) => s !== '')).toBe(true);
    const text = backupStages.join('\n');
    expect(text).not.toMatch(/apps\/(api|web)|packages\/|ops-cli|unseal|drizzle|pg-boss|pgboss/i);
    expect(text).toMatch(/COPY scripts\/backup scripts\/backup/);
    for (const name of FORBIDDEN_NAMES) expect(text).not.toContain(name);
    expect(text).not.toMatch(/KEK_V\d|AGE-SECRET-KEY/);
    const declared = [...text.matchAll(/^\s*(?:ENV|ARG)\s+([A-Z0-9_]+)/gm)].map(
      (m) => m[1] as string,
    );
    for (const name of declared)
      expect(name).not.toMatch(/SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|_KEY$|CREDENTIAL/);
    expect(text).toMatch(/pg_dump --version && age --version/);
  });

  it('is not the base of any other target, and no other target copies from it', () => {
    for (const s of stages) {
      const head = s.split('\n')[0] ?? '';
      if (/\sAS backup(-build)?\s*$/.test(head)) continue;
      expect(head).not.toMatch(/FROM backup/);
      expect(s).not.toMatch(/--from=backup/);
    }
  });

  it('runs as the unprivileged user with the script as its only command', () => {
    const last = backupStages[1] ?? '';
    expect(last).toMatch(/^USER node$/m);
    expect(last).toMatch(/^CMD \["node", "src\/main\.ts"\]$/m);
    expect(last).not.toMatch(/EXPOSE|HEALTHCHECK/);
  });

  it('no compose, CI or workflow definition runs the backup image for another service or another image for backup', () => {
    const files = [
      ...walk(join(repoRoot, 'docker')).filter((f) => /\.ya?ml$/.test(f)),
      ...(statSync(join(repoRoot, '.github'), { throwIfNoEntry: false })
        ? walk(join(repoRoot, '.github')).filter((f) => /\.ya?ml$/.test(f))
        : []),
    ];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const services = text.split(/^ {2}(?=[a-z][a-z0-9-]*:\s*$)/m).slice(1);
      for (const block of services) {
        const name = /^([a-z][a-z0-9-]*):/.exec(block)?.[1] ?? '';
        const usesBackupImage = /image:.*(shroomap-)?backup|CI_IMAGE_BACKUP|--target backup/.test(
          block,
        );
        if (name === 'backup')
          expect(block, relative(repoRoot, file)).not.toMatch(
            /image:.*(api|worker|web)\b|CI_IMAGE_(API|WORKER|WEB)/,
          );
        else expect(usesBackupImage, `${name} in ${relative(repoRoot, file)}`).toBe(false);
      }
    }
  });

  describe('the payload copied into the image', () => {
    const out = mkdtempSync(join(tmpdir(), 'backup-deploy-'));
    afterAll(() => rmSync(out, { recursive: true, force: true }));

    it('contains the script and its two dependencies, and none of the application stack', () => {
      execFileSync(
        'pnpm',
        ['--filter', 'backup', 'deploy', '--prod', '--legacy', join(out, 'backup')],
        { cwd: repoRoot, stdio: 'pipe' },
      );
      const root = join(out, 'backup');
      const files = walk(root).map((f) => relative(root, f));
      expect(files.some((f) => f.startsWith('src/main.ts'))).toBe(true);
      const modules = readdirSync(join(root, 'node_modules')).filter((n) => !n.startsWith('.'));
      const real = [
        ...modules,
        ...modules
          .filter((m) => m.startsWith('@'))
          .flatMap((m) => readdirSync(join(root, 'node_modules', m)).map((n) => `${m}/${n}`)),
      ];
      for (const forbidden of [
        'drizzle-orm',
        'drizzle-kit',
        'pg-boss',
        'fastify',
        '@nestjs',
        'openai',
        '@clerk',
        'sharp',
        'argon2',
      ]) {
        expect(
          real.some((n) => n === forbidden || n.startsWith(`${forbidden}/`)),
          forbidden,
        ).toBe(false);
      }
      expect(files.some((f) => /apps\/api|ops-cli|unseal/i.test(f))).toBe(false);
      const text = files
        .filter((f) => f.startsWith('src/'))
        .map((f) => readFileSync(join(root, f), 'utf8'))
        .join('\n');
      expect(text).not.toMatch(/KEK_V\d+=|AGE-SECRET-KEY-1[A-Z0-9]{10}/);
    }, 180_000);
  });
});

describe('the pg_dump command (TC-BKP-09 b)', () => {
  it('never passes --enable-row-security, in the script, the image or the docs', () => {
    const roots = [join(srcPackageDir, 'src'), join(repoRoot, 'docker', 'backup')];
    const files = roots.flatMap((r) => walk(r)).concat(join(repoRoot, 'docker', 'Dockerfile'));
    for (const file of files)
      expect(readFileSync(file, 'utf8'), relative(repoRoot, file)).not.toMatch(
        /enable-row-security/,
      );
  });

  it('states the exact flags: custom format, the two schemas, one connection', async () => {
    const { PG_DUMP_ARGS } = await import('../src/dump.ts');
    expect(PG_DUMP_ARGS).toContain('--format=custom');
    expect(PG_DUMP_ARGS).toContain('--schema=public');
    expect(PG_DUMP_ARGS).toContain('--schema=pgboss');
    expect(PG_DUMP_ARGS.some((a) => /^(-j|--jobs)/.test(a))).toBe(false);
  });
});
