import type { Metadata } from 'next';
import { InvitationsScreen } from '../../../../features/fe-screen-012/InvitationsScreen';
import { COPY } from '../../../../features/fe-screen-012/copy';

export const metadata: Metadata = { title: COPY.title, robots: { index: false, follow: false } };

/** SCREEN-012 at `/admin/invitations` (Administrator). The API answers 403 to anyone else and the page shows the unavailable state. */
export default function InvitationsPage() {
  return <InvitationsScreen />;
}
