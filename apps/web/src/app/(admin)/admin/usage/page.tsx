import type { Metadata } from 'next';
import { SCREEN_015_COPY } from '../../../../features/fe-screen-015/copy';
import { UsageScreen } from '../../../../features/fe-screen-015/UsageScreen';

export const metadata: Metadata = {
  title: SCREEN_015_COPY.title,
  robots: { index: false, follow: false },
};

type Query = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

/** `/admin/usage` (SCREEN-015, `?from=&to=` as UTC dates). The api decides the role; a non-admin gets the unavailable state. */
export default async function UsageRoute({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const from = one(query.from);
  const to = one(query.to);
  return <UsageScreen initialWindow={from && to ? { from, to } : null} />;
}
