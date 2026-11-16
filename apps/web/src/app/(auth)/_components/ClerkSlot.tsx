'use client';

import { ClerkFailed, ClerkLoading, SignIn } from '@clerk/nextjs';
import { Button } from '@shroomap/ui/cmp-003';
import { Skeleton, SkeletonRegion } from '@shroomap/ui/cmp-008';
import { clerkAppearance } from '../../../lib/auth/appearance';
import { ROUTES } from '../../../lib/errors/routes';

/** The provider-hosted sign-in component for `base` (`/sign-in` or `/mfa`), themed, with the shell's loading and error states. */
export function ClerkSlot({ base, returnTo }: { base: '/sign-in' | '/mfa'; returnTo: string }) {
  return (
    <>
      <ClerkLoading>
        <SkeletonRegion status="Loading sign-in">
          <Skeleton className="h-control" />
          <Skeleton className="h-control" />
          <Skeleton className="h-control" />
        </SkeletonRegion>
      </ClerkLoading>
      <ClerkFailed>
        <div role="alert" className="flex flex-col gap-3 text-ui text-destructive">
          <p>We could not load sign-in. Try again.</p>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Try again
          </Button>
        </div>
      </ClerkFailed>
      <SignIn
        routing="path"
        path={base}
        signInUrl={ROUTES.signIn}
        forceRedirectUrl={returnTo}
        appearance={clerkAppearance}
      />
    </>
  );
}
