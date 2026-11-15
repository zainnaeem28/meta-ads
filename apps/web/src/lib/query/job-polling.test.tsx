// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POLL_INTERVAL_MS, isTerminalJobState, pollInterval, useJobPolling } from './job-polling';

const setVisibility = (state: 'hidden' | 'visible') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

let state = 'processing';
let calls = 0;
const queryFn = () => {
  calls += 1;
  return Promise.resolve({ state });
};

const setup = (errorShown = false) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    ({ err }: { err: boolean }) =>
      useJobPolling({
        query: { queryKey: ['job'], queryFn },
        getState: (d) => d?.state,
        errorShown: err,
      }),
    { wrapper, initialProps: { err: errorShown } },
  );
};

const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  state = 'processing';
  calls = 0;
  setVisibility('visible');
});
afterEach(() => vi.useRealTimers());

describe('pollInterval', () => {
  it('is 3 s only for a visible, error-free, non-terminal job', () => {
    expect(pollInterval({ state: 'processing', hidden: false, errorShown: false })).toBe(3000);
    expect(pollInterval({ state: undefined, hidden: false, errorShown: false })).toBe(
      POLL_INTERVAL_MS,
    );
    expect(pollInterval({ state: 'processing', hidden: true, errorShown: false })).toBe(false);
    expect(pollInterval({ state: 'processing', hidden: false, errorShown: true })).toBe(false);
    for (const s of ['completed', 'failed', 'cancelled']) expect(isTerminalJobState(s)).toBe(true);
    expect(isTerminalJobState('pending')).toBe(false);
    expect(isTerminalJobState(undefined)).toBe(false);
  });
});

describe('useJobPolling', () => {
  it('polls every 3 s while non-terminal and stops at a terminal state', async () => {
    setup();
    await tick(0);
    expect(calls).toBe(1);
    await tick(3000);
    expect(calls).toBe(2);
    state = 'completed';
    await tick(3000);
    expect(calls).toBe(3);
    await tick(9000);
    expect(calls).toBe(3);
  });

  it('pauses while the tab is hidden and resumes when visible', async () => {
    setup();
    await tick(0);
    act(() => setVisibility('hidden'));
    await tick(9000);
    expect(calls).toBe(1);
    act(() => setVisibility('visible'));
    await tick(3000);
    expect(calls).toBeGreaterThan(1);
  });

  it('pauses while an error alert is shown', async () => {
    const view = setup(true);
    await tick(0);
    await tick(9000);
    expect(calls).toBe(1);
    view.rerender({ err: false });
    await tick(3000);
    expect(calls).toBeGreaterThan(1);
  });
});
