import { describe, expect, it } from 'vitest';
import { createApiFetch, type ApiClientError } from '../api/client';
import { resolveError } from './resolve';

const answer = (value: string | null) =>
  createApiFetch({
    origin: 'http://api.test',
    getToken: async () => null,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ success: false, error: { code: 'service_unavailable', message: 'x' } }),
        {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            ...(value === null ? {} : { 'Retry-After': value }),
          },
        },
      ),
  })('/api/v1/me').then(
    () => {
      throw new Error('expected the request to fail');
    },
    (e: unknown) => e as ApiClientError,
  );

describe('Retry-After on an error answer', () => {
  it('reaches the error as whole seconds; a missing, zero or non-numeric header is ignored', async () => {
    expect((await answer('30')).retryAfterSeconds).toBe(30);
    expect((await answer(null)).retryAfterSeconds).toBeNull();
    expect((await answer('0')).retryAfterSeconds).toBeNull();
    expect((await answer('Wed, 21 Oct 2026 07:28:00 GMT')).retryAfterSeconds).toBeNull();
  });

  it('drives the 503 wait', async () => {
    expect(resolveError(await answer('45')).waitSeconds).toBe(45);
    expect(resolveError(await answer(null)).waitSeconds).toBe(5);
  });
});
