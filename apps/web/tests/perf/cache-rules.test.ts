import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { rememberEtag, storedEtag } from '../../src/lib/api/client';
import { clearForIdentityChange } from '../../src/lib/query/query-client';
import { dynamicHeaders } from '../../src/lib/security/csp';
import { POLL_INTERVAL_MS, pollInterval } from '../../src/lib/query/job-polling';

const src = resolve(__dirname, '../../src');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
const sources = files(src).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

describe('cache rules (TC-ZT-07)', () => {
  it('marks every middleware-answered response no-store, keys page and redirects included', () => {
    for (const pathname of ['/campaigns', '/settings/provider-keys', '/admin/usage', '/sign-in']) {
      const headers = dynamicHeaders({ nonce: 'n', pathname, env: { APP_ENV: 'test' } });
      expect(headers['Cache-Control'], pathname).toBe('no-store');
    }
  });

  it('removes every cached query and ETag on identity change, cancelling the ones in flight', async () => {
    const client = new QueryClient();
    client.setQueryData(['campaigns-page', 'user-a'], { rows: 3 });
    void client.prefetchQuery({ queryKey: ['slow'], queryFn: () => new Promise(() => undefined) });
    rememberEtag('/api/v1/drafts/1', '"a"');
    await clearForIdentityChange(client);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(client.getQueryData(['campaigns-page', 'user-a'])).toBeUndefined();
    expect(storedEtag('/api/v1/drafts/1')).toBeUndefined();
  });

  it('pauses polling on a hidden tab, a terminal job and an error on screen, and polls every 3 s otherwise', () => {
    expect(pollInterval({ state: 'running', hidden: false, errorShown: false })).toBe(POLL_INTERVAL_MS);
    expect(POLL_INTERVAL_MS).toBe(3000);
    expect(pollInterval({ state: 'running', hidden: true, errorShown: false })).toBe(false);
    expect(pollInterval({ state: 'completed', hidden: false, errorShown: false })).toBe(false);
    expect(pollInterval({ state: 'running', hidden: false, errorShown: true })).toBe(false);
  });

  it('never polls in a background tab, persists the query cache, or opts a fetch into a shared cache', () => {
    for (const { path, text } of sources) {
      expect(text, path).not.toMatch(/refetchIntervalInBackground:\s*true/);
      expect(text, path).not.toMatch(/persistQueryClient|createSyncStoragePersister|createAsyncStoragePersister/);
      expect(text, path).not.toMatch(/cache:\s*['"]force-cache['"]|next:\s*\{\s*revalidate|unstable_cache/);
      expect(text, path).not.toMatch(/(local|session)Storage\.setItem\([^)]*(token|campaign|query)/i);
    }
  });

  it('refetches a screen after its mutation (invalidation after a write)', () => {
    const screens = sources.filter(({ path }) => /features\/fe-screen-[^/]+\/[A-Za-z]+Screen\.tsx$/.test(path));
    const writers = screens.filter(({ text }) => /useMutation\(/.test(text));
    expect(writers.length).toBeGreaterThan(0);
    for (const { path, text } of writers) expect(text, path).toMatch(/invalidateQueries|setQueryData/);
  });
});
