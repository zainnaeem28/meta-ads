'use client';

import { HydrationBoundary, type DehydratedState } from '@tanstack/react-query';
import { useRef, type ReactNode } from 'react';
import { rememberEtag } from '../lib/api/etag-store';
import { useApiIdentity } from './api-provider';

export interface IdentityHydrationBoundaryProps {
  /** The user the server read this data for. */
  identity: string;
  state: DehydratedState;
  /** Response ETags by resource path (ADR-010): remembered so a write right after first paint sends `If-Match`. */
  etags: Record<string, string>;
  children: ReactNode;
}

/**
 * Hydrates the server's first data only for the user the browser is signed in as (ADR-014, T-20). When the provider's
 * identity is another user's, the state is dropped and the screen reads from the api as it always did. The identity
 * the provider holds is the server's seed until the browser knows its own, so a page for user A never lands in B's cache.
 */
export function IdentityHydrationBoundary({
  identity,
  state,
  etags,
  children,
}: IdentityHydrationBoundaryProps) {
  const current = useApiIdentity();
  const usable = current === identity;
  const remembered = useRef<Record<string, string> | null>(null);
  // Browser only: on the server the module-level store would be shared by every request (SEC-M1).
  if (typeof window !== 'undefined' && usable && remembered.current !== etags) {
    remembered.current = etags;
    for (const [path, etag] of Object.entries(etags)) rememberEtag(path, etag);
  }
  return <HydrationBoundary state={usable ? state : undefined}>{children}</HydrationBoundary>;
}
