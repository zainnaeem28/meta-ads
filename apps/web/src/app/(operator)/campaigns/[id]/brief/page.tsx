import type { Metadata } from 'next';
import { BriefScreen } from '../../../../../features/fe-screen-007b/BriefScreen';
import { SCREEN_007_COPY } from '../../../../../features/fe-screen-007b/copy';

export const metadata: Metadata = {
  title: `${SCREEN_007_COPY.title} · ShrooMap`,
  robots: { index: false, follow: false },
};

/** `/campaigns/[id]/brief` (SCREEN-007). The session middleware sends an anonymous visitor to sign-in; the api decides the rest. */
export default async function BriefRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BriefScreen campaignId={id} />;
}
