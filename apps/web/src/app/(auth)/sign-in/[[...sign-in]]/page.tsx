import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert } from '@shroomap/ui/cmp-011';
import { AuthShell } from '@shroomap/ui/cmp-032';
import { resolveAuthMode } from '../../../../lib/auth/mode';
import { ROUTES } from '../../../../lib/errors/routes';
import { isSessionExpiredVisit, safeReturnPath } from '../../../../lib/errors/session';
import { ClerkSlot } from '../../_components/ClerkSlot';
import { LocalSignInForm } from '../../_components/LocalSignInForm';

export const metadata: Metadata = { title: 'Sign in' };

type Search = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** SCREEN-001: the provider-hosted sign-in (or its local stand-in) in the auth shell's `idp-slot`. */
export default async function SignInPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const returnTo = safeReturnPath(first(search['return']));
  const expired = isSessionExpiredVisit(`?reason=${first(search['reason']) ?? ''}`);
  const clerk = resolveAuthMode(process.env) === 'clerk';
  return (
    <AuthShell title="Sign in" description="Use the email address your administrator invited.">
      {expired ? (
        <Alert variant="info" title="Your session ended">
          Sign in again to continue where you left off. Nothing you entered was lost.
        </Alert>
      ) : null}
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
