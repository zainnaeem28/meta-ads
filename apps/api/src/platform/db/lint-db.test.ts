import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Negative probes for scripts/ci/lint-db.sh: each fixture tree must fail the lint for the named reason.

const script = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'scripts',
  'ci',
  'lint-db.sh',
);
const trees: string[] = [];

function lint(files: Record<string, string>): { status: number | null; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'lint-db-'));
  trees.push(root);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  const run = spawnSync('bash', [script], {
    env: { ...process.env, LINT_ROOT: root },
    encoding: 'utf8',
  });
  return { status: run.status, out: run.stdout + run.stderr };
}

afterAll(() => {
  for (const root of trees) rmSync(root, { recursive: true, force: true });
});

const KEYS = 'apps/api/src/modules/provider-keys/infrastructure/repo.ts';

describe('lint-db negative probes', () => {
  it('passes a clean tree and a projected provider_keys select', () => {
    const clean = lint({
      [KEYS]:
        'const rows = await db.select({ id: providerKeys.id }).from(providerKeys).where(eq(providerKeys.ownerId, o));\n' +
        'const [row] = await db.update(providerKeys).set({ x: 1 }).returning({ id: providerKeys.id });\n' +
        'const others = await db.select().from(users);\n',
      'package.json': '{"scripts":{"db:migrate":"drizzle-kit migrate"}}',
    });
    expect(clean.status, clean.out).toBe(0);
    expect(clean.out).toContain('0 problem(s)');
  });

  it.each([
    ['package.json', '{"scripts":{"db:push":"drizzle-kit push"}}'],
    ['scripts/release.sh', 'pnpm exec drizzle-kit   push:pg --config x'],
    ['.github/workflows/ci.yml', 'run: npx drizzle-kit push --force'],
  ])('fails drizzle-kit push in %s', (name, content) => {
    const result = lint({ [name]: content });
    expect(result.status).toBe(1);
    expect(result.out).toContain('drizzle-kit push is forbidden');
  });

  it.each([
    [
      'select() from providerKeys',
      'const r = await db.select().from(providerKeys);',
      'select() without',
    ],
    [
      'multi-line select',
      'const r = await db\n  .select()\n  .from(provider_keys)\n  .where(x);',
      'select() without',
    ],
    [
      'returning()',
      'await db.update(providerKeys).set({ a: 1 }).returning();',
      'returning() without',
    ],
    [
      'relational query',
      'await db.query.providerKeys.findFirst({ where: x });',
      'relational query without columns',
    ],
    ['getTableColumns', 'const cols = getTableColumns(providerKeys);', 'getTableColumns'],
    [
      'raw select *',
      'await db.execute(sql`select * from provider_keys where id = ${id}`);',
      'SQL selects every column',
    ],
    [
      'raw returning *',
      'await db.execute(sql`insert into provider_keys (a) values (1) returning *`);',
      'SQL selects every column',
    ],
  ])('fails an unprojected provider_keys read: %s', (_label, content, reason) => {
    const result = lint({ [KEYS]: `${content}\n` });
    expect(result.status).toBe(1);
    expect(result.out).toContain(reason);
    expect(result.out).toContain('repo.ts');
  });

  it('accepts a relational query that lists its columns', () => {
    const result = lint({
      [KEYS]: 'await db.query.providerKeys.findFirst({ columns: { id: true } });\n',
    });
    expect(result.status, result.out).toBe(0);
  });

  it('fails migration names without a number and duplicate numbers', () => {
    const base = 'apps/api/src/database/migrations';
    const bad = lint({
      [`${base}/0001_task-001-a.sql`]: '',
      [`${base}/0001_task-002-b.sql`]: '',
      [`${base}/init.sql`]: '',
    });
    expect(bad.status).toBe(1);
    expect(bad.out).toContain('init.sql: migration file name must be');
    expect(bad.out).toContain('number 0001 is already used');
    const good = lint({
      [`${base}/0010_task-032-audit.sql`]: '',
      [`${base}/meta/_journal.json`]: '{}',
    });
    expect(good.status, good.out).toBe(0);
  });
});
