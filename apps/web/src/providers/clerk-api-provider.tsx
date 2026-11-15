'use client';

import { useAuth } from '@clerk/nextjs';
import type { ReactNode } from 'react';
import { ApiProvider } from './api-provider';

const ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? '';

/** ApiProvider fed by Clerk: `getToken()` is the bearer and `userId` the cache identity. */
export function ClerkApiProvider({ children }: { children: ReactNode }) {
  const { getToken, userId } = useAuth();
  return (
    <ApiProvider origin={ORIGIN} getToken={() => getToken()} identity={userId ?? null}>
      {children}
    </ApiProvider>
  );
}
