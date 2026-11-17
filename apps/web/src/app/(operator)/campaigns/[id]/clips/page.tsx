import type { Metadata } from 'next';
import { ClipsScreen } from '../../../../../features/fe-screen-008/ClipsScreen';
import { SCREEN_008_COPY } from '../../../../../features/fe-screen-008/copy';

export const metadata: Metadata = {
  title: `${SCREEN_008_COPY.title} · ShrooMap`,
  robots: { index: false, follow: false },
};

/** `/campaigns/[id]/clips` (SCREEN-008). The session middleware sends an anonymous visitor to sign-in; the api decides the rest. */
export default async function ClipsRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ClipsScreen campaignId={id} />;
}
