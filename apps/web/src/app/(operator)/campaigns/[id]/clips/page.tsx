import type { Metadata } from 'next';
import { FirstData } from '../../../../../components/FirstData';
import { ClipsScreen } from '../../../../../features/fe-screen-008/ClipsScreen';
import { SCREEN_008_COPY } from '../../../../../features/fe-screen-008/copy';
import { briefQuery, campaignQuery, jobsQuery, keysQuery } from '../../../../../lib/query/queries';
import { campaignIdParam, prefetchFirstData } from '../../../../../lib/query/server-prefetch';

export const metadata: Metadata = {
  title: `${SCREEN_008_COPY.title} · ShrooMap`,
  robots: { index: false, follow: false },
};

/** `/campaigns/[id]/clips` (SCREEN-008). The session middleware sends an anonymous visitor to sign-in; the api decides the rest. The first viewport's reads are made on the server as the signed-in user (ADR-014). */
export default async function ClipsRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const campaignId = campaignIdParam(id);
  const data = campaignId
    ? await prefetchFirstData(({ client, fetcher }) => [
        client.prefetchQuery(campaignQuery(campaignId, fetcher)),
        client.prefetchQuery(briefQuery(campaignId, fetcher)),
        client.prefetchQuery(keysQuery(fetcher)),
        client.prefetchQuery(jobsQuery(campaignId, fetcher)),
      ])
    : null;
  return (
    <FirstData data={data}>
      <ClipsScreen campaignId={id} />
    </FirstData>
  );
}
