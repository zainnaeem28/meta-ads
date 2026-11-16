import type { InFlightJobReader } from '../application/ports.js';

/**
 * The reader bound until brief and production exist: no job can be in flight, so the count is zero. Bootstrap replaces
 * it with the real reader (SB §4.2) when those modules arrive; provider-keys never imports them.
 */
export class NoJobsInFlight implements InFlightJobReader {
  countForKey(): Promise<number> {
    return Promise.resolve(0);
  }
}
