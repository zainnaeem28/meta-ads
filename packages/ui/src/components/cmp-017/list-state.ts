/** URL state of a filtered list: `?q=&status=&page=`. Defaults are omitted from the query. */
export interface ListState {
  q: string;
  status: string;
  /** One-based page number. */
  page: number;
}

export const DEFAULT_LIST_STATE: ListState = { q: '', status: '', page: 1 };

export function parseListState(search: string | URLSearchParams): ListState {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const page = Number.parseInt(params.get('page') ?? '', 10);
  return {
    q: params.get('q') ?? '',
    status: params.get('status') ?? '',
    page: Number.isFinite(page) && page >= 1 ? page : 1,
  };
}

/** Query string (with leading `?`, or empty) for a state; changing a filter resets the page via `withFilter`. */
export function buildListSearch(state: ListState): string {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.status) params.set('status', state.status);
  if (state.page > 1) params.set('page', String(state.page));
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** A new search or status always returns to page 1. */
export function withFilter(state: ListState, change: Partial<Pick<ListState, 'q' | 'status'>>) {
  return { ...state, ...change, page: 1 };
}
