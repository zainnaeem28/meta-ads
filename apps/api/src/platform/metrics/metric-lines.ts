import type { Logger } from 'pino';
import type { AppMetrics } from './app-metrics.js';

/**
 * Metrics-from-logs lines (ARCHITECTURE 9.2) for the events the request log does not cover. Each helper writes one
 * allow-listed log line and updates the process registry; labels and fields are bounded names, never IDs.
 */
export class MetricLines {
  constructor(
    private readonly logger: Pick<Logger, 'info'>,
    private readonly metrics: AppMetrics,
  ) {}

  jobTransition(jobType: string, state: string): void {
    this.metrics.jobTransition(jobType, state);
    this.logger.info({ module: 'metrics', jobType, outcome: state }, 'metric job_transition');
  }

  providerCall(provider: string, operation: string, outcomeClass: string, latencyMs: number): void {
    this.metrics.providerCall(provider, operation, outcomeClass, latencyMs);
    this.logger.info(
      { module: 'metrics', provider, outcome: outcomeClass, latencyMs },
      `metric provider_call ${operation}`,
    );
  }

  /** Queue depth is written once per queue each sweep. */
  queueDepth(queue: string, depth: number): void {
    this.metrics.setQueueDepth(queue, depth);
    this.logger.info({ module: 'metrics' }, `metric queue_depth ${queue}=${String(depth)}`);
  }
}
