import type { Metadata } from 'next';
import { FinalScreenWithDownload } from '../../../../../features/fe-screen-009b/FinalScreenWithDownload';
import { SCREEN_009_COPY } from '../../../../../features/fe-screen-009a/copy';

export const metadata: Metadata = {
  title: `${SCREEN_009_COPY.title} · ShrooMap`,
  robots: { index: false, follow: false },
};

/** `/campaigns/[id]/final` (SCREEN-009). The session middleware sends an anonymous visitor to sign-in; the api decides the rest. */
export default async function FinalRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FinalScreenWithDownload campaignId={id} />;
}
