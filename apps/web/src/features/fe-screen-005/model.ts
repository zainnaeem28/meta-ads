import type { BadgeVariant } from '@shroomap/ui/cmp-007';
import type { IconName } from '@shroomap/ui/icons';
import type { CampaignSummary, Draft } from '@shroomap/contracts';
import { SCREEN_005_COPY as COPY } from './copy';

export const PAGE_SIZE = 10;
/** Largest page the api returns; counts read one page of this size and show "n+" when there is more. */
export const COUNT_LIMIT = 50;
export const FILTERS = ['processing', 'completed', 'failed'] as const;
export type Filter = (typeof FILTERS)[number];
export type Tab = 'history' | 'drafts';

export interface UrlState {
  tab: Tab;
  q: string;
  status: Filter | '';
  /** One-based. */
  page: number;
}

export const isFilter = (value: string): value is Filter => (FILTERS as readonly string[]).includes(value);

/** `?tab=history|drafts&q=&status=&page=`: anything unknown falls back to the default. */
export function parseUrl(search: string): UrlState {
  const params = new URLSearchParams(search);
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const status = params.get('status') ?? '';
  return {
    tab: params.get('tab') === 'drafts' ? 'drafts' : 'history',
    q: params.get('q') ?? '',
    status: isFilter(status) ? status : '',
    page: Number.isFinite(page) && page >= 1 ? page : 1,
  };
}

export function buildUrl(state: UrlState): string {
  const params = new URLSearchParams();
  if (state.tab === 'drafts') params.set('tab', 'drafts');
  if (state.q) params.set('q', state.q);
  if (state.tab === 'history' && state.status) params.set('status', state.status);
  if (state.page > 1) params.set('page', String(state.page));
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** The api takes a search of 2 to 100 characters; a shorter one is not sent. */
export const apiQuery = (q: string): string | undefined => {
  const text = q.trim();
  return text.length >= 2 ? text.slice(0, 100) : undefined;
};

const MIN = 60_000;

/** "Updated 12 min ago", "Updated yesterday", otherwise the calendar date. */
export function updatedLabel(iso: string, now: number, prefix = 'Updated'): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  if (diff < MIN) return `${prefix} just now`;
  if (diff < 60 * MIN) return `${prefix} ${Math.floor(diff / MIN)} min ago`;
  if (diff < 24 * 60 * MIN) return `${prefix} ${Math.floor(diff / (60 * MIN))} h ago`;
  const days = Math.floor(diff / (24 * 60 * MIN));
  if (days === 1) return `${prefix} yesterday`;
  if (days < 7) return `${prefix} ${days} days ago`;
  return `${prefix} ${new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

export interface RowStatus {
  label: string;
  variant: BadgeVariant;
  icon: IconName;
}

/** Badge of a campaign: what the user does next, from the derived progress and the brief state. */
export function campaignStatus(c: Pick<CampaignSummary, 'progress' | 'briefState' | 'finalAvailable'>): RowStatus {
  if (c.briefState === 'failed' || c.progress === 'failed') return { label: 'Needs attention', variant: 'destructive', icon: 'circle-x' };
  if (c.briefState === 'generating') return { label: 'Brief generating', variant: 'info', icon: 'loader-circle' };
  if (c.briefState === 'draft') return { label: 'Brief ready to review', variant: 'warning', icon: 'clock' };
  if (c.finalAvailable) return { label: 'Final ready', variant: 'success', icon: 'circle-check' };
  if (c.progress === 'completed') return { label: 'Clips ready', variant: 'success', icon: 'circle-check' };
  return { label: 'Clips generating', variant: 'info', icon: 'loader-circle' };
}

/** The stage a campaign opens at: SCREEN-007, 008 or 009. */
export function campaignHref(c: Pick<CampaignSummary, 'id' | 'briefState' | 'finalAvailable' | 'progress'>): string {
  const base = `/campaigns/${c.id}`;
  if (c.briefState !== 'accepted') return `${base}/brief`;
  return c.finalAvailable ? `${base}/final` : `${base}/clips`;
}

export const draftName = (d: Pick<Draft, 'productName'>): string =>
  d.productName?.trim() || COPY.untitledDraft;

export const draftHref = (d: Pick<Draft, 'id'>): string => `/campaigns/new?draft=${d.id}`;

/** "Step 3 of 4: Audience and direction"; the api's step 5 is the review of step 4. */
export const draftStepLabel = (step: number): string => {
  const at = Math.min(Math.max(step, 1), COPY.steps.length);
  return `Step ${at} of ${COPY.steps.length}: ${COPY.steps[at - 1]}`;
};

/** A draft matches when the search is in its product name or description (the drafts api has no search). */
export function draftMatches(d: Pick<Draft, 'productName' | 'productDescription'>, q: string): boolean {
  const text = q.trim().toLowerCase();
  if (!text) return true;
  return `${d.productName ?? ''}\n${d.productDescription ?? ''}`.toLowerCase().includes(text);
}
