import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DATABASE } from '../db/index.js';
import type { Database } from '../db/index.js';
import { RATE_LIMIT_OPTIONS, RateLimitGuard } from './rate-limit.guard.js';
import type { RateLimitOptions } from './rate-limit.guard.js';
import { RateLimiter } from './rate-limiter.js';

export interface RateLimitConfig {
  RATE_LIMIT_IP_KEY?: string | undefined;
  TRUST_PROXY_HOPS?: number | undefined;
  JOB_CREATE_RATE_LIMIT?: number | undefined;
  JOB_CREATE_RATE_WINDOW_MIN?: number | undefined;
}

export const JOB_CREATE_ROUTE = 'job-create';

export function rateLimitOptionsFrom(config: RateLimitConfig): RateLimitOptions {
  if (config.RATE_LIMIT_IP_KEY === undefined) throw new Error('RATE_LIMIT_IP_KEY is required for the rate limiter');
  return {
    ipKey: config.RATE_LIMIT_IP_KEY,
    trustProxyHops: config.TRUST_PROXY_HOPS ?? 1,
    routes: {
      [JOB_CREATE_ROUTE]: {
        limit: config.JOB_CREATE_RATE_LIMIT ?? 60,
        windowSeconds: (config.JOB_CREATE_RATE_WINDOW_MIN ?? 10) * 60,
      },
    },
  };
}

@Module({})
export class RateLimitModule {
  /** Needs the database module; registers the general limit as a global guard. */
  static register(config: RateLimitConfig): DynamicModule {
    const options = rateLimitOptionsFrom(config);
    return {
      module: RateLimitModule,
      providers: [
        { provide: RATE_LIMIT_OPTIONS, useValue: options },
        { provide: RateLimiter, useFactory: (database: Database) => new RateLimiter(database.db), inject: [DATABASE] },
        { provide: APP_GUARD, useClass: RateLimitGuard },
      ],
      exports: [RateLimiter],
    };
  }
}
