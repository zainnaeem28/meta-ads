import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from './database.js';
import type { Database } from './database.js';
import { guardEgress } from './egress.js';
import {
  EgressInTransactionError,
  LockOrderError,
  LockTimeoutError,
  StatementTimeoutError,
} from './errors.js';
import { lockXact, tryRecoverySweepLock } from './locks.js';
import { assertRoleTimeouts } from './timeouts.js';
import { createTestDatabase, databaseExists, withTestDatabase } from './test-database.js';
import type { TestDatabase } from './test-database.js';

// TASK-024 on the shared test PostgreSQL: two connections for lock order and lock_timeout, the egress guard,
// the recovery-sweep session lock and the test database helper itself.

let testDb: TestDatabase;
let database: Database;

beforeAll(async () => {
  testDb = await createTestDatabase({ label: 'task024', migrations: false });
  database = createDatabase({
    DATABASE_URL: testDb.url,
    DATABASE_POOL_MAX: 6,
    DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
  });
});

afterAll(async () => {
  await database?.close();
  await testDb?.drop();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('unit of work on real PostgreSQL', () => {
  it('commits, rolls back and starts a database the startup check accepts', async () => {
    await database.checkReady();
    await database.pool.query('create table uow_probe (id int primary key)');
    await database.uow.run(async (tx) => {
      await tx.execute('insert into uow_probe values (1)' as never);
    });
    await expect(
      database.uow.run(async (tx) => {
        await tx.execute('insert into uow_probe values (2)' as never);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const rows = await database.pool.query('select id from uow_probe order by id');
    expect(rows.rows).toEqual([{ id: 1 }]);
  });

  it('maps statement_timeout to a typed error', async () => {
    await expect(
      database.uow.run(async (tx) => tx.execute('select pg_sleep(2)' as never), {
        statementTimeoutMs: 100,
      }),
    ).rejects.toBeInstanceOf(StatementTimeoutError);
  });
});

describe('advisory locks with two connections', () => {
  it('makes the second transaction wait for the first, and times out with lock_timeout', async () => {
    let releaseFirst: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstHasLock: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => (firstHasLock = resolve));

    const first = database.uow.run(async (tx) => {
      await lockXact(tx, 'spend', 'owner-a');
      firstHasLock();
      await held;
    });
    await locked;

    const started = Date.now();
    const second = database.uow.run((tx) => lockXact(tx, 'spend', 'owner-a'), {
      lockTimeoutMs: 300,
    });
    await expect(second).rejects.toBeInstanceOf(LockTimeoutError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);

    // A different owner is not blocked; the same owner proceeds once the first transaction ends.
    await database.uow.run((tx) => lockXact(tx, 'spend', 'owner-b'), { lockTimeoutMs: 300 });
    let waiterDone = false;
    const waiter = database.uow
      .run((tx) => lockXact(tx, 'spend', 'owner-a'), { lockTimeoutMs: 5000 })
      .then(() => (waiterDone = true));
    await sleep(200);
    expect(waiterDone).toBe(false);
    releaseFirst();
    await first;
    await waiter;
    expect(waiterDone).toBe(true);
  });

  it('refuses the order that would deadlock before PostgreSQL sees it', async () => {
    const results = await Promise.allSettled([
      database.uow.run(async (tx) => {
        await lockXact(tx, 'admin-invariant');
        await sleep(100);
        await lockXact(tx, 'spend', 'o');
        await lockXact(tx, 'render-day', 'o');
        await lockXact(tx, 'run', 'o');
      }),
      database.uow.run(async (tx) => {
        await lockXact(tx, 'run', 'o');
        await sleep(100);
        await lockXact(tx, 'admin-invariant');
      }),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(LockOrderError);
  });

  it('keeps exactly one holder of the recovery-sweep session lock', async () => {
    const first = await tryRecoverySweepLock(database.pool);
    expect(first).not.toBeNull();
    const other = new pg.Pool({ connectionString: testDb.url, max: 1 });
    try {
      expect(await tryRecoverySweepLock(other)).toBeNull();
      await first?.release();
      const second = await tryRecoverySweepLock(other);
      expect(second).not.toBeNull();
      await second?.release();
    } finally {
      await other.end();
    }
  });
});

describe('egress inside a lock-holding transaction', () => {
  let server: Server;
  let url = '';
  let requests = 0;

  beforeAll(async () => {
    server = createServer((_request, response) => {
      requests += 1;
      response.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('rejects the call before any request leaves, and allows it after the commit', async () => {
    const guardedFetch = guardEgress('provider call', fetch);
    await expect(
      database.uow.run(async (tx) => {
        await lockXact(tx, 'spend', 'owner-c');
        await guardedFetch(url);
      }),
    ).rejects.toThrow(EgressInTransactionError);
    expect(requests).toBe(0);
    expect((await guardedFetch(url)).status).toBe(200);
    expect(requests).toBe(1);
  });
});

describe('role timeouts', () => {
  it('reads the defaults a role was provisioned with and fails closed when they differ', async () => {
    const role = `t_task024_${Date.now().toString(36)}`;
    await database.pool.query(`CREATE ROLE ${role} LOGIN`);
    await database.pool.query(`ALTER ROLE ${role} SET statement_timeout = '5s'`);
    await database.pool.query(`ALTER ROLE ${role} SET lock_timeout = '2s'`);
    await database.pool.query(`ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '10s'`);
    const url = new URL(testDb.url);
    url.username = role;
    const asRole = new pg.Pool({ connectionString: url.toString(), max: 1 });
    try {
      const expected = {
        statement_timeout: 5000,
        lock_timeout: 2000,
        idle_in_transaction_session_timeout: 10000,
      };
      await expect(assertRoleTimeouts(asRole, { [role]: expected })).resolves.toBe(role);
      await expect(
        assertRoleTimeouts(asRole, { [role]: { ...expected, lock_timeout: 5000 } }),
      ).rejects.toThrow(`role ${role} has lock_timeout 2000ms, expected 5000ms`);
    } finally {
      await asRole.end();
      await database.pool.query(`DROP ROLE ${role}`);
    }
  });
});

describe('test database helper', () => {
  it('creates a uniquely named database, applies nothing without a journal, and leaves nothing behind', async () => {
    const names: string[] = [];
    await withTestDatabase(
      async (one) => {
        names.push(one.name);
        await withTestDatabase(
          async (two) => {
            names.push(two.name);
            expect(two.name).not.toBe(one.name);
            expect(await databaseExists(one.name)).toBe(true);
            expect(await databaseExists(two.name)).toBe(true);
          },
          { label: 'task024' },
        );
        expect(one.migrationsApplied).toBe(false);
      },
      { label: 'task024' },
    );
    for (const name of names) expect(await databaseExists(name)).toBe(false);
    expect(names.every((name) => /^t_task024_[0-9a-f]{12}$/.test(name))).toBe(true);
  });

  it('drops the database when the work inside fails', async () => {
    let name = '';
    await expect(
      withTestDatabase(async (one) => {
        name = one.name;
        throw new Error('test body failed');
      }),
    ).rejects.toThrow('test body failed');
    expect(await databaseExists(name)).toBe(false);
  });

  it('refuses a server that is not the test server before connecting', async () => {
    const saved = process.env['TEST_DATABASE_ADMIN_URL'];
    process.env['TEST_DATABASE_ADMIN_URL'] = 'postgres://postgres@db:5432/postgres';
    try {
      await expect(createTestDatabase()).rejects.toThrow('only runs on the test server');
    } finally {
      if (saved === undefined) delete process.env['TEST_DATABASE_ADMIN_URL'];
      else process.env['TEST_DATABASE_ADMIN_URL'] = saved;
    }
  });
});
