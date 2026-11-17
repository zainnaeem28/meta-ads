import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DomainError } from '../http/domain-error.js';

export interface LimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface ConsumeResult {
  readonly allowed: boolean;
  readonly count: number;
  readonly limit: number;
  /** Whole seconds until the window the request fell in ends (at least 1). */
  readonly retryAfterSeconds: number;
}

/** General limits of REQ-019 (b): per user, and per client IP for unauthenticated requests. */
export const GENERAL_USER_LIMIT: LimitRule = { limit: 300, windowSeconds: 60 };
export const GENERAL_IP_LIMIT: LimitRule = { limit: 60, windowSeconds: 60 };

export const MAX_SCOPE = 48;
export const MAX_SUBJECT = 64;

export type Clock = () => number;

/** HMAC of a client IP: the only form in which an address is stored (no personal data in `rate_limit_buckets`). */
export function ipSubject(ipKey: string, ip: string): string {
  return createHmac('sha256', ipKey).update(ip).digest('hex');
}

/** Fixed windows in `rate_limit_buckets`: approximate across window edges, one upsert per request. */
export class RateLimiter {
  constructor(
    private readonly db: Pick<NodePgDatabase, 'execute'>,
    private readonly now: Clock = Date.now,
  ) {}

  /**
   * Counts one request against `(scope, subject)` in the current window. A database failure is 503 and never a
   * pass-through: the request would fail on the same database anyway.
   */
  async consume(
    scope: string,
    subject: string,
    limit: number,
    windowSeconds: number,
  ): Promise<ConsumeResult> {
    if (scope.length === 0 || scope.length > MAX_SCOPE) throw new RangeError('scope length');
    if (subject.length === 0 || subject.length > MAX_SUBJECT)
      throw new RangeError('subject length');
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError('limit must be a positive integer');
    if (!Number.isInteger(windowSeconds) || windowSeconds < 1) {
      throw new RangeError('windowSeconds must be a positive integer');
    }
    const windowMs = windowSeconds * 1000;
    const nowMs = this.now();
    const start = Math.floor(nowMs / windowMs) * windowMs;
    let count: number;
    try {
      const result = await this.db.execute<{ count: number }>(sql`
        insert into rate_limit_buckets (scope, subject, window_start, count)
        values (${scope}, ${subject}, ${new Date(start).toISOString()}::timestamptz, 1)
        on conflict (scope, subject, window_start)
        do update set count = rate_limit_buckets.count + 1
        returning count`);
      count = Number(result.rows[0]?.count);
    } catch {
      throw new DomainError(
        'service_unavailable',
        'The service is temporarily unavailable. Try again shortly.',
      );
    }
    return {
      allowed: count <= limit,
      count,
      limit,
      retryAfterSeconds: Math.max(1, Math.ceil((start + windowMs - nowMs) / 1000)),
    };
  }

  /** `consume` that refuses with 429 `rate_limited` and the wait in the message. */
  async enforce(scope: string, subject: string, rule: LimitRule): Promise<void> {
    const result = await this.consume(scope, subject, rule.limit, rule.windowSeconds);
    if (!result.allowed) throw new RateLimitedError(result.retryAfterSeconds);
  }
}

export class RateLimitedError extends DomainError {
  constructor(readonly retryAfterSeconds: number) {
    super('rate_limited', `Too many attempts. Try again in ${retryAfterSeconds} seconds.`);
  }
}
