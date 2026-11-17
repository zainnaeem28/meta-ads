'use client';

import {
  generateSegment,
  getCampaign,
  getGetCampaignQueryKey,
  getListCampaignVideoJobsQueryKey,
  getListMyProviderKeysQueryKey,
  getMediaUrl,
  listCampaignVideoJobs,
  listMyProviderKeys,
  rerunQc,
  retryVideoJob,
  type CampaignResponse,
  type ProviderKeyListResponse,
  type SegmentJobsResponse,
  type SegmentJobsResponseDataItem,
  type VideoJob,
} from '@shroomap/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@shroomap/ui/cmp-007';
import { Button } from '@shroomap/ui/cmp-003';
import { Alert } from '@shroomap/ui/cmp-011';
import { Tabs } from '@shroomap/ui/cmp-014';
import { Card } from '@shroomap/ui/cmp-018';
import { EmptyState } from '@shroomap/ui/cmp-019';
import { JobCard, type FailureCause, type JobState, type QcState } from '@shroomap/ui/cmp-022';
import { OperatorShell, deriveKeyState } from '@shroomap/ui/cmp-030';
import { PageHeader } from '@shroomap/ui/cmp-033';
import { useRef, useState } from 'react';
import { ErrorNotice } from '../../components/errors';
import { ApiClientError } from '../../lib/api/errors';
import { IdempotencyKeys, idempotencyHeaders } from '../../lib/api/idempotency';
import { resolveError } from '../../lib/errors';
import { ROUTES } from '../../lib/errors/routes';
import { useJobPolling } from '../../lib/query/job-polling';
import { SCREEN_008_COPY as COPY } from './copy';

type Action =
  | { kind: 'generate'; position: number }
  | { kind: 'retry'; position: number; jobId: string }
  | { kind: 'rerun'; position: number; jobId: string };
type Latched = 'key_missing' | 'key_disabled' | 'spend_cap_reached';

const ACTIVE_JOB = new Set(['pending', 'submitting', 'submitted', 'processing']);
const LATCH_CODES: readonly string[] = ['key_missing', 'key_disabled', 'spend_cap_reached'];

/** The API label and cause class mapped to the CMP-022 job state and failure class. */
export function cardState(job: VideoJob | null): { state: JobState; cause?: FailureCause } {
  if (!job) return { state: 'pending' };
  if (job.state === 'completed') return { state: 'completed' };
  if (job.state === 'processing') return { state: 'processing' };
  if (job.state === 'failed' || job.state === 'cancelled') {
    const c = job.causeClass;
    const cause: FailureCause =
      c === 'outcome_unknown'
        ? 'unknown'
        : c === 'configuration' || c === 'credit' || c === 'key_replaced' || c === 'key_deleted'
          ? 'configuration'
          : 'temporary';
    return { state: 'failed', cause };
  }
  // pending, submitting and submitted: the job exists and nothing more can be done on it yet.
  return { state: 'created' };
}

const hasActiveWork = (list: SegmentJobsResponseDataItem[]) =>
  list.some(
    (i) =>
      (i.latestJob && ACTIVE_JOB.has(i.latestJob.state)) ||
      i.latestJob?.latestQc?.qcState === 'pending',
  );

interface ClipCardProps {
  item: SegmentJobsResponseDataItem;
  busy: boolean;
  canStart: boolean;
  onGenerate: (position: number) => void;
  onRetry: (position: number, jobId: string) => void;
  onRerun: (position: number, jobId: string) => void;
}

function ClipCard({ item, busy, canStart, onGenerate, onRetry, onRerun }: ClipCardProps) {
  const job = item.latestJob;
  const { state, cause } = cardState(job);
  const qc = job?.latestQc?.qcState;
  const playable = state === 'completed' && job?.outputMediaId;
  const media = useQuery({
    queryKey: ['media-url', job?.outputMediaId],
    queryFn: async ({ signal }) => (await getMediaUrl(job!.outputMediaId!, { signal })).data,
    enabled: Boolean(playable),
    staleTime: 4 * 60_000,
    retry: false,
  });
  const src = (media.data as { data?: { url?: string } } | undefined)?.data?.url;
  const safe = job?.state === 'failed' || job?.state === 'cancelled' ? job.causeMessage : null;
  const p = item.position;
  return (
    <li
      className="flex flex-col gap-2"
      data-segment={p}
      data-out-of-date={job?.outOfDate || undefined}
    >
      <JobCard
        segment={p}
        state={state}
        cause={cause}
        src={src}
        qc={qc && qc !== 'pending' ? (qc as QcState) : undefined}
        qcReason={job?.latestQc?.reason ?? undefined}
        busy={busy}
        onGenerate={canStart ? () => onGenerate(p) : undefined}
        onRetry={canStart && job ? () => onRetry(p, job.id) : undefined}
        onRerunCheck={canStart && job ? () => onRerun(p, job.id) : undefined}
      />
      {safe ? <p className="text-caption text-muted-foreground">{safe}</p> : null}
      {job?.state === 'pending' ? (
        <p className="text-caption text-muted-foreground">{COPY.queued}</p>
      ) : null}
      {qc === 'pending' ? (
        <p role="status" className="text-caption text-muted-foreground">
          {COPY.qcRunning}
        </p>
      ) : null}
      {job?.outOfDate ? (
        <div className="flex flex-col items-start gap-2" data-testid={`out-of-date-${p}`}>
          <Badge variant="warning" icon="triangle-alert">
            {COPY.outOfDate}
          </Badge>
          <p className="text-caption text-muted-foreground">{COPY.outOfDateNote}</p>
          {state === 'completed' ? (
            <Button
              variant="outline"
              size="sm"
              aria-label={COPY.generateOutOfDate(p)}
              disabled={busy || !canStart}
              onClick={() => onGenerate(p)}
            >
              {COPY.generate}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * SCREEN-008 at `/campaigns/[id]/clips` (Operator): one job card per segment with its status, failure cause class and
 * QC result, Generate and Retry per segment and Re-run check (API-041, API-060 to API-064). Polls every 3 s while a
 * job or check runs and keeps what is on screen when a refresh fails.
 */
export function ClipsScreen({ campaignId }: { campaignId: string }) {
  const client = useQueryClient();
  const path = `/campaigns/${campaignId}/clips`;
  const listKey = getListCampaignVideoJobsQueryKey(campaignId);
  const campaignKey = getGetCampaignQueryKey(campaignId);
  const [actionError, setActionError] = useState<{ error: unknown; action: Action } | null>(null);
  const [latched, setLatched] = useState<{ code: Latched; error: unknown } | null>(null);
  const [toasts, setToasts] = useState<{ id: string; variant: 'success'; message: string }[]>([]);
  const idem = useRef(new Map<string, IdempotencyKeys>());

  const campaign = useQuery({
    queryKey: campaignKey,
    queryFn: async ({ signal }) =>
      (await getCampaign(campaignId, { signal })).data as CampaignResponse,
  });
  const keys = useQuery({
    queryKey: getListMyProviderKeysQueryKey(),
    queryFn: async ({ signal }) =>
      (await listMyProviderKeys({ signal })).data as ProviderKeyListResponse,
    retry: false,
  });
  const jobs = useJobPolling({
    query: {
      queryKey: listKey,
      queryFn: async ({ signal }) =>
        (await listCampaignVideoJobs(campaignId, { signal })).data as SegmentJobsResponse,
    },
    getState: (d) => (d ? (hasActiveWork(d.data) ? 'processing' : 'completed') : undefined),
    errorShown: actionError !== null,
  });

  const camp = campaign.data?.data;
  const name = camp?.productName ?? COPY.fallbackName;
  const items = (jobs.data?.data ?? [])
    .filter((i) => i.segmentState === 'active')
    .sort((a, b) => a.position - b.position);

  const wave = keys.data?.data.find((k) => k.provider === 'wavespeed');
  const keyProblem: Latched | null = !keys.isSuccess
    ? null
    : !wave?.configured
      ? 'key_missing'
      : wave.status === 'disabled'
        ? 'key_disabled'
        : null;
  const notAccepted = camp !== undefined && camp.briefState !== 'accepted';
  const block: { code: string; error: unknown } | null = notAccepted
    ? {
        code: 'brief_not_accepted',
        error: new ApiClientError({ status: 422, code: 'brief_not_accepted' }),
      }
    : (latched ??
      (keyProblem
        ? { code: keyProblem, error: new ApiClientError({ status: 422, code: keyProblem }) }
        : null));
  const canStart = block === null && jobs.isSuccess;

  const refreshAll = () => {
    setActionError(null);
    void jobs.refetch();
    void campaign.refetch();
  };

  const act = useMutation({
    mutationFn: async (a: Action) => {
      const id = `${a.kind}:${a.kind === 'generate' ? a.position : a.jobId}`;
      const keysFor = idem.current.get(id) ?? new IdempotencyKeys();
      idem.current.set(id, keysFor);
      const options = idempotencyHeaders(keysFor.keyFor({}));
      const res =
        a.kind === 'generate'
          ? await generateSegment(
              campaignId,
              a.position,
              { useProductImage: camp?.productMediaId != null },
              options,
            )
          : a.kind === 'retry'
            ? await retryVideoJob(a.jobId, options)
            : await rerunQc(a.jobId, options);
      keysFor.succeeded();
      return res;
    },
    onSuccess: (_res, a) => {
      setActionError(null);
      void client.invalidateQueries({ queryKey: listKey });
      void client.invalidateQueries({ queryKey: campaignKey });
      setToasts([
        {
          id: `${a.kind}-${a.position}-${Date.now()}`,
          variant: 'success',
          message:
            a.kind === 'rerun'
              ? `Check started for segment ${a.position}.`
              : `Segment ${a.position} clip started.`,
        },
      ]);
    },
    onError: (error, a) => {
      const code = resolveError(error, { surface: 'context' }).code;
      if (LATCH_CODES.includes(code)) {
        setLatched({ code: code as Latched, error });
        setActionError(null);
        return;
      }
      setActionError({ error, action: a });
      if (code === 'brief_not_accepted') void campaign.refetch();
      if (code === 'state_conflict' || code === 'clip_not_completed') void jobs.refetch();
    },
  });

  const start = (a: Action) => {
    setActionError(null);
    act.mutate(a);
  };

  const anyDone = items.some((i) => i.latestJob?.state === 'completed');
  const goTo = (id: string) => {
    if (id === 'brief') window.location.assign(`/campaigns/${campaignId}/brief`);
    if (id === 'final' && anyDone) window.location.assign(`/campaigns/${campaignId}/final`);
  };

  const loadingFirst = !jobs.data && !jobs.isError;
  let body;
  if (jobs.isError && !jobs.data) {
    body = (
      <ErrorNotice
        error={jobs.error}
        returnTo={path}
        retrying={jobs.isRefetching}
        onAction={() => void jobs.refetch()}
      />
    );
  } else if (loadingFirst) {
    body = (
      <div className="flex flex-col gap-4">
        <Alert variant="info" role="status" title={COPY.loading} />
        <Card state="loading" title={undefined} />
      </div>
    );
  } else if (items.length === 0) {
    body = <EmptyState title={COPY.empty} headingLevel={2} />;
  } else {
    body = (
      <ul
        aria-label={COPY.segmentsLabel}
        className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
      >
        {items.map((item) => (
          <ClipCard
            key={item.position}
            item={item}
            busy={act.isPending}
            canStart={canStart}
            onGenerate={(position) => start({ kind: 'generate', position })}
            onRetry={(position, jobId) => start({ kind: 'retry', position, jobId })}
            onRerun={(position, jobId) => start({ kind: 'rerun', position, jobId })}
          />
        ))}
      </ul>
    );
  }

  const stale = actionError ? resolveError(actionError.error, { surface: 'context' }).code : null;

  return (
    <OperatorShell
      role="user"
      path={path}
      pageName={`${COPY.title} · ${name}`}
      keyState={deriveKeyState(keys.data?.data)}
      toasts={toasts}
      onDismissToast={() => setToasts([])}
      onSignOut={() => window.location.assign(ROUTES.signIn)}
    >
      <div
        className="mx-auto flex max-w-wide flex-col gap-4"
        data-screen="SCREEN-008"
        data-clips-state={block ? block.code : 'ready'}
        aria-busy={loadingFirst ? true : undefined}
      >
        <PageHeader
          title={name}
          description={
            camp
              ? `UGC ad · ${camp.segmentCount} segments · ${camp.segmentCount * 15} s`
              : undefined
          }
          breadcrumb={[{ label: 'Campaigns', href: ROUTES.campaigns }, { label: name }]}
          actions={
            anyDone ? (
              <Button asChild>
                <a href={`/campaigns/${campaignId}/final`}>{COPY.continueFinal}</a>
              </Button>
            ) : undefined
          }
        />
        <Tabs
          label={COPY.stageTabs}
          value="clips"
          onValueChange={goTo}
          tabs={[
            { id: 'brief', label: COPY.tabBrief },
            { id: 'clips', label: COPY.tabClips },
            { id: 'final', label: COPY.tabFinal, disabled: !anyDone },
          ]}
        >
          <div className="flex flex-col gap-4">
            {block ? (
              <ErrorNotice
                error={block.error}
                surface="context"
                returnTo={path}
                linkHref={
                  block.code === 'brief_not_accepted' ? `/campaigns/${campaignId}/brief` : undefined
                }
              />
            ) : null}
            {actionError ? (
              <ErrorNotice
                error={actionError.error}
                surface="context"
                call="job"
                returnTo={path}
                linkHref={
                  stale === 'brief_not_accepted' ? `/campaigns/${campaignId}/brief` : undefined
                }
                retrying={act.isPending}
                onAction={(a) => {
                  if (a === 'retry') start(actionError.action);
                  else if (a === 'refresh' || a === 'reload') refreshAll();
                  else setActionError(null);
                }}
              />
            ) : null}
            {jobs.isError && jobs.data ? (
              <ErrorNotice
                error={jobs.error}
                surface="context"
                returnTo={path}
                retrying={jobs.isRefetching}
                onAction={() => void jobs.refetch()}
              />
            ) : null}
            <p role="status" className="min-h-5 text-caption text-muted-foreground">
              {jobs.isFetching && jobs.data && !jobs.isError ? COPY.updating : ''}
            </p>
            {body}
          </div>
        </Tabs>
      </div>
    </OperatorShell>
  );
}
