/** In-memory sliding windows behind API-903: one api instance, a restart starts them again at zero. */

export const WINDOW_MINUTES = [10, 15] as const;
const MINUTE_MS = 60_000;
const RETAIN_MS = 15 * MINUTE_MS;
const POOL_MINUTES = 10;

export interface WindowSample {
  minutes: 10 | 15;
  from: string;
  to: string;
  requests: number;
  errors5xx: number;
  p95Ms: number | null;
}

export interface PoolWaitSample {
  minutes: 10;
  acquisitions: number;
  waited: number;
  p95WaitMs: number | null;
}

export interface MetricsWindow {
  processStartedAt: string;
  windows: [WindowSample, WindowSample];
  poolWait: PoolWaitSample;
  telemetryDropped10m: number;
  telemetryDroppedTotal: number;
}

interface RequestEntry {
  at: number;
  durationMs: number;
  failed: boolean;
}

interface PoolEntry {
  at: number;
  waitMs: number;
  waited: boolean;
}

/** Nearest-rank 95th percentile; null for an empty sample. */
export function p95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? null;
}

const round3 = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 1000) / 1000;

export class WindowStore {
  private requests: RequestEntry[] = [];
  private pool: PoolEntry[] = [];
  private dropped: number[] = [];
  private droppedTotal = 0;
  private readonly startedAt: number;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  recordRequest(durationMs: number, status: number): void {
    this.requests.push({ at: this.now(), durationMs, failed: status >= 500 });
    this.prune();
  }

  recordPoolAcquire(waitMs: number, waited: boolean): void {
    this.pool.push({ at: this.now(), waitMs, waited });
    this.prune();
  }

  recordDropped(count = 1): void {
    const at = this.now();
    for (let i = 0; i < count; i++) this.dropped.push(at);
    this.droppedTotal += count;
    this.prune();
  }

  private prune(): void {
    const cutoff = this.now() - RETAIN_MS;
    if (this.requests.length > 0 && (this.requests[0] as RequestEntry).at < cutoff) {
      this.requests = this.requests.filter((entry) => entry.at >= cutoff);
    }
    if (this.pool.length > 0 && (this.pool[0] as PoolEntry).at < cutoff) {
      this.pool = this.pool.filter((entry) => entry.at >= cutoff);
    }
    if (this.dropped.length > 0 && (this.dropped[0] as number) < cutoff) {
      this.dropped = this.dropped.filter((at) => at >= cutoff);
    }
  }

  snapshot(): MetricsWindow {
    this.prune();
    const to = this.now();
    const sample = (minutes: 10 | 15): WindowSample => {
      const from = to - minutes * MINUTE_MS;
      const inside = this.requests.filter((entry) => entry.at >= from);
      return {
        minutes,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        requests: inside.length,
        errors5xx: inside.filter((entry) => entry.failed).length,
        p95Ms: round3(p95(inside.map((entry) => entry.durationMs))),
      };
    };
    const poolFrom = to - POOL_MINUTES * MINUTE_MS;
    const pool = this.pool.filter((entry) => entry.at >= poolFrom);
    return {
      processStartedAt: new Date(this.startedAt).toISOString(),
      windows: [sample(10), sample(15)],
      poolWait: {
        minutes: 10,
        acquisitions: pool.length,
        waited: pool.filter((entry) => entry.waited).length,
        p95WaitMs: round3(p95(pool.filter((entry) => entry.waited).map((entry) => entry.waitMs))),
      },
      telemetryDropped10m: this.dropped.filter((at) => at >= to - 10 * MINUTE_MS).length,
      telemetryDroppedTotal: this.droppedTotal,
    };
  }
}
