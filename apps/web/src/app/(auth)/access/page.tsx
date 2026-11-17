import type { Metadata } from 'next';
import { AccessScreen } from '../../../features/fe-screen-002/AccessScreen';
import { parseNamedState } from '../../../features/fe-screen-002/copy';

export const metadata: Metadata = { title: 'Access' };

/** SCREEN-002 at `/access`: signed in but not linked, suspended or removed, or an invitation that cannot be used. */
export default async function AccessPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[] }>;
}) {
  const { state } = await searchParams;
  return <AccessScreen named={parseNamedState(state)} />;
}
