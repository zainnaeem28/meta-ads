import { describe, expect, it, vi } from 'vitest';
import type { DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/index.js';
import { CampaignDeletionService } from './campaign-deletion.service.js';
import type { CampaignDeletionRepository } from './campaign-deletion-ports.js';

const tx = {} as DbTx;

function setup(over: { marked?: boolean; brief?: { id: string; state: string; callCount: number }[] } = {}) {
  const calls: string[] = [];
  const repository = {
    markDeleting: vi.fn(() => Promise.resolve(over.marked ?? true)),
    cancelBriefJobs: vi.fn(() => Promise.resolve(over.brief ?? [])),
    insertRun: vi.fn((_tx: DbTx, run: { id: string }) => {
      calls.push(`run:${run.id}`);
      return Promise.resolve();
    }),
  } as unknown as CampaignDeletionRepository;
  const queue = { send: vi.fn((_tx: DbTx, runId: string) => { calls.push(`send:${runId}`); return Promise.resolve(); }) };
  const video = { cancelForCampaign: vi.fn(() => Promise.resolve(1)) };
  const usage = { convertUnconfirmed: vi.fn(() => Promise.resolve({ recorded: true, costUsd: '0' })), release: vi.fn(() => Promise.resolve(true)) };
  const audit = { record: vi.fn(() => Promise.resolve('a')) };
  const service = new CampaignDeletionService(
    { uow: { run: (fn: (t: DbTx) => Promise<unknown>) => fn(tx) } } as never,
    repository,
    queue,
    video as never,
    usage as never,
    audit as never,
    'text-model',
  );
  return { service, repository, queue, video, usage, audit, calls };
}

describe('API-042 request', () => {
  it('hides the campaign, cancels its jobs, inserts and sends the run and audits, in one transaction', async () => {
    const s = setup({ brief: [{ id: 'b1', state: 'pending', callCount: 0 }, { id: 'b2', state: 'submitting', callCount: 1 }] });
    const accepted = await s.service.request('own-1', 'camp-1', 'req-1');
    expect(accepted.state).toBe('running');
    expect(s.video.cancelForCampaign).toHaveBeenCalledWith(tx, 'own-1', 'camp-1');
    // A pending brief call is released; one that may already have been sent is converted first, then released.
    expect(s.usage.release).toHaveBeenCalledTimes(2);
    expect(s.usage.convertUnconfirmed).toHaveBeenCalledOnce();
    expect(s.usage.convertUnconfirmed).toHaveBeenCalledWith(tx, expect.objectContaining({ jobId: 'b2', callSeq: 1, jobType: 'brief_generation', call: { provider: 'openai', operation: 'text-model' } }));
    expect(s.calls).toEqual([`run:${accepted.deletionRunId}`, `send:${accepted.deletionRunId}`]);
    expect(s.audit.record).toHaveBeenCalledWith(tx, expect.objectContaining({ action: 'campaign.deleted', objectId: 'camp-1', actorId: 'own-1', requestId: 'req-1', outcome: 'allowed' }));
  });

  it('a foreign, unknown or already deleting campaign is the single not-found, audited as denied, and nothing else is touched', async () => {
    const s = setup({ marked: false });
    await expect(s.service.request('own-1', 'camp-1', null)).rejects.toMatchObject({ code: 'not_found' });
    await expect(s.service.request('own-1', 'camp-1', null)).rejects.toBeInstanceOf(DomainError);
    expect(s.video.cancelForCampaign).not.toHaveBeenCalled();
    expect(s.queue.send).not.toHaveBeenCalled();
    expect(s.audit.record).toHaveBeenCalledWith(tx, expect.objectContaining({ action: 'access.denied_foreign', outcome: 'denied' }));
  });
});
