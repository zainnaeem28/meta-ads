import { describe, expect, it } from 'vitest';
import { isOutOfDate, outOfDateJobs } from './out-of-date.js';

describe('out-of-date derivation (SB-D11, TC-REV-05)', () => {
  it('a job below the segment revision is out of date; equal or above is not', () => {
    expect(isOutOfDate(1, 2)).toBe(true);
    expect(isOutOfDate(2, 2)).toBe(false);
    expect(isOutOfDate(3, 2)).toBe(false);
  });

  it('reports the jobs of changed segments only, in input order', () => {
    const jobs = [
      { jobId: 'j1', segmentId: 's1', segmentRevision: 1 },
      { jobId: 'j2', segmentId: 's2', segmentRevision: 1 },
      { jobId: 'j3', segmentId: 's1', segmentRevision: 2 },
      { jobId: 'j4', segmentId: 'gone', segmentRevision: 1 },
    ];
    const segments = [
      { segmentId: 's1', revision: 2 },
      { segmentId: 's2', revision: 1 },
    ];
    expect(outOfDateJobs(jobs, segments)).toEqual(['j1']);
    expect(outOfDateJobs([], segments)).toEqual([]);
  });
});
