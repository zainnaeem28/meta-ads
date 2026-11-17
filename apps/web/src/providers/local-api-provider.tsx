'use client';

import { useCallback, useState, type ReactNode } from 'react';
import type { FetchLocalToken } from '../lib/auth/local-token';
import { ApiProvider } from './api-provider';

/** ApiProvider fed by the local-mode token route: `sub` of the issued token is the cache identity (a change clears every cached query). */
export function LocalApiProvider({
  origin,
  localToken,
  children,
}: {
  origin: string;
  localToken: FetchLocalToken;
  children: ReactNode;
}) {
  const [identity, setIdentity] = useState<string | null>(null);
  const getToken = useCallback(async () => {
    const token = await localToken();
    setIdentity(localToken.userId());
    return token;
  }, [localToken]);
  return (
    <ApiProvider
      origin={origin}
      getToken={getToken}
      identity={identity}
      clearOnFirstIdentity={false}
    >
      {children}
    </ApiProvider>
  );
}
