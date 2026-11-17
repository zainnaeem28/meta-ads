import 'reflect-metadata';
import { Module } from '@nestjs/common';
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
import { EnvelopeInterceptor, ErrorFilter } from '../platform/http/index.js';
import { installMethodIndex } from '../platform/http/method-index.js';
import type { MethodIndex } from '../platform/http/method-index.js';
import { IdempotencyModule } from '../platform/idempotency/index.js';
import { RateLimitModule } from '../platform/rate-limit/index.js';
import { assertScopesDeclared } from '../platform/http/scope-registry.js';
import { AuditModule } from '../modules/audit/index.js';
import { IdentityModule, authOptionsFrom, identityConfigFrom } from '../modules/identity/index.js';
import { MediaModule } from '../modules/media/media.module.js';
import { CampaignsModule } from '../modules/campaigns/campaigns.module.js';
import { UsageModule } from '../modules/usage/usage.module.js';
import { BriefModule } from '../modules/brief/brief.module.js';
import { ProductionModule, progressBridge } from '../modules/production/production.module.js';
import { ReportingModule } from '../modules/reporting/reporting.module.js';
import { ProviderKeysModule } from '../modules/provider-keys/provider-keys.module.js';
import { JobsModule } from '../platform/jobs/boss.js';
import { HealthModule, healthOptionsFrom } from '../platform/health/index.js';
import { MetricsModule } from '../platform/metrics/index.js';
import type { MetricsConfig } from '../platform/metrics/index.js';

export interface EdgeConfig extends EgressModuleConfig, MetricsConfig {
  API_DRAIN_SECONDS?: number | undefined;
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
  const audit = AuditModule.register(logging.logger);
  const egress = EgressModule.register(config);
  // The session guard needs the database; it is registered before the rate limiter so that guard sees the user.
  const auth =
    config.DATABASE_URL === undefined
      ? undefined
      : { options: authOptionsFrom(process.env, config.WEB_ORIGIN), audit };
  const media =
    config.DATABASE_URL === undefined || process.env['R2_ENDPOINT'] === undefined
      ? undefined
      : MediaModule.register(process.env);
  const usage = config.DATABASE_URL === undefined ? undefined : UsageModule.register(process.env);
  // Campaigns (layer 4) reads job progress through a port that production (layer 6) fills once the database is open.
  const progress = progressBridge();
  const brief =
    config.DATABASE_URL === undefined
      ? undefined
      : BriefModule.register(process.env, media === undefined || usage === undefined ? undefined : { media, usage });
  const production = usage === undefined ? undefined : ProductionModule.register(process.env, { usage }, progress.bind);
  @Module({
    imports: [
      logging.module(),
      egress,
      audit,
      IdentityModule.register(
        identityConfigFrom(process.env, config.APP_ENV, config.WEB_ORIGIN),
        auth,
      ),
      ...database,
      // The seal side of the key custody (REQ-015) whenever the KEK public keys are configured; with a database it also
      // serves API-010 to API-013 (audit and egress are the instances above, not second copies).
      ...(process.env['KEK_PUBLIC_KEYS'] === undefined
        ? []
        : [
            ProviderKeysModule.register(
              process.env,
              'api',
              config.DATABASE_URL === undefined ? undefined : { audit, egress },
            ),
          ]),
      // Object storage and quota (REQ-020); needs the database and the bucket settings.
      ...(media === undefined ? [] : [media]),
      // Drafts CRUD (API-020 to API-023, API-025); needs the database and media (the product image).
      ...(media === undefined ? [] : [CampaignsModule.register(process.env, { audit, media, progress: progress.reader })]),
      // Spend caps, reservations, usage events and the start-up price check (REQ-019, TD-D39); needs the database.
      ...(usage === undefined ? [] : [usage]),
      // The claim-check rules (REQ-007, REQ-008): the rules file is checked at start-up; the rules are read from the database.
      // With media and usage it also serves the job-creating operations: draft submit, image analysis, regenerate (SB-D14).
      ...(brief === undefined ? [] : [brief]),
      // Segment clips (API-060 to API-063) and the campaign progress reader; need the database, the job queue and usage.
      ...(production === undefined ? [] : [production]),
      // The usage report and its CSV (API-130, API-131); read-only over usage events, job counters and claim counts.
      ...(brief === undefined || production === undefined ? [] : [ReportingModule.register(process.env, { audit, brief, production })]),
      HealthModule.register(healthOptionsFrom(process.env, config)),
      MetricsModule.register(config),
    ],
    controllers,
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
