import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { WindowStore } from './window-store.js';

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const WAIT_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5];

/** Routes with an ID or other open value are labelled by template; a request that matched none gets this label. */
export const UNMATCHED_ROUTE = 'unmatched';

export const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;

/** The process metrics of the api: one registry (not the global one), bounded labels, never a user or record ID. */
export class AppMetrics {
  readonly registry = new Registry();
  readonly window: WindowStore;
  private readonly httpDuration: Histogram<'method' | 'route' | 'status_class'>;
  private readonly poolWait: Histogram;
  private readonly poolSize: Gauge;
  private readonly poolInUse: Gauge;
  private readonly poolWaiting: Gauge;
  private readonly bossSendFailures: Counter;
  private readonly dropped: Counter;
  private readonly jobTransitions: Counter<'job_type' | 'state'>;
  private readonly providerLatency: Histogram<'provider' | 'operation' | 'class'>;
  private readonly queueDepth: Gauge<'queue'>;

  constructor(now: () => number = Date.now) {
    this.window = new WindowStore(now);
    const registers = [this.registry];
    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'API request duration by method, route template and status class',
      labelNames: ['method', 'route', 'status_class'],
      buckets: DURATION_BUCKETS,
      registers,
    });
    this.poolWait = new Histogram({
      name: 'db_pool_acquire_wait_seconds',
      help: 'Time a database pool acquisition waited',
      buckets: WAIT_BUCKETS,
      registers,
    });
    this.poolSize = new Gauge({
      name: 'db_pool_size',
      help: 'Database pool connections open',
      registers,
    });
    this.poolInUse = new Gauge({
      name: 'db_pool_in_use',
      help: 'Database pool connections in use',
      registers,
    });
    this.poolWaiting = new Gauge({
      name: 'db_pool_waiting',
      help: 'Database pool requests waiting for a connection',
      registers,
    });
    this.bossSendFailures = new Counter({
      name: 'pgboss_send_failures_total',
      help: 'pg-boss send failures',
      registers,
    });
    this.dropped = new Counter({
      name: 'telemetry_dropped_total',
      help: 'Error-reporter and heartbeat events dropped since process start',
      registers,
    });
    this.jobTransitions = new Counter({
      name: 'job_transitions_total',
      help: 'Job state transitions by known job type and state',
      labelNames: ['job_type', 'state'],
      registers,
    });
    this.providerLatency = new Histogram({
      name: 'provider_call_duration_seconds',
      help: 'Provider call latency by provider, operation and outcome class',
      labelNames: ['provider', 'operation', 'class'],
      buckets: DURATION_BUCKETS,
      registers,
    });
    this.queueDepth = new Gauge({
      name: 'queue_depth',
      help: 'Queued jobs per queue, set each sweep',
      labelNames: ['queue'],
      registers,
    });
  }

  observeRequest(method: string, route: string, status: number, durationMs: number): void {
    this.httpDuration.observe(
      { method, route, status_class: statusClass(status) },
      durationMs / 1000,
    );
    this.window.recordRequest(durationMs, status);
  }

  observePoolAcquire(waitMs: number, waited: boolean): void {
    this.poolWait.observe(waitMs / 1000);
    this.window.recordPoolAcquire(waitMs, waited);
  }

  setPoolState(size: number, inUse: number, waiting: number): void {
    this.poolSize.set(size);
    this.poolInUse.set(inUse);
    this.poolWaiting.set(waiting);
  }

  bossSendFailed(): void {
    this.bossSendFailures.inc();
  }

  /** An error-reporter or heartbeat event that was not delivered. */
  telemetryDropped(count = 1): void {
    this.dropped.inc(count);
    this.window.recordDropped(count);
  }

  jobTransition(jobType: string, state: string): void {
    this.jobTransitions.inc({ job_type: jobType, state });
  }

  providerCall(
    provider: string,
    operation: string,
    outcomeClass: string,
    durationMs: number,
  ): void {
    this.providerLatency.observe({ provider, operation, class: outcomeClass }, durationMs / 1000);
  }

  setQueueDepth(queue: string, depth: number): void {
    this.queueDepth.set({ queue }, depth);
  }

  exposition(): Promise<string> {
    return this.registry.metrics();
  }
}
