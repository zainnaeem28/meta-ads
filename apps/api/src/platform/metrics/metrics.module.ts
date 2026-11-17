import { Inject, Injectable, Module, Optional } from '@nestjs/common';
import type { DynamicModule, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { DATABASE } from '../db/database.module.js';
import type { Database } from '../db/database.js';
import { BOSS } from '../jobs/boss.js';
import type { RuntimeBoss } from '../jobs/boss.js';
import { AppMetrics } from './app-metrics.js';
import { installRequestMetrics, instrumentBossSend, instrumentPool } from './instrument.js';
import { MetricsController } from './metrics.controller.js';
import { METRICS_TOKEN, MetricsTokenGuard } from './metrics-token.guard.js';
import { createSentryAdapter } from './sentry.js';
import type { SentryAdapter, SentryConfig, SentrySdk } from './sentry.js';

export const METRICS_CONFIG = Symbol('METRICS_CONFIG');
export const SENTRY_SDK_LOADER = Symbol('SENTRY_SDK_LOADER');

export interface MetricsConfig extends SentryConfig {
  METRICS_TOKEN?: string | undefined;
}

const loadSentry = async (): Promise<SentrySdk> =>
  (await import('@sentry/node')) as unknown as SentrySdk;

/** Instruments the request path, the pool and pg-boss sends, and starts the error reporter when it is configured. */
@Injectable()
export class MetricsLifecycle implements OnModuleInit, OnApplicationShutdown {
  private sentry: SentryAdapter | null = null;

  constructor(
    @Inject(AppMetrics) private readonly metrics: AppMetrics,
    @Inject(METRICS_CONFIG) private readonly config: MetricsConfig,
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    @Inject(SENTRY_SDK_LOADER) private readonly loader: () => Promise<SentrySdk>,
    @Optional() @Inject(DATABASE) private readonly database?: Database,
    @Optional() @Inject(BOSS) private readonly boss?: RuntimeBoss,
  ) {}

  async onModuleInit(): Promise<void> {
    installRequestMetrics(this.host.httpAdapter.getInstance(), this.metrics);
    if (this.database !== undefined) {
      const { pool } = this.database;
      instrumentPool(pool, this.metrics);
      const gauge = (): void =>
        this.metrics.setPoolState(
          pool.totalCount,
          pool.totalCount - pool.idleCount,
          pool.waitingCount,
        );
      gauge();
      const timer = setInterval(gauge, 5000);
      timer.unref();
    }
    if (this.boss !== undefined) instrumentBossSend(this.boss as never, this.metrics);
    if (this.config.SENTRY_DSN !== undefined && this.config.SENTRY_DSN !== '') {
      this.sentry = createSentryAdapter(this.config, {
        sdk: await this.loader(),
        onDropped: (count) => this.metrics.telemetryDropped(count),
      });
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.sentry?.close();
  }
}

@Module({})
export class MetricsModule {
  static register(
    config: MetricsConfig,
    loader: () => Promise<SentrySdk> = loadSentry,
  ): DynamicModule {
    return {
      module: MetricsModule,
      global: true,
      controllers: [MetricsController],
      providers: [
        { provide: AppMetrics, useFactory: () => new AppMetrics() },
        { provide: METRICS_TOKEN, useValue: config.METRICS_TOKEN },
        { provide: METRICS_CONFIG, useValue: config },
        { provide: SENTRY_SDK_LOADER, useValue: loader },
        MetricsTokenGuard,
        MetricsLifecycle,
      ],
      exports: [AppMetrics],
    };
  }
}
