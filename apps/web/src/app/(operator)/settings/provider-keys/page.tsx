import type { Metadata } from 'next';
import { ProviderKeysScreen } from '../../../../features/fe-screen-010/ProviderKeysScreen';
import { SCREEN_010_COPY } from '../../../../features/fe-screen-010/copy';

export const metadata: Metadata = {
  title: SCREEN_010_COPY.title,
  robots: { index: false, follow: false },
};

/** `/settings/provider-keys` (SCREEN-010). The session middleware sends an anonymous visitor to sign-in; the api decides the rest. */
export default function ProviderKeysRoute() {
  return <ProviderKeysScreen />;
}
