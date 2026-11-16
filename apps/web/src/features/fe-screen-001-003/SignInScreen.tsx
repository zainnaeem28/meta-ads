import Link from 'next/link';
import { Alert } from '@shroomap/ui/cmp-011';
import { AuthShell } from '@shroomap/ui/cmp-032';
import { ClerkSlot } from '../../app/(auth)/_components/ClerkSlot';
import { LocalSignInForm } from '../../app/(auth)/_components/LocalSignInForm';
import { ROUTES } from '../../lib/errors/routes';
import { AUTH_COPY } from './copy';

/** SCREEN-001: the provider-hosted sign-in (or its local stand-in) in the auth shell's `idp-slot`, with the session-ended message above it. */
export function SignInScreen({ clerk, expired, returnTo }: { clerk: boolean; expired: boolean; returnTo: string }) {
  return (
    <AuthShell title={AUTH_COPY.productName} description={AUTH_COPY.signInIntro}>
      {expired ? <Alert variant="info">{AUTH_COPY.sessionExpired}</Alert> : null}
      {clerk ? <ClerkSlot base="/sign-in" returnTo={returnTo} /> : <LocalSignInForm returnTo={returnTo} />}
      <p className="text-ui text-muted-foreground">
        No account? Accounts are created by invitation.{' '}
        <Link href={ROUTES.access} className="text-primary underline">
          Ask for access
        </Link>
      </p>
    </AuthShell>
  );
}
