/** Failures raised by platform/db. Messages carry names and codes, never connection strings or row values. */

export class LockOrderError extends Error {
  readonly code = 'lock_order_violation';
  constructor(requested: string, held: readonly string[]) {
    super(
      `lock ${requested} requested after ${held.join(', ')}: order is admin-invariant, spend, render-day, run`,
    );
    this.name = 'LockOrderError';
  }
}

export class LockTimeoutError extends Error {
  readonly code = 'lock_timeout';
  constructor(options?: ErrorOptions) {
    super('a lock was not granted within lock_timeout', options);
    this.name = 'LockTimeoutError';
  }
}

export class StatementTimeoutError extends Error {
  readonly code = 'statement_timeout';
  constructor(options?: ErrorOptions) {
    super('a statement exceeded statement_timeout', options);
    this.name = 'StatementTimeoutError';
  }
}

export class EgressInTransactionError extends Error {
  readonly code = 'egress_in_transaction';
  constructor(operation: string, lockHeld: boolean) {
    super(
      `${operation}: network calls are not allowed inside a database transaction${lockHeld ? ' that holds an advisory lock' : ''}`,
    );
    this.name = 'EgressInTransactionError';
  }
}

export class NestedTransactionError extends Error {
  readonly code = 'nested_transaction';
  constructor() {
    super(
      'a transaction is already open: pass its handle to the owner modules instead of opening another',
    );
    this.name = 'NestedTransactionError';
  }
}

export class DatabaseUnavailableError extends Error {
  readonly code = 'database_unavailable';
  constructor(reason: string, options?: ErrorOptions) {
    super(`database check failed: ${reason}`, options);
    this.name = 'DatabaseUnavailableError';
  }
}

interface PgErrorShape {
  code: string;
  constraint?: string;
}

/** The PostgreSQL error inside a (possibly wrapped) failure: Drizzle wraps driver errors in `cause`. */
export function pgErrorOf(error: unknown): PgErrorShape | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        ...(typeof candidate.constraint === 'string' ? { constraint: candidate.constraint } : {}),
      };
    }
    current = candidate.cause;
  }
  return undefined;
}

/** Unique violation (23505) on the named index or constraint: callers map it to a domain result. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pgError = pgErrorOf(error);
  return (
    pgError?.code === '23505' && (constraint === undefined || pgError.constraint === constraint)
  );
}

/** Translate lock and statement timeouts into typed errors; anything else passes through unchanged. */
export function normalizeDbError(error: unknown): unknown {
  const code = pgErrorOf(error)?.code;
  if (code === '55P03') return new LockTimeoutError({ cause: error });
  if (code === '57014') return new StatementTimeoutError({ cause: error });
  return error;
}
