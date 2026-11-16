'use client';

import { useClerk } from '@clerk/nextjs';
import { Button } from '@shroomap/ui/cmp-003';
import { ROUTES } from '../errors/routes';

const CLERK_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

function ProviderLink({ label }: { label: string }) {
  const { openUserProfile } = useClerk();
  return (
    <Button variant="ghost" onClick={() => openUserProfile()}>
      {label}
    </Button>
  );
}

/**
 * The account and security entry for the shell's user menu: with the provider it opens the provider-hosted account and
 * security component (password, two-step verification); in local mode it opens the local second-step page.
 */
export function AccountSecurityLink({ label = 'Account and security' }: { label?: string }) {
  if (CLERK_KEY) return <ProviderLink label={label} />;
  return (
    <Button variant="ghost" asChild>
      <a href={ROUTES.mfa}>{label}</a>
    </Button>
  );
}
