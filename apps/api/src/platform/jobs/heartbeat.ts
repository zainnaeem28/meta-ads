import type { SweepLog } from './sweep.js';

export const HEARTBEAT_EVERY_MS = 60_000;
/** The external monitor is pinged on every fifth beat. */
export const PING_EVERY_BEATS = 5;
const PING_TIMEOUT_MS = 10_000;

export interface HeartbeatOptions {
  readonly log: SweepLog;
  /** HEARTBEAT_URL_WORKER; a secret, so it is never written to a log. */
  readonly pingUrl?: string | undefined;
  readonly everyMs?: number;
  readonly ping?: (url: string) => Promise<void>;
}

async function httpPing(url: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`status ${String(response.status)}`);
}

/** `worker_heartbeat` once a minute and, when configured, a ping of the external monitor every fifth minute. */
export class Heartbeat {
  private timer: NodeJS.Timeout | undefined;
  private beats = 0;

  constructor(private readonly options: HeartbeatOptions) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.beat(), this.options.everyMs ?? HEARTBEAT_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  async beat(): Promise<void> {
    this.beats += 1;
    this.options.log.info({ module: 'worker', outcome: 'ok' }, 'worker_heartbeat');
    const url = this.options.pingUrl;
    if (url === undefined || this.beats % PING_EVERY_BEATS !== 0) return;
    try {
      await (this.options.ping ?? httpPing)(url);
    } catch {
      // The URL carries the monitor's secret: only the fact that the ping failed is logged.
      this.options.log.warn({ module: 'worker', outcome: 'error' }, 'worker heartbeat ping failed');
    }
  }
}
