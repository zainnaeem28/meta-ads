'use client';

import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { installApiClient, type GetToken } from '../lib/api/client';
import { clearForIdentityChange, createQueryClient } from '../lib/query/query-client';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The identity the cache currently belongs to: a user id, null (signed out) or undefined (nothing known). */
const ApiIdentityContext = createContext<string | null | undefined>(undefined);

/** The user the query cache holds data for. Hydrated first data is accepted only when it was read for this user. */
export const useApiIdentity = (): string | null | undefined => useContext(ApiIdentityContext);

export interface ApiProviderProps {
  children: ReactNode;
  origin: string;
  getToken: GetToken;
  /**
   * The signed-in user's id, null when known to be signed out, undefined while the browser does not know yet (Clerk is
   * loading). "Not known yet" is never a change. A known identity that differs from the last known one clears the cache.
   */
  identity: string | null | undefined;
  /** The identity the server rendered this request for (a user id, never a token): the seed of the last known one. */
  initialIdentity?: string | null;
  client?: QueryClient;
  /** False when the identity becomes known only after queries have started (local mode): the first user is not a change. */
  clearOnFirstIdentity?: boolean;
}

interface Held {
  client: QueryClient;
  /** Counts the cache switches: the subtree under a new cache is mounted afresh (a mounted observer stays on its old client). */
  epoch: number;
  /** Last known identity; undefined until one is known. */
  known: string | null | undefined;
}

export function ApiProvider({
  children,
  origin,
  getToken,
  identity,
  initialIdentity,
  client,
  clearOnFirstIdentity = true,
}: ApiProviderProps) {
  const [held, setHeld] = useState<Held>(() => ({
    client: client ?? createQueryClient(),
    epoch: 0,
    known: initialIdentity !== undefined ? initialIdentity : identity,
  }));
  const retired = useRef<QueryClient[]>([]);
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;

  // A real change of identity switches to a fresh QueryClient during render, so no render under the new user reads the
  // old user's cache; the old one is cleared in the effect below. Unknown (undefined) is not a change.
  let current = held;
  if (identity !== undefined && identity !== held.known) {
    const first = held.known === null || held.known === undefined;
    if (!first || clearOnFirstIdentity) {
      retired.current.push(held.client);
      current = { client: createQueryClient(), epoch: held.epoch + 1, known: identity };
    } else current = { ...held, known: identity };
    setHeld(current);
  }

  // Installed in the browser only (never on the server, where it would patch a fetch shared by requests).
  // A layout effect runs before any child's query effect, and install/uninstall pair up under StrictMode.
  useIsomorphicLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    return installApiClient({ origin, getToken: () => tokenRef.current() });
  }, [origin]);

  useEffect(() => {
    const old = retired.current.splice(0);
    for (const c of old) void clearForIdentityChange(c);
  });

  return (
    <ApiIdentityContext.Provider value={current.known}>
      <QueryClientProvider key={current.epoch} client={current.client}>
        {children}
      </QueryClientProvider>
    </ApiIdentityContext.Provider>
  );
}
