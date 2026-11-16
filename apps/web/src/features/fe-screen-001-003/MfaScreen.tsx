import { AuthShell } from '@shroomap/ui/cmp-032';
import { ClerkSlot } from '../../app/(auth)/_components/ClerkSlot';
import { AUTH_COPY, type MfaStep } from './copy';
import { MfaVerifyForm } from './MfaVerifyForm';

/** SCREEN-003: the provider-hosted two-step enrol and challenge (or the local stand-in); the copy says recovery re-proves a second factor. */
export function MfaScreen({ clerk, returnTo, step }: { clerk: boolean; returnTo: string; step: MfaStep }) {
  const enrol = step === 'enrol';
  return (
    <AuthShell
      variant="mfa"
      title={enrol ? AUTH_COPY.mfaEnrolTitle : AUTH_COPY.mfaTitle}
      description={enrol ? AUTH_COPY.mfaEnrolIntro : AUTH_COPY.mfaChallengeIntro}
    >
      {clerk ? <ClerkSlot base="/mfa" returnTo={returnTo} /> : <MfaVerifyForm returnTo={returnTo} step={step} />}
      <p className="text-caption text-muted-foreground" data-testid="mfa-recovery">
        {AUTH_COPY.recovery}
      </p>
    </AuthShell>
  );
}
