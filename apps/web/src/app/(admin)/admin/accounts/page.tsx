import type { Metadata } from 'next';
import { AccountsScreen } from '../../../../features/fe-screen-011/AccountsScreen';
import { COPY } from '../../../../features/fe-screen-011/copy';

export const metadata: Metadata = { title: COPY.title, robots: { index: false, follow: false } };

/** SCREEN-011 at `/admin/accounts` (Administrator). The API answers 403 to anyone else and the page shows the unavailable state. */
export default function AccountsPage() {
  return <AccountsScreen />;
}
