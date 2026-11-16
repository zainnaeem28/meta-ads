import { describe, expect, it } from 'vitest';
import { AdminUserListQueries } from './admin-users.queries.js';

const ME = '00000000-0000-4000-8000-000000000001';

describe('AdminUserListQueries', () => {
  it('builds the keyset query with and without a status and a position', async () => {
    const chain = (calls: unknown[]) => {
      const q: Record<string, unknown> = {};
      for (const name of ['from', 'where', 'orderBy', 'limit']) {
        q[name] = (...args: unknown[]) => { calls.push([name, args.length]); return name === 'limit' ? Promise.resolve([{ id: 'x' }]) : q; };
      }
      return q;
    };
    const calls: unknown[] = [];
    const db = { select: () => chain(calls) } as never;
    const queries = new AdminUserListQueries();
    expect(await queries.list(db, { limit: 5 })).toEqual([{ id: 'x' }]);
    await queries.list(db, { limit: 5, status: 'active', after: { createdAt: '2026-01-01 00:00:00+00', id: ME } });
    expect(calls.filter((c) => (c as [string])[0] === 'where')).toHaveLength(2);
  });
});
