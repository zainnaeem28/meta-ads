import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import { Logger } from 'nestjs-pino';
import type { AppEnv } from '../platform/config/index.js';
import { DatabaseModule, dbConfigOf } from '../platform/db/index.js';
import type { HttpLogging } from '../platform/logging/index.js';
import { applyBounds } from '../platform/http/bounds.js';
import { EgressModule } from '../platform/egress/index.js';
import type { EgressModuleConfig } from '../platform/egress/index.js';
import { corsOptions } from '../platform/http/cors.js';
import { EnvelopeInterceptor, ErrorFilter, RawResponse } from '../platform/http/index.js';
import { installMethodIndex } from '../platform/http/method-index.js';
import type { MethodIndex } from '../platform/http/method-index.js';
import { IdempotencyModule } from '../platform/idempotency/index.js';
import { RateLimitModule } from '../platform/rate-limit/index.js';
import { Scope, assertScopesDeclared } from '../platform/http/scope-registry.js';
import { JobsModule } from '../platform/jobs/boss.js';

export interface EdgeConfig extends EgressModuleConfig {
  WEB_ORIGIN?: string | undefined;
  APP_ENV: AppEnv;
  /** When present the application pool is opened and checked at startup (DATABASE_POOL_MAX and ACQUIRE_TIMEOUT too). */
  DATABASE_URL?: string | undefined;
  DATABASE_POOL_MAX?: number | undefined;
  DATABASE_ACQUIRE_TIMEOUT_MS?: number | undefined;
  RATE_LIMIT_IP_KEY?: string | undefined;
  TRUST_PROXY_HOPS?: number | undefined;
  JOB_CREATE_RATE_LIMIT?: number | undefined;
  JOB_CREATE_RATE_WINDOW_MIN?: number | undefined;
  IDEMPOTENCY_TTL_HOURS?: number | undefined;
}

/** Replaced by the health ticket (API-900/901). */
@Controller('health')
@Scope('Pub')
export class HealthController {
  @Get('live')
  @RawResponse()
  live(): { status: string } {
    return { status: 'ok' };
  }
}

/** Operations served at the root, not under `/api/v1` (health probes API-900/901, internal metrics API-902/903). */
export const ROOT_PATHS = [
  'health/live',
  'health/ready',
  'internal/metrics',
  'internal/metrics/window',
];
export const API_PREFIX = 'api/v1';

function apiModule(
  logging: HttpLogging,
  controllers: (new () => object)[],
  config: EdgeConfig,
): new () => object {
  // With a database the api also runs pg-boss (send only) and fails closed when its schema or a queue is missing.
  const database =
    config.DATABASE_URL === undefined
      ? []
      : [
          DatabaseModule.forRoot(dbConfigOf(config)),
          JobsModule.forRoot({ DATABASE_URL: config.DATABASE_URL, role: 'api' }),
          RateLimitModule.register(config),
          IdempotencyModule.register(config),
        ];
  @Module({
    imports: [logging.module(), EgressModule.register(config), ...database],
    controllers: [HealthController, ...controllers],
  })
  class ApiModule {}
  return ApiModule;
}

/**
 * Edge behaviour in the order that makes each header reach route misses too: CORS and helmet first, then the route
 * index that answers 405/404 (so those responses carry the same headers), `no-store` on every `/api/v1` response.
 */
export async function configureHttpEdge(
  app: NestFastifyApplication,
  config: EdgeConfig,
): Promise<MethodIndex> {
  const fastify = app.getHttpAdapter().getInstance();
  app.setGlobalPrefix(API_PREFIX, { exclude: ROOT_PATHS });
  if (config.WEB_ORIGIN === undefined) throw new Error('WEB_ORIGIN is required for the api');
  app.enableCors(corsOptions(config.WEB_ORIGIN));
  await app.register(helmet, {
    contentSecurityPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.APP_ENV === 'production' || config.APP_ENV === 'staging',
  });
  await fastify.after();
  fastify.addHook('onSend', async (request, reply) => {
    if (request.url === `/${API_PREFIX}` || request.url.startsWith(`/${API_PREFIX}/`)) {
      void reply.header('Cache-Control', 'no-store');
    }
  });
  applyBounds(app);
  return installMethodIndex(fastify);
}

export interface ApiApp {
  app: NestFastifyApplication;
  index: MethodIndex;
}

/** The api composition root: used by `main.api.ts` and by the tests that must reach the real wiring. */
export async function createApiApp(
  config: EdgeConfig,
  logging: HttpLogging,
  extraControllers: (new () => object)[] = [],
): Promise<ApiApp> {
  const app = await NestFactory.create<NestFastifyApplication>(
    apiModule(logging, extraControllers, config),
    logging.adapter(),
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  app.useGlobalFilters(new ErrorFilter(logging.logger));
  app.useGlobalInterceptors(new EnvelopeInterceptor());
  app.enableShutdownHooks();
  const index = await configureHttpEdge(app, config);
  await app.init();
  assertScopesDeclared(app);
  await app.getHttpAdapter().getInstance().ready();
  return { app, index };
}
