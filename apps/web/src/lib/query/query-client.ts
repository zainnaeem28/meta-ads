import { QueryClient } from '@tanstack/react-query';
import { clearEtags, isClientHttpError } from '../api/client';

const MAX_RETRIES = 2;

/** No retry on a 4xx answer (it cannot change); transport and 5xx failures retry a bounded number of times. */
export const shouldRetry = (failureCount: number, error: unknown): boolean =>
  !isClientHttpError(error) && failureCount < MAX_RETRIES;

export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 0, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  });

/** Identity changed (sign-in, sign-out, switch): nothing cached for the previous user may be shown to the next. */
export const clearForIdentityChange = async (client: QueryClient): Promise<void> => {
  await client.cancelQueries();
  client.clear();
  clearEtags();
};
