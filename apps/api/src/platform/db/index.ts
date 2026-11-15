export { Database, createDatabase } from './database.js';
export { DATABASE, DatabaseLifecycle, DatabaseModule } from './database.module.js';
export { assertNoEgress, guardEgress } from './egress.js';
export {
  DatabaseUnavailableError,
  EgressInTransactionError,
  LockOrderError,
  LockTimeoutError,
  NestedTransactionError,
  StatementTimeoutError,
  isUniqueViolation,
  pgErrorOf,
} from './errors.js';
export {
  LOCK_ORDER,
  RECOVERY_SWEEP_LOCK,
  lockName,
  lockXact,
  tryRecoverySweepLock,
} from './locks.js';
export type { LockKind, SessionLock } from './locks.js';
export { IDLE_TIMEOUT_MS, createPool, dbConfigOf } from './pools.js';
export type { DbConfig, PoolOptions } from './pools.js';
export { ROLE_TIMEOUTS, assertRoleTimeouts, parseMillis } from './timeouts.js';
export type { RoleTimeouts } from './timeouts.js';
export { UnitOfWork } from './unit-of-work.js';
export type { DbTx, TxOptions, TxRunner } from './unit-of-work.js';
