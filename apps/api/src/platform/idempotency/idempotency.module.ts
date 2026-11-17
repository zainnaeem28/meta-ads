import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { DATABASE } from '../db/index.js';
import type { Database } from '../db/index.js';
import { runPlatformCleanup } from './cleanup.js';
import type { CleanupResult } from './cleanup.js';

export const IDEMPOTENCY_TTL_HOURS = Symbol('IDEMPOTENCY_TTL_HOURS');
export const PLATFORM_CLEANUP = Symbol('PLATFORM_CLEANUP');

export type PlatformCleanup = () => Promise<CleanupResult>;

export interface IdempotencyConfig {
  IDEMPOTENCY_TTL_HOURS?: number | undefined;
}

@Module({})
export class IdempotencyModule {
  /** Provides the TTL (24 h default) and the `platform.cleanup` handler body for the worker's job registry. */
  static register(config: IdempotencyConfig): DynamicModule {
    return {
      module: IdempotencyModule,
      providers: [
        { provide: IDEMPOTENCY_TTL_HOURS, useValue: config.IDEMPOTENCY_TTL_HOURS ?? 24 },
        {
          provide: PLATFORM_CLEANUP,
          useFactory:
            (database: Database): PlatformCleanup =>
            () =>
              runPlatformCleanup(database.db),
          inject: [DATABASE],
        },
      ],
      exports: [IDEMPOTENCY_TTL_HOURS, PLATFORM_CLEANUP],
    };
  }
}
