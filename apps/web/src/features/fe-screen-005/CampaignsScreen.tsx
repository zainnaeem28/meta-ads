'use client';

import {
  deleteCampaign,
  deleteDraft,
  getGetMeQueryKey,
  getListMyProviderKeysQueryKey,
  getMe,
  listCampaigns,
  listDrafts,
  listMyProviderKeys,
  type CampaignPage,
  type CampaignSummary,
  type Draft,
  type DraftPage,
  type MeResponse,
  type ProviderKeyListResponse,
} from '@shroomap/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@shroomap/ui/cmp-003';
import { Skeleton, SkeletonRegion } from '@shroomap/ui/cmp-008';
import { Alert } from '@shroomap/ui/cmp-011';
import { Dialog } from '@shroomap/ui/cmp-013';
import { Tabs } from '@shroomap/ui/cmp-014';
import { FilterBar, type FilterChip } from '@shroomap/ui/cmp-017';
import { EmptyState } from '@shroomap/ui/cmp-019';
import { CampaignRow } from '@shroomap/ui/cmp-027';
import { OperatorShell, deriveKeyState } from '@shroomap/ui/cmp-030';
import { PageHeader } from '@shroomap/ui/cmp-033';
import { Icon } from '@shroomap/ui/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorNotice } from '../../components/errors';
import { resolveError } from '../../lib/errors';
import { ROUTES } from '../../lib/errors/routes';
import { signInUrl } from '../../lib/errors/session';
import { SCREEN_005_COPY as COPY } from './copy';
import {
  COUNT_LIMIT,
  PAGE_SIZE,
  apiQuery,
  buildUrl,
  campaignHref,
  campaignStatus,
  draftHref,
  draftMatches,
  draftName,
  draftStepLabel,
  parseUrl,
  updatedLabel,
  type Filter,
  type Tab,
  type UrlState,
} from './model';

const PATH = ROUTES.campaigns;
const DEBOUNCE_MS = 300;
const STALE_MS = 30_000;
const DRAFT_PAGES_MAX = 6;

interface HistoryPage {
  rows: CampaignSummary[];
  hasNext: boolean;
  nextCursor: string | null;
  /** Every id on this page and the pages before it: a campaign that moved during traversal is not repeated. */
  seen: string[];
}

interface Target {
  kind: 'campaign' | 'draft';
  id: string;
  name: string;
}

interface Toast {
  id: string;
  variant: 'success';
  message: string;
}

const historyKey = (filter: Filter | '', q: string | undefined, page: number) =>
  ['campaigns-page', filter, q ?? '', page] as const;
const countKey = (filter: Filter | '', q: string | undefined) =>
  ['campaigns-count', filter, q ?? ''] as const;
const DRAFTS_KEY = ['drafts-all'] as const;

const params = (
  filter: Filter | '',
  q: string | undefined,
  limit: number,
  cursor?: string | null,
) => ({
  limit,
  ...(cursor ? { cursor } : {}),
  ...(q ? { q } : {}),
  ...(filter ? { filter } : {}),
});

/** The current search string; the server passes the first one so the first paint matches. */
const readSearch = () => (typeof window === 'undefined' ? '' : window.location.search);

/** SCREEN-005 at `/campaigns`: history and drafts with search, status chips, paging and delete (API-040, 020, 042, 025). */
export function CampaignsScreen({ initialSearch = '' }: { initialSearch?: string }) {
  const client = useQueryClient();
  const [url, setUrl] = useState<UrlState>(() => parseUrl(initialSearch));
  const [input, setInput] = useState(url.q);
  const [target, setTarget] = useState<Target | null>(null);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => setNow(Date.now()), []);

  // URL state: a change pushes one history entry; Back and Forward restore it.
  const go = useCallback((next: UrlState, mode: 'push' | 'replace' = 'push') => {
    const search = buildUrl(next);
    if (search !== readSearch()) {
      window.history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', `${PATH}${search}`);
    }
    setUrl(next);
  }, []);
  useEffect(() => {
    const onPop = () => {
      const next = parseUrl(readSearch());
      setUrl(next);
      setInput(next.q);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // The search box is debounced into the URL; a new search always returns to page 1.
  useEffect(() => {
    if (input === url.q) return;
    const timer = setTimeout(() => go({ ...url, q: input, page: 1 }, 'replace'), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input, url, go]);

  const q = apiQuery(url.q);
  const drafts = url.tab === 'drafts';

  const me = useQuery({
    queryKey: getGetMeQueryKey(),
    queryFn: async ({ signal }) => (await getMe({ signal })).data as MeResponse,
    retry: false,
  });
  const keys = useQuery({
    queryKey: getListMyProviderKeysQueryKey(),
    queryFn: async ({ signal }) =>
      (await listMyProviderKeys({ signal })).data as ProviderKeyListResponse,
    retry: false,
  });

  const loadHistory = useCallback(
    async (page: number, signal?: AbortSignal): Promise<HistoryPage> => {
      let cursor: string | null = null;
      let before: string[] = [];
      if (page > 1) {
        const previous = await client.fetchQuery({
          queryKey: historyKey(url.status, q, page - 1),
          queryFn: ({ signal: s }) => loadHistory(page - 1, s),
          staleTime: STALE_MS,
        });
        cursor = previous.nextCursor;
        before = previous.seen;
        if (!previous.hasNext || !cursor)
          return { rows: [], hasNext: false, nextCursor: null, seen: before };
      }
      const body = (await listCampaigns(params(url.status, q, PAGE_SIZE, cursor), { signal }))
        .data as CampaignPage;
      const seen = new Set(before);
      const rows = body.data.filter((c) => !seen.has(c.id));
      rows.forEach((c) => seen.add(c.id));
      const { hasNextPage, nextCursor } = body.metaData.pagination;
      return { rows, hasNext: hasNextPage, nextCursor, seen: [...seen] };
    },
    [client, url.status, q],
  );

  const history = useQuery({
    queryKey: historyKey(url.status, q, url.page),
    queryFn: ({ signal }) => loadHistory(url.page, signal),
    enabled: !drafts,
    staleTime: STALE_MS,
  });

  const count = (filter: Filter | '', search: string | undefined) => ({
    queryKey: countKey(filter, search),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const body = (await listCampaigns(params(filter, search, COUNT_LIMIT), { signal }))
        .data as CampaignPage;
      return {
        count: body.metaData.pagination.returnedCount,
        more: body.metaData.pagination.hasNextPage,
      };
    },
    staleTime: STALE_MS,
    retry: false,
  });
  const total = useQuery(count('', undefined));
  const chipAll = useQuery(count('', q));
  const chipProcessing = useQuery(count('processing', q));
  const chipCompleted = useQuery(count('completed', q));
  const chipFailed = useQuery(count('failed', q));

  const draftList = useQuery({
    queryKey: DRAFTS_KEY,
    queryFn: async ({ signal }) => {
      const all: Draft[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < DRAFT_PAGES_MAX; i += 1) {
        const body = (
          await listDrafts({ limit: COUNT_LIMIT, ...(cursor ? { cursor } : {}) }, { signal })
        ).data as DraftPage;
        all.push(...body.data);
        const { hasNextPage, nextCursor } = body.metaData.pagination;
        if (!hasNextPage || !nextCursor) break;
        cursor = nextCursor;
      }
      return all;
    },
    staleTime: STALE_MS,
  });

  const refreshed = () => {
    void client.invalidateQueries({ queryKey: ['campaigns-page'] });
    void client.invalidateQueries({ queryKey: ['campaigns-count'] });
    void client.invalidateQueries({ queryKey: DRAFTS_KEY });
  };

  const remove = useMutation({
    mutationFn: async (t: Target) => {
      if (t.kind === 'campaign') await deleteCampaign(t.id);
      else await deleteDraft(t.id);
      return t;
    },
    onSuccess: (t) => {
      setGone((old) => new Set(old).add(t.id));
      setTarget(null);
      setToasts([{ id: `deleted-${t.id}`, variant: 'success', message: COPY.toast[t.kind] }]);
      refreshed();
    },
    onError: (error) => {
      // A record that is already gone (not_found) or changed (state_conflict) is shown as the list now is.
      const code = resolveError(error, { surface: 'context' }).code;
      if (code === 'not_found' || code === 'state_conflict') refreshed();
    },
  });

  const closeDialog = () => {
    if (remove.isPending) return;
    remove.reset();
    setTarget(null);
  };
  const ask = (t: Target) => {
    remove.reset();
    setTarget(t);
  };

  const visibleRows = useMemo(
    () => (history.data?.rows ?? []).filter((c) => !gone.has(c.id)),
    [history.data, gone],
  );
  const draftRows = useMemo(
    () => (draftList.data ?? []).filter((d) => !gone.has(d.id) && draftMatches(d, url.q)),
    [draftList.data, gone, url.q],
  );
  const draftPage = draftRows.slice((url.page - 1) * PAGE_SIZE, url.page * PAGE_SIZE);

  // A page past the end (a stale link, or the last row of the last page deleted) returns to the last page that exists.
  useEffect(() => {
    if (url.page > 1 && !drafts && history.isSuccess && visibleRows.length === 0)
      go({ ...url, page: 1 }, 'replace');
    if (url.page > 1 && drafts && draftList.isSuccess && draftPage.length === 0)
      go({ ...url, page: 1 }, 'replace');
  }, [
    url,
    drafts,
    history.isSuccess,
    visibleRows.length,
    draftList.isSuccess,
    draftPage.length,
    go,
  ]);

  const filtering = url.q !== '' || url.status !== '';
  const clearAll = () => {
    setInput('');
    go({ ...url, q: '', status: '', page: 1 });
  };
  const reauthenticate = () => window.location.assign(signInUrl(PATH));

  const num = (r: { data?: { count: number; more: boolean } }) =>
    r.data && !r.data.more ? r.data.count : undefined;
  const chips: FilterChip[] = [
    { id: '', label: COPY.chips.all, count: num(chipAll) },
    { id: 'processing', label: COPY.chips.processing, count: num(chipProcessing) },
    { id: 'completed', label: COPY.chips.completed, count: num(chipCompleted) },
    { id: 'failed', label: COPY.chips.failed, count: num(chipFailed) },
  ];
  const tabs = [
    { id: 'history', label: COPY.historyTab, count: num(total) },
    {
      id: 'drafts',
      label: COPY.draftsTab,
      count: draftList.data ? draftList.data.filter((d) => !gone.has(d.id)).length : undefined,
    },
  ];

  const pager = (hasPrev: boolean, hasNext: boolean) => (
    <nav
      aria-label={COPY.pagination}
      className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-ui text-muted-foreground"
    >
      <span role="status">{COPY.perPage(PAGE_SIZE)}</span>
      <div className="inline-flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!hasPrev}
          onClick={() => go({ ...url, page: url.page - 1 })}
        >
          <Icon name="chevron-left" size={16} />
          {COPY.previous}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!hasNext}
          onClick={() => go({ ...url, page: url.page + 1 })}
        >
          {COPY.next}
          <Icon name="chevron-right" size={16} />
        </Button>
      </div>
    </nav>
  );

  const loadingList = (
    <SkeletonRegion status={COPY.loading} data-state="loading">
      <ul className="flex list-none flex-col gap-3 p-0">
        {[0, 1, 2, 3].map((i) => (
          <li
            key={i}
            className="flex items-center gap-3 rounded-lg border border-border bg-card p-3"
          >
            <Skeleton className="h-14 w-11 md:w-14" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="w-3/4" />
            </div>
            <Skeleton className="hidden w-36 md:block" />
          </li>
        ))}
      </ul>
    </SkeletonRegion>
  );

  const noResults = (
    <EmptyState
      variant="no-matches"
      headingLevel={2}
      title={COPY.noResults.title(url.q ? `"${url.q}"` : 'these filters')}
      description={drafts ? COPY.noResults.draftsBody : COPY.noResults.body}
      action={
        <Button variant="outline" onClick={clearAll}>
          {COPY.noResults.action}
        </Button>
      }
    />
  );

  const newBrief = (
    <Button asChild>
      <a href="/campaigns/new">
        <Icon name="plus" size={16} />
        {COPY.newBrief}
      </a>
    </Button>
  );

  let body;
  if (!drafts) {
    if (history.isPending) body = loadingList;
    else if (history.isError) {
      body = (
        <ErrorNotice
          error={history.error}
          call="read"
          returnTo={PATH}
          retrying={history.isRefetching}
          onAction={(action) => (action === 'confirm' ? reauthenticate() : void history.refetch())}
        />
      );
    } else if (visibleRows.length === 0) {
      body = filtering ? (
        noResults
      ) : (
        <EmptyState
          headingLevel={2}
          title={COPY.empty.title}
          description={COPY.empty.body}
          action={newBrief}
        />
      );
    } else {
      body = (
        <>
          <ul aria-label={COPY.historyLabel} className="m-0 flex list-none flex-col gap-3 p-0">
            {visibleRows.map((c) => (
              <CampaignRow
                key={c.id}
                variant="history"
                format="UGC ad"
                name={c.productName}
                href={campaignHref(c)}
                segments={c.segmentCount}
                duration={`${c.segmentCount * 15} s`}
                date={updatedLabel(c.updatedAt, now)}
                status={campaignStatus(c)}
                deleting={remove.isPending && target?.id === c.id}
                actions={[
                  {
                    id: 'delete',
                    label: COPY.deleteLabel(c.productName, false),
                    destructive: true,
                    icon: 'trash-2',
                    onClick: () => ask({ kind: 'campaign', id: c.id, name: c.productName }),
                  },
                ]}
              />
            ))}
          </ul>
          {pager(url.page > 1, history.data.hasNext)}
        </>
      );
    }
  } else if (draftList.isPending) body = loadingList;
  else if (draftList.isError) {
    body = (
      <ErrorNotice
        error={draftList.error}
        call="read"
        returnTo={PATH}
        retrying={draftList.isRefetching}
        onAction={(action) => (action === 'confirm' ? reauthenticate() : void draftList.refetch())}
      />
    );
  } else if (draftRows.length === 0) {
    body = url.q ? (
      noResults
    ) : (
      <EmptyState
        headingLevel={2}
        title={COPY.draftsEmpty.title}
        description={COPY.draftsEmpty.body}
        action={newBrief}
      />
    );
  } else {
    body = (
      <>
        <ul aria-label={COPY.draftsLabel} className="m-0 flex list-none flex-col gap-3 p-0">
          {draftPage.map((d) => {
            const name = draftName(d);
            return (
              <CampaignRow
                key={d.id}
                variant="draft"
                name={name}
                href={draftHref(d)}
                date={`${draftStepLabel(d.step)} · ${updatedLabel(d.updatedAt, now, 'Saved')}`}
                status={{ label: COPY.draftStatus, variant: 'neutral' }}
                deleting={remove.isPending && target?.id === d.id}
                actions={[
                  {
                    id: 'delete',
                    label: COPY.deleteLabel(name, true),
                    destructive: true,
                    icon: 'trash-2',
                    onClick: () => ask({ kind: 'draft', id: d.id, name }),
                  },
                ]}
              />
            );
          })}
        </ul>
        {draftRows.length > PAGE_SIZE
          ? pager(url.page > 1, url.page * PAGE_SIZE < draftRows.length)
          : null}
      </>
    );
  }

  const role = me.data && me.data.data.linkState === 'linked' ? me.data.data.role : 'user';
  const keyState = deriveKeyState(keys.data?.data);
  const deleteError = remove.error
    ? resolveError(remove.error, { surface: 'context' }).message
    : undefined;
  const busy = drafts ? draftList.isPending : history.isPending;

  return (
    <OperatorShell
      role={role}
      path={PATH}
      pageName={COPY.title}
      keyState={keyState}
      toasts={toasts}
      onDismissToast={() => setToasts([])}
      onSignOut={() => window.location.assign(ROUTES.signIn)}
    >
      <div
        className="mx-auto flex max-w-wide flex-col gap-4"
        data-screen="SCREEN-005"
        aria-busy={busy || undefined}
      >
        <PageHeader title={COPY.title} description={COPY.description} actions={newBrief} />

        {keyState === 'missing' ? (
          <Alert
            variant="warning"
            role="status"
            title={COPY.keyMissing.title}
            action={
              <Button variant="outline" size="sm" asChild>
                <a href={ROUTES.providerKeys}>{COPY.keyMissing.action}</a>
              </Button>
            }
          >
            {COPY.keyMissing.body}
          </Alert>
        ) : null}

        <Tabs
          label={COPY.tabsLabel}
          tabs={tabs}
          value={url.tab}
          onValueChange={(id) => go({ tab: id as Tab, q: url.q, status: '', page: 1 })}
        >
          <div className="flex flex-col gap-4 pt-4">
            {drafts ? (
              <FilterBar
                searchLabel={COPY.searchLabel}
                query={input}
                onQueryChange={setInput}
                chips={[]}
                status=""
                onStatusChange={() => undefined}
                onClearAll={clearAll}
              />
            ) : (
              <FilterBar
                searchLabel={COPY.searchLabel}
                query={input}
                onQueryChange={setInput}
                chips={chips}
                status={url.status}
                onStatusChange={(status) =>
                  go({ ...url, q: input, status: status as Filter | '', page: 1 })
                }
                onClearAll={clearAll}
              />
            )}
            {body}
          </div>
        </Tabs>
      </div>

      {target ? (
        <Dialog
          open
          onClose={closeDialog}
          title={
            target.kind === 'campaign'
              ? COPY.deleteDialog.campaignTitle(target.name)
              : COPY.deleteDialog.draftTitle(target.name)
          }
          confirmLabel={
            target.kind === 'campaign'
              ? COPY.deleteDialog.campaignConfirm
              : COPY.deleteDialog.draftConfirm
          }
          destructive
          pending={remove.isPending}
          error={deleteError}
          onConfirm={() => remove.mutate(target)}
        >
          <p className="text-ui">
            {target.kind === 'campaign'
              ? COPY.deleteDialog.campaignBody
              : COPY.deleteDialog.draftBody}
          </p>
          {target.kind === 'campaign' ? (
            <Alert variant="warning" role="status">
              {COPY.deleteDialog.warning}
            </Alert>
          ) : null}
          <p className="text-ui text-muted-foreground">{COPY.deleteDialog.irreversible}</p>
        </Dialog>
      ) : null}
    </OperatorShell>
  );
}
