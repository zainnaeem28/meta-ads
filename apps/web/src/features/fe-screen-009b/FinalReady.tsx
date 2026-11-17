'use client';

import { getMediaUrl } from '@shroomap/contracts';
import { Badge } from '@shroomap/ui/cmp-007';
import { Button } from '@shroomap/ui/cmp-003';
import { Alert } from '@shroomap/ui/cmp-011';
import { FinalPreview } from '@shroomap/ui/cmp-026';
import { Card } from '@shroomap/ui/cmp-018';
import { Icon } from '@shroomap/ui/icons';
import { useCallback, useState } from 'react';
import { ErrorNotice } from '../../components/errors';
import type { DoneContext } from '../fe-screen-009a/FinalScreen';
import { SCREEN_009_COPY } from '../fe-screen-009a/copy';
import { SCREEN_009B_COPY as COPY } from './copy';
import { ThumbstopperCard } from './ThumbstopperCard';

const CLIP_SECONDS = 15;

function startDownload(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * SCREEN-009 `default` and `out-of-date`: the finished ad with Download (a fresh 5-minute link per click, API-032),
 * the out-of-date notice with its rebuild action, the clips used and the optional thumbstopper (API-075, API-076).
 */
export function FinalReady({ campaignId, assembled, src, onReassemble }: DoneContext) {
  const path = `/campaigns/${campaignId}/final`;
  const [poster, setPoster] = useState<string | undefined>();
  const [downloadError, setDownloadError] = useState<unknown>(null);
  const clips = [...assembled.clips].sort((a, b) => a.position - b.position);
  const changed = clips.find((c) => c.outOfDate);

  // The ownership check happens on the api for every click; a failure is shown with its own copy (UI-UX §9.1).
  const requestDownloadUrl = useCallback(async () => {
    setDownloadError(null);
    try {
      const res = await getMediaUrl(assembled.outputMediaId!);
      return (res.data as { data: { url: string } }).data.url;
    } catch (error) {
      setDownloadError(error);
      return '';
    }
  }, [assembled.outputMediaId]);

  return (
    <div
      className="flex flex-col gap-4"
      data-ready-state={assembled.outOfDate ? 'out-of-date' : 'done'}
    >
      {assembled.outOfDate ? (
        <Alert
          variant="warning"
          role="status"
          title={COPY.outOfDateTitle}
          action={
            <Button size="sm" onClick={onReassemble}>
              <Icon name="layers" size={16} />
              {COPY.reassemble}
            </Button>
          }
        >
          {changed ? COPY.outOfDateClip(changed.position) : COPY.outOfDateBrief}
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card
            title={COPY.finalTitle}
            headingLevel={2}
            footer={<p className="text-ui text-muted-foreground">{COPY.downloadHint}</p>}
          >
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="success">
                  <Icon name="circle-check" size={16} />
                  {COPY.done}
                </Badge>
                <span className="text-ui text-muted-foreground">
                  {COPY.length}: {COPY.lengthValue(clips.length * CLIP_SECONDS, clips.length)}
                </span>
              </div>
              <FinalPreview
                state="done"
                title={SCREEN_009_COPY.doneLabel}
                durationSeconds={clips.length * CLIP_SECONDS}
                src={src}
                poster={poster}
                requestDownloadUrl={requestDownloadUrl}
                onDownloadUrl={(url) => {
                  if (url) startDownload(url);
                }}
              />
              <div>
                <Button variant="outline" onClick={onReassemble}>
                  <Icon name="layers" size={16} />
                  {COPY.reassemble}
                </Button>
              </div>
              {downloadError ? (
                <ErrorNotice
                  error={downloadError}
                  surface="context"
                  returnTo={path}
                  onAction={(a) => {
                    if (a === 'retry') void requestDownloadUrl().then((u) => u && startDownload(u));
                    else setDownloadError(null);
                  }}
                />
              ) : null}
            </div>
          </Card>
        </div>
        <aside className="flex flex-col gap-4" aria-label="Thumbstopper and clips used">
          <ThumbstopperCard campaignId={campaignId} path={path} onReady={setPoster} />
          <Card title={COPY.clipsUsed} headingLevel={3}>
            <ol className="flex flex-col gap-2">
              {clips.map((c) => (
                <li key={c.position} className="flex flex-wrap items-center gap-2 text-ui">
                  <span
                    aria-hidden="true"
                    className="flex size-6 flex-none items-center justify-center rounded-full bg-muted text-caption font-medium"
                  >
                    {c.position}
                  </span>
                  <span className="mr-auto">{COPY.segment(c.position)}</span>
                  {c.qcOverrideConfirmed ? (
                    <Badge variant="warning">
                      <Icon name="triangle-alert" size={16} />
                      {COPY.qcOverride}
                    </Badge>
                  ) : null}
                  {c.outOfDate ? <Badge variant="warning">{COPY.clipOutOfDate}</Badge> : null}
                </li>
              ))}
            </ol>
          </Card>
        </aside>
      </div>
    </div>
  );
}
