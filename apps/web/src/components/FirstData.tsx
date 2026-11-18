import type { ReactNode } from 'react';
import type { FirstData as FirstDataValue } from '../lib/query/server-prefetch';
import { IdentityHydrationBoundary } from '../providers/identity-hydration-boundary';

/** Hands a route's server-read first data to its screen; with none (a failed or skipped read) the screen is rendered as before. */
export function FirstData({
  data,
  children,
}: {
  data: FirstDataValue | null;
  children: ReactNode;
}) {
  if (!data) return <>{children}</>;
  return (
    <IdentityHydrationBoundary identity={data.identity} state={data.state} etags={data.etags}>
      {children}
    </IdentityHydrationBoundary>
  );
}
