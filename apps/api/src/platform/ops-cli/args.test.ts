import { describe, expect, it } from 'vitest';
import { COMMAND_ROLE, OPS_COMMANDS, OpsRefusedError, assertEnvironmentMatch, isRunId, parseArgs, usage } from './args.js';

const RUN = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';

describe('ops-cli arguments', () => {
  it('parses each command with its environment', () => {
    for (const command of ['first-admin:reopen', 'keys:disable-all', 'kek:rewrap'] as const) {
      expect(parseArgs([command, '--env=staging'])).toEqual({ command, env: 'staging', args: [] });
    }
    expect(parseArgs(['erasure:resume', RUN, '--env=production'])).toEqual({ command: 'erasure:resume', env: 'production', args: [RUN] });
  });

  it('refuses an unknown command, a missing environment and stray arguments', () => {
    expect(() => parseArgs([])).toThrow(OpsRefusedError);
    expect(() => parseArgs(['rm:everything', '--env=staging'])).toThrow('unknown command');
    expect(() => parseArgs(['kek:rewrap'])).toThrow('--env');
    expect(() => parseArgs(['kek:rewrap', '--env='])).toThrow('--env');
    expect(() => parseArgs(['kek:rewrap', '--env=staging', '--force'])).toThrow('unknown option');
    expect(() => parseArgs(['kek:rewrap', 'extra', '--env=staging'])).toThrow('takes no argument');
    expect(() => parseArgs(['erasure:resume', '--env=staging'])).toThrow('run id');
    expect(() => parseArgs(['erasure:resume', 'not-a-uuid', '--env=staging'])).toThrow('run id');
    expect(() => parseArgs(['erasure:resume', RUN, RUN, '--env=staging'])).toThrow('run id');
  });

  it('only a run id of the right shape is accepted', () => {
    expect(isRunId(RUN)).toBe(true);
    expect(isRunId(`${RUN}0`)).toBe(false);
    expect(isRunId("'; drop table users; --")).toBe(false);
  });

  it('refuses unless the named environment is APP_ENV, naming neither value', () => {
    expect(() => assertEnvironmentMatch('staging', 'staging')).not.toThrow();
    try {
      assertEnvironmentMatch('production', 'staging');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OpsRefusedError);
      expect((error as Error).message).not.toMatch(/production|staging/);
    }
  });

  it('every command has a role and the usage lists them all', () => {
    for (const command of OPS_COMMANDS) {
      expect(['api', 'worker']).toContain(COMMAND_ROLE[command]);
      expect(usage()).toContain(command);
    }
    expect(COMMAND_ROLE['kek:rewrap']).toBe('worker');
  });
});
