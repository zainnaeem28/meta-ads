'use client';

import { useGetMe, useHealthLive } from '@shroomap/contracts';
import { useEffect, useState } from 'react';
import { installApiClient, isApiClientError } from '../../lib/api/client';

// Exercises the api layer through the real entry point (generated hooks -> wrapped fetch -> api) for TASK-082 e2e.
// `?api=<origin>` points it at a running api; without it the page stays idle.
function Probe() {
  const me = useGetMe();
  const live = useHealthLive();
  const err = isApiClientError(me.error) ? me.error : null;
  return (
    <>
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
    </>
  );
}

export default function ApiProbePage() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const origin = new URLSearchParams(window.location.search).get('api');
    if (!origin) return;
    const uninstall = installApiClient({ origin, getToken: () => Promise.resolve(null) });
    setReady(true);
    return uninstall;
  }, []);
  return (
    <main className="p-4 font-sans text-foreground">
      <h1 className="font-medium">API probe</h1>
      {ready ? <Probe /> : null}
    </main>
  );
}
