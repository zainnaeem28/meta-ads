import type { DbTx } from '../db/index.js';

/**
 * A recovery step a job-owning module contributes (ARCHITECTURE §5.11 F-SWEEP). The module registers it at start-up;
 * `platform/jobs` runs every registered hook, so the platform never imports a module (layer rule).
 */
export interface SweepHook {
  readonly name: string;
  /** Runs in the sweep's transaction; returns how many rows it settled. */
  run(tx: DbTx): Promise<{ readonly swept: number }>;
}

export interface SweepHookResult {
  readonly name: string;
  readonly swept: number;
  readonly error?: string;
}

export class DuplicateSweepHookError extends Error {
  constructor(name: string) {
    super(`sweep hook ${name} is already registered`);
    this.name = 'DuplicateSweepHookError';
  }
}

export class SweepRegistry {
  private readonly hooks = new Map<string, SweepHook>();

  register(hook: SweepHook): void {
    if (this.hooks.has(hook.name)) throw new DuplicateSweepHookError(hook.name);
    this.hooks.set(hook.name, hook);
  }

  names(): string[] {
    return [...this.hooks.keys()];
  }

  /**
   * Run the hooks in registration order. Each gets its own transaction (`inTx`), so one failing hook rolls back only
   * itself and the others still run; its error is reported, not thrown.
   */
  async runAll(inTx: <T>(fn: (tx: DbTx) => Promise<T>) => Promise<T>): Promise<SweepHookResult[]> {
    const results: SweepHookResult[] = [];
    for (const hook of this.hooks.values()) {
      try {
        const { swept } = await inTx((tx) => hook.run(tx));
        results.push({ name: hook.name, swept });
      } catch (error) {
        results.push({
          name: hook.name,
          swept: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }
}

/** The process-wide registry the worker's recovery sweep runs. */
export const sweepRegistry = new SweepRegistry();
