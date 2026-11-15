'use client';

import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { installApiClient, type GetToken } from '../lib/api/client';
import { clearForIdentityChange, createQueryClient } from '../lib/query/query-client';

export interface ApiProviderProps {
  children: ReactNode;
  origin: string;
  getToken: GetToken;
  /** Stable id of the signed-in user, or null when signed out. A change clears every cached query. */
  identity: string | null;
  client?: QueryClient;
}

export function ApiProvider({ children, origin, getToken, identity, client }: ApiProviderProps) {
  const [queryClient] = useState(() => client ?? createQueryClient());
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const previous = useRef(identity);

  // Installed during render-phase state init so the first child query already has the bearer.
  const [uninstall] = useState(() =>
    installApiClient({ origin, getToken: () => tokenRef.current() }),
  );
  useEffect(() => uninstall, [uninstall]);

  useEffect(() => {
    if (previous.current !== identity) {
      previous.current = identity;
      void clearForIdentityChange(queryClient);
    }
  }, [identity, queryClient]);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
