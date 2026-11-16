'use client';

import { FAILURE_CAUSES, JOB_STATES, JobCard } from './JobCard';
import type { FailureCause, JobState } from './JobCard';

const CASES: { key: string; state: JobState; cause?: FailureCause }[] = [
  ...JOB_STATES.filter((s) => s !== 'failed').map((s) => ({ key: s, state: s })),
  ...FAILURE_CAUSES.map((c) => ({ key: `failed-${c}`, state: 'failed' as const, cause: c })),
];
const noop = () => {};

/** Gallery host: every job state, every failure cause and every QC state (handlers need a client module). */
export function JobCardGallery() {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {CASES.map((c, i) => (
        <JobCard
          key={c.key}
          segment={(i % 4) + 1}
          state={c.state}
          cause={c.cause}
          qc={c.state === 'completed' ? 'passed' : undefined}
          onGenerate={noop}
          onRetry={noop}
          onRerunCheck={noop}
        />
      ))}
      <JobCard
        segment={2}
        state="completed"
        qc="failed"
        qcReason="Dialogue does not match the audio."
        onRerunCheck={noop}
      />
      <JobCard
        segment={3}
        state="completed"
        qc="skipped"
        qcReason="Check was not run for this clip."
        onRerunCheck={noop}
      />
    </div>
  );
}
