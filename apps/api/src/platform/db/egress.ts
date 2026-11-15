import { EgressInTransactionError } from './errors.js';
import { currentTxState } from './tx-state.js';

/**
 * Adapters call this before any network I/O (provider, R2, Clerk, key probe): inside a database transaction it
 * throws. ARCHITECTURE 1.5: no network call inside a transaction, with no exceptions; a lock-holding transaction
 * is reported in the message because it is the case that blocks other requests.
 */
export function assertNoEgress(operation: string): void {
  const state = currentTxState();
  if (state !== undefined) throw new EgressInTransactionError(operation, state.holdsLock);
}

/** Wrap a network function so every call first runs the guard. */
export function guardEgress<A extends unknown[], R>(
  operation: string,
  fn: (...args: A) => R,
): (...args: A) => R {
  return (...args: A): R => {
    assertNoEgress(operation);
    return fn(...args);
  };
}
