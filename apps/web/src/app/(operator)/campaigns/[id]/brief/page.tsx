import type { Metadata } from 'next';
import { FirstData } from '../../../../../components/FirstData';
import { BriefScreen } from '../../../../../features/fe-screen-007b/BriefScreen';
import { SCREEN_007_COPY } from '../../../../../features/fe-screen-007b/copy';
import { briefQuery, campaignQuery, keysQuery } from '../../../../../lib/query/queries';
import { campaignIdParam, prefetchFirstData } from '../../../../../lib/query/server-prefetch';

export const metadata: Metadata = {
  title: `${SCREEN_007_COPY.title} · ShrooMap`,
  robots: { index: false, follow: false },
};

/** `/campaigns/[id]/brief` (SCREEN-007). The session middleware sends an anonymous visitor to sign-in; the api decides the rest. The first viewport's reads are made on the server as the signed-in user (ADR-014). */
export default async function BriefRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const campaignId = campaignIdParam(id);
  const data = campaignId
    ? await prefetchFirstData(({ client, fetcher }) => [
        client.prefetchQuery(briefQuery(campaignId, fetcher)),
        client.prefetchQuery(campaignQuery(campaignId, fetcher)),
        client.prefetchQuery(keysQuery(fetcher)),
      ])
    : null;
  return (
    <FirstData data={data}>
      <BriefScreen campaignId={id} />
    </FirstData>
  );
}
