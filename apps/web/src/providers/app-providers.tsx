'use client';

import { ClerkProvider } from '@clerk/nextjs';
import type { ReactNode } from 'react';
import '../lib/security/zod-jitless';
import { createLocalTokenGetter } from '../lib/auth/local-token';
import { ApiProvider } from './api-provider';
import { ClerkApiProvider } from './clerk-api-provider';

const ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? '';
const CLERK_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const localToken = createLocalTokenGetter();

/** Root providers. Without a Clerk key (self-contained builds, e2e) the bearer is the api's local-mode token (the `/local-token` route answers only in AUTH_MODE=local; elsewhere none). */
export function AppProviders({ children }: { children: ReactNode }) {
  if (!CLERK_KEY) {
    return (
      <ApiProvider origin={ORIGIN} getToken={localToken} identity={null}>
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
