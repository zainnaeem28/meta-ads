'use client';

import {
  acceptBrief,
  editBrief,
  getBrief,
  getCampaign,
  getGetBriefQueryKey,
  getGetBriefUrl,
  getGetCampaignQueryKey,
  listMyProviderKeys,
  getListMyProviderKeysQueryKey,
  type Brief,
  type BriefPatchSegmentsItem,
  type BriefResponse,
  type Campaign,
  type CampaignResponse,
  type ClaimIssue,
  type ProviderKeyListResponse,
  type Segment,
} from '@shroomap/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@shroomap/ui/cmp-007';
import { Button } from '@shroomap/ui/cmp-003';
import { Textarea } from '@shroomap/ui/cmp-004';
import { Alert } from '@shroomap/ui/cmp-011';
import { Tabs } from '@shroomap/ui/cmp-014';
import { Card } from '@shroomap/ui/cmp-018';
import { EmptyState } from '@shroomap/ui/cmp-019';
import { HARD_MAX, SegmentEditor, countWords } from '@shroomap/ui/cmp-024';
import { OperatorShell, deriveKeyState } from '@shroomap/ui/cmp-030';
import { PageHeader } from '@shroomap/ui/cmp-033';
import { GridCol, PageGrid } from '@shroomap/ui/cmp-034';
import { Icon } from '@shroomap/ui/icons';
import { useEffect, useRef, useState } from 'react';
import { ErrorNotice } from '../../components/errors';
import { resolveError } from '../../lib/errors';
import { ROUTES } from '../../lib/errors/routes';
import { ifMatch } from '../../lib/api/etag-store';
import { POLL_INTERVAL_MS } from '../../lib/query/job-polling';
import { SCREEN_007_COPY as COPY, issueHeading } from './copy';

type Edits = Record<number, { dialogue?: string; prompt?: string }>;
type Toast = { id: string; variant: 'success'; message: string };

const BADGE = {
  generating: 'info',
  draft: 'warning',
  accepted: 'success',
  failed: 'destructive',
} as const;
const first = (v: string | null | undefined) => v ?? '';

/**
 * SCREEN-007 at `/campaigns/[id]/brief` (Operator): review the generated brief, edit each segment's dialogue and
 * visual prompt with word counters, and accept it once no claim issue is open (API-041, API-050, API-051, API-052).
 * Clearing an issue, regenerating and copying prompts belong to the next brief ticket.
 */
export function BriefScreen({ campaignId }: { campaignId: string }) {
  const client = useQueryClient();
  const briefKey = getGetBriefQueryKey(campaignId);
  const path = `/campaigns/${campaignId}/brief`;
  const [edits, setEdits] = useState<Edits>({});
  const [saveError, setSaveError] = useState<unknown>(null);
  const [acceptError, setAcceptError] = useState<unknown>(null);
  const [attempted, setAttempted] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const blockedRef = useRef<HTMLDivElement>(null);

  const brief = useQuery({
    queryKey: briefKey,
    queryFn: async ({ signal }) => (await getBrief(campaignId, { signal })).data as BriefResponse,
    refetchInterval: (q) => (q.state.data?.data.state === 'generating' ? POLL_INTERVAL_MS : false),
  });
  const campaign = useQuery({
    queryKey: getGetCampaignQueryKey(campaignId),
    queryFn: async ({ signal }) =>
      (await getCampaign(campaignId, { signal })).data as CampaignResponse,
  });
  // A missing, deleted or not-yours campaign goes to SCREEN-004 (UI-UX §7 FLOW-06, §9.1).
  const unavailable = [campaign.error, brief.error].some(
    (e) => e != null && resolveError(e, { surface: 'context' }).code === 'not_found',
  );
  useEffect(() => {
    if (unavailable) window.location.replace(ROUTES.unavailable);
  }, [unavailable]);
  const keys = useQuery({
    queryKey: getListMyProviderKeysQueryKey(),
    queryFn: async ({ signal }) =>
      (await listMyProviderKeys({ signal })).data as ProviderKeyListResponse,
    retry: false,
  });

  const data: Brief | undefined = brief.data?.data;
  const camp: Campaign | undefined = campaign.data?.data;
  const name = camp?.productName ?? COPY.fallbackName;
  const segments: Segment[] = (data?.segments ?? [])
    .filter((s) => s.state === 'active')
    .sort((a, b) => a.position - b.position);
  const openIssues: ClaimIssue[] = (data?.issues ?? []).filter((i) => i.resolution === 'open');
  const highRisk = openIssues.filter((i) => i.class === 'high_risk').length;
  const dirty = Object.keys(edits).length > 0;

  const valueOf = (s: Segment, field: 'dialogue' | 'prompt') =>
    edits[s.position]?.[field] ?? s[field];
  const setField = (s: Segment, field: 'dialogue' | 'prompt', value: string) =>
    setEdits((old) => {
      const next = { ...old, [s.position]: { ...old[s.position], [field]: value } };
      if (value === s[field]) delete next[s.position]![field];
      if (Object.keys(next[s.position]!).length === 0) delete next[s.position];
      if (Object.keys(next).length === 0) setSaveError(null);
      return next;
    });

  const tooLong = segments.find((s) => countWords(valueOf(s, 'dialogue')) > HARD_MAX);
  const empty = segments.find(
    (s) => valueOf(s, 'dialogue').trim() === '' || valueOf(s, 'prompt').trim() === '',
  );

  const store = (body: BriefResponse) => {
    client.setQueryData(briefKey, body);
    void client.invalidateQueries({ queryKey: getGetCampaignQueryKey(campaignId) });
  };

  const save = useMutation({
    mutationFn: async () => {
      const changed: BriefPatchSegmentsItem[] = Object.entries(edits).map(([position, e]) => ({
        position: Number(position),
        ...(e.dialogue !== undefined ? { dialogue: e.dialogue } : {}),
        ...(e.prompt !== undefined ? { prompt: e.prompt } : {}),
      }));
      return (
        await editBrief(campaignId, { segments: changed }, ifMatch(getGetBriefUrl(campaignId)))
      ).data as BriefResponse;
    },
    onSuccess: (body) => {
      store(body);
      setEdits({});
      setSaveError(null);
      setShowLatest(false);
      setAttempted(false);
      setToasts([
        { id: `saved-${body.data.version}`, variant: 'success', message: COPY.savedToast },
      ]);
    },
    onError: (error) => setSaveError(error),
  });

  const accept = useMutation({
    mutationFn: async () =>
      (await acceptBrief(campaignId, ifMatch(getGetBriefUrl(campaignId)))).data as BriefResponse,
    onSuccess: (body) => {
      store(body);
      void client.invalidateQueries({ queryKey: briefKey });
      setAcceptError(null);
      setAttempted(false);
      setToasts([
        { id: `accepted-${body.data.version}`, variant: 'success', message: COPY.acceptedToast },
      ]);
    },
    onError: (error) => {
      setAcceptError(error);
      if (resolveError(error, { surface: 'context' }).code === 'open_claim_issues')
        void brief.refetch();
    },
  });

  const reason: string | null = tooLong
    ? COPY.reasonTooLong(tooLong.position)
    : dirty
      ? COPY.reasonUnsaved
      : openIssues.length > 0
        ? COPY.reasonOpenIssues(openIssues.length, highRisk)
        : null;
  const accepted = data?.state === 'accepted';

  const onAccept = () => {
    if (reason) {
      setAttempted(true);
      blockedRef.current?.focus();
      return;
    }
    accept.mutate();
  };
  const refresh = (error: unknown) => {
    const conflict = resolveError(error, { surface: 'context' }).code === 'version_conflict';
    // The latest text is shown only once it has arrived, so it is never the stale copy.
    void brief.refetch().then(() => conflict && setShowLatest(true));
  };
  const goTo = (id: string) => {
    if (id === 'clips' && accepted) window.location.assign(`/campaigns/${campaignId}/clips`);
  };
  const focusSegment = (position: number) => {
    document.querySelector<HTMLTextAreaElement>(`#segment-${position} textarea`)?.focus();
  };

  const openaiKey = keys.data?.data.find((k) => k.provider === 'openai');
  const keyIssue =
    keys.isSuccess && data && data.state !== 'generating'
      ? !openaiKey?.configured
        ? 'missing'
        : openaiKey.status === 'disabled'
          ? 'disabled'
          : null
      : null;

  const stateKey = data?.state;
  const actions =
    data && (data.state === 'draft' || data.state === 'accepted') ? (
      <>
        {dirty ? (
          <Button
            variant="outline"
            pending={save.isPending}
            pendingLabel={COPY.saving}
            disabled={Boolean(tooLong || empty)}
            onClick={() => save.mutate()}
          >
            <Icon name="check" size={16} />
            {COPY.save}
          </Button>
        ) : null}
        {accepted && !dirty ? (
          <Button asChild>
            <a href={`/campaigns/${campaignId}/clips`}>
              {COPY.continueToClips}
              <Icon name="arrow-right" size={16} />
            </a>
          </Button>
        ) : (
          <Button asChild disabled={reason !== null || accept.isPending} pending={accept.isPending}>
            <button
              type="button"
              aria-describedby={reason ? 'accept-reason' : undefined}
              onClick={onAccept}
            >
              <Icon name="check" size={16} />
              {accept.isPending ? COPY.accepting : COPY.accept}
            </button>
          </Button>
        )}
      </>
    ) : undefined;

  let body;
  if (brief.isError) {
    body = (
      <ErrorNotice
        error={brief.error}
        returnTo={path}
        retrying={brief.isRefetching}
        onAction={() => void brief.refetch()}
      />
    );
  } else if (!data || data.state === 'generating') {
    body = (
      <div className="flex flex-col gap-4">
        <Alert variant="info" role="status" title={data ? COPY.generatingTitle : COPY.loadingBrief}>
          {data ? COPY.generatingBody : null}
        </Alert>
        <Card state="loading" title={undefined} />
      </div>
    );
  } else if (data.state === 'failed') {
    body = (
      <Card>
        <EmptyState
          variant="error"
          title={COPY.failedTitle}
          description={data.generationJob?.causeMessage ?? COPY.failedFallback}
          headingLevel={2}
          action={
            camp ? (
              <Button variant="outline" asChild>
                <a href={`${ROUTES.campaigns}/new?draft=${camp.draftId}`}>{COPY.editAnswers}</a>
              </Button>
            ) : undefined
          }
        />
      </Card>
    );
  } else {
    body = (
      <PageGrid>
        <GridCol span={8} className="flex flex-col gap-4">
          {accept.isPending ? null : acceptError ? (
            <div ref={blockedRef} tabIndex={-1}>
              <ErrorNotice
                error={acceptError}
                surface="context"
                returnTo={path}
                onAction={(a) => (a === 'refresh' ? refresh(acceptError) : undefined)}
              />
            </div>
          ) : null}
          {attempted && reason ? (
            <div ref={blockedRef} tabIndex={-1} className="outline-none">
              <Alert variant="destructive" title={COPY.blockedTitle}>
                {reason}
              </Alert>
            </div>
          ) : null}
          {keyIssue ? (
            <Alert
              variant="warning"
              role="status"
              title={keyIssue === 'missing' ? COPY.keyMissingTitle : COPY.keyDisabledTitle}
              action={
                <Button size="sm" asChild>
                  <a href={ROUTES.providerKeys}>
                    {keyIssue === 'missing' ? COPY.keyMissingAction : COPY.keyDisabledAction}
                  </a>
                </Button>
              }
            >
              {keyIssue === 'missing' ? COPY.keyMissingBody : COPY.keyDisabledBody}
            </Alert>
          ) : null}
          {saveError ? (
            <ErrorNotice
              error={saveError}
              surface="context"
              returnTo={path}
              retrying={save.isPending}
              onAction={(a) => (a === 'refresh' ? refresh(saveError) : void save.mutate())}
            />
          ) : null}

          {accepted && !dirty ? (
            <Card>
              <div className="flex items-center gap-3">
                <span className="text-success">
                  <Icon name="circle-check" size={24} />
                </span>
                <div className="flex flex-col">
                  <h2 className="text-body font-semibold">{COPY.acceptedTitle}</h2>
                  <p className="text-ui text-muted-foreground">{COPY.acceptedBody}</p>
                </div>
              </div>
            </Card>
          ) : openIssues.length > 0 ? (
            <Card>
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h2 id="issues-title" className="text-body font-semibold">
                      {COPY.issuesTitle(openIssues.length)}
                    </h2>
                    <p className="text-ui text-muted-foreground">{COPY.issuesNote}</p>
                  </div>
                  {highRisk > 0 ? (
                    <Badge variant="destructive" icon="circle-alert">
                      {highRisk} high risk
                    </Badge>
                  ) : null}
                </div>
                <ul aria-labelledby="issues-title" className="flex flex-col gap-3">
                  {openIssues.map((issue) => {
                    const high = issue.class === 'high_risk';
                    return (
                      <li
                        key={issue.id}
                        data-class={issue.class}
                        className={`flex items-start gap-3 rounded-md border p-3 ${high ? 'border-destructive-border bg-destructive-subtle' : 'border-warning-border bg-warning-subtle'}`}
                      >
                        <span className={high ? 'text-destructive' : 'text-warning'}>
                          <Icon name={high ? 'shield-alert' : 'triangle-alert'} size={20} />
                        </span>
                        <div className="flex min-w-0 flex-1 flex-col gap-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <strong className="text-ui font-semibold">{issueHeading(issue)}</strong>
                            <Badge variant={high ? 'destructive' : 'warning'}>
                              {high ? COPY.highRisk : COPY.other}
                            </Badge>
                          </div>
                          <p className="break-words text-ui">{issue.message}</p>
                          {high ? (
                            <p className="text-caption text-muted-foreground">
                              {COPY.highRiskNote}
                            </p>
                          ) : null}
                          <div>
                            <Button variant="outline" size="sm" asChild>
                              <a
                                href={`#segment-${issue.segmentPosition}`}
                                onClick={(e) => {
                                  e.preventDefault();
                                  focusSegment(issue.segmentPosition);
                                }}
                              >
                                <Icon name="pencil" size={16} />
                                {COPY.editSegment(issue.segmentPosition)}
                              </a>
                            </Button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </Card>
          ) : null}

          {segments.map((s) => {
            const mine = openIssues.filter((i) => i.segmentPosition === s.position);
            const mineHigh = mine.some((i) => i.class === 'high_risk');
            const promptId = `prompt-${s.position}`;
            const edited = edits[s.position];
            return (
              <section
                key={s.position}
                id={`segment-${s.position}`}
                aria-labelledby={`segment-${s.position}-title`}
                className="flex scroll-mt-20 flex-col gap-3 rounded-md border border-border bg-card p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 id={`segment-${s.position}-title`} className="text-body font-semibold">
                    {COPY.segmentHeading(s.position)}
                  </h3>
                  {mine.length > 0 ? (
                    mineHigh ? (
                      <Badge variant="destructive" icon="shield-alert">
                        {COPY.highRisk}
                      </Badge>
                    ) : (
                      <Badge variant="warning" icon="triangle-alert">
                        {COPY.segmentIssues(mine.length)}
                      </Badge>
                    )
                  ) : null}
                </div>
                <SegmentEditor
                  segment={s.position}
                  value={valueOf(s, 'dialogue')}
                  onChange={(v) => setField(s, 'dialogue', v)}
                  saveState={save.isPending && edited ? 'saving' : 'idle'}
                />
                <div className="flex flex-col gap-2">
                  <label htmlFor={promptId} className="text-ui font-semibold">
                    {COPY.visualPrompt} · Segment {s.position}
                  </label>
                  <Textarea
                    id={promptId}
                    rows={4}
                    maxLength={2000}
                    value={valueOf(s, 'prompt')}
                    onChange={(e) => setField(s, 'prompt', e.target.value)}
                  />
                </div>
                {showLatest && edited ? (
                  <div
                    className="flex flex-col gap-2 rounded-md border border-warning-border bg-warning-subtle p-3"
                    data-testid={`latest-${s.position}`}
                  >
                    <h4 className="text-ui font-semibold">
                      {COPY.latestTitle} · Segment {s.position}
                    </h4>
                    <p className="text-caption text-muted-foreground">{COPY.latestNote}</p>
                    <p className="whitespace-pre-wrap break-words text-ui">{first(s.dialogue)}</p>
                    <p className="whitespace-pre-wrap break-words text-ui text-muted-foreground">
                      {first(s.prompt)}
                    </p>
                    <div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setEdits((old) => {
                            const next = { ...old };
                            delete next[s.position];
                            if (Object.keys(next).length === 0) setSaveError(null);
                            return next;
                          })
                        }
                      >
                        {COPY.useLatest}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </section>
            );
          })}
        </GridCol>
        <GridCol span={4} as="section" aria-label={COPY.aside} className="flex flex-col gap-4">
          <Card title={COPY.asideTitle} headingLevel={2}>
            <dl className="flex flex-col gap-2 text-ui">
              <div className="flex gap-4">
                <dt className="w-20 shrink-0 text-muted-foreground">{COPY.asideProduct}</dt>
                <dd>{camp?.productName ?? '–'}</dd>
              </div>
              <div className="flex gap-4">
                <dt className="w-20 shrink-0 text-muted-foreground">{COPY.asideLength}</dt>
                <dd>
                  {camp ? `${camp.segmentCount} segments · ${camp.segmentCount * 15} s` : '–'}
                </dd>
              </div>
            </dl>
            {camp ? (
              <a
                href={`${ROUTES.campaigns}/new?draft=${camp.draftId}`}
                className="text-ui underline underline-offset-4"
              >
                {COPY.intakeLink}
              </a>
            ) : null}
          </Card>
          <Card title={COPY.asideChecks} headingLevel={3}>
            <p className="text-ui text-muted-foreground">{COPY.asideChecksNote}</p>
            <div className="mt-2 flex items-center justify-between text-ui">
              <span>{COPY.openIssues}</span>
              <Badge
                variant={openIssues.length > 0 ? 'destructive' : 'success'}
                icon={openIssues.length > 0 ? undefined : 'circle-check'}
              >
                {String(openIssues.length)}
              </Badge>
            </div>
          </Card>
        </GridCol>
      </PageGrid>
    );
  }

  const panel = (
    <div className="flex flex-col gap-4">
      {data ? (
        <div className="flex items-center gap-2">
          <Badge variant={BADGE[data.state]}>{COPY.stateBadge[data.state]}</Badge>
          {reason && !accepted && data.state === 'draft' ? (
            <p id="accept-reason" className="text-ui text-muted-foreground">
              {reason}
            </p>
          ) : null}
        </div>
      ) : null}
      {body}
    </div>
  );

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
        data-screen="SCREEN-007"
        data-brief-state={stateKey ?? 'loading'}
        aria-busy={!data && !brief.isError ? true : undefined}
      >
        <PageHeader
          title={name}
          description={
            camp
              ? `UGC ad · ${camp.segmentCount} segments · ${camp.segmentCount * 15} s`
              : undefined
          }
          breadcrumb={[{ label: 'Campaigns', href: ROUTES.campaigns }, { label: name }]}
          actions={actions}
        />
        <Tabs
          label={COPY.stageTabs}
          value="brief"
          onValueChange={goTo}
          tabs={[
            { id: 'brief', label: COPY.tabBrief },
            { id: 'clips', label: COPY.tabClips, disabled: !accepted },
            { id: 'final', label: COPY.tabFinal, disabled: true },
          ]}
        >
          {panel}
        </Tabs>
      </div>
    </OperatorShell>
  );
}
