import type pg from 'pg';
import { DatabaseUnavailableError } from './errors.js';

/** Role defaults set by provisioning (ARCHITECTURE 1.5), in milliseconds. */
export interface RoleTimeouts {
  readonly statement_timeout: number;
  readonly lock_timeout: number;
  readonly idle_in_transaction_session_timeout: number;
}

export const ROLE_TIMEOUTS: Readonly<Record<string, RoleTimeouts>> = {
  app_api: {
    statement_timeout: 5000,
    lock_timeout: 2000,
    idle_in_transaction_session_timeout: 10000,
  },
  app_worker: {
    statement_timeout: 30000,
    lock_timeout: 5000,
    idle_in_transaction_session_timeout: 30000,
  },
};

const UNITS: Record<string, number> = {
  us: 0.001,
  ms: 1,
  s: 1000,
  min: 60000,
  h: 3600000,
  d: 86400000,
};

/** `SHOW` prints a timeout as `5s`, `2000ms` or a bare number of milliseconds. */
export function parseMillis(text: string): number {
  const match = /^(\d+)\s*([a-z]*)$/.exec(text.trim());
  const unit = match?.[2] === '' ? 'ms' : match?.[2];
  const factor = unit === undefined ? undefined : UNITS[unit];
  if (match?.[1] === undefined || factor === undefined)
    throw new Error('unreadable timeout setting');
  return Number(match[1]) * factor;
}

/**
 * Fail closed when the connecting role is an application role whose timeouts were not set at provisioning.
 * Other roles (a developer's, the test server's) have no defined timeouts and are not checked.
 */
export async function assertRoleTimeouts(
  pool: pg.Pool,
  table: Readonly<Record<string, RoleTimeouts>> = ROLE_TIMEOUTS,
): Promise<string> {
  const identity = await pool.query<{ role: string }>('select current_user as role');
  const role = identity.rows[0]?.role ?? '';
  const expected = table[role];
  if (expected === undefined) return role;
  for (const [setting, millis] of Object.entries(expected)) {
    const shown = await pool.query<Record<string, string>>(
      `select current_setting('${setting}') as value`,
    );
    const actual = parseMillis(shown.rows[0]?.['value'] ?? '');
    if (actual !== millis) {
      throw new DatabaseUnavailableError(
        `role ${role} has ${setting} ${actual}ms, expected ${millis}ms`,
      );
    }
  }
  return role;
}
