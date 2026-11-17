import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../../platform/http/auth.guard.js';
import { encodeCursor } from '../../../platform/http/cursor.js';
import type { DomainError } from '../../../platform/http/domain-error.js';
import { AdminUsersService, viewOf } from './admin-users.service.js';
import type { AdminUserListed, AdminUserRecord, AdminUserStore } from './admin.ports.js';
import { RevokeSessionsService, revokeSessionsHandler } from './revoke-sessions.service.js';
import { IdentityNotFound, IdentityUnavailable } from '../domain/identity-port.js';
import type { IdentityPort } from '../domain/identity-port.js';
import { AdminUsersController, versionOf } from '../transport/admin-users.controller.js';

const locks = vi.hoisted(() => ({ lockXact: vi.fn(() => Promise.resolve()) }));
vi.mock('../../../platform/db/index.js', async (original) => ({
  ...(await original<object>()),
  lockXact: locks.lockXact,
}));
const jobs = vi.hoisted(() => ({ enqueue: vi.fn(() => Promise.resolve('job')) }));
vi.mock('../../../platform/jobs/enqueue.js', () => jobs);

const KEY = 'k'.repeat(40);
const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const actor = { userId: ME, role: 'admin' } as ActorContext;
const T0 = new Date('2026-01-01T00:00:00.000Z');

const row = (over: Partial<AdminUserRecord> = {}): AdminUserRecord => ({
  id: OTHER,
  idpSubject: 'sub_other',
  email: 'other@example.test',
  role: 'admin',
  status: 'active',
  version: 3,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

class FakeStore implements AdminUserStore {
  rows = new Map<string, AdminUserRecord>();
  admins = 2;
  findById = vi.fn((_db: unknown, id: string) => Promise.resolve(this.rows.get(id)));
  setRole = vi.fn((_db: unknown, id: string, version: number, role: string) => {
    const current = this.rows.get(id);
    return Promise.resolve(
      current === undefined || current.version !== version
        ? undefined
        : { ...current, role, version: version + 1 },
    );
  });
  setStatus = vi.fn((_db: unknown, id: string, version: number, status: string) => {
    const current = this.rows.get(id);
    return Promise.resolve(
      current === undefined || current.version !== version
        ? undefined
        : { ...current, status, version: version + 1 },
    );
  });
  countActiveAdmins = vi.fn(() => Promise.resolve(this.admins));
}

let store: FakeStore;
let events: { action: string; actorType: string; outcome: string; objectId: string | null }[];
let announced: number;
let listed: AdminUserListed[];
let listArgs: unknown[];
const poolDb = { pool: true };

function make(key: string | null = KEY): AdminUsersService {
  const database = {
    db: poolDb,
    uow: { run: (fn: (tx: unknown) => Promise<unknown>) => fn({ tx: true }) },
  };
  return new AdminUsersService(
    database as never,
    store,
    {
      list: (_db: unknown, q: unknown) => {
        listArgs.push(q);
        return Promise.resolve(listed);
      },
    },
    {
      record: (_db: unknown, e: never) => {
        events.push(e);
        return Promise.resolve('id');
      },
    },
    {
      raiseAlert: () =>
        Promise.resolve({
          raised: true,
          alertId: 'a',
          announce: () => {
            announced += 1;
          },
        }),
    },
    {} as never,
    key ?? undefined,
  );
}

beforeEach(() => {
  store = new FakeStore();
  store.rows.set(OTHER, row());
  store.rows.set(ME, row({ id: ME, idpSubject: 'sub_me' }));
  events = [];
  announced = 0;
  listed = [];
  listArgs = [];
  locks.lockXact.mockClear();
  jobs.enqueue.mockClear();
});

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return (error as DomainError).code;
  }
  return 'none';
};

describe('setRole (API-104)', () => {
  it('demotes another admin under the lock, audits, alerts after commit and queues the session revoke', async () => {
    const result = await make().setRole(actor, OTHER, 'user', 3, 'req1');
    expect(result).toMatchObject({ changed: true, user: { role: 'user', version: 4 } });
    expect(locks.lockXact).toHaveBeenCalledWith({ tx: true }, 'admin-invariant');
    expect(events).toEqual([
      expect.objectContaining({
        action: 'role.revoked',
        outcome: 'allowed',
        actorType: 'admin',
        objectId: OTHER,
      }),
    ]);
    expect(announced).toBe(1);
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      { tx: true },
      'identity.revoke-sessions',
      { userId: OTHER },
    );
  });

  it('grants admin to a user with role.granted', async () => {
    store.rows.set(OTHER, row({ role: 'user' }));
    await make().setRole(actor, OTHER, 'admin', 3, 'req1');
    expect(events[0]?.action).toBe('role.granted');
  });

  it('answers 200 unchanged with no event, alert or job when the role is already set', async () => {
    const result = await make().setRole(actor, OTHER, 'admin', 99, 'req1');
    expect(result.changed).toBe(false);
    expect([events.length, announced, jobs.enqueue.mock.calls.length]).toEqual([0, 0, 0]);
  });

  it('refuses an unknown account, an inactive one and a stale version', async () => {
    expect(
      await refusal(make().setRole(actor, '00000000-0000-4000-8000-0000000000ff', 'user', 1, 'r')),
    ).toBe('not_found');
    store.rows.set(OTHER, row({ status: 'suspended' }));
    expect(await refusal(make().setRole(actor, OTHER, 'user', 3, 'r'))).toBe('state_conflict');
    store.rows.set(OTHER, row());
    expect(await refusal(make().setRole(actor, OTHER, 'user', 2, 'r'))).toBe('version_conflict');
    expect(events).toEqual([]);
  });

  it('turns a lost optimistic update into version_conflict', async () => {
    store.setRole.mockResolvedValueOnce(undefined);
    expect(await refusal(make().setRole(actor, OTHER, 'user', 3, 'r'))).toBe('version_conflict');
  });

  it('refuses acting on oneself with self_action and an audit event (commit, then error)', async () => {
    expect(await refusal(make().setRole(actor, ME, 'user', 3, 'r'))).toBe('self_action');
    expect(events).toEqual([
      expect.objectContaining({
        action: 'admin_invariant.refused',
        outcome: 'denied',
        objectId: ME,
      }),
    ]);
    expect(store.setRole).not.toHaveBeenCalled();
  });

  it('refuses self-grant of admin too (a user cannot reach this route, an admin granting itself is a no-op earlier)', async () => {
    store.rows.set(ME, row({ id: ME, role: 'user' }));
    expect(await refusal(make().setRole(actor, ME, 'admin', 3, 'r'))).toBe('self_action');
  });

  it('refuses to demote the last active admin with last_admin and an audit event', async () => {
    store.admins = 1;
    expect(await refusal(make().setRole(actor, OTHER, 'user', 3, 'r'))).toBe('last_admin');
    expect(events[0]).toMatchObject({ action: 'admin_invariant.refused', outcome: 'denied' });
    expect(store.setRole).not.toHaveBeenCalled();
    expect(announced).toBe(0);
  });
});

describe('setStatus (lifecycle caller) and assertAdminInvariant', () => {
  const tx = { tx: true } as never;
  const input = (over: object = {}) => ({
    actorId: ME as string | null,
    userId: OTHER,
    status: 'suspended' as const,
    expectedVersion: 3,
    ...over,
  });

  it('suspends and removes another admin while one remains, and queues a session revoke', async () => {
    expect(await make().setStatus(tx, input())).toMatchObject({ status: 'suspended', version: 4 });
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(await make().setStatus(tx, input({ status: 'removed' }))).toMatchObject({
      status: 'removed',
    });
  });

  it('reinstates without the invariant and without a job', async () => {
    store.rows.set(OTHER, row({ status: 'suspended' }));
    store.admins = 1;
    expect(await make().setStatus(tx, input({ status: 'active' }))).toMatchObject({
      status: 'active',
    });
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('returns the account unchanged for the status it already has, and refuses a removed account', async () => {
    expect(await make().setStatus(tx, input({ status: 'active' }))).toMatchObject({ version: 3 });
    store.rows.set(OTHER, row({ status: 'removed' }));
    expect(await refusal(make().setStatus(tx, input({ status: 'active' })))).toBe('state_conflict');
    expect(
      await refusal(
        make().setStatus(tx, input({ userId: '00000000-0000-4000-8000-0000000000ff' })),
      ),
    ).toBe('not_found');
  });

  it('refuses a stale version and a lost update', async () => {
    expect(await refusal(make().setStatus(tx, input({ expectedVersion: 1 })))).toBe(
      'version_conflict',
    );
    store.setStatus.mockResolvedValueOnce(undefined);
    expect(await refusal(make().setStatus(tx, input()))).toBe('version_conflict');
  });

  it('refuses the last admin and oneself, each with an audit event on its own connection', async () => {
    store.admins = 1;
    expect(await refusal(make().setStatus(tx, input({ actorId: null })))).toBe('last_admin');
    expect(events[0]).toMatchObject({ actorType: 'system', action: 'admin_invariant.refused' });
    expect(await refusal(make().setStatus(tx, input({ userId: ME, status: 'removed' })))).toBe(
      'self_action',
    );
    expect(events[1]).toMatchObject({ actorType: 'admin', objectId: ME });
    expect(store.setStatus).not.toHaveBeenCalled();
  });

  it('does not audit an unrelated failure', async () => {
    store.countActiveAdmins.mockRejectedValueOnce(new Error('db down'));
    await expect(make().setStatus(tx, input())).rejects.toThrow('db down');
    expect(events).toEqual([]);
  });

  it('lets a plain user target and an inactive admin through the last-admin check', async () => {
    store.admins = 1;
    await make().assertAdminInvariant(tx, ME, row({ role: 'user' }), 'demote');
    await make().assertAdminInvariant(tx, ME, row({ status: 'suspended' }), 'remove');
  });
});

describe('listUsers (API-100)', () => {
  const rowOf = (n: number): AdminUserListed => ({
    ...row({ id: `00000000-0000-4000-8000-00000000010${String(n)}` }),
    createdAtKey: `2026-01-0${String(n)} 00:00:00.123456+00`,
  });

  it('pages with a signed cursor, returns email and the filter', async () => {
    listed = [rowOf(3), rowOf(2), rowOf(1)];
    const page = await make().listUsers(actor, { limit: 2, status: 'active' });
    expect(page.items.map((u) => u.email)).toEqual(['other@example.test', 'other@example.test']);
    expect(page.pagination).toMatchObject({ hasNextPage: true, returnedCount: 2 });
    expect(listArgs[0]).toEqual({ limit: 3, status: 'active' });
    listed = [];
    const next = await make().listUsers(actor, {
      limit: 2,
      status: 'active',
      cursor: page.pagination.nextCursor ?? '',
    });
    expect(next.items).toEqual([]);
    expect(listArgs[1]).toMatchObject({
      after: { createdAt: '2026-01-02 00:00:00.123456+00', id: rowOf(2).id },
    });
  });

  it('refuses a cursor for other filters, a tampered one and a malformed sort key', async () => {
    listed = [rowOf(2), rowOf(1)];
    const page = await make().listUsers(actor, { limit: 1 });
    const cursor = page.pagination.nextCursor ?? '';
    expect(await refusal(make().listUsers(actor, { limit: 1, status: 'removed', cursor }))).toBe(
      'validation_failed',
    );
    expect(await refusal(make().listUsers(actor, { limit: 1, cursor: `${cursor}x` }))).toBe(
      'validation_failed',
    );
    const scope = { owner: ME, filters: { status: null } };
    for (const bad of [
      'nodivider',
      'x|not-an-id',
      'not a date|00000000-0000-4000-8000-000000000101',
    ]) {
      expect(
        await refusal(make().listUsers(actor, { limit: 1, cursor: encodeCursor(KEY, scope, bad) })),
      ).toBe('validation_failed');
    }
  });

  it('fails closed when no signing key is configured', async () => {
    await expect(make(null).listUsers(actor, { limit: 1 })).rejects.toThrow('CURSOR_SIGNING_KEY');
  });

  it('maps unknown stored values to the safe defaults', () => {
    expect(viewOf(row({ role: 'weird', status: 'weird' }))).toMatchObject({
      role: 'user',
      status: 'active',
      erasure: null,
    });
  });
});

describe('identity.revoke-sessions handler', () => {
  const make = (identity: Partial<IdentityPort>) =>
    new RevokeSessionsService(identity as IdentityPort, { db: poolDb } as never, store);

  it('ends the provider sessions of the account', async () => {
    const revokeSessions = vi.fn(() => Promise.resolve());
    await revokeSessionsHandler(make({ revokeSessions }))({ data: { userId: OTHER } });
    expect(revokeSessions).toHaveBeenCalledWith('sub_other');
  });

  it('ends quietly for an unknown account or a subject the provider no longer has', async () => {
    const revokeSessions = vi.fn(() => Promise.reject(new IdentityNotFound('revokeSessions')));
    await make({ revokeSessions }).handle({ userId: '00000000-0000-4000-8000-0000000000ff' });
    expect(revokeSessions).not.toHaveBeenCalled();
    await make({ revokeSessions }).handle({ userId: OTHER });
  });

  it('throws on a provider outage so the queue retries, and on malformed data', async () => {
    const revokeSessions = vi.fn(() =>
      Promise.reject(new IdentityUnavailable('revokeSessions', 'timeout')),
    );
    await expect(make({ revokeSessions }).handle({ userId: OTHER })).rejects.toBeInstanceOf(
      IdentityUnavailable,
    );
    await expect(make({}).handle(null)).rejects.toThrow(TypeError);
  });
});

describe('transport', () => {
  it('reads If-Match as the ETag version', () => {
    expect(versionOf('"3"')).toBe(3);
    for (const bad of [undefined, '3', '"0"', '"x"', 'W/"3"', '"12345678901"']) {
      expect(() => versionOf(bad)).toThrow(expect.objectContaining({ code: 'validation_failed' }));
    }
  });

  it('validates the query, the path id and the body, and sets the ETag', async () => {
    const calls: unknown[] = [];
    const admin = {
      listUsers: (_a: unknown, input: unknown) => {
        calls.push(input);
        return Promise.resolve('page');
      },
      setRole: (...args: unknown[]) => {
        calls.push(args.slice(1));
        return Promise.resolve({ user: { version: 4 } });
      },
    };
    const controller = new AdminUsersController(admin as never);
    await controller.list(actor, { limit: '5', status: 'removed' });
    await controller.list(actor, undefined);
    expect(calls.slice(0, 2)).toEqual([{ limit: 5, status: 'removed' }, { limit: 20 }]);
    for (const bad of [
      { limit: '0' },
      { limit: '51' },
      { status: 'gone' },
      { cursor: 'x'.repeat(513) },
    ]) {
      expect(() => controller.list(actor, bad)).toThrow(
        expect.objectContaining({ code: 'validation_failed' }),
      );
    }
    const header = vi.fn();
    const reply = { header } as never;
    const request = { id: 'req-1' } as never;
    const result = await controller.setRole(actor, OTHER, { role: 'user' }, '"3"', request, reply);
    expect(result).toEqual({ version: 4 });
    expect(header).toHaveBeenCalledWith('ETag', '"4"');
    expect(calls[2]).toEqual([OTHER, 'user', 3, 'req-1']);
    await expect(
      controller.setRole(actor, 'nope', { role: 'user' }, '"3"', request, reply),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      controller.setRole(actor, OTHER, { role: 'root' }, '"3"', request, reply),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      controller.setRole(actor, OTHER, { role: 'user', extra: 1 }, '"3"', request, reply),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      controller.setRole(actor, OTHER, { role: 'user' }, undefined, request, reply),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
