'use client';

import { useState } from 'react';
import type { HTMLAttributes } from 'react';
import { Alert } from '../cmp-011';
import { Button } from '../cmp-003';
import { Progress } from '../cmp-008';
import { Icon } from '../../icons';

export const PREVIEW_STATES = ['assembling', 'done', 'failed', 'out-of-date'] as const;
export type PreviewState = (typeof PREVIEW_STATES)[number];

export interface QcSummary {
  passed: number;
  total: number;
}

export interface FinalPreviewProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  state: PreviewState;
  title: string;
  durationSeconds?: number;
  /** The video file; used for done and out-of-date. */
  src?: string;
  /** The thumbstopper frame, shown before play. */
  poster?: string;
  /** WebVTT captions track. */
  captionsSrc?: string;
  qc?: QcSummary;
  /** Assembly step, e.g. "Joining segments (3 of 4)". */
  step?: string;
  /** Percent, when the assembler reports it. */
  progress?: number;
  /** Why it failed, in plain words. */
  failure?: string;
  /** Requests a fresh 5-minute download URL; called on every click. */
  requestDownloadUrl?: () => Promise<string>;
  /** Receives the fresh URL; the default starts the download. */
  onDownloadUrl?: (url: string) => void;
  onRetry?: () => void;
  onReassemble?: () => void;
}

export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function startDownload(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** CMP-026: the finished 9:16 video with its quality summary. The download link is requested on click, never stored. */
export function FinalPreview({
  state,
  title,
  durationSeconds,
  src,
  poster,
  captionsSrc,
  qc,
  step,
  progress,
  failure,
  requestDownloadUrl,
  onDownloadUrl = startDownload,
  onRetry,
  onReassemble,
  className,
  ...rest
}: FinalPreviewProps) {
  const [pending, setPending] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const duration = durationSeconds === undefined ? undefined : formatDuration(durationSeconds);
  const playable = state === 'done' || state === 'out-of-date';

  const download = async () => {
    if (!requestDownloadUrl) return;
    setPending(true);
    setDownloadError(false);
    try {
      onDownloadUrl(await requestDownloadUrl());
    } catch {
      setDownloadError(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      aria-label={`Final preview: ${title}`}
      data-state={state}
      className={['flex flex-col gap-4', className].filter(Boolean).join(' ')}
      {...rest}
    >
      <figure className="m-0 flex w-full max-w-55 flex-col gap-2 md:max-w-80">
        <div className="relative aspect-9/16 overflow-hidden rounded-lg bg-surface-inverse text-surface-inverse-foreground">
          {playable ? (
            <video
              controls
              preload="metadata"
              playsInline
              poster={poster}
              src={src}
              aria-label={`${title}${duration ? `, ${duration}` : ''}`}
              className="size-full object-contain"
            >
              {captionsSrc ? (
                <track kind="captions" srcLang="en" label="English" src={captionsSrc} default />
              ) : null}
            </video>
          ) : (
            <div className="flex size-full flex-col items-center justify-center gap-3 p-4 text-center text-ui">
              {state === 'failed' ? (
                <>
                  <Icon name="circle-x" size={24} />
                  <span>No video was made</span>
                </>
              ) : (
                <>
                  <Icon name="film" size={24} />
                  <div role="status" className="flex flex-col gap-1">
                    <span>Assembling your video</span>
                    {step ? <span className="text-surface-inverse-muted">{step}</span> : null}
                  </div>
                  <Progress
                    label="Assembly progress"
                    value={progress}
                    className="w-full border-surface-inverse-muted bg-surface-inverse"
                  />
                </>
              )}
            </div>
          )}
        </div>
        <figcaption className="text-ui text-muted-foreground">
          <span className="font-medium text-foreground">{title}</span>
          {duration ? <span> · {duration}</span> : null}
        </figcaption>
      </figure>

      {state === 'done' && qc ? (
        <p className="text-ui" data-testid="qc-summary">
          Quality check: {qc.passed} of {qc.total} checks passed
        </p>
      ) : null}

      {state === 'failed' ? (
        <Alert
          variant="destructive"
          title="The video could not be assembled"
          action={
            onRetry ? (
              <Button variant="outline" size="sm" onClick={onRetry}>
                Try assembling again
              </Button>
            ) : undefined
          }
        >
          {failure ?? 'Something went wrong while joining the segments.'}
        </Alert>
      ) : null}

      {state === 'out-of-date' ? (
        <Alert
          variant="warning"
          title="This video is out of date"
          action={
            onReassemble ? (
              <Button variant="outline" size="sm" onClick={onReassemble}>
                Assemble a new video
              </Button>
            ) : undefined
          }
        >
          The segments changed after it was assembled. Download gives you the earlier version.
        </Alert>
      ) : null}

      {downloadError ? (
        <Alert variant="destructive" title="The download link could not be created">
          Try again in a moment.
        </Alert>
      ) : null}

      {playable ? (
        <div>
          <Button
            variant="primary"
            pending={pending}
            pendingLabel="Preparing download"
            onClick={download}
          >
            <Icon name="download" size={16} />
            Download video
          </Button>
        </div>
      ) : null}
    </section>
  );
}
