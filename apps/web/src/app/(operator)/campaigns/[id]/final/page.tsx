import type { Metadata } from 'next';
import { FirstData } from '../../../../../components/FirstData';
import { FinalScreenWithDownload } from '../../../../../features/fe-screen-009b/FinalScreenWithDownload';
import { SCREEN_009_COPY } from '../../../../../features/fe-screen-009a/copy';
import { campaignQuery, jobsQuery, keysQuery } from '../../../../../lib/query/queries';
import { campaignIdParam, prefetchFirstData } from '../../../../../lib/query/server-prefetch';

export const metadata: Metadata = {
  title: `${SCREEN_009_COPY.title} · ShrooMap`,
  robots: { index: false, follow: false },
};

/** `/campaigns/[id]/final` (SCREEN-009). The session middleware sends an anonymous visitor to sign-in; the api decides the rest. The first viewport's reads are made on the server as the signed-in user (ADR-014). */
export default async function FinalRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const campaignId = campaignIdParam(id);
  const data = campaignId
    ? await prefetchFirstData(({ client, fetcher }) => [
        client.prefetchQuery(campaignQuery(campaignId, fetcher)),
        client.prefetchQuery(keysQuery(fetcher)),
        client.prefetchQuery(jobsQuery(campaignId, fetcher)),
      ])
    : null;
  return (
    <FirstData data={data}>
      <FinalScreenWithDownload campaignId={id} />
    </FirstData>
  );
}
