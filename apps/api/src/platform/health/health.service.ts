import { Inject, Injectable, Optional } from '@nestjs/common';
import type { BeforeApplicationShutdown } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../db/database.module.js';
import type { Database } from '../db/database.js';
import { BOSS } from '../jobs/boss.js';
import type { RuntimeBoss } from '../jobs/boss.js';

export const HEALTH_OPTIONS = Symbol('HEALTH_OPTIONS');

export interface HealthOptions {
  /** Applied-migration count the build needs at least (`MIN_SCHEMA_HEAD`). */
  minSchemaHead: number;
  /** Highest applied-migration count the build tolerates (`MAX_SCHEMA_HEAD`); a rolled-back build allows the newer schema. */
  maxSchemaHead: number;
  /** Configuration was validated at startup; false only where a caller reports it invalid. */
  configValid: boolean;
  /** API_DRAIN_SECONDS: how long to stay unready before the process closes its connections. */
  drainSeconds: number;
  checkTimeoutMs: number;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 1000;

export function healthOptionsFrom(
  env: Record<string, string | undefined>,
  config: { API_DRAIN_SECONDS?: number | undefined } = {},
): HealthOptions {
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0)
      throw new Error(`${name} must be a non-negative integer`);
    return value;
  };
  const minSchemaHead = num('MIN_SCHEMA_HEAD', 0);
  const maxSchemaHead = num('MAX_SCHEMA_HEAD', Number.MAX_SAFE_INTEGER);
  if (minSchemaHead > maxSchemaHead)
    throw new Error('MIN_SCHEMA_HEAD must not exceed MAX_SCHEMA_HEAD');
  return {
    minSchemaHead,
    maxSchemaHead,
    configValid: true,
    drainSeconds: config.API_DRAIN_SECONDS ?? 0,
    checkTimeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
  };
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

@Injectable()
export class HealthService implements BeforeApplicationShutdown {
  private drainingFlag = false;

  constructor(
    @Inject(HEALTH_OPTIONS) private readonly options: HealthOptions,
    @Optional() @Inject(DATABASE) private readonly database?: Database,
    @Optional() @Inject(BOSS) private readonly boss?: RuntimeBoss,
  ) {}

  get draining(): boolean {
    return this.drainingFlag;
  }

  /** On a shutdown signal readiness fails first; the connections close after the drain period. */
  async beforeApplicationShutdown(): Promise<void> {
    this.drainingFlag = true;
    if (this.options.drainSeconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.drainSeconds * 1000));
    }
  }

  /** API-901. Resolves the failed check's name for the log; the caller never sees it. */
  async failure(): Promise<string | null> {
    if (this.drainingFlag) return 'draining';
    if (!this.options.configValid) return 'config';
    const { database, boss } = this;
    const ms = this.options.checkTimeoutMs;
    if (database !== undefined) {
      try {
        await within(database.pool.query('select 1'), ms);
      } catch {
        return 'database';
      }
      try {
        const head = await within(this.schemaHead(database), ms);
        if (head < this.options.minSchemaHead || head > this.options.maxSchemaHead)
          return 'schema_head';
      } catch {
        return 'schema_head';
      }
    }
    if (boss !== undefined) {
      try {
        if (!(await within(boss.isInstalled(), ms))) return 'queue';
      } catch {
        return 'queue';
      }
    }
    return null;
  }

  /** The number of applied migrations; none applied (no migrations table) is 0. */
  private async schemaHead(database: Database): Promise<number> {
    const present = await database.pool.query<{ t: string | null }>(
      `select to_regclass('drizzle.__drizzle_migrations') as t`,
    );
    if (present.rows[0]?.t === null || present.rows[0] === undefined) return 0;
    const result = await database.db.execute(
      sql`select count(*)::int as head from drizzle.__drizzle_migrations`,
    );
    return Number((result.rows[0] as { head: number } | undefined)?.head ?? 0);
  }
}
