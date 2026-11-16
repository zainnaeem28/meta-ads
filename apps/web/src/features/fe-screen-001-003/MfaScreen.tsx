import { Alert } from '@shroomap/ui/cmp-011';
import { AuthShell } from '@shroomap/ui/cmp-032';
import { ClerkSlot } from '../../app/(auth)/_components/ClerkSlot';
import { AUTH_COPY, AUTH_PANEL, type MfaStep } from './copy';
import { MfaVerifyForm } from './MfaVerifyForm';

/** SCREEN-003: the provider-hosted two-step enrol and challenge (or the local stand-in); the copy says recovery re-proves a second factor. */
export function MfaScreen({ clerk, required = false, returnTo, step }: { clerk: boolean; required?: boolean; returnTo: string; step: MfaStep }) {
  const enrol = step === 'enrol';
  return (
    <AuthShell
      variant="mfa"
      panel={AUTH_PANEL}
      title={enrol ? AUTH_COPY.mfaEnrolTitle : AUTH_COPY.mfaTitle}
      description={enrol ? AUTH_COPY.mfaEnrolIntro : AUTH_COPY.mfaChallengeIntro}
    >
      {required || enrol ? <Alert variant="info">{AUTH_COPY.mfaRequired}</Alert> : null}
      {clerk ? <ClerkSlot base="/mfa" returnTo={returnTo} /> : <MfaVerifyForm returnTo={returnTo} step={step} />}
      <p className="text-caption text-muted-foreground" data-testid="mfa-recovery">
        {AUTH_COPY.recovery}
      </p>
    </AuthShell>
  );
}
