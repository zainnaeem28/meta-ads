import { describe, expect, it } from 'vitest';
import { HealthService, healthOptionsFrom } from './health.service.js';
import type { HealthOptions } from './health.service.js';

// TC-OPS-01 (unit part): each failing check gives a named failure; the real database case is in the integration test.

const options = (extra: Partial<HealthOptions> = {}): HealthOptions => ({
  minSchemaHead: 1,
  maxSchemaHead: 3,
  configValid: true,
  drainSeconds: 0,
  checkTimeoutMs: 50,
  ...extra,
});

function fakeDatabase(head: number | 'missing', query?: () => Promise<unknown>): never {
  return {
    pool: {
      query: (text: string): Promise<unknown> => {
        if (text.includes('to_regclass'))
          return Promise.resolve({ rows: [{ t: head === 'missing' ? null : 'x' }] });
        return query?.() ?? Promise.resolve({ rows: [] });
      },
    },
    db: { execute: () => Promise.resolve({ rows: [{ head }] }) },
  } as never;
}

describe('HealthService.failure', () => {
  it('is ready with no dependencies configured', async () => {
    expect(await new HealthService(options()).failure()).toBeNull();
  });

  it('is ready with the schema head in range and pg-boss installed', async () => {
    const boss = { isInstalled: async () => true } as never;
    expect(await new HealthService(options(), fakeDatabase(2), boss).failure()).toBeNull();
    expect(await new HealthService(options(), fakeDatabase(1), boss).failure()).toBeNull();
    expect(await new HealthService(options(), fakeDatabase(3), boss).failure()).toBeNull();
  });

  it('fails for a head below the minimum, above the maximum or with no migrations table', async () => {
    expect(await new HealthService(options({ minSchemaHead: 2 }), fakeDatabase(1)).failure()).toBe(
      'schema_head',
    );
    expect(await new HealthService(options(), fakeDatabase(4)).failure()).toBe('schema_head');
    expect(await new HealthService(options(), fakeDatabase('missing')).failure()).toBe(
      'schema_head',
    );
  });

  it('fails when the database errors or does not answer within the time limit', async () => {
    expect(
      await new HealthService(
        options(),
        fakeDatabase(2, () => Promise.reject(new Error('down'))),
      ).failure(),
    ).toBe('database');
    expect(
      await new HealthService(
        options(),
        fakeDatabase(2, () => new Promise(() => undefined)),
      ).failure(),
    ).toBe('database');
  });

  it('fails when pg-boss is not installed or not reachable', async () => {
    expect(
      await new HealthService(options(), undefined, {
        isInstalled: async () => false,
      } as never).failure(),
    ).toBe('queue');
    expect(
      await new HealthService(options(), undefined, {
        isInstalled: async () => {
          throw new Error('x');
        },
      } as never).failure(),
    ).toBe('queue');
  });

  it('fails when the configuration is not valid and while draining', async () => {
    expect(await new HealthService(options({ configValid: false })).failure()).toBe('config');
    const service = new HealthService(options());
    await service.beforeApplicationShutdown();
    expect(service.draining).toBe(true);
    expect(await service.failure()).toBe('draining');
  });
});

describe('healthOptionsFrom', () => {
  it('defaults to an open range and reads the environment', () => {
    expect(healthOptionsFrom({})).toMatchObject({
      minSchemaHead: 0,
      maxSchemaHead: Number.MAX_SAFE_INTEGER,
      drainSeconds: 0,
    });
    expect(
      healthOptionsFrom({ MIN_SCHEMA_HEAD: '2', MAX_SCHEMA_HEAD: '4' }, { API_DRAIN_SECONDS: 20 }),
    ).toMatchObject({
      minSchemaHead: 2,
      maxSchemaHead: 4,
      drainSeconds: 20,
    });
  });

  it('rejects a malformed or inverted range', () => {
    expect(() => healthOptionsFrom({ MIN_SCHEMA_HEAD: 'x' })).toThrow(/MIN_SCHEMA_HEAD/);
    expect(() => healthOptionsFrom({ MIN_SCHEMA_HEAD: '5', MAX_SCHEMA_HEAD: '2' })).toThrow(
      /must not exceed/,
    );
  });
});
