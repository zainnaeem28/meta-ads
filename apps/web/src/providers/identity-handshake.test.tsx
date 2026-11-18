// @vitest-environment jsdom
import { dehydrate, QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { clearEtags, storedEtag } from '../lib/api/client';
import { server } from '../lib/api/msw.setup';
import { ApiProvider, useApiIdentity } from './api-provider';
import { IdentityHydrationBoundary } from './identity-hydration-boundary';
import { LocalApiProvider } from './local-api-provider';

// ADR-014 constraint 6: the server's identity seeds the browser's, first data is hydrated only for that user, and a real
// change of user switches to a fresh cache during render (T-20, SEC-M3).
afterEach(() => {
  cleanup();
  clearEtags();
});

const KEY = ['hydrated'] as const;
const hydratedFor = (data: string) => {
  const server = new QueryClient();
  server.setQueryData(KEY, data);
  return dehydrate(server);
};

function Read() {
  const client = useQueryClient();
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => Promise.resolve('fetched'),
    staleTime: 30_000,
  });
  return (
    <p data-testid="out">
      {String(q.data)}|{client.getQueryCache().getAll().length}|{String(useApiIdentity())}
    </p>
  );
}

const provider = (identity: string | null | undefined, children: ReactNode, initial = 'user-a') => (
  <ApiProvider
    origin="http://api.test"
    getToken={() => Promise.resolve(null)}
    identity={identity}
    initialIdentity={initial}
  >
    {children}
  </ApiProvider>
);
const page = (identity: string, data: string, etags: Record<string, string> = {}) => (
  <IdentityHydrationBoundary identity={identity} state={hydratedFor(data)} etags={etags}>
    <Read />
  </IdentityHydrationBoundary>
);

describe('identity handshake (Clerk mode)', () => {
  it('(i) keeps hydrated queries, and forces no refetch, when Clerk loads as the same user', async () => {
    const view = render(provider(undefined, page('user-a', 'from-server')));
    expect(screen.getByTestId('out').textContent).toBe('from-server|1|user-a');
    view.rerender(provider('user-a', page('user-a', 'from-server')));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('out').textContent).toBe('from-server|1|user-a');
  });

  it('(ii) clears every query when the browser loads as another user, and never shows the first user’s data to the second', async () => {
    const view = render(provider(undefined, page('user-a', 'user-a-records')));
    view.rerender(provider('user-b', page('user-a', 'user-a-records')));
    await waitFor(() =>
      expect(screen.getByTestId('out').textContent).toMatch(/^fetched\|1\|user-b$/),
    );
    expect(screen.getByTestId('out').textContent).not.toContain('user-a-records');
  });

  it('(iii) clears every query when the browser turns out to be signed out', async () => {
    const view = render(provider(undefined, page('user-a', 'user-a-records')));
    view.rerender(provider(null, <p data-testid="out">gone</p>));
    expect(screen.getByTestId('out').textContent).toBe('gone');
  });

  it('(v) hydrates nothing for a user other than the one the provider holds, and remembers none of its ETags', () => {
    render(
      provider(
        'user-b',
        page('user-a', 'user-a-records', { '/campaigns/1/brief': '"a"' }),
        'user-b',
      ),
    );
    expect(screen.getByTestId('out').textContent).toMatch(/^undefined|^fetched/);
    expect(screen.getByTestId('out').textContent).not.toContain('user-a-records');
    expect(storedEtag('/campaigns/1/brief')).toBeUndefined();
  });

  it('switches to a new cache in the render that sees the change, not after it', () => {
    const seen: string[] = [];
    function Spy() {
      const client = useQueryClient();
      seen.push(`${useApiIdentity()}:${client.getQueryCache().getAll().length}`);
      return null;
    }
    const view = render(provider('user-a', page('user-a', 'x')));
    view.rerender(provider('user-b', <Spy />));
    expect(seen.at(-1)).toBe('user-b:0');
  });

  it('works under StrictMode', () => {
    render(<StrictMode>{provider(undefined, page('user-a', 'strict'))}</StrictMode>);
    expect(screen.getByTestId('out').textContent).toBe('strict|1|user-a');
  });

  it('remembers the server’s ETags for the user it hydrates, so a write straight after first paint sends If-Match', () => {
    render(provider('user-a', page('user-a', 'x', { '/campaigns/9/brief': '"v7"' })));
    expect(storedEtag('/campaigns/9/brief')).toBe('"v7"');
  });
});

describe('identity handshake (local mode)', () => {
  it('(iv) the first token for the user the server rendered for is not a change', async () => {
    const token = Object.assign(async () => 'tok', { userId: () => 'user_local_a' });
    render(
      <LocalApiProvider origin="http://api.test" localToken={token} initialIdentity="user_local_a">
        <IdentityHydrationBoundary
          identity="user_local_a"
          state={hydratedFor('server-data')}
          etags={{}}
        >
          <Read />
        </IdentityHydrationBoundary>
      </LocalApiProvider>,
    );
    expect(screen.getByTestId('out').textContent).toBe('server-data|1|user_local_a');
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('out').textContent).toBe('server-data|1|user_local_a');
  });

  it('a token issued for another user switches to a new cache (the browser identity is the authority)', async () => {
    server.use(http.get('http://api.test/api/v1/me', () => HttpResponse.json({ ok: true })));
    const token = Object.assign(async () => 'tok', { userId: () => 'user_local_b' });
    function Call() {
      useQuery({
        queryKey: ['call'],
        // eslint-disable-next-line no-restricted-globals -- exercises the installed client through the global fetch it wraps
        queryFn: async () => (await fetch('http://api.test/api/v1/me')).json(),
      });
      return <Read />;
    }
    render(
      <LocalApiProvider origin="http://api.test" localToken={token} initialIdentity="user_local_a">
        <IdentityHydrationBoundary
          identity="user_local_a"
          state={hydratedFor('a-records')}
          etags={{}}
        >
          <Call />
        </IdentityHydrationBoundary>
      </LocalApiProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('out').textContent).toContain('|user_local_b'));
    expect(screen.getByTestId('out').textContent).not.toContain('a-records');
  });
});
