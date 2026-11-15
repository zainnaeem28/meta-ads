import { AsyncLocalStorage } from 'node:async_hooks';

/** What one open transaction has done so far: the advisory locks it holds, in acquisition order. */
export class TxState {
  readonly locks: { name: string; rank: number }[] = [];
  get holdsLock(): boolean {
    return this.locks.length > 0;
  }
}

const storage = new AsyncLocalStorage<TxState>();
const byHandle = new WeakMap<object, TxState>();

export function runInTransaction<T>(
  handle: object,
  state: TxState,
  fn: () => Promise<T>,
): Promise<T> {
  byHandle.set(handle, state);
  return storage.run(state, fn);
}

/** The state of the transaction the caller is running in, if any. */
export function currentTxState(): TxState | undefined {
  return storage.getStore();
}

/** The state of a given transaction handle: locks are taken on a handle, so they are tracked per handle. */
export function stateOf(handle: object): TxState {
  const state = byHandle.get(handle);
  if (state === undefined) throw new Error('not a transaction handle created by the unit of work');
  return state;
}
