'use client';

import type { QcRun, SegmentJobsResponseDataItem, VideoJob } from '@shroomap/contracts';
import { Badge, type BadgeVariant } from '@shroomap/ui/cmp-007';
import { Button } from '@shroomap/ui/cmp-003';
import { Alert } from '@shroomap/ui/cmp-011';
import { Icon } from '@shroomap/ui/icons';
import type { IconName } from '@shroomap/ui/icons';
import { useRef, useState, type ReactNode } from 'react';
import { ROUTES } from '../../lib/errors/routes';
import { SCREEN_008_COPY as COPY } from './copy';

export type RowCause = 'temporary' | 'configuration' | 'unknown';
export type RowState = 'none' | 'queued' | 'processing' | 'completed' | 'failed';

const ACTIVE = new Set(['pending', 'submitting', 'submitted']);

/** The API job mapped to the row's display state and failure cause class. */
export function rowState(job: VideoJob | null): { state: RowState; cause?: RowCause } {
  if (!job) return { state: 'none' };
  if (job.state === 'completed') return { state: 'completed' };
  if (job.state === 'processing') return { state: 'processing' };
  if (job.state === 'failed' || job.state === 'cancelled') {
    const c = job.causeClass;
    const cause: RowCause =
      c === 'outcome_unknown'
        ? 'unknown'
        : c === 'configuration' || c === 'credit' || c === 'key_replaced' || c === 'key_deleted'
          ? 'configuration'
          : 'temporary';
    return { state: 'failed', cause };
  }
  return ACTIVE.has(job.state) ? { state: 'queued' } : { state: 'none' };
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

const BADGE: Record<RowState, { variant: BadgeVariant; icon: IconName; label: string }> = {
  none: { variant: 'neutral', icon: 'clock', label: 'Not generated' },
  queued: { variant: 'info', icon: 'circle-dashed', label: 'Queued' },
  processing: { variant: 'info', icon: 'loader-circle', label: 'Processing' },
  completed: { variant: 'success', icon: 'circle-check', label: 'Completed' },
  failed: { variant: 'destructive', icon: 'circle-x', label: 'Failed' },
};

const FAILURE: Record<RowCause, { icon: IconName; title: string; body: string }> = {
  temporary: {
    icon: 'circle-x',
    title: 'Failed: temporary provider problem',
    body: 'WaveSpeed did not respond in time. Nothing is retried automatically. Your credit is only used if the provider reports the clip as made.',
  },
  configuration: {
    icon: 'circle-x',
    title: 'Failed: credit or configuration',
    body: 'WaveSpeed reports a problem with your account, such as no credit or a key that no longer works. Fix it in your WaveSpeed account, then retry. This is your own account, so ShrooMap cannot fix it for you.',
  },
  unknown: {
    icon: 'circle-help',
    title: 'Failed: outcome unknown',
    body: 'ShrooMap restarted after sending this clip to WaveSpeed but before its job number was saved. Check your WaveSpeed account for a clip made around this time. This job is not sent again automatically, to avoid charging you twice.',
  },
};

const QC: Record<
  'passed' | 'failed' | 'skipped',
  { icon: IconName; tone: string; box: string; title: string; fallback: string }
> = {
  passed: {
    icon: 'circle-check',
    tone: 'text-success',
    box: 'bg-success-subtle border-success-border',
    title: 'Audio check: passed',
    fallback: 'Speech matches the script.',
  },
  failed: {
    icon: 'circle-alert',
    tone: 'text-destructive',
    box: 'bg-destructive-subtle border-destructive-border',
    title: 'Audio check: failed',
    fallback: 'The speech does not match the script.',
  },
  skipped: {
    icon: 'triangle-alert',
    tone: 'text-warning',
    box: 'bg-warning-subtle border-warning-border',
    title: 'Audio check: skipped',
    fallback: 'The check could not run. Re-run it when the problem is fixed.',
  },
};

const QC_LABEL: Record<string, string> = { passed: 'passed', failed: 'failed', skipped: 'skipped' };

function QcPanel({ qc }: { qc: QcRun }) {
  const spec = QC[qc.qcState as 'passed' | 'failed' | 'skipped'];
  if (!spec) return null;
  return (
    <div
      data-qc={qc.qcState}
      className={`flex items-start gap-3 rounded-md border p-3 text-ui ${spec.box}`}
    >
      <span className={`mt-0.5 shrink-0 ${spec.tone}`}>
        <Icon name={spec.icon} size={16} />
      </span>
      <div className="min-w-0">
        <strong>{spec.title}</strong>
        <div className="break-words">{qc.reason ?? spec.fallback}</div>
      </div>
    </div>
  );
}

const withIcon = (icon: IconName, label: string): ReactNode => (
  <>
    <Icon name={icon} size={16} />
    {label}
  </>
);

export interface ClipRowProps {
  item: SegmentJobsResponseDataItem;
  /** The segment's spoken text from the brief; omitted when the brief could not be read. */
  script?: string;
  busy: boolean;
  canStart: boolean;
  src?: string;
  onGenerate: (position: number) => void;
  onRetry: (position: number, jobId: string) => void;
  onRerun: (position: number, jobId: string) => void;
}

/** One full-width segment row of SCREEN-008: 9:16 thumbnail, heading with timecodes, script, status and named actions. */
export function ClipRow({
  item,
  script,
  busy,
  canStart,
  src,
  onGenerate,
  onRetry,
  onRerun,
}: ClipRowProps) {
  const p = item.position;
  const job = item.latestJob;
  const { state, cause } = rowState(job);
  const qc = job?.latestQc ?? null;
  const qcPending = qc?.qcState === 'pending';
  const [previewing, setPreviewing] = useState(false);
  const [history, setHistory] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const badge =
    job?.outOfDate && state === 'completed'
      ? { variant: 'warning' as const, icon: 'clock' as const, label: COPY.outOfDate }
      : BADGE[state];
  const heading = `Segment ${p} · ${clock((p - 1) * 15)} to ${clock(p * 15)}`;
  const earlier = (job?.qcHistory ?? []).filter((r) => r.id !== qc?.id);
  const preview = () => {
    setPreviewing(true);
    requestAnimationFrame(() => void video.current?.play().catch(() => undefined));
  };
  const hasClip = state === 'completed' && Boolean(src);
  const fail = cause ? FAILURE[cause] : null;
  const safe =
    job && (job.state === 'failed' || job.state === 'cancelled') ? job.causeMessage : null;

  return (
    <li data-segment={p} data-out-of-date={job?.outOfDate || undefined} data-state={state}>
      <article
        aria-label={`Segment ${p} clip`}
        data-state={state}
        data-cause={cause}
        className="grid grid-cols-1 gap-4 rounded-lg border border-border bg-card p-4 md:grid-cols-(--clip-thumb-col)"
      >
        {hasClip ? (
          <div className="relative grid aspect-9/16 max-h-90 w-full place-items-center overflow-hidden rounded-md bg-surface-inverse text-surface-inverse-foreground max-md:max-w-55">
            <video
              ref={video}
              src={src}
              controls={previewing}
              muted={!previewing}
              playsInline
              preload="metadata"
              aria-label={`Clip for segment ${p}`}
              className="h-full w-full object-cover"
            />
            <span className="absolute bottom-2 right-2 rounded-sm bg-overlay px-1.5 py-0.5 text-caption tabular-nums text-surface-inverse-foreground">
              0:15
            </span>
          </div>
        ) : (
          <div
            aria-hidden="true"
            className="grid aspect-9/16 max-h-90 w-full place-items-center rounded-md border border-dashed border-input bg-muted text-muted-foreground max-md:aspect-auto max-md:h-30 max-md:max-w-none"
          >
            <Icon
              name={
                state === 'processing' || state === 'queued'
                  ? 'loader-circle'
                  : job?.outOfDate
                    ? 'triangle-alert'
                    : 'file-video'
              }
              size={24}
            />
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-ui font-semibold">{heading}</h3>
            <Badge variant={badge.variant} icon={badge.icon}>
              {badge.label}
            </Badge>
          </div>
          {script ? <p className="break-words text-ui text-muted-foreground">“{script}”</p> : null}

          {state === 'queued' || state === 'processing' ? (
            <div className="flex flex-col gap-2">
              <p role="status" className="text-ui text-muted-foreground">
                {state === 'queued' ? COPY.queued : COPY.processing}
              </p>
            </div>
          ) : null}

          {fail ? (
            <Alert variant="destructive" role="status" title={fail.title}>
              <span className="block">{fail.body}</span>
              {safe ? <span className="mt-1 block text-muted-foreground">{safe}</span> : null}
            </Alert>
          ) : null}

          {job?.outOfDate ? (
            <div data-testid={`out-of-date-${p}`}>
              <Alert variant="warning" role="status">
                {COPY.outOfDateNote}
              </Alert>
            </div>
          ) : null}

          {state === 'completed' && qc && !qcPending ? <QcPanel qc={qc} /> : null}
          {qcPending ? (
            <p role="status" className="text-ui text-muted-foreground">
              {COPY.qcRunning}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {state === 'none' ? (
              <Button
                size="sm"
                aria-label={`Generate segment ${p}`}
                disabled={busy || !canStart}
                onClick={() => onGenerate(p)}
              >
                {withIcon('clapperboard', COPY.generate)}
              </Button>
            ) : null}
            {state === 'failed' && cause !== 'unknown' && job ? (
              <Button
                size="sm"
                aria-label={`Retry segment ${p}`}
                disabled={busy || !canStart}
                onClick={() => onRetry(p, job.id)}
              >
                {withIcon('rotate-ccw', 'Retry')}
              </Button>
            ) : null}
            {state === 'failed' && cause === 'unknown' ? (
              <Button
                size="sm"
                variant="outline"
                aria-label={`Retry segment ${p} as a new clip`}
                disabled={busy || !canStart}
                onClick={() => onGenerate(p)}
              >
                {withIcon('rotate-ccw', 'Retry as a new clip')}
              </Button>
            ) : null}
            {state === 'failed' && cause === 'configuration' ? (
              <Button asChild size="sm" variant="ghost">
                <a href={ROUTES.providerKeys}>Check provider keys</a>
              </Button>
            ) : null}
            {state === 'failed' && !canStart ? (
              <span className="text-ui text-muted-foreground">{COPY.retryUnavailable}</span>
            ) : null}
            {state === 'completed' && job?.outOfDate ? (
              <Button
                size="sm"
                aria-label={COPY.generateOutOfDate(p)}
                disabled={busy || !canStart}
                onClick={() => onGenerate(p)}
              >
                {withIcon('rotate-ccw', 'Regenerate clip')}
              </Button>
            ) : null}
            {hasClip ? (
              <Button
                size="sm"
                variant="outline"
                aria-label={`${job?.outOfDate ? 'Preview old clip' : 'Preview'} segment ${p}`}
                onClick={preview}
              >
                {withIcon('play', job?.outOfDate ? 'Preview old clip' : 'Preview')}
              </Button>
            ) : null}
            {state === 'completed' && job ? (
              <Button
                size="sm"
                variant={qc?.qcState === 'passed' ? 'ghost' : 'outline'}
                aria-label={`Re-run check segment ${p}`}
                disabled={busy || !canStart}
                onClick={() => onRerun(p, job.id)}
              >
                {withIcon('audio-lines', 'Re-run audio check')}
              </Button>
            ) : null}
            {state === 'completed' && !job?.outOfDate ? (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Regenerate segment ${p}`}
                disabled={busy || !canStart}
                onClick={() => onGenerate(p)}
              >
                Regenerate
              </Button>
            ) : null}
          </div>

          {earlier.length > 0 ? (
            <div className="flex flex-col gap-2">
              <Button
                size="sm"
                variant="ghost"
                className="self-start"
                aria-expanded={history}
                aria-controls={`qc-history-${p}`}
                onClick={() => setHistory((v) => !v)}
              >
                {withIcon('history', `Earlier check results (${earlier.length})`)}
              </Button>
              {history ? (
                <ul
                  id={`qc-history-${p}`}
                  className="flex flex-col gap-1 text-ui text-muted-foreground"
                >
                  {earlier.map((r) => (
                    <li key={r.id}>
                      Audio check {QC_LABEL[r.qcState] ?? r.qcState}
                      {r.reason ? `: ${r.reason}` : ''}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </article>
    </li>
  );
}
