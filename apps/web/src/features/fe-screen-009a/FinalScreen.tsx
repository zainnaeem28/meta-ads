'use client';

import {
  createAssembly,
  getAssembly,
  getCampaign,
  getGetAssemblyQueryKey,
  getGetCampaignQueryKey,
  getListCampaignVideoJobsQueryKey,
  getListMyProviderKeysQueryKey,
  getMediaUrl,
  listCampaignVideoJobs,
  listMyProviderKeys,
  type Assembly,
  type AssemblyResponse,
  type CampaignResponse,
  type ProviderKeyListResponse,
  type SegmentJobsResponse,
  type SegmentJobsResponseDataItem,
} from '@shroomap/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@shroomap/ui/cmp-007';
import { Button } from '@shroomap/ui/cmp-003';
import { Checkbox } from '@shroomap/ui/cmp-006';
import { Progress } from '@shroomap/ui/cmp-008';
import { Alert } from '@shroomap/ui/cmp-011';
import { Dialog } from '@shroomap/ui/cmp-013';
import { Tabs } from '@shroomap/ui/cmp-014';
import { Stepper } from '@shroomap/ui/cmp-015';
import { Card } from '@shroomap/ui/cmp-018';
import { EmptyState } from '@shroomap/ui/cmp-019';
import { FinalPreview } from '@shroomap/ui/cmp-026';
import { OperatorShell, deriveKeyState } from '@shroomap/ui/cmp-030';
import { PageHeader } from '@shroomap/ui/cmp-033';
import { Icon } from '@shroomap/ui/icons';
import { useEffect, useRef, useState } from 'react';
import { ErrorNotice } from '../../components/errors';
import { IdempotencyKeys, idempotencyHeaders } from '../../lib/api/idempotency';
import { resolveError } from '../../lib/errors';
import { ROUTES } from '../../lib/errors/routes';
import { useJobPolling } from '../../lib/query/job-polling';
import { SCREEN_009_COPY as COPY } from './copy';

const CLIP_SECONDS = 15;
const CAP_CODES: readonly string[] = ['assembly_daily_limit', 'spend_cap_reached'];
const IN_PROGRESS = ['pending', 'queued', 'fetching', 'rendering', 'saving'] as const;
const STEP_OF: Record<string, number> = {
  pending: 0,
  queued: 0,
  fetching: 1,
  rendering: 2,
  saving: 3,
};
const STEP_PERCENT = [10, 35, 60, 85];

type QcKind = 'passed' | 'failed' | 'skipped' | 'pending' | 'none';
type Row = {
  position: number;
  jobId: string;
  qc: QcKind;
  reason: string | null;
  outOfDate: boolean;
};
type Dialogue = 'proactive' | 'recovery' | null;
type AssembleError = { error: unknown; payload: AssemblyPayload };
interface AssemblyPayload {
  clips: string[];
  confirmations?: { qcOverride: string[] };
}

const needsConfirm = (r: Row) => r.qc === 'failed' || r.qc === 'skipped';

/** The completed, active clips of the list as selectable rows. */
function completedRows(list: SegmentJobsResponseDataItem[]): Row[] {
  return list
    .filter((i) => i.segmentState === 'active' && i.latestJob?.state === 'completed')
    .sort((a, b) => a.position - b.position)
    .map((i) => {
      const job = i.latestJob!;
      const qc = job.latestQc?.qcState;
      return {
        position: i.position,
        jobId: job.id,
        qc:
          qc === 'passed' || qc === 'failed' || qc === 'skipped' || qc === 'pending' ? qc : 'none',
        reason: job.latestQc?.reason ?? null,
        outOfDate: job.outOfDate,
      };
    });
}

const QC_BADGE = {
  passed: { variant: 'success', icon: 'circle-check', label: 'QC passed' },
  failed: { variant: 'destructive', icon: 'circle-alert', label: 'QC failed' },
  skipped: { variant: 'warning', icon: 'triangle-alert', label: 'QC skipped' },
  pending: { variant: 'info', icon: 'clock', label: 'QC running' },
  none: { variant: 'neutral', icon: 'clock', label: 'No QC result' },
} as const;

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/**
 * SCREEN-009 at `/campaigns/[id]/final` (Operator): choose and order the completed clips, confirm failed or skipped
 * checks, assemble and follow the assembly (API-061, API-070, API-071). The finished file is played from the media link.
 */
export function FinalScreen({ campaignId }: { campaignId: string }) {
  const client = useQueryClient();
  const path = `/campaigns/${campaignId}/final`;
  const listKey = getListCampaignVideoJobsQueryKey(campaignId);
  const campaignKey = getGetCampaignQueryKey(campaignId);
  const [order, setOrder] = useState<number[]>([]);
  const [unchecked, setUnchecked] = useState<ReadonlySet<number>>(new Set());
  const [dialogue, setDialogue] = useState<Dialogue>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [ackMissing, setAckMissing] = useState(false);
  const [assemblyId, setAssemblyId] = useState<string | null>(null);
  const [reselect, setReselect] = useState(false);
  const [lastPayload, setLastPayload] = useState<AssemblyPayload | null>(null);
  const [failure, setFailure] = useState<AssembleError | null>(null);
  const [cap, setCap] = useState<AssembleError | null>(null);
  const [announce, setAnnounce] = useState('');
  const [focusMove, setFocusMove] = useState<{ position: number; dir: 'up' | 'down' } | null>(null);
  const idem = useRef(new IdempotencyKeys());
  const listRef = useRef<HTMLOListElement>(null);

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
  const jobs = useQuery({
    queryKey: listKey,
    queryFn: async ({ signal }) =>
      (await listCampaignVideoJobs(campaignId, { signal })).data as SegmentJobsResponse,
  });

  const camp = campaign.data?.data;
  const name = camp?.productName ?? COPY.fallbackName;
  const currentAssemblyId = assemblyId ?? camp?.latestAssemblyId ?? null;
  const assembly = useJobPolling({
    query: {
      queryKey: getGetAssemblyQueryKey(currentAssemblyId ?? ''),
      queryFn: async ({ signal }) =>
        (await getAssembly(currentAssemblyId!, { signal })).data as AssemblyResponse,
      enabled: currentAssemblyId !== null,
      retry: false,
    },
    getState: (d) =>
      d
        ? d.data.state === 'done'
          ? 'completed'
          : d.data.state === 'failed'
            ? 'failed'
            : 'processing'
        : undefined,
  });
  const assembled: Assembly | undefined = assembly.data?.data;

  // The rows in the order the person chose; clips they have not moved follow in segment order.
  const base = completedRows(jobs.data?.data ?? []);
  const rows = [...base].sort((a, b) => {
    const ia = order.indexOf(a.position);
    const ib = order.indexOf(b.position);
    return (ia < 0 ? 99 + a.position : ia) - (ib < 0 ? 99 + b.position : ib);
  });
  const selected = rows.filter((r) => !unchecked.has(r.position));
  const exceptions = selected.filter(needsConfirm);
  const seconds = selected.length * CLIP_SECONDS;
  const capCode = cap ? resolveError(cap.error, { surface: 'context' }).code : null;

  const move = (position: number, dir: 'up' | 'down') => {
    const next = rows.map((r) => r.position);
    const at = next.indexOf(position);
    const to = dir === 'up' ? at - 1 : at + 1;
    if (to < 0 || to >= next.length) return;
    [next[at], next[to]] = [next[to]!, next[at]!];
    setOrder(next);
    setFocusMove({ position, dir });
    const rank = next.filter((p) => !unchecked.has(p)).indexOf(position);
    setAnnounce(rank >= 0 ? COPY.moved(position, rank + 1) : '');
  };

  // Keep keyboard focus on the moved clip's control, or its twin when the clip reached an end of the list.
  useEffect(() => {
    if (!focusMove) return;
    const { position, dir } = focusMove;
    const root = listRef.current;
    const pick = (d: string) => root?.querySelector<HTMLElement>(`[data-move="${position}-${d}"]`);
    (pick(dir) ?? pick(dir === 'up' ? 'down' : 'up'))?.focus();
    setFocusMove(null);
  }, [focusMove]);

  const toggle = (position: number, on: boolean) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (on) next.delete(position);
      else next.add(position);
      return next;
    });

  const build = (overrides: Row[]): AssemblyPayload => ({
    clips: selected.map((r) => r.jobId),
    ...(overrides.length > 0
      ? { confirmations: { qcOverride: overrides.map((r) => r.jobId) } }
      : {}),
  });

  const submit = useMutation({
    mutationFn: async (payload: AssemblyPayload) => {
      const res = await createAssembly(
        campaignId,
        payload,
        idempotencyHeaders(idem.current.keyFor(payload)),
      );
      idem.current.succeeded();
      return res;
    },
    onSuccess: (res, payload) => {
      const created = (res.data as AssemblyResponse).data;
      setDialogue(null);
      setFailure(null);
      setCap(null);
      setReselect(false);
      setLastPayload(payload);
      setAssemblyId(created.id);
      client.setQueryData(getGetAssemblyQueryKey(created.id), res.data);
      void client.invalidateQueries({ queryKey: campaignKey });
    },
    onError: (error, payload) => {
      const code = resolveError(error, { surface: 'context' }).code;
      if (code === 'qc_confirmation_required') {
        // The checks changed under the page: read them again, then ask for the confirmation on what they are now.
        setFailure(null);
        void jobs.refetch().then(() => setDialogue('recovery'));
        return;
      }
      setDialogue(null);
      if (CAP_CODES.includes(code)) {
        setCap({ error, payload });
        setFailure(null);
        return;
      }
      setFailure({ error, payload });
      if (code === 'clip_not_completed' || code === 'state_conflict') void jobs.refetch();
    },
  });

  const assemble = () => {
    if (selected.length === 0 || submit.isPending) return;
    setFailure(null);
    if (exceptions.length > 0) {
      setAcknowledged(false);
      setAckMissing(false);
      setDialogue('proactive');
      return;
    }
    submit.mutate(build([]));
  };

  const confirmProactive = () => {
    if (!acknowledged) {
      setAckMissing(true);
      return;
    }
    submit.mutate(build(exceptions));
  };

  const startOver = () => {
    setReselect(true);
    setAssemblyId(null);
    setFailure(null);
  };

  // The same clips again: from this session's request, or from the assembly that was loaded.
  const again = () => {
    if (lastPayload) return submit.mutate(lastPayload);
    if (!assembled) return startOver();
    const used = [...assembled.clips].sort((a, b) => a.position - b.position);
    const overrides = used.filter((c) => c.qcOverrideConfirmed).map((c) => c.videoJobId);
    submit.mutate({
      clips: used.map((c) => c.videoJobId),
      ...(overrides.length > 0 ? { confirmations: { qcOverride: overrides } } : {}),
    });
  };

  const downloadable = assembled?.state === 'done' && assembled.outputMediaId !== null;
  const media = useQuery({
    queryKey: ['media-url', assembled?.outputMediaId],
    queryFn: async ({ signal }) => (await getMediaUrl(assembled!.outputMediaId!, { signal })).data,
    enabled: downloadable,
    staleTime: 4 * 60_000,
    retry: false,
  });
  const src = (media.data as { data?: { url?: string } } | undefined)?.data?.url;

  const inProgress = assembled && (IN_PROGRESS as readonly string[]).includes(assembled.state);
  const mode: 'loading' | 'error' | 'assembling' | 'failed' | 'done' | 'no-clips' | 'select' =
    jobs.isError && !jobs.data
      ? 'error'
      : !jobs.data || (currentAssemblyId !== null && !assembled && assembly.isPending && !reselect)
        ? 'loading'
        : assembled && !reselect && inProgress
          ? 'assembling'
          : assembled && !reselect && assembled.state === 'failed'
            ? 'failed'
            : assembled && !reselect && assembled.state === 'done'
              ? 'done'
              : base.length === 0
                ? 'no-clips'
                : 'select';

  const goTo = (id: string) => {
    if (id === 'brief') window.location.assign(`/campaigns/${campaignId}/brief`);
    if (id === 'clips') window.location.assign(`/campaigns/${campaignId}/clips`);
  };

  const recoveryRows = exceptions;
  const stepIndex = assembled ? (STEP_OF[assembled.state] ?? 0) : 0;
  const description = camp
    ? `UGC ad · ${camp.segmentCount} segments · ${camp.segmentCount * CLIP_SECONDS} s`
    : undefined;

  return (
    <OperatorShell
      role="user"
      path={path}
      pageName={`${COPY.title} · ${name}`}
      keyState={deriveKeyState(keys.data?.data)}
      onSignOut={() => window.location.assign(ROUTES.signIn)}
    >
      <div
        className="mx-auto flex max-w-wide flex-col gap-4"
        data-screen="SCREEN-009"
        data-final-state={
          dialogue === 'recovery'
            ? 'qc-confirm-required'
            : dialogue === 'proactive'
              ? 'qc-confirm'
              : cap && mode === 'select'
                ? 'cap-reached'
                : mode === 'select' && selected.length > 0
                  ? 'selecting'
                  : mode
        }
        aria-busy={mode === 'loading' ? true : undefined}
      >
        <PageHeader
          title={name}
          description={description}
          breadcrumb={[{ label: 'Campaigns', href: ROUTES.campaigns }, { label: name }]}
        />
        <Tabs
          label={COPY.stageTabs}
          value="final"
          onValueChange={goTo}
          tabs={[
            { id: 'brief', label: COPY.tabBrief },
            { id: 'clips', label: COPY.tabClips },
            { id: 'final', label: COPY.tabFinal },
          ]}
        >
          <div className="flex flex-col gap-4">
            <p role="status" className="sr-only">
              {announce}
            </p>

            {mode === 'error' ? (
              <ErrorNotice
                error={jobs.error}
                returnTo={path}
                retrying={jobs.isRefetching}
                onAction={() => void jobs.refetch()}
              />
            ) : null}

            {mode === 'loading' ? (
              <div className="flex flex-col gap-4">
                <Alert variant="info" role="status" title={COPY.loading} />
                <Card state="loading" title={undefined} />
              </div>
            ) : null}

            {mode === 'no-clips' ? (
              <EmptyState
                title={COPY.noClipsTitle}
                description={COPY.noClipsBody}
                headingLevel={2}
                action={
                  <Button asChild>
                    <a href={`/campaigns/${campaignId}/clips`}>{COPY.goToClips}</a>
                  </Button>
                }
              />
            ) : null}

            {mode === 'select' ? (
              <Card
                title={COPY.selectTitle}
                headingLevel={2}
                footer={
                  <div className="flex w-full flex-wrap items-center justify-between gap-3">
                    <span className="text-ui text-muted-foreground">
                      {selected.length === 0
                        ? COPY.noneSelected
                        : COPY.summary(selected.length, seconds)}
                    </span>
                    <Button
                      disabled={selected.length === 0 || cap !== null}
                      pending={submit.isPending && dialogue === null}
                      pendingLabel="Assembling"
                      onClick={assemble}
                    >
                      <Icon name="layers" size={16} />
                      {COPY.assemble}
                    </Button>
                  </div>
                }
              >
                <div className="flex flex-col gap-4">
                  <p className="text-ui text-muted-foreground">{COPY.selectHint}</p>
                  <ol ref={listRef} aria-label={COPY.listLabel} className="flex flex-col gap-2">
                    {rows.map((r, index) => {
                      const on = !unchecked.has(r.position);
                      const badge = QC_BADGE[r.qc];
                      const rank = selected.indexOf(r) + 1;
                      return (
                        <li
                          key={r.position}
                          data-clip={r.position}
                          data-qc={r.qc}
                          className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-1"
                        >
                          <span
                            aria-hidden="true"
                            className="flex size-6 flex-none items-center justify-center rounded-full bg-muted text-caption font-medium"
                          >
                            {on ? rank : '–'}
                          </span>
                          <Checkbox
                            className="min-w-40 flex-1"
                            checked={on}
                            onChange={(e) => toggle(r.position, e.target.checked)}
                            label={`Segment ${r.position} · ${clock(CLIP_SECONDS)}`}
                          />
                          <div className="ml-auto flex items-center gap-2">
                            {r.outOfDate ? (
                              <Badge variant="warning">
                                <Icon name="triangle-alert" size={16} />
                                Out of date
                              </Badge>
                            ) : null}
                            <Badge variant={badge.variant}>
                              <Icon name={badge.icon} size={16} />
                              {badge.label}
                            </Badge>
                            <span className="flex">
                              <Button
                                variant="icon-only"
                                size="sm"
                                aria-label={COPY.moveUp(r.position)}
                                data-move={`${r.position}-up`}
                                disabled={index === 0}
                                onClick={() => move(r.position, 'up')}
                              >
                                <Icon name="chevron-up" size={16} />
                              </Button>
                              <Button
                                variant="icon-only"
                                size="sm"
                                aria-label={COPY.moveDown(r.position)}
                                data-move={`${r.position}-down`}
                                disabled={index === rows.length - 1}
                                onClick={() => move(r.position, 'down')}
                              >
                                <Icon name="chevron-down" size={16} />
                              </Button>
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                  {cap ? (
                    <Alert variant="warning" role="alert" title={COPY.capTitle}>
                      {capCode === 'assembly_daily_limit' ? COPY.capBody : undefined}
                      {capCode !== 'assembly_daily_limit' ? (
                        <ErrorNotice error={cap.error} surface="context" returnTo={path} />
                      ) : null}
                    </Alert>
                  ) : null}
                  {failure ? (
                    <ErrorNotice
                      error={failure.error}
                      surface="context"
                      returnTo={path}
                      retrying={submit.isPending}
                      onAction={(a) => {
                        if (a === 'retry') submit.mutate(failure.payload);
                        else if (a === 'refresh' || a === 'reload') {
                          setFailure(null);
                          void jobs.refetch();
                        } else setFailure(null);
                      }}
                    />
                  ) : null}
                  {exceptions.length > 0 && !cap && !failure ? (
                    <Alert variant="warning" role="status">
                      {COPY.qcHeads(exceptions.length)}
                    </Alert>
                  ) : null}
                </div>
              </Card>
            ) : null}

            {mode === 'assembling' && assembled ? (
              <Card title={COPY.assemblingTitle} headingLevel={2} aria-live="polite">
                <div className="flex flex-col gap-4">
                  <div>
                    <Badge variant="info">
                      <Icon
                        name="loader-circle"
                        size={16}
                        className="animate-spin motion-reduce:animate-none"
                      />
                      {COPY.stepStatus[stepIndex]}
                    </Badge>
                  </div>
                  <Stepper steps={[...COPY.steps]} current={stepIndex} />
                  <Progress
                    label={COPY.progressLabel}
                    value={STEP_PERCENT[stepIndex]}
                    aria-valuetext={COPY.steps[stepIndex]}
                  />
                  <p className="text-ui text-muted-foreground">{COPY.assemblingBody}</p>
                </div>
              </Card>
            ) : null}

            {mode === 'failed' && assembled ? (
              <>
                {failure ? (
                  <ErrorNotice
                    error={failure.error}
                    surface="context"
                    returnTo={path}
                    retrying={submit.isPending}
                    onAction={(a) => {
                      if (a === 'retry') submit.mutate(failure.payload);
                      else setFailure(null);
                    }}
                  />
                ) : null}
                <EmptyState
                  variant="error"
                  title={COPY.failedTitle}
                  description={assembled.causeMessage ?? COPY.failedBody}
                  headingLevel={2}
                  action={
                    <div className="flex flex-wrap items-center gap-3">
                      <Button pending={submit.isPending} pendingLabel="Assembling" onClick={again}>
                        <Icon name="layers" size={16} />
                        {COPY.assembleAgain}
                      </Button>
                      <Button variant="outline" asChild>
                        <a href={`/campaigns/${campaignId}/clips`}>{COPY.goToClips}</a>
                      </Button>
                    </div>
                  }
                />
              </>
            ) : null}

            {mode === 'done' && assembled ? (
              <FinalPreview
                state={assembled.outOfDate ? 'out-of-date' : 'done'}
                title={COPY.doneLabel}
                durationSeconds={assembled.clips.length * CLIP_SECONDS}
                src={src}
                requestDownloadUrl={async () => {
                  const res = await getMediaUrl(assembled.outputMediaId!);
                  return (res.data as { data: { url: string } }).data.url;
                }}
                onReassemble={startOver}
              />
            ) : null}
          </div>
        </Tabs>
      </div>

      <Dialog
        open={dialogue === 'proactive'}
        onClose={() => setDialogue(null)}
        title={COPY.qcDialogTitle}
        confirmLabel={COPY.qcDialogConfirm}
        cancelLabel={COPY.qcDialogBack}
        pending={submit.isPending}
        error={ackMissing && !acknowledged ? COPY.qcDialogAckMissing : undefined}
        onConfirm={confirmProactive}
      >
        <div className="flex flex-col gap-2 text-ui">
          {exceptions.map((r) => (
            <p key={r.position}>
              {r.qc === 'failed' ? COPY.qcFailed(r.position, r.reason) : COPY.qcSkipped(r.position)}
            </p>
          ))}
          <Checkbox
            checked={acknowledged}
            onChange={(e) => {
              setAcknowledged(e.target.checked);
              setAckMissing(false);
            }}
            label={COPY.qcDialogAck}
          />
        </div>
      </Dialog>

      <Dialog
        open={dialogue === 'recovery'}
        onClose={() => setDialogue(null)}
        title="Confirm clips that did not pass the check"
        description={COPY.changedDialogIntro}
        confirmLabel="Include these clips and assemble"
        cancelLabel={COPY.qcDialogBack}
        pending={submit.isPending}
        onConfirm={() => submit.mutate(build(recoveryRows))}
      >
        <div className="flex flex-col gap-2 text-ui">
          {recoveryRows.length === 0 ? (
            <p>{COPY.changedNow}</p>
          ) : (
            <ul className="list-disc pl-5">
              {recoveryRows.map((r) => (
                <li key={r.position}>
                  {r.qc === 'failed'
                    ? COPY.changedFailed(r.position)
                    : COPY.changedSkipped(r.position)}
                </li>
              ))}
            </ul>
          )}
          <p>The final ad will include these clips as they are. Your confirmation is recorded.</p>
        </div>
      </Dialog>
    </OperatorShell>
  );
}
