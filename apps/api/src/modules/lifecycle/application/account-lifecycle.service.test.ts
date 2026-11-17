import { describe, expect, it, vi } from 'vitest';
import type { DbTx } from '../../../platform/db/index.js';
import { AccountLifecycleService, confirmationMatches } from './account-lifecycle.service.js';
import type {
  AccountLifecycleRepository,
  AccountSubject,
  AccountView,
} from './account-lifecycle-ports.js';

const tx = {} as DbTx;

function subject(over: Partial<AccountSubject> = {}): AccountSubject {
  return {
    id: 'user-1',
    email: 'user1@example.test',
    idpSubject: 'idp-1',
    role: 'user',
    status: 'active',
    version: 3,
    ...over,
  };
}

function view(status: AccountView['status'], version = 4): AccountView {
  return {
    id: 'user-1',
    email: 'user1@example.test',
    role: 'user',
    status,
    version,
    createdAt: 'c',
    updatedAt: 'u',
    erasure: null,
  };
}

function setup(
  over: {
    target?: AccountSubject | undefined;
    brief?: { id: string; state: string; callCount: number }[];
    hold?: number;
    key?: string | undefined;
    rows?: unknown[];
  } = {},
) {
  const calls: string[] = [];
  const repository = {
    lockAndFind: vi.fn(() => Promise.resolve('target' in over ? over.target : subject())),
    cancelBriefJobs: vi.fn(() => Promise.resolve(over.brief ?? [])),
    deleteKeys: vi.fn(() => {
      calls.push('keys');
      return Promise.resolve(1);
    }),
    hideCampaigns: vi.fn(() => {
      calls.push('campaigns');
      return Promise.resolve(1);
    }),
    insertRun: vi.fn((_tx: DbTx, run: { id: string }) => {
      calls.push(`run:${run.id}`);
      return Promise.resolve();
    }),
    findRun: vi.fn((_tx: DbTx, id: string) =>
      Promise.resolve(id === 'run-1' ? { id, subjectId: 'user-1' } : undefined),
    ),
    resume: vi.fn(() => Promise.resolve(true)),
    listRuns: vi.fn(() => Promise.resolve(over.rows ?? [])),
  } as unknown as AccountLifecycleRepository;
  const admin = {
    setStatus: vi.fn((_tx: DbTx, input: { status: AccountView['status'] }) => {
      calls.push(`status:${input.status}`);
      return Promise.resolve(view(input.status));
    }),
  };
  const queue = {
    send: vi.fn((_tx: DbTx, runId: string, options: object = {}) => {
      calls.push(`send:${runId}:${JSON.stringify(options)}`);
      return Promise.resolve();
    }),
  };
  const video = { cancelForOwner: vi.fn(() => Promise.resolve(1)) };
  const usage = {
    convertUnconfirmed: vi.fn(() => Promise.resolve({ recorded: true, costUsd: '0' })),
    release: vi.fn(() => Promise.resolve(true)),
  };
  const audit = { record: vi.fn(() => Promise.resolve('a')) };
  const service = new AccountLifecycleService(
    { uow: { run: (fn: (t: DbTx) => Promise<unknown>) => fn(tx) }, db: tx } as never,
    repository,
    admin,
    queue,
    video as never,
    usage as never,
    audit as never,
    'text-model',
    over.hold ?? 0,
    'key' in over ? over.key : 'k'.repeat(40),
  );
  return { service, repository, admin, queue, video, usage, audit, calls };
}

describe('API-101 suspend', () => {
  it('changes the status, cancels every unfinished job with its reservation and audits', async () => {
    const s = setup({
      brief: [
        { id: 'b1', state: 'pending', callCount: 0 },
        { id: 'b2', state: 'submitting', callCount: 1 },
      ],
    });
    const result = await s.service.suspend('admin-1', 'user-1', 'req-1');
    expect(result.status).toBe('suspended');
    expect(s.admin.setStatus).toHaveBeenCalledWith(tx, {
      actorId: 'admin-1',
      userId: 'user-1',
      status: 'suspended',
      expectedVersion: 3,
    });
    expect(s.video.cancelForOwner).toHaveBeenCalledWith(
      tx,
      'user-1',
      'cancelled_account_suspended',
    );
    expect(s.usage.release).toHaveBeenCalledTimes(2);
    expect(s.usage.convertUnconfirmed).toHaveBeenCalledOnce();
    expect(s.audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'account.suspended',
        actorId: 'admin-1',
        actorType: 'admin',
        objectId: 'user-1',
        requestId: 'req-1',
      }),
    );
  });

  it('an already suspended account is returned unchanged with no cancel and no event', async () => {
    const s = setup({ target: subject({ status: 'suspended' }) });
    expect((await s.service.suspend('admin-1', 'user-1', null)).status).toBe('suspended');
    expect(s.video.cancelForOwner).not.toHaveBeenCalled();
    expect(s.audit.record).not.toHaveBeenCalled();
  });

  it('an unknown account is not found and a removed one is a state conflict', async () => {
    await expect(
      setup({ target: undefined }).service.suspend('a', 'user-1', null),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      setup({ target: subject({ status: 'removed' }) }).service.suspend('a', 'user-1', null),
    ).rejects.toMatchObject({ code: 'state_conflict' });
  });
});

describe('API-102 reinstate', () => {
  it('reactivates a suspended account and audits once; an active one is unchanged', async () => {
    const s = setup({ target: subject({ status: 'suspended' }) });
    expect((await s.service.reinstate('admin-1', 'user-1', null)).status).toBe('active');
    expect(s.audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'account.reinstated' }),
    );
    const unchanged = setup();
    await unchanged.service.reinstate('admin-1', 'user-1', null);
    expect(unchanged.audit.record).not.toHaveBeenCalled();
  });
});

describe('API-103 remove', () => {
  it('does everything in one transaction in order: status, jobs, keys, campaigns, run, job, audit', async () => {
    const s = setup();
    const accepted = await s.service.remove('admin-1', 'user-1', '  USER1@example.test ', 'req-1');
    expect(accepted.state).toBe('running');
    expect(s.calls).toEqual([
      'status:removed',
      'keys',
      'campaigns',
      `run:${accepted.deletionRunId}`,
      `send:${accepted.deletionRunId}:{}`,
    ]);
    expect(s.video.cancelForOwner).toHaveBeenCalledWith(tx, 'user-1', 'cancelled_account_removed');
    expect(s.audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'account.removed', objectId: 'user-1' }),
    );
  });

  it('a hold period delays the first step', async () => {
    const s = setup({ hold: 2 });
    const accepted = await s.service.remove('admin-1', 'user-1', 'user1@example.test', null);
    expect(s.repository.insertRun).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ holdHours: 2 }),
    );
    expect(s.calls.at(-1)).toBe(`send:${accepted.deletionRunId}:{"startAfterSec":7200}`);
  });

  it('a missing or wrong confirmation changes nothing', async () => {
    const s = setup();
    await expect(
      s.service.remove('admin-1', 'user-1', 'other@example.test', null),
    ).rejects.toMatchObject({ code: 'confirmation_mismatch' });
    expect(s.admin.setStatus).not.toHaveBeenCalled();
    expect(s.repository.deleteKeys).not.toHaveBeenCalled();
    expect(s.queue.send).not.toHaveBeenCalled();
    expect(s.audit.record).not.toHaveBeenCalled();
  });

  it('a removed or unknown account is refused', async () => {
    await expect(
      setup({ target: subject({ status: 'removed' }) }).service.remove(
        'a',
        'user-1',
        'user1@example.test',
        null,
      ),
    ).rejects.toMatchObject({ code: 'state_conflict' });
    await expect(
      setup({ target: undefined }).service.remove('a', 'user-1', 'user1@example.test', null),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('matches the typed identifier case-insensitively and trimmed', () => {
    expect(confirmationMatches(' A@B.test ', 'a@b.test')).toBe(true);
    expect(confirmationMatches('a@b.tes', 'a@b.test')).toBe(false);
  });
});

describe('API-105 and the resume', () => {
  it('lists runs with a cursor and refuses a missing signing key or a bad cursor', async () => {
    const row = (id: string) => ({
      id,
      subjectId: 's',
      step: 2,
      state: 'stuck',
      attempts: 3,
      remainingObjects: null,
      updatedAt: '2026-11-17 10:00:00+00',
      updatedAtKey: '2026-11-17 10:00:00.123456+00',
    });
    const s = setup({
      rows: [
        row('00000000-0000-4000-8000-000000000001'),
        row('00000000-0000-4000-8000-000000000002'),
      ],
    });
    const page = await s.service.listErasures('admin-1', { limit: 1, state: 'stuck' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      kind: 'account',
      state: 'stuck',
      updatedAt: '2026-11-17T10:00:00.000Z',
    });
    expect(page.pagination.nextCursor).not.toBeNull();
    await s.service.listErasures('admin-1', {
      limit: 1,
      state: 'stuck',
      cursor: page.pagination.nextCursor as string,
    });
    expect(s.repository.listRuns).toHaveBeenLastCalledWith(
      tx,
      expect.objectContaining({
        after: {
          updatedAt: '2026-11-17 10:00:00.123456+00',
          id: '00000000-0000-4000-8000-000000000001',
        },
      }),
    );
    await expect(
      s.service.listErasures('admin-1', { limit: 1, cursor: 'garbage' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(setup({ key: undefined }).service.listErasures('a', { limit: 1 })).rejects.toThrow(
      'CURSOR_SIGNING_KEY',
    );
  });

  it('resumes a stuck run once, queues it and audits it as the operator', async () => {
    const s = setup();
    expect(await s.service.resume('run-1')).toBe(true);
    expect(s.queue.send).toHaveBeenCalledWith(tx, 'run-1');
    expect(s.audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'erasure.resumed', actorType: 'operator', actorId: null }),
    );
    expect(await s.service.resume('missing')).toBe(false);
    (s.repository.resume as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    expect(await s.service.resume('run-1')).toBe(false);
  });
});
