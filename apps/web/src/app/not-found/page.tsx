import type { Metadata } from 'next';
import { NotFoundScreen } from '../../features/fe-screen-004/NotFoundScreen';
import { SCREEN_004_COPY, parseScreen004State } from '../../features/fe-screen-004/copy';

type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Search;
}): Promise<Metadata> {
  const { title } = SCREEN_004_COPY[parseScreen004State((await searchParams)['state'])];
  return { title, robots: { index: false, follow: false } };
}

/** `/not-found?state=unavailable` is where a screen sends a missing, deleted or not-yours record (SCREEN-004). */
export default async function NotFoundRoute({ searchParams }: { searchParams: Search }) {
  return <NotFoundScreen state={parseScreen004State((await searchParams)['state'])} />;
}
