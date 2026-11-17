import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { DATABASE } from '../../platform/db/index.js';
import type { Database } from '../../platform/db/index.js';
import { RateLimiter } from '../../platform/rate-limit/index.js';
import { REPORTING_CLOCK, REPORTING_CONFIG, REPORTING_USAGE } from './application/ports.js';
import type { ReportingConfig } from './application/ports.js';
import { UsageReportService } from './application/usage-report.service.js';
import { DrizzleUsageReportReader } from './infrastructure/usage-report.reader.js';
import { ReportingController } from './transport/reporting.controller.js';

type Env = Readonly<Record<string, string | undefined>>;

const days = (env: Env, name: string, fallback: number): number => {
  const text = env[name];
  if (text === undefined || text === '') return fallback;
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 366) throw new Error(`${name} must be a whole number of days from 1 to 366`);
  return Number(text);
};

/** REPORT_DEFAULT_WINDOW_DAYS (30) and REPORT_MAX_WINDOW_DAYS (366); the default never exceeds the maximum. */
export function reportingConfigFrom(env: Env): ReportingConfig {
  const defaultWindowDays = days(env, 'REPORT_DEFAULT_WINDOW_DAYS', 30);
  const maxWindowDays = days(env, 'REPORT_MAX_WINDOW_DAYS', 366);
  if (defaultWindowDays > maxWindowDays) throw new Error('REPORT_DEFAULT_WINDOW_DAYS must not exceed REPORT_MAX_WINDOW_DAYS');
  return { defaultWindowDays, maxWindowDays, statementTimeoutMs: 15_000 };
}

export interface ReportingEdge {
  /** The audit, brief and production modules as registered by the api root (the last two export the claim and job counters). */
  readonly audit: DynamicModule;
  readonly brief: DynamicModule;
  readonly production: DynamicModule;
}

export interface ReportingModuleOptions {
  readonly clock?: () => Date;
}

/** Reporting (TASK-060): the usage report and its CSV, read-only over usage, production and brief (REQ-021). */
@Module({})
export class ReportingModule {
  static register(env: Env, edge: ReportingEdge, options: ReportingModuleOptions = {}): DynamicModule {
    return {
      module: ReportingModule,
      imports: [edge.audit, edge.brief, edge.production],
      providers: [
        UsageReportService,
        { provide: REPORTING_CONFIG, useValue: reportingConfigFrom(env) },
        { provide: REPORTING_CLOCK, useValue: options.clock ?? (() => new Date()) },
        { provide: REPORTING_USAGE, useClass: DrizzleUsageReportReader },
        { provide: RateLimiter, useFactory: (database: Database) => new RateLimiter(database.db), inject: [DATABASE] },
      ],
      controllers: [ReportingController],
    };
  }
}
