import type { Metadata } from 'next';
import { resolveAuthMode } from '../../../../lib/auth/mode';
import { isSessionExpiredVisit, safeReturnPath } from '../../../../lib/errors/session';
import { SignInScreen } from '../../../../features/fe-screen-001-003/SignInScreen';

export const metadata: Metadata = { title: 'Sign in' };

type Search = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** SCREEN-001 at `/sign-in`. */
export default async function SignInPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  return (
    <SignInScreen
      clerk={resolveAuthMode(process.env) === 'clerk'}
      expired={isSessionExpiredVisit(`?reason=${first(search['reason']) ?? ''}`)}
      returnTo={safeReturnPath(first(search['return']))}
    />
  );
}
