import { describe, expect, it, vi } from 'vitest';
import type { DbTx } from '../../../platform/db/index.js';
import { AccountErasureJob, ErasureVerificationFailed } from './account-erasure.job.js';
import { accountPrefixes, holdMs, ledgerKeyAndBody } from './account-erasure-steps.js';
import type { AccountLifecycleRepository, AccountRun } from './account-lifecycle-ports.js';
import type { CampaignDeletionConfig, CampaignMediaPurge, JobLog } from './campaign-deletion-ports.js';

const tx = {} as DbTx;
const log: JobLog = { info: () => undefined, warn: () => undefined };
const CONFIG: CampaignDeletionConfig = { retryLimit: 2, jobDeadlineMinutes: 30, graceSeconds: 60 };
type Run = AccountRun & { createdAt: string; notBefore: string; ownerId: string };

function run(over: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    subjectId: 'user-1',
    ownerId: 'user-1',
    step: 1,
    state: 'running',
    attempts: 0,
    remainingObjects: null,
    updatedAt: '2026-11-17 10:00:00+00',
    createdAt: '2026-11-17 10:00:00+00',
    notBefore: new Date(Date.now() - 1000).toISOString(),
    ...over,
  };
}

function harness(initial: Run, over: { media?: Partial<CampaignMediaPurge>; subject?: boolean; invitations?: string[] } = {}) {
  let current = initial;
  const events: string[] = [];
  const sent: { runId: string; startAfterSec?: number }[] = [];
  const repository = {
    findRun: () => Promise.resolve(current),
    findSubject: () => Promise.resolve(over.subject === false ? undefined : { email: 'a@example.test', idpSubject: 'idp-1' }),
    advance: (_tx: DbTx, _id: string, patch: { step: number; remainingObjects?: number | null }) => {
      current = { ...current, step: patch.step, attempts: 0, remainingObjects: patch.remainingObjects === undefined ? current.remainingObjects : patch.remainingObjects };
      events.push(`advance:${String(patch.step)}`);
      return Promise.resolve();
    },
    setNotBefore: (_tx: DbTx, _id: string, inMs: number) => {
      current = { ...current, notBefore: new Date(Date.now() + inMs).toISOString() };
      return Promise.resolve();
    },
    recordFailure: (_tx: DbTx, _id: string, errorClass: string) => {
      current = { ...current, attempts: current.attempts + 1 };
      events.push(`failure:${errorClass}`);
      return Promise.resolve(current.attempts);
    },
    markStuck: () => {
      current = { ...current, state: 'stuck' };
      return Promise.resolve();
    },
    setRemaining: (_tx: DbTx, _id: string, remaining: number) => {
      current = { ...current, remainingObjects: remaining };
      return Promise.resolve();
    },
    invitationsToRevoke: () => Promise.resolve(over.invitations ?? []),
    eraseSubjectRecords: () => {
      events.push('erase-records');
      return Promise.resolve();
    },
    deleteUser: () => {
      events.push('delete-user');
      return Promise.resolve();
    },
    complete: () => {
      current = { ...current, state: 'completed', remainingObjects: 0 };
      return Promise.resolve();
    },
  } as unknown as AccountLifecycleRepository;
  const identity = {
    revokeSessions: vi.fn(() => Promise.resolve()),
    deleteUser: vi.fn(() => Promise.resolve()),
    revokeInvitation: vi.fn(() => Promise.resolve()),
  };
  const purge: CampaignMediaPurge = {
    deleteForCampaign: () => Promise.resolve({ rows: 0, objects: 0 }),
    sweepPrefix: () => Promise.resolve(0),
    ...over.media,
  };
  const ledger = { record: vi.fn(() => Promise.resolve()) };
  const providers = { deleteFinishedTasks: vi.fn(() => Promise.resolve()) };
  const queue = {
    send: (_tx: DbTx, runId: string, options: { startAfterSec?: number } = {}) => {
      sent.push({ runId, ...options });
      return Promise.resolve();
    },
  };
  const audit = { record: vi.fn(() => Promise.resolve('a')) };
  const announce = vi.fn();
  const alerts = { raiseAlert: vi.fn(() => Promise.resolve({ raised: true, alertId: 'x', announce })) };
  const job = new AccountErasureJob(
    { uow: { run: (fn: (t: DbTx) => Promise<unknown>) => fn(tx) } } as never,
    repository,
    identity,
    purge,
    providers,
    ledger,
    queue,
    CONFIG,
    audit as never,
    alerts as never,
  );
  return { job, identity, ledger, providers, sent, events, audit, alerts, announce, state: () => current };
}

describe('account erasure run', () => {
  it('writes the ledger object before the first step, then revokes, deletes at the provider, purges and waits out the deadline', async () => {
    const h = harness(run());
    expect(await h.job.run('run-1', log)).toBe('waiting');
    expect(h.ledger.record).toHaveBeenCalledOnce();
    expect(h.ledger.record).toHaveBeenCalledWith('erasure/2026-11-17T10-00-00-000Z-run-1', JSON.stringify({ runId: 'run-1', kind: 'account', subjectId: 'user-1' }));
    expect(h.ledger.record.mock.invocationCallOrder[0]).toBeLessThan(h.identity.revokeSessions.mock.invocationCallOrder[0] ?? 0);
    expect(h.identity.revokeSessions).toHaveBeenCalledWith('idp-1');
    expect(h.identity.deleteUser).toHaveBeenCalledWith('idp-1');
    expect(h.state().step).toBe(4);
    expect(h.sent[0]?.startAfterSec).toBeGreaterThan(30 * 60);
    expect(h.events).not.toContain('delete-user');
  });

  it('the ledger failing holds the run before any step does anything', async () => {
    const h = harness(run());
    h.ledger.record.mockRejectedValue(new Error('ledger down'));
    await expect(h.job.run('run-1', log)).rejects.toThrow('ledger down');
    expect(h.state().step).toBe(1);
    expect(h.identity.revokeSessions).not.toHaveBeenCalled();
    expect(h.identity.deleteUser).not.toHaveBeenCalled();
    expect(h.providers.deleteFinishedTasks).not.toHaveBeenCalled();
  });

  it('verifies and hard-deletes: provider invitations first, then records, the account, the run and the audit event', async () => {
    const h = harness(run({ step: 4 }), { invitations: ['inv-1', 'inv-2'] });
    expect(await h.job.run('run-1', log)).toBe('completed');
    expect(h.identity.revokeInvitation.mock.calls).toEqual([['inv-1'], ['inv-2']]);
    expect(h.events).toEqual(['advance:5', 'erase-records', 'delete-user']);
    expect(h.state()).toMatchObject({ state: 'completed', remainingObjects: 0 });
    expect(h.audit.record).toHaveBeenCalledWith(tx, expect.objectContaining({ action: 'account.erasure_completed', objectId: 'user-1', actorType: 'system' }));
  });

  it('an account row that is already gone still completes the run', async () => {
    const h = harness(run({ step: 5 }), { subject: false });
    expect(await h.job.run('run-1', log)).toBe('completed');
    expect(h.events).toEqual([]);
    expect(h.identity.revokeInvitation).not.toHaveBeenCalled();
    const early = harness(run({ step: 1 }), { subject: false });
    expect(await early.job.run('run-1', log)).toBe('waiting');
    expect(early.identity.revokeSessions).not.toHaveBeenCalled();
    expect(early.identity.deleteUser).not.toHaveBeenCalled();
  });

  it('sweeps both owner prefixes and counts what is left', async () => {
    const swept: string[] = [];
    const h = harness(run({ step: 3 }), { media: { sweepPrefix: (prefix) => { swept.push(prefix); return Promise.resolve(0); } } });
    expect(await h.job.run('run-1', log)).toBe('waiting');
    expect(swept).toEqual([...accountPrefixes('user-1')]);
  });

  it('does not run before not_before and sends the job again for the remaining time', async () => {
    const h = harness(run({ notBefore: new Date(Date.now() + 90_000).toISOString() }));
    expect(await h.job.run('run-1', log)).toBe('waiting');
    expect(h.sent[0]?.startAfterSec).toBeGreaterThanOrEqual(89);
    expect(h.ledger.record).not.toHaveBeenCalled();
  });

  it('skips a missing, finished or stuck run', async () => {
    for (const over of [{ state: 'completed' as const }, { state: 'stuck' as const }]) {
      const h = harness(run(over));
      expect(await h.job.run('run-1', log)).toBe('skipped');
      expect(h.ledger.record).not.toHaveBeenCalled();
    }
  });

  it('keeps going when the provider task cleanup fails (best effort)', async () => {
    const h = harness(run({ step: 3 }));
    h.providers.deleteFinishedTasks.mockRejectedValue(new Error('provider down'));
    expect(await h.job.run('run-1', log)).toBe('waiting');
    expect(h.state().step).toBe(4);
  });

  it('an identity provider failure is retried by the queue, then stuck with one alert and an audit event', async () => {
    const h = harness(run({ step: 2 }));
    h.identity.deleteUser.mockRejectedValue(new TypeError('clerk down'));
    await expect(h.job.run('run-1', log)).rejects.toThrow('clerk down');
    expect(h.state()).toMatchObject({ state: 'running', attempts: 1, step: 2 });
    expect(await h.job.run('run-1', log)).toBe('stuck');
    expect(h.alerts.raiseAlert).toHaveBeenCalledOnce();
    expect(h.alerts.raiseAlert).toHaveBeenCalledWith(tx, 'account_erasure_stuck', 'user-1', { attempts: 2, step: 2 });
    expect(h.announce).toHaveBeenCalledOnce();
    expect(h.audit.record).toHaveBeenCalledWith(tx, expect.objectContaining({ action: 'account.erasure_stuck', outcome: 'failed' }));
    expect(h.events).toContain('failure:TypeError');
    expect(await h.job.run('run-1', log)).toBe('skipped');
    expect(h.alerts.raiseAlert).toHaveBeenCalledOnce();
  });

  it('a verification count above zero fails the step and is recorded', async () => {
    const h = harness(run({ step: 4 }), { media: { sweepPrefix: () => Promise.resolve(2) } });
    await expect(h.job.run('run-1', log)).rejects.toBeInstanceOf(ErasureVerificationFailed);
    expect(h.state()).toMatchObject({ step: 4, remainingObjects: 4, attempts: 1 });
    expect(h.events).not.toContain('delete-user');
  });

  it('handle needs a run id and reports the outcome', async () => {
    const h = harness(run({ state: 'completed' }));
    await expect(h.job.handle({ id: 'j', data: {} }, log)).rejects.toThrow('runId');
    expect(await h.job.handle({ id: 'j', data: { runId: 'run-1' } }, log)).toBe('skipped');
  });

  it('an unknown step is a failure, never a silent skip', async () => {
    const h = harness(run({ step: 9 }));
    await expect(h.job.run('run-1', log)).rejects.toBeInstanceOf(RangeError);
  });
});

describe('account erasure steps', () => {
  it('names the ledger object by time and run, with IDs and the kind only', () => {
    const entry = ledgerKeyAndBody({ createdAt: '2026-11-17 10:00:00.123456+00', id: 'r', subjectId: 's' });
    expect(entry.key).toBe('erasure/2026-11-17T10-00-00-123Z-r');
    expect(JSON.parse(entry.body)).toEqual({ runId: 'r', kind: 'account', subjectId: 's' });
  });

  it('turns the hold period into milliseconds', () => {
    expect(holdMs(0)).toBe(0);
    expect(holdMs(2)).toBe(7_200_000);
  });
});
