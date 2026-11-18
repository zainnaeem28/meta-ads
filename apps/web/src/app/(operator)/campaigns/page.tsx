import type { Metadata } from 'next';
import { FirstData } from '../../../components/FirstData';
import { CampaignsScreen } from '../../../features/fe-screen-005/CampaignsScreen';
import { SCREEN_005_COPY } from '../../../features/fe-screen-005/copy';
import { apiQuery, parseUrl } from '../../../features/fe-screen-005/model';
import { countQuery, draftsQuery, historyQuery } from '../../../features/fe-screen-005/queries';
import { keysQuery, meQuery } from '../../../lib/query/queries';
import { prefetchFirstData } from '../../../lib/query/server-prefetch';

export const metadata: Metadata = {
  title: SCREEN_005_COPY.title,
  robots: { index: false, follow: false },
};

/**
 * `/campaigns` (SCREEN-005): `?tab=history|drafts&q=&status=&page=`. The session middleware sends an anonymous visitor to
 * sign-in. The first viewport's reads are made on the server as the signed-in user and handed to the screen (ADR-014).
 */
export default async function CampaignsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const params = new URLSearchParams();
  for (const key of ['tab', 'q', 'status', 'page']) {
    const value = query[key];
    const first = Array.isArray(value) ? value[0] : value;
    if (first) params.set(key, first);
  }
  const search = params.toString();
  const url = parseUrl(search);
  const q = apiQuery(url.q);
  const data = await prefetchFirstData(({ client, fetcher }) => [
    client.prefetchQuery(meQuery(fetcher)),
    client.prefetchQuery(keysQuery(fetcher)),
    ...(url.tab === 'drafts'
      ? [client.prefetchQuery(draftsQuery(fetcher))]
      : [
          client.prefetchQuery(historyQuery(client, url.status, q, url.page, fetcher)),
          client.prefetchQuery(countQuery('', undefined, fetcher)),
          client.prefetchQuery(countQuery('', q, fetcher)),
          client.prefetchQuery(countQuery('processing', q, fetcher)),
          client.prefetchQuery(countQuery('completed', q, fetcher)),
          client.prefetchQuery(countQuery('failed', q, fetcher)),
        ]),
  ]);
  return (
    <FirstData data={data}>
      <CampaignsScreen initialSearch={search} {...(data ? { now: data.now } : {})} />
    </FirstData>
  );
}
