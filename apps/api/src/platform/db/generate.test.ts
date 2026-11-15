import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: spawn }));

const { MIGRATION_NAME, generateMigration } = await import('./generate.js');

const dirs: string[] = [];
afterEach(() => {
  spawn.mockReset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workdir(tags: string[]): string {
  const cwd = mkdtempSync(join(tmpdir(), 'generate-'));
  dirs.push(cwd);
  const out = join(cwd, 'src', 'database', 'migrations');
  mkdirSync(join(out, 'meta'), { recursive: true });
  writeFileSync(
    join(out, 'meta', '_journal.json'),
    JSON.stringify({ entries: tags.map((tag, idx) => ({ idx, tag })) }),
  );
  return cwd;
}

describe('generate wrapper', () => {
  it('accepts <NNNN>_<ticket>-<slug> only', () => {
    expect(MIGRATION_NAME.test('0010_task-032-audit')).toBe(true);
    for (const bad of [
      '',
      'audit',
      '10_task-032-x',
      '0010_task-32-x',
      '0010_task-032-X',
      '0010_task-032-',
    ]) {
      expect(MIGRATION_NAME.test(bad)).toBe(false);
    }
  });

  it('rejects a bad name and a number already used, without running drizzle-kit', () => {
    const cwd = workdir(['0003_task-020-x']);
    expect(() => generateMigration({ name: 'audit', cwd })).toThrow('--name must be');
    expect(() => generateMigration({ name: '0003_task-021-y', cwd })).toThrow(
      'number 0003 is already used by 0003_task-020-x',
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('renames the generated migration to the exact name and rewrites the journal tag', () => {
    const cwd = workdir([]);
    const out = join(cwd, 'src', 'database', 'migrations');
    spawn.mockImplementation(() => {
      writeFileSync(join(out, '0000_0010_task-032-audit.sql'), 'CREATE TABLE a ();');
      writeFileSync(
        join(out, 'meta', '_journal.json'),
        JSON.stringify({ entries: [{ idx: 0, tag: '0000_0010_task-032-audit' }] }),
      );
      return { status: 0, stdout: 'ok\n', stderr: '' };
    });
    expect(generateMigration({ name: '0010_task-032-audit', cwd })).toEqual({
      generated: true,
      tag: '0010_task-032-audit',
    });
    expect(readFileSync(join(out, '0010_task-032-audit.sql'), 'utf8')).toBe('CREATE TABLE a ();');
    expect(
      JSON.parse(readFileSync(join(out, 'meta', '_journal.json'), 'utf8')).entries[0].tag,
    ).toBe('0010_task-032-audit');
  });

  it('reports nothing to do, and fails when drizzle-kit fails or stays silent', () => {
    const cwd = workdir([]);
    spawn.mockReturnValueOnce({
      status: 0,
      stdout: 'No schema changes, nothing to migrate\n',
      stderr: '',
    });
    expect(generateMigration({ name: '0010_task-032-audit', cwd })).toEqual({ generated: false });
    spawn.mockReturnValueOnce({ status: 0, stdout: 'Error: ENOENT\n', stderr: '' });
    expect(() => generateMigration({ name: '0010_task-032-audit', cwd })).toThrow(
      'did not report "No schema changes"',
    );
    spawn.mockReturnValueOnce({ status: 1, stdout: '', stderr: 'boom' });
    expect(() => generateMigration({ name: '0010_task-032-audit', cwd })).toThrow(
      'failed with status 1',
    );
    const empty = mkdtempSync(join(tmpdir(), 'generate-empty-'));
    dirs.push(empty);
    spawn.mockReturnValueOnce({ status: 0, stdout: 'No schema changes\n', stderr: '' });
    expect(generateMigration({ name: '0010_task-032-audit', cwd: empty })).toEqual({
      generated: false,
    });
  });
});
