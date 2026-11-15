import { JobState } from '@shroomap/contracts';
import {
  useQuery,
  type Query,
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

export const POLL_INTERVAL_MS = 3000;

const TERMINAL: ReadonlySet<string> = new Set([
  JobState.completed,
  JobState.failed,
  JobState.cancelled,
]);

export const isTerminalJobState = (state: string | undefined): boolean =>
  state !== undefined && TERMINAL.has(state);

/** The interval for the next poll, or false to stop: terminal job, hidden tab, or an error alert on screen. */
export const pollInterval = (opts: {
  state: string | undefined;
  hidden: boolean;
  errorShown: boolean;
}): number | false =>
  opts.hidden || opts.errorShown || isTerminalJobState(opts.state) ? false : POLL_INTERVAL_MS;

const subscribeVisibility = (cb: () => void): (() => void) => {
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
};

export const useTabHidden = (): boolean =>
  useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === 'hidden',
    () => false,
  );

export interface JobPollingOptions<TData, TError, TKey extends QueryKey> {
  query: UseQueryOptions<TData, TError, TData, TKey>;
  /** Reads the job state from a response of the query; undefined means no job yet (keep polling). */
  getState: (data: TData | undefined) => string | undefined;
  /** True while an error alert for this job is shown: polling waits until the user dismisses or retries. */
  errorShown?: boolean;
}

/** A query that refetches every 3 s while its job is non-terminal. */
export const useJobPolling = <TData, TError = Error, TKey extends QueryKey = QueryKey>(
  opts: JobPollingOptions<TData, TError, TKey>,
): UseQueryResult<TData, TError> => {
  const hidden = useTabHidden();
  const errorShown = opts.errorShown ?? false;
  return useQuery({
    ...opts.query,
    refetchIntervalInBackground: false,
    refetchInterval: (query: Query<TData, TError, TData, TKey>) =>
      pollInterval({
        state: opts.getState(query.state.data),
        hidden,
        errorShown: errorShown || query.state.status === 'error',
      }),
  });
};
