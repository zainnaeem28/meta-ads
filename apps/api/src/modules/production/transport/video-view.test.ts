import { describe, expect, it } from 'vitest';
import { instant, qcView, videoJobView } from './video-view.js';

const job = {
  id: 'j', state: 'processing', causeClass: null, causeMessage: null,
  createdAt: '2026-11-15 23:53:22.123456+00', updatedAt: '2026-11-15 23:54:00+00', deadlineAt: '2026-11-16 00:23:22.5+00',
  campaignId: 'c', segmentId: 's', segmentPosition: 2, segmentRevision: 1, currentRevision: 2, outputMediaId: null,
  latestQc: null, qcHistory: [],
};

describe('video view', () => {
  it('keeps microseconds when it turns a timestamp into an instant', () => {
    expect(instant('2026-11-15 23:53:22.123456+00')).toBe('2026-11-15T23:53:22.123456Z');
    expect(instant('2026-11-15 23:53:22+00:00')).toBe('2026-11-15T23:53:22Z');
    expect(instant('2026-11-15T23:53:22.000Z')).toBe('2026-11-15T23:53:22.000Z');
  });
  it('derives the out-of-date flag and the label, and carries the QC runs', () => {
    const qc = { ...job, id: 'q', videoJobId: 'j', qcState: 'failed', reason: 'missing: calm', state: 'completed' };
    const view = videoJobView({ ...job, latestQc: qc, qcHistory: [qc] }, true);
    expect(view).toMatchObject({ id: 'j', label: 'processing', reused: true, outOfDate: true, segmentPosition: 2 });
    expect(view.latestQc).toEqual(qcView(qc));
    expect(view.qcHistory).toHaveLength(1);
    expect(videoJobView({ ...job, currentRevision: 1 }, false)).toMatchObject({ outOfDate: false, latestQc: null });
  });
});
