import type { Metadata } from 'next';
import { AuthShell } from '@shroomap/ui/cmp-032';
import { resolveAuthMode } from '../../../../lib/auth/mode';
import { safeReturnPath } from '../../../../lib/errors/session';
import { ClerkSlot } from '../../_components/ClerkSlot';
import { LocalVerifyForm } from '../../_components/LocalVerifyForm';

export const metadata: Metadata = { title: 'Two-step verification' };

type Search = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** SCREEN-003: the provider-hosted two-step enrol and challenge (or the local stand-in) in the auth shell. */
export default async function MfaPage({ searchParams }: { searchParams: Promise<Search> }) {
  const returnTo = safeReturnPath(first((await searchParams)['return']));
  const clerk = resolveAuthMode(process.env) === 'clerk';
  return (
    <AuthShell
      variant="mfa"
      title="Two-step verification"
      description="Required for every account. Open your authenticator app and enter the 6-digit code."
    >
      {clerk ? <ClerkSlot base="/mfa" returnTo={returnTo} /> : <LocalVerifyForm returnTo={returnTo} />}
    </AuthShell>
  );
}
