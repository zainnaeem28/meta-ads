import { describe, expect, it } from 'vitest';
import { ApiClientError, ApiNetworkError } from '../api/client';
import { clearForIdentityChange, createQueryClient, shouldRetry } from './query-client';
import { rememberEtag, storedEtag } from '../api/client';

const http = (status: number) => new ApiClientError({ status, code: 'x' });

describe('query defaults', () => {
  it('does not retry 4xx and retries transport and 5xx failures up to twice', () => {
    expect(shouldRetry(0, http(404))).toBe(false);
    expect(shouldRetry(0, http(429))).toBe(false);
    expect(shouldRetry(0, http(503))).toBe(true);
    expect(shouldRetry(0, new ApiNetworkError(new Error('x')))).toBe(true);
    expect(shouldRetry(2, http(503))).toBe(false);
  });

  it('wires the retry rule into the client and never retries mutations', () => {
    const client = createQueryClient();
    expect(client.getDefaultOptions().queries?.retry).toBe(shouldRetry);
    expect(client.getDefaultOptions().mutations?.retry).toBe(false);
  });

  it('clears every cached query and stored ETag on identity change', async () => {
    const client = createQueryClient();
    client.setQueryData(['a'], 1);
    client.setQueryData(['b', 2], 2);
    rememberEtag('/drafts/1', '"1"');
    await clearForIdentityChange(client);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(storedEtag('/drafts/1')).toBeUndefined();
  });
});
