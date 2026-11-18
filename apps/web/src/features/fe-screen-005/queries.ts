import {
  getListCampaignsUrl,
  getListDraftsUrl,
  type CampaignPage,
  type CampaignSummary,
  type Draft,
  type DraftPage,
} from '@shroomap/contracts';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { apiGet, type ApiFetcher } from '../../lib/query/api-get';
import { STALE_MS } from '../../lib/query/queries';
import { COUNT_LIMIT, PAGE_SIZE, type Filter } from './model';

const DRAFT_PAGES_MAX = 6;

export interface HistoryPage {
  rows: CampaignSummary[];
  hasNext: boolean;
  nextCursor: string | null;
  /** Every id on this page and the pages before it: a campaign that moved during traversal is not repeated. */
  seen: string[];
}

export const historyKey = (filter: Filter | '', q: string | undefined, page: number) =>
  ['campaigns-page', filter, q ?? '', page] as const;
export const countKey = (filter: Filter | '', q: string | undefined) =>
  ['campaigns-count', filter, q ?? ''] as const;
export const DRAFTS_KEY = ['drafts-all'] as const;

const listParams = (
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

/** One page of the history. A later page reads the one before it (through the cache) for its cursor. */
async function loadHistory(
  client: QueryClient,
  filter: Filter | '',
  q: string | undefined,
  page: number,
  signal: AbortSignal | undefined,
  fetcher: ApiFetcher | undefined,
): Promise<HistoryPage> {
  let cursor: string | null = null;
  let before: string[] = [];
  if (page > 1) {
    const previous = await client.fetchQuery(historyQuery(client, filter, q, page - 1, fetcher));
    cursor = previous.nextCursor;
    before = previous.seen;
    if (!previous.hasNext || !cursor)
      return { rows: [], hasNext: false, nextCursor: null, seen: before };
  }
  const body = await apiGet<CampaignPage>(
    getListCampaignsUrl(listParams(filter, q, PAGE_SIZE, cursor)),
    { signal },
    fetcher,
  );
  const seen = new Set(before);
  const rows = body.data.filter((c) => !seen.has(c.id));
  rows.forEach((c) => seen.add(c.id));
  const { hasNextPage, nextCursor } = body.metaData.pagination;
  return { rows, hasNext: hasNextPage, nextCursor, seen: [...seen] };
}

export const historyQuery = (
  client: QueryClient,
  filter: Filter | '',
  q: string | undefined,
  page: number,
  fetcher?: ApiFetcher,
) =>
  queryOptions({
    queryKey: historyKey(filter, q, page),
    queryFn: ({ signal }) => loadHistory(client, filter, q, page, signal, fetcher),
    staleTime: STALE_MS,
  });

export const countQuery = (filter: Filter | '', q: string | undefined, fetcher?: ApiFetcher) =>
  queryOptions({
    queryKey: countKey(filter, q),
    queryFn: async ({ signal }) => {
      const body = await apiGet<CampaignPage>(
        getListCampaignsUrl(listParams(filter, q, COUNT_LIMIT)),
        { signal },
        fetcher,
      );
      return {
        count: body.metaData.pagination.returnedCount,
        more: body.metaData.pagination.hasNextPage,
      };
    },
    staleTime: STALE_MS,
  });

export const draftsQuery = (fetcher?: ApiFetcher) =>
  queryOptions({
    queryKey: DRAFTS_KEY,
    queryFn: async ({ signal }) => {
      const all: Draft[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < DRAFT_PAGES_MAX; i += 1) {
        const body: DraftPage = await apiGet<DraftPage>(
          getListDraftsUrl({ limit: COUNT_LIMIT, ...(cursor ? { cursor } : {}) }),
          { signal },
          fetcher,
        );
        all.push(...body.data);
        const { hasNextPage, nextCursor } = body.metaData.pagination;
        if (!hasNextPage || !nextCursor) break;
        cursor = nextCursor;
      }
      return all;
    },
    staleTime: STALE_MS,
  });
