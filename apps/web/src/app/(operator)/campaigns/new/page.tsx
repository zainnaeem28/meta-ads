import type { Metadata } from 'next';
import { NewBriefWizard, type SubmitBlock } from '../../../../features/fe-screen-006b/NewBriefWizard';
import { SCREEN_006B_COPY } from '../../../../features/fe-screen-006b/copy';

export const metadata: Metadata = {
  title: SCREEN_006B_COPY.title,
  robots: { index: false, follow: false },
};

const BLOCKS: readonly SubmitBlock[] = ['key_missing', 'spend_cap_reached'];
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** `/campaigns/new` (SCREEN-006): `?draft=<id>` resumes. The session middleware sends an anonymous visitor to sign-in. */
export default async function NewBriefRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const block = first(query.block);
  // `?block=` previews the step-4 blocks in the test build only; the real ones come from API-024 (TASK-092).
  const initialBlock = process.env.NEXT_PUBLIC_E2E_PROBE === '1' ? BLOCKS.find((b) => b === block) : undefined;
  return <NewBriefWizard draftId={first(query.draft)} initialBlock={initialBlock} />;
}
