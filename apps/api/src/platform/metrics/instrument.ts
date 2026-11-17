import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { UNMATCHED_ROUTE } from './app-metrics.js';
import type { AppMetrics } from './app-metrics.js';

/** API-900..903 are not counted (not in the windows, not in the request histogram). */
export function isProbePath(url: string): boolean {
  const path = url.split('?', 1)[0] ?? '';
  return (
    path === '/health' ||
    path.startsWith('/health/') ||
    path === '/internal/metrics' ||
    path.startsWith('/internal/metrics/')
  );
}

/**
 * Request duration and status by route template (never the concrete URL, so no record ID reaches a label). The
 * per-request log line (route template, status, duration) is the metrics-from-logs source for rate and latency.
 */
export function installRequestMetrics(fastify: FastifyInstance, metrics: AppMetrics): void {
  fastify.addHook('onResponse', async (request, reply) => {
    if (isProbePath(request.url)) return;
    const route = request.is404 ? UNMATCHED_ROUTE : (request.routeOptions?.url ?? UNMATCHED_ROUTE);
    const durationMs = reply.elapsedTime;
    metrics.observeRequest(request.method, route, reply.statusCode, durationMs);
  });
}

type PoolLike = Pick<pg.Pool, 'totalCount' | 'idleCount' | 'waitingCount' | 'options' | 'connect'>;

/**
 * Time every acquisition of a pool connection (`pool.query` goes through `connect`). An acquisition "waited" when no
 * idle connection was available and the pool was at its limit or already had a queue.
 */
export function instrumentPool(pool: PoolLike, metrics: AppMetrics): void {
  const original = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  (pool as { connect: unknown }).connect = (...args: unknown[]): unknown => {
    const waited =
      pool.idleCount === 0 &&
      (pool.waitingCount > 0 || pool.totalCount >= (pool.options.max ?? 10));
    const started = performance.now();
    const done = (): void => metrics.observePoolAcquire(performance.now() - started, waited);
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      args[args.length - 1] = (...cb: unknown[]) => {
        done();
        return (last as (...a: unknown[]) => unknown)(...cb);
      };
      return original(...args);
    }
    const result = original(...args) as Promise<unknown>;
    return result.then(
      (client) => {
        done();
        return client;
      },
      (error: unknown) => {
        done();
        throw error;
      },
    );
  };
}

/** Count rejected `send` calls of the pg-boss handle. */
export function instrumentBossSend(
  boss: { send: (...args: never[]) => Promise<unknown> },
  metrics: AppMetrics,
): void {
  const original = boss.send.bind(boss) as (...args: unknown[]) => Promise<unknown>;
  (boss as { send: unknown }).send = async (...args: unknown[]): Promise<unknown> => {
    try {
      return await original(...args);
    } catch (error) {
      metrics.bossSendFailed();
      throw error;
    }
  };
}
