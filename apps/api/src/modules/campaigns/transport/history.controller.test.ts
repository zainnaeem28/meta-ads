import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../../platform/http/index.js';
import { encodeCursor } from '../../../platform/http/index.js';
import { NO_JOBS } from '../application/progress-reader.js';
import { HistoryController } from './history.controller.js';

const A = '0197a1b2-0000-7000-8000-000000000001';
const C = '0197a1b2-0000-7000-8000-0000000000c1';
const KEY = 'k'.repeat(40);
const actor = { userId: A } as ActorContext;
const campaign = (n: number) => ({
  id: `0197a1b2-0000-7000-8000-0000000000c${String(n)}`, ownerId: A, productName: 'Tonic', productDescription: 'é'.repeat(200),
  productMediaId: null, segmentCount: 2, createdAt: '2026-11-16 10:00:00.123456+00', updatedAt: '2026-11-16 10:05:00+00',
});

function setup(rows = [campaign(1)]) {
  const service = {
    list: vi.fn(async () => rows.map((c) => ({ campaign: c, snapshot: NO_JOBS }))),
    get: vi.fn(async () => ({ campaign: campaign(1), snapshot: NO_JOBS, draftId: 'd1' })),
  };
  return { service, controller: new HistoryController(service as never, KEY) };
}

describe('HistoryController', () => {
  it('shows a summary with a 160-character excerpt and microsecond instants', async () => {
    const { controller, service } = setup();
    const page = await controller.list(actor, { filter: 'failed', q: ' ab ' });
    expect(page.items[0]).toMatchObject({ progress: 'in_progress', briefState: 'generating', createdAt: '2026-11-16T10:00:00.123456Z' });
    expect([...(page.items[0]?.productDescriptionExcerpt ?? '')]).toHaveLength(160);
    expect(service.list).toHaveBeenCalledWith(A, 'failed', 'ab', 21, undefined);
  });

  it('gives a next cursor that only the same search and filter accept', async () => {
    const { controller, service } = setup([campaign(1), campaign(2)]);
    const page = await controller.list(actor, { limit: '1' });
    const cursor = page.pagination.nextCursor as string;
    expect(cursor).toBeTruthy();
    await controller.list(actor, { limit: '1', cursor });
    expect(service.list).toHaveBeenLastCalledWith(A, 'all', undefined, 2, { updatedAt: '2026-11-16 10:05:00+00', id: campaign(1).id });
    await expect(controller.list(actor, { limit: '1', cursor, filter: 'completed' })).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('rejects a cursor whose position is malformed and unauthenticated calls', async () => {
    const { controller } = setup();
    const scope = { owner: A, filters: { list: 'campaigns', q: null, filter: 'all' } };
    for (const key of ['not json', '[1]', JSON.stringify([5, C]), JSON.stringify(['x', 'y']), JSON.stringify(['nope', C])]) {
      await expect(controller.list(actor, { cursor: encodeCursor(KEY, scope, key) })).rejects.toMatchObject({ code: 'validation_failed' });
    }
    await expect(controller.list(undefined, {})).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(controller.get(undefined, { campaignId: C })).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('shows the full campaign', async () => {
    const { controller } = setup();
    expect(await controller.get(actor, { campaignId: C })).toMatchObject({ draftId: 'd1', jobCounts: {}, latestAssemblyId: null, thumbstopperJobId: null });
    await expect(controller.get(actor, { campaignId: 'x' })).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
