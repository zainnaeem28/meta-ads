'use client';

import {
  getImageAnalysis,
  getMedia,
  requestImageAnalysis,
  uploadMedia,
  type ImageAnalysisResponse,
  type MediaResponse,
} from '@shroomap/contracts';
import { Button } from '@shroomap/ui/cmp-003';
import { Alert } from '@shroomap/ui/cmp-011';
import { FileUpload, type UploadItem } from '@shroomap/ui/cmp-021';
import { Icon } from '@shroomap/ui/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorNotice } from '../../components/errors';
import { IdempotencyKeys, idempotencyHeaders } from '../../lib/api/idempotency';
import { resolveError } from '../../lib/errors';
import { ROUTES } from '../../lib/errors/routes';
import { SCREEN_006B_COPY as COPY } from './copy';

const MEDIA_POLL_MS = 1500;
const ANALYSIS_POLL_MS = 2000;
const MAX_POLLS = 80;

type Analysis =
  | { phase: 'none' }
  | { phase: 'running' }
  | { phase: 'done'; text: string }
  | { phase: 'failed'; message: string };

export interface ProductImageProps {
  /** The image attached to the draft ('' for none). */
  mediaId: string;
  /** Called with the media id once it is ready, and with '' when the image is removed. */
  onMediaChange: (mediaId: string) => void;
  /** True while the image uploads or is processed (the step cannot be left). */
  onBusyChange: (busy: boolean) => void;
  /** Puts the analysis text into the product description. */
  onUseDescription: (text: string) => void;
  /** An API-035 answer that needs the sign-in dialog. */
  onUnauthenticated: () => void;
  disabled?: boolean;
}

const mediaIn = (res: { data: unknown }) => (res.data as MediaResponse).data;
const analysisIn = (res: { data: unknown }) => (res.data as ImageAnalysisResponse).data;
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

/** The reason text of a rejected image (API-031 `rejectReason`). */
export const rejectText = (reason: string | null): string =>
  (reason && (COPY.step2.rejected as Record<string, string>)[reason]) || COPY.step2.rejectedFallback;

/**
 * Step 2 image part of SCREEN-006: CMP-021 drop zone with the upload (API-030), the processing state polled with
 * API-031, and the product-only analysis (API-035, API-036) the person can copy into the description.
 */
export function ProductImage({ mediaId, onMediaChange, onBusyChange, onUseDescription, onUnauthenticated, disabled }: ProductImageProps) {
  const [item, setItem] = useState<UploadItem | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [analysis, setAnalysis] = useState<Analysis>({ phase: 'none' });
  const [analysisError, setAnalysisError] = useState<unknown>(null);
  const [requesting, setRequesting] = useState(false);
  const [used, setUsed] = useState(false);
  const work = useRef<AbortController | null>(null);
  const keys = useRef(new IdempotencyKeys());
  const attached = useRef(mediaId);
  attached.current = mediaId;

  const busy = item?.status === 'uploading' || item?.status === 'processing';
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  useEffect(() => () => work.current?.abort(), []);

  const reset = () => {
    work.current?.abort();
    work.current = new AbortController();
    setProblem(null);
    setAnalysis({ phase: 'none' });
    setAnalysisError(null);
    setUsed(false);
    return work.current.signal;
  };

  /** Polls API-036 until the analysis job finishes. */
  const watchAnalysis = useCallback(async (id: string, signal: AbortSignal) => {
    for (let n = 0; n < MAX_POLLS && !signal.aborted; n += 1) {
      try {
        const { job, productDescription } = analysisIn(await getImageAnalysis(id, { signal }));
        if (job === null) return setAnalysis({ phase: 'none' });
        if (job.state === 'completed') {
          return setAnalysis(productDescription ? { phase: 'done', text: productDescription } : { phase: 'failed', message: COPY.step2.analysisFailed });
        }
        if (job.state === 'failed' || job.state === 'cancelled') {
          return setAnalysis({ phase: 'failed', message: job.causeMessage ?? COPY.step2.analysisFailed });
        }
        setAnalysis({ phase: 'running' });
      } catch (error) {
        if (signal.aborted) return;
        if (resolveError(error).code === 'unauthenticated') return onUnauthenticated();
        return setAnalysisError(error);
      }
      await sleep(ANALYSIS_POLL_MS, signal);
    }
  }, [onUnauthenticated]);

  const becameReady = useCallback(
    (id: string, signal: AbortSignal) => {
      // A resumed draft already carries this image: no write.
      if (attached.current !== id) onMediaChange(id);
      void watchAnalysis(id, signal);
    },
    [onMediaChange, watchAnalysis],
  );

  /** Polls API-031 until the worker has made the image ready or rejected it. */
  const watchMedia = useCallback(
    async (id: string, signal: AbortSignal) => {
      for (let n = 0; n < MAX_POLLS && !signal.aborted; n += 1) {
        try {
          const media = mediaIn(await getMedia(id, { signal }));
          if (media.state === 'ready') {
            setItem((it) => (it ? { ...it, status: 'ready', size: media.bytes ?? it.size } : it));
            return becameReady(id, signal);
          }
          if (media.state === 'rejected') {
            setItem((it) => (it ? { ...it, status: 'rejected', reason: rejectText(media.rejectReason) } : it));
            return;
          }
          setItem((it) => (it ? { ...it, status: 'processing', size: media.bytes ?? it.size } : it));
        } catch (error) {
          if (signal.aborted) return;
          if (resolveError(error).code === 'unauthenticated') return onUnauthenticated();
          setItem((it) => (it ? { ...it, status: 'rejected', reason: COPY.step2.pollFailed } : it));
          return;
        }
        await sleep(MEDIA_POLL_MS, signal);
      }
      if (!signal.aborted) setItem((it) => (it && it.status === 'processing' ? { ...it, status: 'rejected', reason: COPY.step2.pollFailed } : it));
    },
    [becameReady, onUnauthenticated],
  );

  // A resumed draft: show the image it already has.
  useEffect(() => {
    if (item !== null || mediaId === '') return;
    const signal = reset();
    setItem({ id: mediaId, name: COPY.step2.storedName, size: 0, status: 'processing' });
    void watchMedia(mediaId, signal);
    // Runs once for the id the draft arrived with.
  }, [mediaId === '']);

  const upload = async (file: File) => {
    const signal = reset();
    setItem({ id: `local-${file.name}`, name: file.name, size: file.size, status: 'uploading', progress: 0 });
    try {
      const media = mediaIn(await uploadMedia({ file }, { signal }));
      setItem({ id: media.id, name: file.name, size: file.size, status: 'processing' });
      await watchMedia(media.id, signal);
    } catch (error) {
      if (signal.aborted) return;
      const view = resolveError(error, { surface: 'context' });
      if (view.code === 'unauthenticated') {
        setItem(null);
        return onUnauthenticated();
      }
      if (view.presentation === 'file-row') {
        setItem({ id: `local-${file.name}`, name: file.name, size: file.size, status: 'rejected', reason: view.message });
        if (view.code === 'storage_quota_reached') setProblem(error);
      } else {
        setItem(null);
        setProblem(error);
      }
    }
  };

  const remove = () => {
    work.current?.abort();
    setItem(null);
    reset();
    if (attached.current !== '') onMediaChange('');
  };

  const describe = async () => {
    if (!item || item.status !== 'ready') return;
    setRequesting(true);
    setAnalysisError(null);
    try {
      const res = await requestImageAnalysis(item.id, idempotencyHeaders(keys.current.keyFor({ mediaId: item.id })));
      keys.current.succeeded();
      setAnalysis({ phase: 'running' });
      work.current ??= new AbortController();
      const { job, productDescription } = analysisIn(res);
      if (job?.state === 'completed' && productDescription) setAnalysis({ phase: 'done', text: productDescription });
      else void watchAnalysis(item.id, work.current.signal);
    } catch (error) {
      if (resolveError(error).code === 'unauthenticated') onUnauthenticated();
      else setAnalysisError(error);
    } finally {
      setRequesting(false);
    }
  };

  const ready = item?.status === 'ready';
  return (
    <div className="flex flex-col gap-3">
      <p className="text-ui text-muted-foreground">{COPY.step2.imageHelp}</p>
      <FileUpload
        items={item ? [item] : []}
        label={COPY.step2.imageLabel}
        disabled={disabled || busy}
        onFiles={(files) => void upload(files[0]!)}
        onRejected={(rejections) => {
          const first = rejections[0]!;
          setItem({ id: `local-${first.file.name}`, name: first.file.name, size: first.file.size, status: 'rejected', reason: first.reason });
        }}
        onRemove={remove}
      />
      <p className="text-caption text-muted-foreground" data-testid="likeness-consent">
        {COPY.step2.likeness}
      </p>
      {problem ? <ErrorNotice error={problem} surface="context" call="write" returnTo={ROUTES.campaigns} onAction={() => setProblem(null)} /> : null}
      {ready ? (
        <div className="flex flex-col gap-3">
          {analysis.phase === 'none' || analysis.phase === 'failed' ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void describe()} pending={requesting} pendingLabel={COPY.step2.analysing}>
                {COPY.step2.analyse}
              </Button>
            </div>
          ) : null}
          {analysis.phase === 'running' ? (
            <p className="flex items-center gap-2 text-ui text-muted-foreground" role="status">
              <Icon name="loader-circle" size={16} className="animate-spin motion-reduce:animate-none" />
              {COPY.step2.analysisWaiting}
            </p>
          ) : null}
          {analysis.phase === 'failed' ? (
            <Alert variant="warning" role="alert" title={COPY.step2.analysisFailed}>
              {analysis.message}
            </Alert>
          ) : null}
          {analysis.phase === 'done' ? (
            <section aria-label={COPY.step2.analysisTitle} className="flex flex-col gap-2 rounded-md border border-border bg-card p-3" data-testid="analysis-result">
              <h3 className="text-ui font-semibold">{COPY.step2.analysisTitle}</h3>
              <p className="text-ui">{analysis.text}</p>
              <p className="text-caption text-muted-foreground">{COPY.step2.analysisNote}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onUseDescription(analysis.text);
                    setUsed(true);
                  }}
                >
                  {COPY.step2.analysisUse}
                </Button>
                {used ? (
                  <span role="status" className="flex items-center gap-1 text-ui text-muted-foreground">
                    <Icon name="circle-check" size={16} />
                    {COPY.step2.analysisUsed}
                  </span>
                ) : null}
              </div>
            </section>
          ) : null}
          {analysisError ? <ErrorNotice error={analysisError} surface="context" call="job" returnTo={ROUTES.campaigns} onAction={() => void describe()} retrying={requesting} /> : null}
        </div>
      ) : null}
    </div>
  );
}
