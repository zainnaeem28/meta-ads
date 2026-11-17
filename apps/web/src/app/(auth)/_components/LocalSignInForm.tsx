'use client';

import { useActionState } from 'react';
import { Alert } from '@shroomap/ui/cmp-011';
import { Button } from '@shroomap/ui/cmp-003';
import { Input } from '@shroomap/ui/cmp-004';
import { FormField } from '@shroomap/ui/cmp-010';
import { LOCAL_DEV_PASSWORD } from '../../../lib/auth/local-dev';
import { localSignIn, type LocalFormState } from '../actions';

const INITIAL: LocalFormState = { error: null };

/** The local stand-in for the provider's sign-in component: same frame and states, no Clerk account (AUTH_MODE=local). */
export function LocalSignInForm({ returnTo }: { returnTo: string }) {
  const [state, action, pending] = useActionState(localSignIn, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-3" noValidate>
      <input type="hidden" name="return" value={returnTo} />
      {state.error === 'invalid' ? (
        <Alert variant="destructive">
          That email and password do not match. Check them and try again.
        </Alert>
      ) : null}
      {state.error === 'unavailable' ? (
        <Alert variant="destructive" title="Sign-in is unavailable right now">
          The sign-in service did not respond. Wait a moment and try again. If it keeps happening,
          tell your administrator.
        </Alert>
      ) : null}
      <FormField label="Email address">
        {(control) => (
          <Input
            {...control}
            name="email"
            type="email"
            autoComplete="username"
            placeholder="name@company.com"
            required
          />
        )}
      </FormField>
      <FormField label="Password">
        {(control) => (
          <Input
            {...control}
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="Your password"
            required
          />
        )}
      </FormField>
      <Button type="submit" pending={pending} pendingLabel="Signing in…">
        Continue
      </Button>
      <p className="text-caption text-muted-foreground" data-testid="local-mode-note">
        Local sign-in (AUTH_MODE=local): any email, password <code>{LOCAL_DEV_PASSWORD}</code>.
      </p>
    </form>
  );
}
