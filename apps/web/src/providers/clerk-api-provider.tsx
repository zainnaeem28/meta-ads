'use client';

import { useAuth } from '@clerk/nextjs';
import type { ReactNode } from 'react';
import { ApiProvider } from './api-provider';

const ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? '';

/** ApiProvider fed by Clerk: `getToken()` is the bearer and `userId` the cache identity. */
export function ClerkApiProvider({
  initialIdentity = null,
  children,
}: {
  /** The user the server rendered this request for. */
  initialIdentity?: string | null;
  children: ReactNode;
}) {
  const { getToken, userId, isLoaded } = useAuth();
  return (
    <ApiProvider
      origin={ORIGIN}
      getToken={() => getToken()}
      // Not known until clerk-js has loaded: that is not "signed out", and not a change.
      identity={isLoaded ? (userId ?? null) : undefined}
      initialIdentity={initialIdentity}
    >
      {children}
    </ApiProvider>
  );
}
