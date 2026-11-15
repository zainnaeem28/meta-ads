import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { Database } from './database.js';
import { DATABASE, DatabaseLifecycle, DatabaseModule } from './database.module.js';
import { assertNoEgress, guardEgress } from './egress.js';
import {
  DatabaseUnavailableError,
  EgressInTransactionError,
  LockOrderError,
  LockTimeoutError,
  NestedTransactionError,
  StatementTimeoutError,
  isUniqueViolation,
  normalizeDbError,
  pgErrorOf,
} from './errors.js';
import { LOCK_ORDER, lockName, lockXact, tryRecoverySweepLock } from './locks.js';
import { IDLE_TIMEOUT_MS, createPool, dbConfigOf } from './pools.js';
import { ROLE_TIMEOUTS, assertRoleTimeouts, parseMillis } from './timeouts.js';
import { UnitOfWork } from './unit-of-work.js';
import type { DbTx } from './unit-of-work.js';

function fakeUow(): { uow: UnitOfWork; executed: string[]; tx: DbTx } {
  const executed: string[] = [];
  const tx = {
    execute: vi.fn((query: { queryChunks?: unknown[] }) => {
      executed.push(JSON.stringify(query.queryChunks ?? []));
      return Promise.resolve({ rows: [] });
    }),
  } as unknown as DbTx;
  const uow = new UnitOfWork({ transaction: (fn) => fn(tx) });
  return { uow, executed, tx };
}

describe('lock names and order', () => {
  it('builds the documented names', () => {
    expect(lockName('admin-invariant')).toBe('admin-invariant');
    expect(lockName('spend', 'o1')).toBe('spend:o1');
    expect(lockName('render-day', 'o1')).toBe('render-day:o1');
    expect(lockName('run', 'o1')).toBe('run:o1');
    expect(() => lockName('spend')).toThrow('needs an owner id');
    expect(LOCK_ORDER).toEqual(['admin-invariant', 'spend', 'render-day', 'run']);
  });

  it('accepts the documented order and a repeat of a held lock', async () => {
    const { uow, executed } = fakeUow();
    await uow.run(async (tx) => {
      await lockXact(tx, 'admin-invariant');
      await lockXact(tx, 'spend', 'o1');
      await lockXact(tx, 'spend', 'o1');
      await lockXact(tx, 'render-day', 'o1');
      await lockXact(tx, 'run', 'o1');
    });
    expect(executed).toHaveLength(4);
  });

  it('rejects a lock taken out of order or a second lock of one kind', async () => {
    const { uow } = fakeUow();
    await expect(
      uow.run(async (tx) => {
        await lockXact(tx, 'run', 'o1');
        await lockXact(tx, 'spend', 'o1');
      }),
    ).rejects.toBeInstanceOf(LockOrderError);
    await expect(
      uow.run(async (tx) => {
        await lockXact(tx, 'spend', 'o1');
        await lockXact(tx, 'spend', 'o2');
      }),
    ).rejects.toThrow('spend:o2 requested after spend:o1');
  });

  it('refuses a handle the unit of work did not create', async () => {
    await expect(
      lockXact({ execute: vi.fn() } as unknown as DbTx, 'admin-invariant'),
    ).rejects.toThrow('not a transaction handle');
  });
});

describe('unit of work', () => {
  it('sets transaction timeouts and rejects a nested transaction', async () => {
    const { uow, executed } = fakeUow();
    await uow.run(async () => undefined, { lockTimeoutMs: 200, statementTimeoutMs: 1000 });
    expect(executed.join()).toContain('lock_timeout');
    expect(executed.join()).toContain('statement_timeout');
    await expect(uow.run(() => uow.run(async () => undefined))).rejects.toBeInstanceOf(
      NestedTransactionError,
    );
    await expect(uow.run(async () => undefined, { lockTimeoutMs: -1 })).rejects.toThrow(
      'non-negative',
    );
  });

  it('maps timeout failures to typed errors and leaves others alone', async () => {
    const lock = new UnitOfWork({
      transaction: () => Promise.reject(Object.assign(new Error('x'), { code: '55P03' })),
    });
    await expect(lock.run(async () => 1)).rejects.toBeInstanceOf(LockTimeoutError);
    const statement = new UnitOfWork({
      transaction: () => Promise.reject(new Error('wrapped', { cause: { code: '57014' } })),
    });
    await expect(statement.run(async () => 1)).rejects.toBeInstanceOf(StatementTimeoutError);
    const other = new UnitOfWork({ transaction: () => Promise.reject(new Error('plain')) });
    await expect(other.run(async () => 1)).rejects.toThrow('plain');
  });
});

describe('egress guard', () => {
  it('passes outside a transaction and rejects inside one, naming a held lock', async () => {
    assertNoEgress('provider call');
    const call = guardEgress('provider call', (value: number) => value + 1);
    expect(call(1)).toBe(2);
    const { uow } = fakeUow();
    await expect(uow.run(async () => call(1))).rejects.toThrow('inside a database transaction');
    await expect(
      uow.run(async (tx) => {
        await lockXact(tx, 'spend', 'o1');
        assertNoEgress('r2 put');
      }),
    ).rejects.toThrow(EgressInTransactionError);
    await expect(
      uow.run(async (tx) => {
        await lockXact(tx, 'spend', 'o1');
        assertNoEgress('r2 put');
      }),
    ).rejects.toThrow('holds an advisory lock');
  });
});

describe('errors', () => {
  it('reads PostgreSQL codes through wrappers', () => {
    expect(pgErrorOf(new Error('w', { cause: { code: '23505', constraint: 'u' } }))).toEqual({
      code: '23505',
      constraint: 'u',
    });
    expect(pgErrorOf({ code: 'ECONNREFUSED' })).toBeUndefined();
    expect(pgErrorOf('text')).toBeUndefined();
    expect(isUniqueViolation({ code: '23505', constraint: 'u' }, 'u')).toBe(true);
    expect(isUniqueViolation({ code: '23505', constraint: 'u' }, 'other')).toBe(false);
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    const plain = new Error('x');
    expect(normalizeDbError(plain)).toBe(plain);
  });
});

describe('timeouts', () => {
  it('parses SHOW output', () => {
    expect(parseMillis('5s')).toBe(5000);
    expect(parseMillis('2000ms')).toBe(2000);
    expect(parseMillis('30')).toBe(30);
    expect(parseMillis('1min')).toBe(60000);
    expect(() => parseMillis('soon')).toThrow('unreadable');
    expect(() => parseMillis('3 fortnights')).toThrow('unreadable');
  });

  function poolFor(role: string, shown: Record<string, string>): pg.Pool {
    return {
      query: vi.fn((text: string) => {
        if (text.includes('current_user')) return Promise.resolve({ rows: [{ role }] });
        const setting = /current_setting\('(\w+)'\)/.exec(text)?.[1] ?? '';
        return Promise.resolve({ rows: [{ value: shown[setting] ?? '' }] });
      }),
    } as unknown as pg.Pool;
  }

  it('checks application roles and ignores other roles', async () => {
    const api = ROLE_TIMEOUTS['app_api']!;
    const good = {
      statement_timeout: `${api.statement_timeout}ms`,
      lock_timeout: '2s',
      idle_in_transaction_session_timeout: '10s',
    };
    await expect(assertRoleTimeouts(poolFor('app_api', good))).resolves.toBe('app_api');
    await expect(
      assertRoleTimeouts(poolFor('app_api', { ...good, lock_timeout: '0' })),
    ).rejects.toThrow('role app_api has lock_timeout 0ms, expected 2000ms');
    await expect(assertRoleTimeouts(poolFor('postgres', {}))).resolves.toBe('postgres');
    await expect(
      assertRoleTimeouts({ query: () => Promise.resolve({ rows: [] }) } as unknown as pg.Pool),
    ).resolves.toBe('');
  });
});

describe('pool configuration', () => {
  const config = {
    DATABASE_URL: 'postgres://u@localhost:5432/d',
    DATABASE_POOL_MAX: 10,
    DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
  };

  it('takes size and acquire timeout from configuration', async () => {
    const pool = createPool(config);
    const options = pool.options as {
      max: number;
      connectionTimeoutMillis: number;
      idleTimeoutMillis: number;
    };
    expect([options.max, options.connectionTimeoutMillis, options.idleTimeoutMillis]).toEqual([
      10,
      5000,
      IDLE_TIMEOUT_MS,
    ]);
    pool.emit('error', new Error('idle client failed'));
    await pool.end();
    const reported: Error[] = [];
    const small = createPool(config, { max: 2, onError: (e) => reported.push(e) });
    small.emit('error', new Error('boom'));
    expect(reported).toHaveLength(1);
    expect((small.options as { max: number }).max).toBe(2);
    await small.end();
  });

  it('names the missing key', () => {
    expect(dbConfigOf(config)).toEqual(config);
    expect(() => dbConfigOf({})).toThrow('DATABASE_URL is required');
    expect(() => dbConfigOf({ DATABASE_URL: 'x' })).toThrow('DATABASE_POOL_MAX is required');
    expect(() => dbConfigOf({ DATABASE_URL: 'x', DATABASE_POOL_MAX: 1 })).toThrow(
      'ACQUIRE_TIMEOUT',
    );
  });
});

describe('Database', () => {
  it('reports an unreachable database by code, never by address', async () => {
    const pool = {
      query: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('connect 10.0.0.1'), { code: 'ECONNREFUSED' })),
    };
    const database = new Database(pool as unknown as pg.Pool);
    const failure = await database.checkReady().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DatabaseUnavailableError);
    expect((failure as Error).message).toBe(
      'database check failed: cannot run a query (ECONNREFUSED)',
    );
    const noCode = new Database({
      query: vi.fn().mockRejectedValue(new Error('x')),
    } as unknown as pg.Pool);
    await expect(noCode.checkReady()).rejects.toThrow('(error)');
  });

  it('registers the pool as a global provider that opens lazily and closes', async () => {
    const config = {
      DATABASE_URL: 'postgres://u@localhost:5/d',
      DATABASE_POOL_MAX: 2,
      DATABASE_ACQUIRE_TIMEOUT_MS: 100,
    };
    const module = DatabaseModule.forRoot(config);
    expect(module.global).toBe(true);
    expect(module.exports).toEqual([DATABASE]);
    const provider = (module.providers ?? [])[0] as { useFactory: () => Database };
    const database = provider.useFactory();
    expect((database.pool.options as { max: number }).max).toBe(2);
    await database.close();
  });

  it('passes the check and closes the pool through the lifecycle', async () => {
    const pool = {
      query: vi
        .fn()
        .mockImplementation((text: string) =>
          Promise.resolve({ rows: text.includes('current_user') ? [{ role: 'postgres' }] : [{}] }),
        ),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const database = new Database(pool as unknown as pg.Pool);
    const lifecycle = new DatabaseLifecycle(database);
    await lifecycle.onModuleInit();
    await lifecycle.onApplicationShutdown();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});

describe('recovery-sweep session lock', () => {
  function pool(results: boolean[], failUnlock = false) {
    const release = vi.fn();
    const client = {
      query: vi.fn((text: string) => {
        if (text.includes('pg_advisory_unlock') && failUnlock)
          return Promise.reject(new Error('gone'));
        return Promise.resolve({ rows: [{ locked: results.shift() }] });
      }),
      release,
    };
    return {
      pool: { connect: () => Promise.resolve(client) } as unknown as pg.Pool,
      client,
      release,
    };
  }

  it('returns null and frees the connection when another session holds it', async () => {
    const { pool: p, release } = pool([false]);
    expect(await tryRecoverySweepLock(p)).toBeNull();
    expect(release).toHaveBeenCalledOnce();
  });

  it('holds the connection until released, once', async () => {
    const { pool: p, release } = pool([true]);
    const lock = await tryRecoverySweepLock(p);
    expect(release).not.toHaveBeenCalled();
    await lock?.release();
    await lock?.release();
    expect(release).toHaveBeenCalledOnce();
  });

  it('discards the connection when the unlock fails', async () => {
    const { pool: p, release } = pool([true], true);
    const lock = await tryRecoverySweepLock(p);
    await expect(lock?.release()).rejects.toThrow('gone');
    expect(release).toHaveBeenCalledWith(true);
  });
});
