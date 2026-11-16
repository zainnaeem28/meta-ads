'use client';

import { Button } from '@shroomap/ui/cmp-003';
import { AuthShell } from '@shroomap/ui/cmp-032';
import { AUTH_COPY } from '../../features/fe-screen-001-003/copy';

/** SCREEN-001 `error`: the shell with the retry alert when the page fails. */
export default function AuthError({ reset }: { error: Error; reset: () => void }) {
  return (
    <AuthShell
      title={AUTH_COPY.productName}
      providerState="error"
      providerAction={
        <Button variant="outline" onClick={reset}>
          Try again
        </Button>
      }
    />
  );
}
