import type { ReactNode } from 'react';
import { Icon } from '../../icons';
import type { IconName } from '../../icons';
import { Button } from '../cmp-003/Button';
import { Badge } from '../cmp-007/Badge';
import type { BadgeVariant } from '../cmp-007/Badge';

export const JOB_STATES = ['pending', 'created', 'processing', 'completed', 'failed'] as const;
export type JobState = (typeof JOB_STATES)[number];
export const FAILURE_CAUSES = ['temporary', 'configuration', 'unknown'] as const;
export type FailureCause = (typeof FAILURE_CAUSES)[number];
export type QcState = 'passed' | 'failed' | 'skipped';

const STATE_LABEL: Record<JobState, string> = {
  pending: 'Pending',
  created: 'Created',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
};
const STATE_BADGE: Record<JobState, { variant: BadgeVariant; icon: IconName }> = {
  pending: { variant: 'neutral', icon: 'clock' },
  created: { variant: 'info', icon: 'circle-dashed' },
  processing: { variant: 'info', icon: 'loader-circle' },
  completed: { variant: 'success', icon: 'circle-check' },
  failed: { variant: 'destructive', icon: 'circle-x' },
};
const CAUSE_TEXT: Record<FailureCause, string> = {
  temporary: 'Temporary failure. Retry is safe.',
  configuration: 'Configuration or credit problem. Check your provider key and credit, then retry.',
  unknown:
    'Outcome unknown. Check your provider account before retrying; it is never retried automatically.',
};
const QC_BADGE: Record<QcState, { variant: BadgeVariant; icon: IconName; label: string }> = {
  passed: { variant: 'success', icon: 'circle-check', label: 'Check passed' },
  failed: { variant: 'destructive', icon: 'circle-x', label: 'Check failed' },
  skipped: { variant: 'warning', icon: 'circle-alert', label: 'Check skipped' },
};

export interface JobCardProps {
  /** Segment number, 1 to 4. */
  segment: number;
  state: JobState;
  /** Only for `failed`. */
  cause?: FailureCause;
  /** Poster or clip URL for a completed job. */
  src?: string;
  qc?: QcState;
  /** Why the check was skipped or failed. */
  qcReason?: string;
  onGenerate?: () => void;
  onRetry?: () => void;
  onRerunCheck?: () => void;
  /** Disables actions, e.g. while a request is in flight. */
  busy?: boolean;
  className?: string;
}

/** CMP-022 job card for one clip: status in text, 9:16 player or placeholder, QC row, named actions. */
export function JobCard({
  segment,
  state,
  cause = 'temporary',
  src,
  qc,
  qcReason,
  onGenerate,
  onRetry,
  onRerunCheck,
  busy = false,
  className,
}: JobCardProps) {
  const badge = STATE_BADGE[state];
  const retryable = state === 'failed' && cause !== 'unknown';
  const action = (
    label: string,
    handler: (() => void) | undefined,
    primary: boolean,
  ): ReactNode => (
    <Button
      variant={primary ? 'primary' : 'outline'}
      size="sm"
      aria-label={`${label} segment ${segment}`}
      disabled={busy || !handler}
      onClick={handler}
    >
      {label}
    </Button>
  );
  return (
    <article
      aria-label={`Segment ${segment} clip`}
      data-state={state}
      data-cause={state === 'failed' ? cause : undefined}
      className={[
        'flex w-full flex-col gap-3 rounded-lg border border-border bg-card p-4 max-md:max-w-55',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <h3 className="whitespace-nowrap text-ui font-semibold">Segment {segment}</h3>
        <Badge variant={badge.variant} icon={badge.icon}>
          {STATE_LABEL[state]}
        </Badge>
      </header>
      <div className="aspect-9/16 w-full overflow-hidden rounded-md bg-muted">
        {state === 'completed' && src ? (
          <video
            src={src}
            controls
            playsInline
            preload="metadata"
            aria-label={`Clip for segment ${segment}`}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center text-caption text-muted-foreground">
            <Icon name={state === 'failed' ? 'file-warning' : 'film'} size={24} />
            <span>{state === 'completed' ? 'Clip not available' : 'No clip yet'}</span>
          </div>
        )}
      </div>
      {state === 'failed' ? (
        <p
          role="status"
          className="rounded-md border border-destructive-border bg-destructive-subtle p-2 text-caption"
        >
          {CAUSE_TEXT[cause]}
        </p>
      ) : null}
      {qc ? (
        <p data-qc={qc} className="flex flex-wrap items-center gap-2 text-caption">
          <Badge variant={QC_BADGE[qc].variant} icon={QC_BADGE[qc].icon}>
            {QC_BADGE[qc].label}
          </Badge>
          {qcReason ? <span className="min-w-0 break-words">{qcReason}</span> : null}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {state === 'pending' ? action('Generate', onGenerate, true) : null}
        {retryable ? action('Retry', onRetry, true) : null}
        {state === 'completed' ? action('Re-run check', onRerunCheck, false) : null}
      </div>
    </article>
  );
}
