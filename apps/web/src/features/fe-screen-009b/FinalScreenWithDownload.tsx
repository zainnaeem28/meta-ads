'use client';

import { FinalScreen } from '../fe-screen-009a/FinalScreen';
import { FinalReady } from './FinalReady';

/** SCREEN-009 as routed: choose and assemble (TASK-096) plus the finished ad, download and thumbstopper (TASK-097). */
export function FinalScreenWithDownload({ campaignId }: { campaignId: string }) {
  return <FinalScreen campaignId={campaignId} renderDone={(ctx) => <FinalReady {...ctx} />} />;
}
