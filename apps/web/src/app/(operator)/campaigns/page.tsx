import type { Metadata } from 'next';
import { CampaignsScreen } from '../../../features/fe-screen-005/CampaignsScreen';
import { SCREEN_005_COPY } from '../../../features/fe-screen-005/copy';

export const metadata: Metadata = {
  title: SCREEN_005_COPY.title,
  robots: { index: false, follow: false },
};

/** `/campaigns` (SCREEN-005): `?tab=history|drafts&q=&status=&page=`. The session middleware sends an anonymous visitor to sign-in. */
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
  return <CampaignsScreen initialSearch={params.toString()} />;
}
