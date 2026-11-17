import type { Thumbstopper } from '@shroomap/contracts';
import { CAMPAIGN_ID, mediaId } from '../fe-screen-009a/fixtures';

const T = '2026-11-17T09:00:00Z';

export const THUMB_ID = '00000000-0000-4000-b000-000000000001';
export const THUMB_MEDIA_ID = mediaId(8);

/** A contract-shaped thumbstopper job (OpenAPI Thumbstopper) in the given state. */
export const thumbFixture = (
  state: 'pending' | 'processing' | 'completed' | 'failed',
  over: Partial<Thumbstopper> = {},
): Thumbstopper => ({
  id: THUMB_ID,
  state,
  label: state,
  causeClass: state === 'failed' ? 'temporary' : null,
  causeMessage: state === 'failed' ? 'The image service could not make the frame.' : null,
  createdAt: T,
  updatedAt: T,
  reused: false,
  campaignId: CAMPAIGN_ID,
  calloutText: 'Sleep better tonight',
  outputMediaId: state === 'completed' ? THUMB_MEDIA_ID : null,
  ...over,
});
