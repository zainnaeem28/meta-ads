import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { DATABASE } from '../../platform/db/index.js';
import type { Database } from '../../platform/db/index.js';
import { RateLimiter } from '../../platform/rate-limit/index.js';
import {
  FINGERPRINTER,
  IN_FLIGHT_JOB_READER,
  KEY_ENTRY_LIMITER,
  KEY_EVENT_REPOSITORY,
  KEY_POLICY,
  PROVIDER_KEY_REPOSITORY,
} from './application/ports.js';
import type { InFlightJobReader } from './application/ports.js';
import { ProviderKeysService } from './application/provider-keys.service.js';
import { KEY_WRAP_PORT } from './domain/key-wrap.js';
import { PROVIDER_PROBE_PORT } from './domain/provider-probe.js';
import { NoJobsInFlight } from './infrastructure/in-flight.js';
import { fingerprinterFromEnv, keyPolicyFromEnv } from './infrastructure/key-config.js';
import { EgressProviderProbe } from './infrastructure/provider-probe.js';
import { DrizzleKeyEventRepository, DrizzleProviderKeyRepository } from './infrastructure/provider-keys.repositories.js';
import { SealedEnvelopeKeyWrap } from './infrastructure/sealed-envelope.js';
import { KEY_EVENT_CURSOR_KEY, ProviderKeysController, cursorKeyFrom } from './transport/provider-keys.controller.js';

/**
 * What the api composition root passes in when a database is configured: the audit module instance (the trail is layer
 * 1) and the egress module instance (the probe's only way out), and optionally the reader of jobs in flight that brief
 * and production provide.
 */
export interface ProviderKeysEdge {
  readonly audit: DynamicModule;
  readonly egress: DynamicModule;
  readonly inFlight?: InFlightJobReader;
}

/**
 * Provider keys. Both processes bind the seal side of KeyWrapPort from `KEK_PUBLIC_KEYS` and `KEK_ACTIVE_VERSION`; the
 * unsealer is deliberately not here: `bootstrap/worker.module.ts` binds it (layer rule L3). Fails at construction, so
 * the process does not start, when the maps are unreadable or not RSA-3072. With `edge` (api, database present) it also
 * serves API-010 to API-013.
 */
@Module({})
export class ProviderKeysModule {
  static register(
    env: Readonly<Record<string, string | undefined>>,
    role: 'api' | 'worker',
    edge?: ProviderKeysEdge,
  ): DynamicModule {
    if (role === 'api' && env['KEK_PRIVATE_KEYS'] !== undefined) {
      throw new Error('KEK_PRIVATE_KEYS must be absent in the api process');
    }
    const seal: Provider = { provide: KEY_WRAP_PORT, useValue: SealedEnvelopeKeyWrap.fromEnv(env) };
    if (role !== 'api' || edge === undefined) {
      return { module: ProviderKeysModule, providers: [seal], exports: [KEY_WRAP_PORT] };
    }
    return {
      module: ProviderKeysModule,
      imports: [edge.audit, edge.egress],
      providers: [
        seal,
        { provide: KEY_POLICY, useValue: keyPolicyFromEnv(env) },
        { provide: FINGERPRINTER, useValue: fingerprinterFromEnv(env) },
        { provide: PROVIDER_KEY_REPOSITORY, useClass: DrizzleProviderKeyRepository },
        { provide: KEY_EVENT_REPOSITORY, useClass: DrizzleKeyEventRepository },
        { provide: IN_FLIGHT_JOB_READER, useValue: edge.inFlight ?? new NoJobsInFlight() },
        { provide: KEY_ENTRY_LIMITER, useFactory: (database: Database) => new RateLimiter(database.db), inject: [DATABASE] },
        { provide: PROVIDER_PROBE_PORT, useClass: EgressProviderProbe },
        { provide: KEY_EVENT_CURSOR_KEY, useFactory: () => cursorKeyFrom(env) },
        ProviderKeysService,
      ],
      controllers: [ProviderKeysController],
      exports: [KEY_WRAP_PORT, ProviderKeysService, IN_FLIGHT_JOB_READER],
    };
  }
}
