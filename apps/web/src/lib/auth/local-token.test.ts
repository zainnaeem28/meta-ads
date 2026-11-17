import { describe, expect, it, vi } from 'vitest';
import { createLocalTokenGetter } from './local-token';

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('createLocalTokenGetter', () => {
  it('fetches once, caches until near expiry, then refetches', async () => {
    let t = 0;
    const f = vi.fn(async () => ok({ token: 'tok', expiresInSeconds: 3600 }));
    const get = createLocalTokenGetter(f as unknown as typeof fetch, () => t);
    expect(await Promise.all([get(), get()])).toEqual(['tok', 'tok']);
    expect(f).toHaveBeenCalledTimes(1);
    t = 3000 * 1000;
    await get();
    expect(f).toHaveBeenCalledTimes(1);
    t = 3550 * 1000;
    await get();
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('yields no bearer when the route is absent, unauthenticated, malformed or failing', async () => {
    for (const f of [
      async () => new Response(null, { status: 404 }),
      async () => ok({ token: null }, 401),
      async () => ok({ nope: 1 }),
      async () => {
        throw new Error('net');
      },
    ]) {
      expect(await createLocalTokenGetter(f as unknown as typeof fetch)()).toBeNull();
    }
  });
});
