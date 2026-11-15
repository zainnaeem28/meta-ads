// @vitest-environment jsdom
import { useGetMe } from '@shroomap/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../lib/api/msw.setup';
import { createQueryClient } from '../lib/query/query-client';
import { ApiProvider } from './api-provider';

const ORIGIN = 'http://api.test';

function Probe() {
  const me = useGetMe();
  const client = useQueryClient();
  return (
    <p data-testid="out">
      {me.data ? 'loaded' : 'empty'}:{client.getQueryCache().getAll().length}
    </p>
  );
}

describe('ApiProvider', () => {
  it('sends the bearer of the current token and clears every cached query on identity change (TC-ZT-07)', async () => {
    const auth: (string | null)[] = [];
    server.use(
      http.get(`${ORIGIN}/api/v1/me`, ({ request }) => {
        auth.push(request.headers.get('authorization'));
        return HttpResponse.json({ success: true });
      }),
    );
    const client = createQueryClient();
    const view = render(
      <ApiProvider
        origin={ORIGIN}
        getToken={() => Promise.resolve('tok-a')}
        identity="user-a"
        client={client}
      >
        <Probe />
      </ApiProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('loaded:1'));
    expect(auth[0]).toBe('Bearer tok-a');
    client.setQueryData(['other'], 'user-a-data');
    expect(client.getQueryCache().getAll().length).toBe(2);

    view.rerender(
      <ApiProvider
        origin={ORIGIN}
        getToken={() => Promise.resolve('tok-b')}
        identity="user-b"
        client={client}
      >
        <div data-testid="out">switched</div>
      </ApiProvider>,
    );
    await waitFor(() => expect(client.getQueryCache().getAll()).toHaveLength(0));
    expect(client.getQueryData(['other'])).toBeUndefined();
    view.unmount();
  });
});
