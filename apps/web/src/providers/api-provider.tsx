'use client';

import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { installApiClient, type GetToken } from '../lib/api/client';
import { clearForIdentityChange, createQueryClient } from '../lib/query/query-client';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface ApiProviderProps {
  children: ReactNode;
  origin: string;
  getToken: GetToken;
  /** Stable id of the signed-in user, or null when signed out. A change clears every cached query. */
  identity: string | null;
  client?: QueryClient;
  /** False when the identity becomes known only after queries have started (local mode): the first user is not a change. */
  clearOnFirstIdentity?: boolean;
}

export function ApiProvider({
  children,
  origin,
  getToken,
  identity,
  client,
  clearOnFirstIdentity = true,
}: ApiProviderProps) {
  const [queryClient] = useState(() => client ?? createQueryClient());
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const previous = useRef(identity);

  // Installed in the browser only (never on the server, where it would patch a fetch shared by requests).
  // A layout effect runs before any child's query effect, and install/uninstall pair up under StrictMode.
  useIsomorphicLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    return installApiClient({ origin, getToken: () => tokenRef.current() });
  }, [origin]);

  useEffect(() => {
    if (previous.current !== identity) {
      const first = previous.current === null;
      previous.current = identity;
      if (!first || clearOnFirstIdentity) void clearForIdentityChange(queryClient);
    }
  }, [identity, queryClient, clearOnFirstIdentity]);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
