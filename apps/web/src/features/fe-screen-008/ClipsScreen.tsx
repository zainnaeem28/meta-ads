'use client';

import {
  generateSegment,
  getGetCampaignQueryKey,
  getListCampaignVideoJobsQueryKey,
  getMediaUrl,
  rerunQc,
  retryVideoJob,
  type SegmentJobsResponseDataItem,
} from '@shroomap/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@shroomap/ui/cmp-003';
import { Alert } from '@shroomap/ui/cmp-011';
import { Tabs } from '@shroomap/ui/cmp-014';
import { Card } from '@shroomap/ui/cmp-018';
import { EmptyState } from '@shroomap/ui/cmp-019';
import { Icon } from '@shroomap/ui/icons';
import { OperatorShell, deriveKeyState } from '@shroomap/ui/cmp-030';
import { PageHeader } from '@shroomap/ui/cmp-033';
import { useEffect, useRef, useState } from 'react';
import { ErrorNotice } from '../../components/errors';
import { ApiClientError } from '../../lib/api/errors';
import { IdempotencyKeys, idempotencyHeaders } from '../../lib/api/idempotency';
import { resolveError } from '../../lib/errors';
import { ROUTES } from '../../lib/errors/routes';
import { useJobPolling } from '../../lib/query/job-polling';
import { briefQuery, campaignQuery, jobsQuery, keysQuery } from '../../lib/query/queries';
import { ClipRow, type ClipRowProps } from './ClipRow';
import { SCREEN_008_COPY as COPY } from './copy';

type Action =
  | { kind: 'generate'; position: number }
  | { kind: 'remaining'; position: number; positions: number[] }
  | { kind: 'retry'; position: number; jobId: string }
  | { kind: 'rerun'; position: number; jobId: string };
type Latched = 'key_missing' | 'key_disabled' | 'spend_cap_reached';

const ACTIVE_JOB = new Set(['pending', 'submitting', 'submitted', 'processing']);
const LATCH_CODES: readonly string[] = ['key_missing', 'key_disabled', 'spend_cap_reached'];

const hasActiveWork = (list: SegmentJobsResponseDataItem[]) =>
  list.some(
    (i) =>
      (i.latestJob && ACTIVE_JOB.has(i.latestJob.state)) ||
      i.latestJob?.latestQc?.qcState === 'pending',
  );

function ClipItem(props: Omit<ClipRowProps, 'src'>) {
  const job = props.item.latestJob;
  const media = useQuery({
    queryKey: ['media-url', job?.outputMediaId],
    queryFn: async ({ signal }) => (await getMediaUrl(job!.outputMediaId!, { signal })).data,
    enabled: job?.state === 'completed' && Boolean(job.outputMediaId),
    staleTime: 4 * 60_000,
    retry: false,
  });
  const src = (media.data as { data?: { url?: string } } | undefined)?.data?.url;
  return <ClipRow {...props} src={src} />;
}

const formatCreated = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

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

  const campaign = useQuery(campaignQuery(campaignId));
  const brief = useQuery({ ...briefQuery(campaignId), retry: false });
  const keys = useQuery({ ...keysQuery(), retry: false });
  const jobs = useJobPolling({
    query: jobsQuery(campaignId),
    getState: (d) => (d ? (hasActiveWork(d.data) ? 'processing' : 'completed') : undefined),
    errorShown: actionError !== null,
  });

  // A missing, deleted or not-yours campaign is SCREEN-004 (UI-UX §7 FLOW-06, §9.1), not an in-page state.
  const unavailable = [campaign.error, jobs.error].some(
    (e) =>
      e !== null && e !== undefined && resolveError(e, { surface: 'page' }).code === 'not_found',
  );
  useEffect(() => {
    if (unavailable) window.location.replace('/not-found?state=unavailable');
  }, [unavailable]);

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
      const send = async (position: number) => {
        const id = `generate:${position}`;
        const keysFor = idem.current.get(id) ?? new IdempotencyKeys();
        idem.current.set(id, keysFor);
        const res = await generateSegment(
          campaignId,
          position,
          { useProductImage: camp?.productMediaId != null },
          idempotencyHeaders(keysFor.keyFor({})),
        );
        keysFor.succeeded();
        return res;
      };
      if (a.kind === 'generate') return send(a.position);
      if (a.kind === 'remaining') {
        let last;
        for (const position of a.positions) last = await send(position);
        return last;
      }
      const id = `${a.kind}:${a.jobId}`;
      const keysFor = idem.current.get(id) ?? new IdempotencyKeys();
      idem.current.set(id, keysFor);
      const options = idempotencyHeaders(keysFor.keyFor({}));
      const res =
        a.kind === 'retry'
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
              : a.kind === 'remaining'
                ? 'Remaining clips started.'
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

  const readyCount = items.filter((i) => i.latestJob?.state === 'completed').length;
  const anyDone = readyCount > 0;
  const missing = items.filter((i) => i.latestJob === null).map((i) => i.position);
  const outOfDate = items.filter((i) => i.latestJob?.outOfDate).map((i) => i.position);
  const scripts = new Map(
    (brief.data?.data.segments ?? [])
      .filter((g) => g.state === 'active')
      .map((g) => [g.position, g.dialogue] as const),
  );
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
      <ul aria-label={COPY.segmentsLabel} className="flex flex-col gap-4">
        {items.map((item) => (
          <ClipItem
            key={item.position}
            item={item}
            script={scripts.get(item.position)}
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
      keyState={deriveKeyState(keys.data?.data, keys.isError)}
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
              ? `UGC ad · ${camp.segmentCount} segments · ${camp.segmentCount * 15} s · Created ${formatCreated(camp.createdAt)}`
              : undefined
          }
          breadcrumb={[{ label: 'Campaigns', href: ROUTES.campaigns }, { label: name }]}
          actions={
            <span className="flex">
              <Button
                variant="outline"
                disabled={act.isPending || !canStart || missing.length === 0}
                onClick={() =>
                  start({ kind: 'remaining', position: missing[0] ?? 1, positions: missing })
                }
              >
                <Icon name="rotate-ccw" size={16} />
                {COPY.generateRemaining}
              </Button>
            </span>
          }
        />
        <Tabs
          label={COPY.stageTabs}
          value="clips"
          onValueChange={goTo}
          tabs={[
            { id: 'brief', label: COPY.tabBrief, icon: 'file-text' },
            {
              id: 'clips',
              label: COPY.tabClips,
              icon: 'film',
              chip:
                items.length > 0 ? (
                  <span className="rounded-full border border-border-strong bg-muted px-2 text-caption font-semibold text-foreground">
                    {`${readyCount} of ${items.length}`}
                  </span>
                ) : loadingFirst ? (
                  <span
                    aria-hidden="true"
                    data-chip-slot="loading"
                    className="rounded-full border border-border-strong bg-muted px-2 text-caption font-semibold text-transparent"
                  >
                    {'00 of 00'}
                  </span>
                ) : undefined,
            },
            { id: 'final', label: COPY.tabFinal, icon: 'video', disabled: !anyDone },
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
            {outOfDate.length > 0 ? (
              <Alert variant="warning" role="status" title={COPY.outOfDateTitle(outOfDate)}>
                {COPY.outOfDateBanner}
              </Alert>
            ) : null}
            <p role="status" className="min-h-5 text-caption text-muted-foreground">
              {jobs.isFetching && jobs.data && !jobs.isError ? COPY.updating : ''}
            </p>
            {body}
            {items.length > 0 ? (
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <p className="text-ui">
                    <strong>{`${readyCount} of ${items.length} clips ready.`}</strong>{' '}
                    <span className="text-muted-foreground">{COPY.footerHint}</span>
                  </p>
                  {anyDone ? (
                    <Button asChild>
                      <a href={`/campaigns/${campaignId}/final`}>
                        {COPY.continueFinal}
                        <Icon name="arrow-right" size={16} />
                      </a>
                    </Button>
                  ) : (
                    <Button disabled>
                      {COPY.continueFinal}
                      <Icon name="arrow-right" size={16} />
                    </Button>
                  )}
                </div>
              </Card>
            ) : null}
          </div>
        </Tabs>
      </div>
    </OperatorShell>
  );
}
