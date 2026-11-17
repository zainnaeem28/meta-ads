import { describe, expect, it } from 'vitest';
import type { ProcessConfig } from '../config/index.js';
import { EXIT_INCOMPLETE, EXIT_OK, EXIT_REFUSED, runOps } from './runner.js';
import type { OpsRuntime } from './runner.js';
import type { OpsResult } from './commands.js';
import { OpsRefusedError } from './args.js';

function runtime(appEnv: 'staging' | 'production', outcome: OpsResult | Error) {
  const lines: string[] = [];
  const roles: string[] = [];
  let executed = 0;
  const fake: OpsRuntime = {
    loadConfig: (role) => {
      roles.push(role);
      return { APP_ENV: appEnv, LOG_LEVEL: 'info' } as ProcessConfig;
    },
    execute: () => {
      executed += 1;
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
    write: (line) => lines.push(line),
  };
  return { fake, lines, roles, executed: () => executed };
}

describe('ops-cli runner', () => {
  it('prints counts only and exits 0 when the command did what it was asked', async () => {
    const r = runtime('staging', { counts: { rewrapped: 3, failed: 0 }, ok: true });
    expect(await runOps(['kek:rewrap', '--env=staging'], r.fake)).toBe(EXIT_OK);
    expect(r.lines).toEqual(['ops kek:rewrap: done', 'rewrapped=3', 'failed=0']);
    expect(r.roles).toEqual(['worker']);
  });

  it('exits 1 when the command did less than asked', async () => {
    const r = runtime('staging', { counts: { resumed: 0, not_stuck: 1 }, ok: false });
    expect(
      await runOps(
        ['erasure:resume', '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', '--env=staging'],
        r.fake,
      ),
    ).toBe(EXIT_INCOMPLETE);
    expect(r.lines[0]).toBe('ops erasure:resume: incomplete');
  });

  it('refuses on an environment mismatch before anything runs', async () => {
    const r = runtime('production', { counts: {}, ok: true });
    expect(await runOps(['keys:disable-all', '--env=staging'], r.fake)).toBe(EXIT_REFUSED);
    expect(r.executed()).toBe(0);
    expect(r.lines.join('\n')).toBe('ops refused: --env does not match APP_ENV');
  });

  it('refuses a bad command line with the usage and loads no configuration', async () => {
    const r = runtime('staging', { counts: {}, ok: true });
    expect(await runOps(['nope'], r.fake)).toBe(EXIT_REFUSED);
    expect(r.roles).toEqual([]);
    expect(r.lines.join('\n')).toContain('usage: ops <command>');
  });

  it('a refusal from the command itself exits 2', async () => {
    const r = runtime(
      'staging',
      new OpsRefusedError('connected database is not the configured one'),
    );
    expect(await runOps(['first-admin:reopen', '--env=staging'], r.fake)).toBe(EXIT_REFUSED);
  });

  it('a failure prints the kind of error and never its message', async () => {
    const r = runtime(
      'staging',
      Object.assign(new Error('password authentication failed for postgres://user:secret@db'), {
        name: 'DatabaseError',
      }),
    );
    expect(await runOps(['first-admin:reopen', '--env=staging'], r.fake)).toBe(EXIT_INCOMPLETE);
    expect(r.lines).toEqual(['ops first-admin:reopen: failed (DatabaseError)']);
    const other = runtime('staging', 'x' as unknown as Error);
    other.fake.execute = () => Promise.reject(new Error('plain'));
    expect(await runOps(['first-admin:reopen', '--env=staging'], other.fake)).toBe(EXIT_INCOMPLETE);
    const odd = runtime('staging', { counts: {}, ok: true });
    odd.fake.execute = () => Promise.reject('a string');
    expect(await runOps(['first-admin:reopen', '--env=staging'], odd.fake)).toBe(EXIT_INCOMPLETE);
    expect(odd.lines).toEqual(['ops first-admin:reopen: failed (error)']);
  });
});
