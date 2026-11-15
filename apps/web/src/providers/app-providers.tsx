'use client';

import { ClerkProvider } from '@clerk/nextjs';
import type { ReactNode } from 'react';
import { ApiProvider } from './api-provider';
import { ClerkApiProvider } from './clerk-api-provider';

const ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? '';
const CLERK_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const anonymous = () => Promise.resolve(null);

/** Root providers. Without a Clerk key (self-contained builds, e2e) the api is called without a bearer. */
export function AppProviders({ children }: { children: ReactNode }) {
  if (!CLERK_KEY) {
    return (
      <ApiProvider origin={ORIGIN} getToken={anonymous} identity={null}>
        {children}
      </ApiProvider>
    );
  }
  return (
    <ClerkProvider publishableKey={CLERK_KEY}>
      <ClerkApiProvider>{children}</ClerkApiProvider>
    </ClerkProvider>
  );
}
