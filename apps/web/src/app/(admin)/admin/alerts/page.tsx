import type { Metadata } from 'next';
import { AlertsScreen } from '../../../../features/fe-screen-014/AlertsScreen';
import { SCREEN_014_COPY } from '../../../../features/fe-screen-014/copy';

export const metadata: Metadata = {
  title: SCREEN_014_COPY.title,
  robots: { index: false, follow: false },
};

/** `/admin/alerts` (SCREEN-014). The session middleware sends an anonymous visitor to sign-in; the api decides the role. */
export default function AlertsRoute() {
  return <AlertsScreen />;
}
