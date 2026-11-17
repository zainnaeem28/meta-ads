import { describe, expect, it } from 'vitest';
import { thumbView } from './thumb-view.js';

const job = {
  id: 'j',
  state: 'failed',
  causeClass: 'credit',
  causeMessage: 'Add credit.',
  createdAt: '2026-11-15 23:53:22.123456+00',
  updatedAt: '2026-11-15 23:54:00+00',
  deadlineAt: '2026-11-15 23:58:22.5+00',
  campaignId: 'c',
  calloutText: 'Mellow mornings',
  outputMediaId: null,
};

describe('thumbView', () => {
  it('shapes the job summary and the call-out, with instants in ISO form and `reused` as given', () => {
    expect(thumbView(job, true)).toEqual({
      id: 'j',
      state: 'failed',
      label: 'failed',
      causeClass: 'credit',
      causeMessage: 'Add credit.',
      createdAt: '2026-11-15T23:53:22.123456Z',
      updatedAt: '2026-11-15T23:54:00Z',
      deadlineAt: '2026-11-15T23:58:22.5Z',
      reused: true,
      campaignId: 'c',
      calloutText: 'Mellow mornings',
      outputMediaId: null,
    });
  });

  it('labels a submitting job as created, like the clips', () => {
    expect(thumbView({ ...job, state: 'submitting' }, false).label).toBe('created');
  });
});
