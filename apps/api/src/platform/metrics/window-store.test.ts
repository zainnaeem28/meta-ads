import { describe, expect, it } from 'vitest';
import { AppMetrics } from './app-metrics.js';
import { WindowStore, p95 } from './window-store.js';

// TC-ALR-04..06 inputs: the windows, the pool wait sample and the 10-minute dropped-telemetry count.

const MIN = 60_000;

describe('WindowStore', () => {
  it('computes nearest-rank p95 and null for an empty sample', () => {
    expect(p95([])).toBeNull();
    expect(p95([5])).toBe(5);
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
  });

  it('reports exactly the 10- then 15-minute entries with requests, 5xx and p95', () => {
    let now = 1_000_000;
    const store = new WindowStore(() => now);
    store.recordRequest(100, 200);
    now += 12 * MIN;
    store.recordRequest(40, 500);
    store.recordRequest(60, 404);
    const { windows } = store.snapshot();
    expect(windows.map((w) => w.minutes)).toEqual([10, 15]);
    expect(windows[0]).toMatchObject({ requests: 2, errors5xx: 1, p95Ms: 60 });
    expect(windows[1]).toMatchObject({ requests: 3, errors5xx: 1, p95Ms: 100 });
    expect(windows[0]?.to).toBe(windows[1]?.to);
    now += 4 * MIN;
    expect(store.snapshot().windows[1]).toMatchObject({ requests: 2 });
    now += 20 * MIN;
    expect(store.snapshot().windows[0]).toMatchObject({ requests: 0, errors5xx: 0, p95Ms: null });
  });

  it('summarises pool acquisitions that waited over 10 minutes', () => {
    let now = 0;
    const store = new WindowStore(() => now);
    store.recordPoolAcquire(0.1, false);
    store.recordPoolAcquire(250, true);
    store.recordPoolAcquire(50, true);
    expect(store.snapshot().poolWait).toEqual({
      minutes: 10,
      acquisitions: 3,
      waited: 2,
      p95WaitMs: 250,
    });
    now += 11 * MIN;
    expect(store.snapshot().poolWait).toEqual({
      minutes: 10,
      acquisitions: 0,
      waited: 0,
      p95WaitMs: null,
    });
  });

  it('counts a drop inside 10 minutes, then 0 with a non-zero total, and restarts at 0 with a new process', () => {
    let now = 5 * MIN;
    const store = new WindowStore(() => now);
    expect(store.snapshot()).toMatchObject({ telemetryDropped10m: 0, telemetryDroppedTotal: 0 });
    store.recordDropped();
    expect(store.snapshot()).toMatchObject({ telemetryDropped10m: 1, telemetryDroppedTotal: 1 });
    now += 9 * MIN;
    expect(store.snapshot().telemetryDropped10m).toBe(1);
    now += 2 * MIN;
    expect(store.snapshot()).toMatchObject({ telemetryDropped10m: 0, telemetryDroppedTotal: 1 });
    const restarted = new WindowStore(() => now);
    expect(restarted.snapshot()).toMatchObject({
      telemetryDropped10m: 0,
      telemetryDroppedTotal: 0,
    });
    expect(restarted.snapshot().processStartedAt).toBe(new Date(now).toISOString());
  });
});

describe('AppMetrics exposition', () => {
  it('uses bounded labels and carries the dropped-telemetry counter', async () => {
    const metrics = new AppMetrics();
    metrics.observeRequest('GET', '/api/v1/drafts/:draftId', 503, 12);
    metrics.telemetryDropped(2);
    metrics.bossSendFailed();
    metrics.setPoolState(3, 1, 0);
    metrics.observePoolAcquire(4, true);
    metrics.jobTransition('video_segment', 'completed');
    metrics.providerCall('openai', 'text', 'ok', 30);
    metrics.setQueueDepth('provider', 7);
    const text = await metrics.exposition();
    expect(text).toContain(
      'http_request_duration_seconds_count{method="GET",route="/api/v1/drafts/:draftId",status_class="5xx"} 1',
    );
    expect(text).toContain('telemetry_dropped_total 2');
    expect(text).toContain('pgboss_send_failures_total 1');
    expect(text).toContain('db_pool_size 3');
    expect(text).toContain('queue_depth{queue="provider"} 7');
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
