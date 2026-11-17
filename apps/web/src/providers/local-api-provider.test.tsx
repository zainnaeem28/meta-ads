// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FetchLocalToken } from '../lib/auth/local-token';

const seen: (string | null)[] = [];
vi.mock('./api-provider', () => ({
  ApiProvider: (p: { identity: string | null; getToken: () => Promise<string | null> }) => {
    seen.push(p.identity);
    void p.getToken();
    return null;
  },
}));

describe('LocalApiProvider', () => {
  it('uses the token user id as the cache identity', async () => {
    const { LocalApiProvider } = await import('./local-api-provider');
    const token = Object.assign(async () => 'tok', {
      userId: () => 'user_local_a',
    }) as FetchLocalToken;
    render(
      <LocalApiProvider origin="" localToken={token}>
        x
      </LocalApiProvider>,
    );
    await waitFor(() => expect(seen).toContain('user_local_a'));
  });
});
