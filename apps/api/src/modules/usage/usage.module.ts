import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { AbuseMonitor, USAGE_ABUSE_CONFIG } from './application/abuse.js';
import type { AbuseConfig } from './application/abuse.js';
import { UsageAggregator } from './application/aggregate.js';
import { StartupPriceCheck } from './application/startup-price-check.js';
import { USAGE_CLOCK, USAGE_CONFIG, USAGE_REPOSITORY, USAGE_STARTUP } from './application/ports.js';
import type { Clock, UsageConfig, UsageStartupOptions } from './application/ports.js';
import { UsageService } from './application/usage.service.js';
import { toUnits } from './domain/money.js';
import { configuredOperations } from './domain/operations.js';
import { DrizzleUsageRepository } from './infrastructure/usage.repository.js';

type Env = Readonly<Record<string, string | undefined>>;

const DEFAULT_DAILY = '50';
const DEFAULT_MONTHLY = '500';
const DECIMAL = /^\d{1,8}(\.\d{1,4})?$/;

function capOf(env: Env, name: string, fallback: string): number {
  const text = env[name] === undefined || env[name] === '' ? fallback : env[name];
  if (text === undefined || !DECIMAL.test(text) || Number(text) <= 0) {
    throw new Error(`${name} must be a positive decimal with at most four decimals`);
  }
  return toUnits(text);
}

/** Reads and checks the cap settings (SB-D10): positive, monthly not below daily. A fault stops the process at start-up. */
export function usageConfigFrom(env: Env): UsageConfig {
  const dailyCapUnits = capOf(env, 'SPEND_CAP_DAILY_USD', DEFAULT_DAILY);
  const monthlyCapUnits = capOf(env, 'SPEND_CAP_MONTHLY_USD', DEFAULT_MONTHLY);
  if (monthlyCapUnits < dailyCapUnits)
    throw new Error('SPEND_CAP_MONTHLY_USD must not be below SPEND_CAP_DAILY_USD');
  return { dailyCapUnits, monthlyCapUnits };
}

const positiveInt = (env: Env, name: string, fallback: number): number => {
  const text = env[name];
  if (text === undefined || text === '') return fallback;
  if (!/^\d+$/.test(text) || Number(text) < 1)
    throw new Error(`${name} must be a positive whole number`);
  return Number(text);
};

/** Abuse thresholds (OI-CAPS): 20 jobs and 5 provider 401/429 responses in 10 minutes unless configured. */
export function abuseConfigFrom(env: Env): AbuseConfig {
  return {
    jobBurstCount: positiveInt(env, 'JOB_BURST_ALERT_COUNT', 20),
    authSpikeCount: positiveInt(env, 'PROVIDER_AUTH_SPIKE_COUNT', 5),
    windowMinutes: positiveInt(env, 'JOB_BURST_WINDOW_MIN', 10),
  };
}

export interface UsageModuleOptions {
  readonly clock?: Clock;
  /** Replaces `process.exit` and stderr (tests); the start-up price check exits 78 or 1 through them. */
  readonly exit?: (code: number) => void;
  readonly stderr?: (line: string) => void;
}

/**
 * Usage (TASK-044): price table, spend reservations and usage events, the cap check under `spend:{ownerId}` and the
 * start-up price check. The start-up check runs for the models and operations configured in `env`, once the
 * database is open.
 */
@Module({})
export class UsageModule {
  static register(env: Env, options: UsageModuleOptions = {}): DynamicModule {
    const config = usageConfigFrom(env);
    const startup: UsageStartupOptions = {
      operations: configuredOperations(env),
      exit: options.exit ?? ((code) => process.exit(code)),
      stderr: options.stderr ?? ((line) => process.stderr.write(`${line}\n`)),
    };
    return {
      module: UsageModule,
      providers: [
        UsageService,
        AbuseMonitor,
        UsageAggregator,
        { provide: USAGE_ABUSE_CONFIG, useValue: abuseConfigFrom(env) },
        StartupPriceCheck,
        { provide: USAGE_CONFIG, useValue: config },
        { provide: USAGE_CLOCK, useValue: options.clock ?? (() => new Date()) },
        { provide: USAGE_STARTUP, useValue: startup },
        { provide: USAGE_REPOSITORY, useClass: DrizzleUsageRepository },
      ],
      exports: [UsageService, AbuseMonitor, UsageAggregator],
    };
  }
}
