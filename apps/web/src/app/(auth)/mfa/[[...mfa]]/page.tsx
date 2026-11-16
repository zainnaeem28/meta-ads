import type { Metadata } from 'next';
import { resolveAuthMode } from '../../../../lib/auth/mode';
import { safeReturnPath } from '../../../../lib/errors/session';
import { MfaScreen } from '../../../../features/fe-screen-001-003/MfaScreen';

export const metadata: Metadata = { title: 'Two-step verification' };

type Search = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** SCREEN-003 at `/mfa`; `?step=enrol` shows the set-up copy (the provider decides the step in hosted mode). */
export default async function MfaPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  return (
    <MfaScreen
      clerk={resolveAuthMode(process.env) === 'clerk'}
      required={first(search['reason']) === 'mfa_required'}
      returnTo={safeReturnPath(first(search['return']))}
      step={first(search['step']) === 'enrol' ? 'enrol' : 'challenge'}
    />
  );
}
