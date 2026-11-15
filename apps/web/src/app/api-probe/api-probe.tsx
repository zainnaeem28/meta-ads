'use client';

import { useGetMe, useHealthLive } from '@shroomap/contracts';
import { isApiClientError } from '../../lib/api/client';

// Uses the client that the root ApiProvider installed (no install of its own), through the generated hooks.
export function ApiProbe() {
  const me = useGetMe();
  const live = useHealthLive();
  const err = isApiClientError(me.error) ? me.error : null;
  return (
    <main className="p-4 font-sans text-foreground">
      <h1 className="font-medium">API probe</h1>
      <p data-testid="health">
        {live.data ? `http ${live.data.status}` : live.isError ? 'error' : 'loading'}
      </p>
      <p data-testid="me-error">
        {err
          ? `${err.kind}:${err.status}:${err.code}:${err.requestId ?? 'none'}`
          : me.isPending
            ? 'loading'
            : 'ok'}
      </p>
    </main>
  );
}
