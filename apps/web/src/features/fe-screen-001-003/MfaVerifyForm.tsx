'use client';

import { useActionState } from 'react';
import { Button } from '@shroomap/ui/cmp-003';
import { Input } from '@shroomap/ui/cmp-004';
import { FormField } from '@shroomap/ui/cmp-010';
import { LOCAL_DEV_CODE } from '../../lib/auth/local-dev';
import { localVerify, type LocalFormState } from '../../app/(auth)/actions';
import { AUTH_COPY, type MfaStep } from './copy';

const INITIAL: LocalFormState = { error: null };

/** The local stand-in for the provider's two-step enrol and challenge (AUTH_MODE=local). */
export function MfaVerifyForm({ returnTo, step }: { returnTo: string; step: MfaStep }) {
  const [state, action, pending] = useActionState(localVerify, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-3" noValidate>
      <input type="hidden" name="return" value={returnTo} />
      <FormField label="6-digit code" error={state.error ? AUTH_COPY.mfaCodeError : undefined}>
        {(control) => (
          <Input
            {...control}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
          />
        )}
      </FormField>
      <Button type="submit" pending={pending} pendingLabel="Verifying…">
        {step === 'enrol' ? 'Verify and continue' : 'Verify'}
      </Button>
      <p className="text-caption text-muted-foreground">
        Local second step (AUTH_MODE=local): the code is <code>{LOCAL_DEV_CODE}</code>.
      </p>
    </form>
  );
}
