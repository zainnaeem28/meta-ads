import pg from 'pg';

/** The configuration keys the application pool reads (registry: DATABASE_URL, DATABASE_POOL_MAX, DATABASE_ACQUIRE_TIMEOUT_MS). */
export interface DbConfig {
  readonly DATABASE_URL: string;
  readonly DATABASE_POOL_MAX: number;
  readonly DATABASE_ACQUIRE_TIMEOUT_MS: number;
}

export const IDLE_TIMEOUT_MS = 30_000;

export interface PoolOptions {
  /** Overrides DATABASE_POOL_MAX (migration and seed use 2). */
  readonly max?: number;
  readonly applicationName?: string;
  readonly onError?: (error: Error) => void;
}

/** Narrow a process configuration to the database keys; throws naming the key when one is absent. */
export function dbConfigOf(config: {
  readonly DATABASE_URL?: string | undefined;
  readonly DATABASE_POOL_MAX?: number | undefined;
  readonly DATABASE_ACQUIRE_TIMEOUT_MS?: number | undefined;
}): DbConfig {
  const { DATABASE_URL, DATABASE_POOL_MAX, DATABASE_ACQUIRE_TIMEOUT_MS } = config;
  if (DATABASE_URL === undefined) throw new Error('DATABASE_URL is required');
  if (DATABASE_POOL_MAX === undefined) throw new Error('DATABASE_POOL_MAX is required');
  if (DATABASE_ACQUIRE_TIMEOUT_MS === undefined)
    throw new Error('DATABASE_ACQUIRE_TIMEOUT_MS is required');
  return { DATABASE_URL, DATABASE_POOL_MAX, DATABASE_ACQUIRE_TIMEOUT_MS };
}

/**
 * The application pool: size from configuration (10 by default), acquire timeout from configuration (5 s), idle
 * timeout 30 s. An idle client's error must not crash the process, so it is reported through `onError`.
 */
export function createPool(config: DbConfig, options: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: options.max ?? config.DATABASE_POOL_MAX,
    connectionTimeoutMillis: config.DATABASE_ACQUIRE_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    application_name: options.applicationName ?? 'shroomap',
  });
  pool.on('error', options.onError ?? (() => undefined));
  return pool;
}
