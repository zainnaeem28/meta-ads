import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { AppMetrics } from './app-metrics.js';
import {
  installRequestMetrics,
  instrumentBossSend,
  instrumentPool,
  isProbePath,
} from './instrument.js';

describe('request metrics', () => {
  it('records by route template, skips probes and counts unmatched routes under one label', async () => {
    const metrics = new AppMetrics();
    const app = Fastify();
    installRequestMetrics(app, metrics);
    app.get('/api/v1/drafts/:draftId', async () => ({}));
    app.get('/health/live', async () => ({}));
    app.get('/boom', async (_req, reply) => reply.status(503).send({}));
    await app.inject({ url: '/api/v1/drafts/0198a5e0-0000-7000-8000-000000000001' });
    await app.inject({ url: '/health/live' });
    await app.inject({ url: '/boom' });
    await app.inject({ url: '/nowhere/0198a5e0-0000-7000-8000-000000000001' });
    const text = await metrics.exposition();
    expect(text).toContain('route="/api/v1/drafts/:draftId"');
    expect(text).toContain('route="unmatched"');
    expect(text).not.toContain('0198a5e0');
    expect(text).not.toContain('/health/live');
    expect(metrics.window.snapshot().windows[0]).toMatchObject({ requests: 3, errors5xx: 1 });
    await app.close();
  });

  it('recognises the probe and metrics paths only', () => {
    expect(
      ['/health/live', '/health/ready?x=1', '/internal/metrics', '/internal/metrics/window'].every(
        isProbePath,
      ),
    ).toBe(true);
    expect(['/api/v1/health/live', '/healthy', '/internal/metricsx'].some(isProbePath)).toBe(false);
  });
});

class FakePool extends EventEmitter {
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
  options = { max: 2 };
  delay = 0;
  fail = false;
  connect(cb?: (err: Error | undefined, client?: unknown) => void): unknown {
    const settle = (): void => void (this.fail ? cb?.(new Error('down')) : cb?.(undefined, {}));
    if (cb !== undefined) {
      setTimeout(settle, this.delay);
      return undefined;
    }
    return new Promise((resolve, reject) =>
      setTimeout(() => (this.fail ? reject(new Error('down')) : resolve({})), this.delay),
    );
  }
}

describe('pool wait instrumentation (ALR-7 input)', () => {
  it('times promise and callback acquisitions and marks one that found the pool full as waited', async () => {
    const metrics = new AppMetrics();
    const pool = new FakePool();
    instrumentPool(pool as never, metrics);
    pool.idleCount = 1;
    await (pool as never as { connect(): Promise<unknown> }).connect();
    pool.idleCount = 0;
    pool.totalCount = 2;
    pool.delay = 15;
    await (pool as never as { connect(): Promise<unknown> }).connect();
    await new Promise<void>((resolve) =>
      (pool as never as { connect(cb: () => void): void }).connect(() => resolve()),
    );
    const sample = metrics.window.snapshot().poolWait;
    expect(sample.acquisitions).toBe(3);
    expect(sample.waited).toBe(2);
    expect(sample.p95WaitMs).toBeGreaterThan(5);
    expect(await metrics.exposition()).toContain('db_pool_acquire_wait_seconds_count 3');
  });

  it('still records and rethrows when the acquisition fails', async () => {
    const metrics = new AppMetrics();
    const pool = new FakePool();
    pool.fail = true;
    instrumentPool(pool as never, metrics);
    await expect((pool as never as { connect(): Promise<unknown> }).connect()).rejects.toThrow(
      'down',
    );
    expect(metrics.window.snapshot().poolWait.acquisitions).toBe(1);
  });
});

describe('pg-boss send instrumentation', () => {
  it('counts a failed send and rethrows, passing a successful one through', async () => {
    const metrics = new AppMetrics();
    let fail = true;
    const boss = {
      send: async (queue: string): Promise<string> => {
        if (fail) throw new Error(queue);
        return 'id';
      },
    };
    instrumentBossSend(boss as never, metrics);
    await expect(boss.send('provider')).rejects.toThrow('provider');
    fail = false;
    expect(await boss.send('provider')).toBe('id');
    expect(await metrics.exposition()).toContain('pgboss_send_failures_total 1');
  });
});
