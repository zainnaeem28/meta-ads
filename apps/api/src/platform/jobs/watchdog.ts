/** The exit code of a worker that stopped making progress; the supervisor restarts it (ARCHITECTURE §5.11, TD-D13). */
export const EXIT_WATCHDOG = 70;

export type StallKind = 'loop' | 'sweep';

export interface WatchdogOptions {
  /** WORKER_WATCHDOG_SECONDS. */
  readonly limitSec: number;
  readonly exit: (code: number) => void;
  readonly onStall?: (kind: StallKind, stalledSec: number) => void;
  readonly now?: () => number;
  /** How often the check runs; at most a quarter of the limit, so a stall is caught within 1.25 limits. */
  readonly checkEveryMs?: number;
}

/**
 * In-process watchdog. Two things must keep moving: the event loop (this check's own timer fires on time) and the
 * recovery sweep (`sweepDone` is called after every tick, run or skipped). Either one silent for longer than the
 * limit ends the process with 70; a worker that is stuck is worse than one that restarts.
 */
export class Watchdog {
  private timer: NodeJS.Timeout | undefined;
  private lastTick: number;
  private lastSweep: number;
  private readonly now: () => number;
  private readonly limitMs: number;
  private tripped = false;

  constructor(private readonly options: WatchdogOptions) {
    if (!(options.limitSec > 0)) throw new Error('watchdog limit must be positive');
    this.now = options.now ?? Date.now;
    this.limitMs = options.limitSec * 1000;
    this.lastTick = this.lastSweep = this.now();
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.lastTick = this.lastSweep = this.now();
    const every = this.options.checkEveryMs ?? Math.max(10, Math.min(1000, this.limitMs / 4));
    this.timer = setInterval(() => this.check(), every);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The sweep tick finished (it ran, or another worker held the lock). */
  sweepDone(): void {
    this.lastSweep = this.now();
  }

  /** One check; public so a test can drive it without timers. */
  check(): void {
    if (this.tripped) return;
    const now = this.now();
    const loopGap = now - this.lastTick;
    this.lastTick = now;
    if (loopGap > this.limitMs) return this.trip('loop', loopGap);
    const sweepGap = now - this.lastSweep;
    if (sweepGap > this.limitMs) this.trip('sweep', sweepGap);
  }

  private trip(kind: StallKind, gapMs: number): void {
    this.tripped = true;
    this.stop();
    this.options.onStall?.(kind, Math.round(gapMs / 1000));
    this.options.exit(EXIT_WATCHDOG);
  }
}
