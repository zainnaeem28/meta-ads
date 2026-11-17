import { describe, expect, it, vi } from 'vitest';
import type { DbTx } from '../../../platform/db/index.js';
import type { DeletionRun } from '../domain/campaign-deletion.js';
import { CampaignDeletionJob, DeletionVerificationFailed } from './campaign-deletion.job.js';
import type {
  CampaignDeletionConfig,
  CampaignDeletionRepository,
  CampaignMediaPurge,
  JobLog,
} from './campaign-deletion-ports.js';

const tx = {} as DbTx;
const log: JobLog = { info: () => undefined, warn: () => undefined };
const CONFIG: CampaignDeletionConfig = { retryLimit: 2, jobDeadlineMinutes: 30, graceSeconds: 60 };

function run(over: Partial<DeletionRun> = {}): DeletionRun {
  return {
    id: 'run-1',
    kind: 'campaign',
    subjectId: 'camp-1',
    ownerId: 'own-1',
    step: 1,
    state: 'running',
    attempts: 0,
    remainingObjects: null,
    lastErrorClass: null,
    notBefore: new Date(Date.now() - 1000).toISOString(),
    createdAt: '2026-11-17 10:00:00+00',
    ...over,
  };
}

/** An in-memory repository over one run; the steps' effects are what the job asks of it. */
function harness(initial: DeletionRun, media?: Partial<CampaignMediaPurge>) {
  let current = initial;
  const sent: { runId: string; startAfterSec?: number }[] = [];
  const events: string[] = [];
  const repository: CampaignDeletionRepository = {
    markDeleting: vi.fn(),
    cancelBriefJobs: vi.fn(),
    insertRun: vi.fn(),
    findRun: () => Promise.resolve(current),
    advance: (_tx, _id, patch) => {
      current = {
        ...current,
        step: patch.step,
        attempts: 0,
        remainingObjects:
          patch.remainingObjects === undefined ? current.remainingObjects : patch.remainingObjects,
        notBefore:
          patch.notBeforeInMs === undefined
            ? current.notBefore
            : new Date(Date.now() + patch.notBeforeInMs).toISOString(),
      };
      events.push(`advance:${String(patch.step)}`);
      return Promise.resolve();
    },
    recordFailure: (_tx, _id, errorClass) => {
      current = { ...current, attempts: current.attempts + 1, lastErrorClass: errorClass };
      return Promise.resolve(current.attempts);
    },
    markStuck: () => {
      current = { ...current, state: 'stuck' };
      return Promise.resolve();
    },
    hardDeleteCampaign: () => {
      events.push('hard-delete');
      return Promise.resolve();
    },
    complete: () => {
      current = { ...current, state: 'completed', remainingObjects: 0 };
      return Promise.resolve();
    },
    setRemaining: (_tx, _id, remaining) => {
      current = { ...current, remainingObjects: remaining };
      return Promise.resolve();
    },
  };
  const purge: CampaignMediaPurge = {
    deleteForCampaign: () => Promise.resolve({ rows: 0, objects: 0 }),
    sweepPrefix: () => Promise.resolve(0),
    ...media,
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
  const alerts = {
    raiseAlert: vi.fn(() => Promise.resolve({ raised: true, alertId: 'x', announce })),
  };
  const job = new CampaignDeletionJob(
    { uow: { run: (fn: (t: DbTx) => Promise<unknown>) => fn(tx) } } as never,
    repository,
    purge,
    providers,
    ledger,
    queue,
    CONFIG,
    audit as never,
    alerts as never,
  );
  return { job, ledger, providers, sent, events, audit, alerts, announce, state: () => current };
}

describe('campaign deletion run', () => {
  it('writes the ledger object first, then waits out the longest deadline before the count, then hard-deletes', async () => {
    const h = harness(run());
    expect(await h.job.run('run-1', log)).toBe('waiting');
    expect(h.ledger.record).toHaveBeenCalledOnce();
    expect(h.ledger.record).toHaveBeenCalledWith(
      'erasure/2026-11-17T10-00-00-000Z-run-1',
      JSON.stringify({ runId: 'run-1', kind: 'campaign', subjectId: 'camp-1' }),
    );
    expect(h.state().step).toBe(3);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.startAfterSec).toBeGreaterThan(30 * 60);
    expect(h.events).not.toContain('hard-delete');

    // The wait passes: the count runs, the campaign goes, the run is completed and audited.
    const moved = harness(run({ step: 3 }));
    expect(await moved.job.run('run-1', log)).toBe('completed');
    expect(moved.events).toEqual(['advance:4', 'hard-delete']);
    expect(moved.state()).toMatchObject({ state: 'completed', remainingObjects: 0 });
    expect(moved.audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'campaign.deletion_completed', actorType: 'system' }),
    );
  });

  it('does not run before not_before and sends the job again for the remaining time', async () => {
    const h = harness(run({ step: 3, notBefore: new Date(Date.now() + 90_000).toISOString() }));
    expect(await h.job.run('run-1', log)).toBe('waiting');
    expect(h.sent[0]?.startAfterSec).toBeGreaterThanOrEqual(89);
    expect(h.state().step).toBe(3);
  });

  it('skips a missing, finished, stuck or account run', async () => {
    for (const over of [
      { state: 'completed' as const },
      { state: 'stuck' as const },
      { kind: 'account' as const },
    ]) {
      const h = harness(run(over));
      expect(await h.job.run('run-1', log)).toBe('skipped');
      expect(h.ledger.record).not.toHaveBeenCalled();
    }
  });

  it('keeps going when the provider cleanup fails (best effort)', async () => {
    const h = harness(run());
    h.providers.deleteFinishedTasks.mockRejectedValue(new Error('provider down'));
    expect(await h.job.run('run-1', log)).toBe('waiting');
    expect(h.state().step).toBe(3);
  });

  it('a failing storage delete is retried by the queue, then stuck with one alert and an audit event', async () => {
    const h = harness(run({ step: 2 }), {
      deleteForCampaign: () => Promise.reject(new TypeError('r2 down u/own-1')),
    });
    await expect(h.job.run('run-1', log)).rejects.toThrow('r2 down');
    expect(h.state()).toMatchObject({ state: 'running', attempts: 1, lastErrorClass: 'TypeError' });
    expect(await h.job.run('run-1', log)).toBe('stuck');
    expect(h.state().state).toBe('stuck');
    expect(h.alerts.raiseAlert).toHaveBeenCalledOnce();
    expect(h.alerts.raiseAlert).toHaveBeenCalledWith(tx, 'campaign_deletion_stuck', 'own-1', {
      attempts: 2,
      step: 2,
    });
    expect(h.announce).toHaveBeenCalledOnce();
    expect(h.audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'campaign.deletion_stuck', outcome: 'failed' }),
    );
    // A stuck run is left alone: no second alert.
    expect(await h.job.run('run-1', log)).toBe('skipped');
    expect(h.alerts.raiseAlert).toHaveBeenCalledOnce();
  });

  it('the ledger failing holds the run before step 1 does anything', async () => {
    const h = harness(run());
    h.ledger.record.mockRejectedValue(new Error('ledger down'));
    await expect(h.job.run('run-1', log)).rejects.toThrow('ledger down');
    expect(h.state().step).toBe(1);
    expect(h.providers.deleteFinishedTasks).not.toHaveBeenCalled();
  });

  it('a verification count above zero fails the step and is recorded', async () => {
    const h = harness(run({ step: 3 }), { sweepPrefix: () => Promise.resolve(2) });
    await expect(h.job.run('run-1', log)).rejects.toBeInstanceOf(DeletionVerificationFailed);
    expect(h.state()).toMatchObject({ step: 3, remainingObjects: 2, attempts: 1 });
    expect(h.events).not.toContain('hard-delete');
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
