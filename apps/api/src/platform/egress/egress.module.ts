import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { Egress, validateAllowList } from './egress.js';
import type { AllowedHosts, EgressOptions } from './egress.js';

export const EGRESS = Symbol('EGRESS');

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 209_715_200;

export interface EgressModuleConfig {
  EGRESS_ALLOWED_HOSTS?: AllowedHosts | undefined;
  PROVIDER_HTTP_TIMEOUT_MS?: number | undefined;
  PROVIDER_OUTPUT_MAX_BYTES?: number | undefined;
}

export function egressOptionsFrom(config: EgressModuleConfig): EgressOptions {
  return {
    allowedHosts: config.EGRESS_ALLOWED_HOSTS ?? {},
    timeoutMs: config.PROVIDER_HTTP_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
    maxBytes: config.PROVIDER_OUTPUT_MAX_BYTES ?? DEFAULT_MAX_BYTES,
  };
}

export function assertAllowList(allowed: AllowedHosts): void {
  const problems = validateAllowList(allowed);
  if (problems.length > 0) throw new Error(`EGRESS_ALLOWED_HOSTS is not acceptable: ${problems.join('; ')}`);
}

@Module({})
export class EgressModule {
  /** Startup refuses an allow-list that names an IP address or a too-broad wildcard (the config schema checks shape only). */
  static register(config: EgressModuleConfig): DynamicModule {
    const options = egressOptionsFrom(config);
    assertAllowList(options.allowedHosts);
    return {
      module: EgressModule,
      providers: [{ provide: EGRESS, useValue: new Egress(options) }],
      exports: [EGRESS],
    };
  }
}
