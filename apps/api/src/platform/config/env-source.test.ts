import { describe, expect, it } from 'vitest';
import { parseDotenv, resolveEnvironment } from './env-source.js';

describe('environment source', () => {
  const files: Record<string, string> = {
    '/app/.env': 'FROM_DOT_ENV=1\n',
    '/app/.env.local':
      '# comment\nexport LOG_LEVEL=debug\nQUOTED="a b"\nSINGLE=\'x\'\nAPP_ENV=production\nnot a line\n',
  };
  const readFile = (path: string) => files[path];
  const reads: string[] = [];
  const spy = (path: string) => {
    reads.push(path);
    return readFile(path);
  };

  it('reads .env.local only when APP_ENV is development, and never .env', () => {
    const env = resolveEnvironment({ APP_ENV: 'development' }, { cwd: '/app', readFile: spy });
    expect(env['LOG_LEVEL']).toBe('debug');
    expect(env['QUOTED']).toBe('a b');
    expect(env['SINGLE']).toBe('x');
    expect(env['FROM_DOT_ENV']).toBeUndefined();
    expect(reads).toEqual(['/app/.env.local']);
  });

  it('the process environment wins over .env.local', () => {
    const env = resolveEnvironment(
      { APP_ENV: 'development', LOG_LEVEL: 'warn', UNSET: undefined },
      { cwd: '/app', readFile },
    );
    expect(env['LOG_LEVEL']).toBe('warn');
    expect(env['APP_ENV']).toBe('development');
  });

  for (const appEnv of ['test', 'staging', 'production', undefined]) {
    it(`reads no file when APP_ENV is ${String(appEnv)}`, () => {
      reads.length = 0;
      const source = { APP_ENV: appEnv, LOG_LEVEL: 'warn' };
      expect(resolveEnvironment(source, { cwd: '/app', readFile: spy })).toBe(source);
      expect(reads).toEqual([]);
    });
  }

  it('a missing .env.local leaves the environment as it is', () => {
    const source = { APP_ENV: 'development' };
    expect(resolveEnvironment(source, { cwd: '/nowhere' })).toBe(source);
  });

  it('reads the real file system by default', () => {
    expect(
      resolveEnvironment({ APP_ENV: 'development' }, { cwd: '/nonexistent-dir-for-test' }),
    ).toEqual({ APP_ENV: 'development' });
  });

  it('parseDotenv skips comments and malformed lines', () => {
    expect(parseDotenv('# x=1\nA=1\n  B = 2 \n=3\n')).toEqual({ A: '1', B: '2' });
  });
});
