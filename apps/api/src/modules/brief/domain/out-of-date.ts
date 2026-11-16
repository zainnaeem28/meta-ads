/**
 * Out of date is derived, never stored (SB-D11): a job built from segment revision `n` is out of date once the
 * segment's revision is above `n`. Segment revisions go up by one whenever the prompt, the dialogue or the state changes.
 */
export function isOutOfDate(jobSegmentRevision: number, segmentRevision: number): boolean {
  return jobSegmentRevision < segmentRevision;
}

export interface SegmentRevision {
  readonly segmentId: string;
  readonly revision: number;
}

export interface JobRevision {
  readonly jobId: string;
  readonly segmentId: string;
  readonly segmentRevision: number;
}

/**
 * The jobs that are out of date against the current segment revisions, in input order. A job whose segment is not in
 * `segmentRevisions` is not reported: its segment is gone, so nothing can be compared.
 */
export function outOfDateJobs(
  jobs: readonly JobRevision[],
  segmentRevisions: readonly SegmentRevision[],
): string[] {
  const current = new Map(segmentRevisions.map((segment) => [segment.segmentId, segment.revision]));
  return jobs
    .filter((job) => {
      const revision = current.get(job.segmentId);
      return revision !== undefined && isOutOfDate(job.segmentRevision, revision);
    })
    .map((job) => job.jobId);
}
