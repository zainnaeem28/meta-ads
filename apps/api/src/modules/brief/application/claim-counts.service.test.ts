import { describe, expect, it } from 'vitest';
import type { ClaimCountRow, ClaimCountsRepository, ClaimWindow } from './brief-ports.js';
import { ClaimCountsService } from './claim-counts.service.js';

const from = new Date('2026-11-01T00:00:00Z');
const to = new Date('2026-11-08T00:00:00Z');

function service(rows: readonly ClaimCountRow[], seen: ClaimWindow[] = []): ClaimCountsService {
  const repository: ClaimCountsRepository = {
    countEvents: (_tx, window) => {
      seen.push(window);
      return Promise.resolve(rows);
    },
  };
  return new ClaimCountsService({ uow: { run: (body: never) => (body as (tx: unknown) => Promise<unknown>)({}) } } as never, repository);
}

describe('ClaimCountsService', () => {
  it('returns a zero entry for each class when the window is empty', async () => {
    expect(await service([]).claimCounts({ from, to })).toEqual([
      { class: 'high_risk', raised: 0, closedByEdit: 0, clearedWithReason: 0 },
      { class: 'other', raised: 0, closedByEdit: 0, clearedWithReason: 0 },
    ]);
  });

  it('splits the outcomes by class and passes the window on', async () => {
    const seen: ClaimWindow[] = [];
    const counts = await service(
      [
        { class: 'high_risk', outcome: 'raised', count: 3 },
        { class: 'high_risk', outcome: 'closed_by_edit', count: 2 },
        { class: 'other', outcome: 'raised', count: 5 },
        { class: 'other', outcome: 'cleared_with_reason', count: 4 },
      ],
      seen,
    ).claimCounts({ from, to, ownerId: 'o1' });
    expect(counts).toEqual([
      { class: 'high_risk', raised: 3, closedByEdit: 2, clearedWithReason: 0 },
      { class: 'other', raised: 5, closedByEdit: 0, clearedWithReason: 4 },
    ]);
    expect(seen).toEqual([{ from, to, ownerId: 'o1' }]);
  });
});
