import {
  getGetBriefQueryKey,
  getGetBriefUrl,
  getGetCampaignQueryKey,
  getGetCampaignUrl,
  getGetMeQueryKey,
  getGetMeUrl,
  getListCampaignVideoJobsQueryKey,
  getListCampaignVideoJobsUrl,
  getListMyProviderKeysQueryKey,
  getListMyProviderKeysUrl,
  type BriefResponse,
  type CampaignResponse,
  type MeResponse,
  type ProviderKeyListResponse,
  type SegmentJobsResponse,
} from '@shroomap/contracts';
import { queryOptions } from '@tanstack/react-query';
import { apiGet, type ApiFetcher } from './api-get';

/**
 * A hydrated query is fresh for this long. `staleTime` is an observer option evaluated in the browser, so it lives on the
 * options both the server prefetch and the screens use; the server client's defaults would not travel (ADR-014, constraint 9).
 */
export const STALE_MS = 30_000;

/**
 * Query definitions shared by the server prefetch and the screens: one key and one loader per read. Each takes the
 * server's per-request fetch, or none in the browser. Polling intervals, retry and `enabled` stay with the screen.
 */
export const meQuery = (fetcher?: ApiFetcher) =>
  queryOptions({
    queryKey: getGetMeQueryKey(),
    queryFn: ({ signal }) => apiGet<MeResponse>(getGetMeUrl(), { signal }, fetcher),
    staleTime: STALE_MS,
  });

export const keysQuery = (fetcher?: ApiFetcher) =>
  queryOptions({
    queryKey: getListMyProviderKeysQueryKey(),
    queryFn: ({ signal }) =>
      apiGet<ProviderKeyListResponse>(getListMyProviderKeysUrl(), { signal }, fetcher),
    staleTime: STALE_MS,
  });

export const campaignQuery = (campaignId: string, fetcher?: ApiFetcher) =>
  queryOptions({
    queryKey: getGetCampaignQueryKey(campaignId),
    queryFn: ({ signal }) =>
      apiGet<CampaignResponse>(getGetCampaignUrl(campaignId), { signal }, fetcher),
    staleTime: STALE_MS,
  });

export const briefQuery = (campaignId: string, fetcher?: ApiFetcher) =>
  queryOptions({
    queryKey: getGetBriefQueryKey(campaignId),
    queryFn: ({ signal }) => apiGet<BriefResponse>(getGetBriefUrl(campaignId), { signal }, fetcher),
    staleTime: STALE_MS,
  });

export const jobsQuery = (campaignId: string, fetcher?: ApiFetcher) =>
  queryOptions({
    queryKey: getListCampaignVideoJobsQueryKey(campaignId),
    queryFn: ({ signal }) =>
      apiGet<SegmentJobsResponse>(getListCampaignVideoJobsUrl(campaignId), { signal }, fetcher),
    staleTime: STALE_MS,
  });
