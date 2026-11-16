import { describe, expect, it } from 'vitest';
import type { Executor, KeyWrite } from '../application/ports.js';
import { DrizzleKeyEventRepository, DrizzleProviderKeyRepository } from './provider-keys.repositories.js';

// A chainable stand-in for the Drizzle builder: every call returns the chain, awaiting it yields the next queued result.
// The SQL itself is proven against real PostgreSQL in provider-keys.integration.test.ts; this covers the row mapping.
const fakeDb = (...results: unknown[][]): Executor => {
  const queue = [...results];
  const chain: unknown = new Proxy(() => undefined, {
    get: (_t, prop) =>
      prop === 'then'
        ? (resolve: (v: unknown) => void) => resolve(queue.shift() ?? [])
        : chain,
    apply: () => chain,
  });
  return chain as Executor;
};

const now = new Date('2026-01-01T00:00:00Z');
const row = {
  id: 'k1',
  ownerId: 'o1',
  provider: 'openai',
  status: 'active',
  version: 1,
  last4: 'abcd',
  fingerprint: 'fp',
  consecutiveAuthFailures: 0,
  createdAt: now,
  updatedAt: now,
  lastValidatedAt: null,
};
const auth = { id: 'k1', ownerId: 'o1', provider: 'openai', status: 'active', consecutiveAuthFailures: 1 };
const write = {
  status: 'active',
  version: 2,
  sealed: { ciphertext: Buffer.from('c'), nonce: Buffer.from('n'), wrappedDek: Buffer.from('w'), kekVersion: 1 },
  last4: 'abcd',
  fingerprint: 'fp',
  fingerprintPepperVersion: 1,
  validatedAt: now,
} as unknown as KeyWrite;

describe('DrizzleProviderKeyRepository row mapping', () => {
  const repo = new DrizzleProviderKeyRepository();

  it('find returns a record or null', async () => {
    expect(await repo.find(fakeDb([row]), 'o1', 'openai')).toMatchObject({ id: 'k1', provider: 'openai' });
    expect(await repo.find(fakeDb([]), 'o1', 'openai')).toBeNull();
  });

  it('list maps every row', async () => {
    expect(await repo.list(fakeDb([row, row]), 'o1')).toHaveLength(2);
  });

  it('insert and replace report whether a row was written', async () => {
    expect(await repo.insert(fakeDb([{ id: 'k1' }]), 'k1', 'o1', 'openai', write)).toBe(true);
    expect(await repo.insert(fakeDb([]), 'k1', 'o1', 'openai', write)).toBe(false);
    expect(await repo.replace(fakeDb([{ id: 'k1' }]), 'k1', 1, write)).toBe(true);
    expect(await repo.replace(fakeDb([]), 'k1', 1, write)).toBe(false);
  });

  it('delete and deleteAll return the removed ids', async () => {
    expect(await repo.delete(fakeDb([{ id: 'k1' }]), 'o1', 'openai')).toBe('k1');
    expect(await repo.delete(fakeDb([]), 'o1', 'openai')).toBeNull();
    expect(await repo.deleteAll(fakeDb([{ id: 'k1', provider: 'openai' }]), 'o1')).toEqual([{ id: 'k1', provider: 'openai' }]);
  });

  it('recordFailure maps the updated row or null', async () => {
    expect(await repo.recordFailure(fakeDb([auth]), 'k1', 1, 5)).toMatchObject({ consecutiveAuthFailures: 1 });
    expect(await repo.recordFailure(fakeDb([]), 'k1', 1, 5)).toBeNull();
  });

  it('recordSuccess reports activation, a kept key, or a stale version', async () => {
    expect(await repo.recordSuccess(fakeDb([auth]), 'k1', 1)).toMatchObject({ activated: true });
    expect(await repo.recordSuccess(fakeDb([], [auth]), 'k1', 1)).toMatchObject({ activated: false });
    expect(await repo.recordSuccess(fakeDb([], []), 'k1', 1)).toBeNull();
  });

  it('disableAll returns the disabled keys', async () => {
    expect(await repo.disableAll(fakeDb([{ id: 'k1', ownerId: 'o1', provider: 'openai' }]))).toHaveLength(1);
  });
});

describe('DrizzleKeyEventRepository', () => {
  const repo = new DrizzleKeyEventRepository();

  it('inserts an event', async () => {
    await expect(repo.insert(fakeDb([]), { ownerId: 'o1', provider: 'openai', kind: 'stored' } as never)).resolves.toBeUndefined();
  });

  it('lists with provider and cursor filters', async () => {
    const events = [{ id: 'e1', provider: 'openai', kind: 'stored', at: '2026-01-01 00:00:00+00' }];
    const query = { limit: 10, provider: 'openai', after: { at: '2026-01-02T00:00:00Z', id: '00000000-0000-0000-0000-000000000000' } };
    expect(await repo.list(fakeDb(events), 'o1', query as never)).toEqual(events);
    expect(await repo.list(fakeDb([]), 'o1', { limit: 10 } as never)).toEqual([]);
  });
});
