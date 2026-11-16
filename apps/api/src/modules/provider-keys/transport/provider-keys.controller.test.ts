import { describe, expect, it, vi } from 'vitest';
import { RateLimitedError } from '../../../platform/rate-limit/index.js';
import { ProviderKeysController, cursorKeyFrom } from './provider-keys.controller.js';

const actor = { userId: 'u1' } as never;
const request = { id: 'req-1' } as never;

function build() {
  const service = {
    keyStatus: vi.fn(() => Promise.resolve([])),
    storeKey: vi.fn(() => Promise.resolve({ provider: 'openai' })),
    deleteKey: vi.fn(() => Promise.resolve()),
    listEvents: vi.fn<(owner: string, query: unknown) => Promise<unknown[]>>(() => Promise.resolve([])),
  };
  return { service, controller: new ProviderKeysController(service as never, 'k'.repeat(32)) };
}

describe('ProviderKeysController', () => {
  it('requires a signed-in actor', () => {
    expect(() => build().controller.list(undefined)).toThrow(/Sign in/);
  });

  it('lists, stores and deletes for the actor', async () => {
    const { controller, service } = build();
    await controller.list(actor);
    await controller.put(actor, request, { header: vi.fn() } as never, { provider: 'openai' }, { apiKey: 'x' });
    await controller.remove(actor, request, { provider: 'wavespeed' });
    expect(service.storeKey).toHaveBeenCalledWith('u1', 'openai', 'x', { requestId: 'req-1' });
    expect(service.deleteKey).toHaveBeenCalledWith('u1', 'wavespeed', { requestId: 'req-1' });
  });

  it('rejects an unknown provider, an extra body field and a missing key', async () => {
    const { controller } = build();
    const reply = { header: vi.fn() } as never;
    await expect(controller.put(actor, request, reply, { provider: 'x' }, { apiKey: 'a' })).rejects.toBeDefined();
    await expect(controller.put(actor, request, reply, { provider: 'openai' }, { apiKey: 'a', extra: 1 })).rejects.toBeDefined();
    await expect(controller.put(actor, request, reply, { provider: 'openai' }, {})).rejects.toBeDefined();
  });

  it('sets Retry-After on a rate-limited attempt', async () => {
    const { controller, service } = build();
    const header = vi.fn();
    service.storeKey.mockRejectedValueOnce(new RateLimitedError(30) as never);
    await expect(controller.put(actor, request, { header } as never, { provider: 'openai' }, { apiKey: 'a' })).rejects.toBeInstanceOf(RateLimitedError);
    expect(header).toHaveBeenCalledWith('Retry-After', '30');
  });

  it('pages events with a signed cursor and rejects a bad one', async () => {
    const { controller, service } = build();
    const rows = [1, 2, 3].map((n) => ({ id: `e${String(n)}`, provider: 'openai', kind: 'added', at: `2026-11-15 23:53:2${String(n)}.123456+00` }));
    service.listEvents.mockResolvedValueOnce(rows);
    const page = await controller.events(actor, { limit: '2', provider: 'openai' });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.at).toBe('2026-11-15T23:53:21.123456Z');
    const cursor = (page.pagination as { nextCursor?: string | null }).nextCursor;
    expect(cursor).toBeTruthy();
    await controller.events(actor, { limit: '2', provider: 'openai', cursor });
    expect(service.listEvents.mock.calls[1]?.[1]).toMatchObject({ after: { id: 'e2' } });
    await expect(controller.events(actor, { cursor: 'garbage' })).rejects.toBeDefined();
  });

  it('cursorKeyFrom prefers the configured key', () => {
    expect(cursorKeyFrom({ CURSOR_SIGNING_KEY: 'abc' })).toBe('abc');
    expect(cursorKeyFrom({})).toHaveLength(64);
  });
});
