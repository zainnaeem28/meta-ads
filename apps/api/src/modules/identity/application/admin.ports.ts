import type { Db, UserRecord } from './ports.js';
import type { Role, UserStatus } from '../domain/records.js';

/** The account as the admin list and API-104 show it. */
export interface AdminUserRecord extends UserRecord {
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One listed account with the exact `created_at` text, the sort key of the cursor (microsecond precision). */
export interface AdminUserListed extends AdminUserRecord {
  readonly createdAtKey: string;
}

export interface AdminUserPosition {
  readonly createdAt: string;
  readonly id: string;
}

export interface AdminUserQuery {
  readonly status?: UserStatus;
  /** Rows to fetch (the caller asks for one more than the page size). */
  readonly limit: number;
  readonly after?: AdminUserPosition;
}

// Satisfied structurally by the module-private repositories (infrastructure); the application never imports them.
export interface AdminUserStore {
  findById(db: Db, id: string): Promise<AdminUserRecord | undefined>;
  /** Optimistic update: `undefined` when `expectedVersion` is stale. */
  setRole(
    db: Db,
    id: string,
    expectedVersion: number,
    role: Role,
  ): Promise<AdminUserRecord | undefined>;
  setStatus(
    db: Db,
    id: string,
    expectedVersion: number,
    status: UserStatus,
  ): Promise<AdminUserRecord | undefined>;
  countActiveAdmins(db: Db): Promise<number>;
}

export interface AdminUserQueries {
  /** Accounts ordered by (created_at desc, id desc). */
  list(db: Db, query: AdminUserQuery): Promise<AdminUserListed[]>;
}

export const ADMIN_USER_STORE = Symbol('ADMIN_USER_STORE');
export const ADMIN_USER_QUERIES = Symbol('ADMIN_USER_QUERIES');
/** `CURSOR_SIGNING_KEY` (registry), read once by the composition root. */
export const CURSOR_KEY = Symbol('CURSOR_KEY');

export const REVOKE_SESSIONS_QUEUE = 'identity.revoke-sessions';
