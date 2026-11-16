import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { KEY_WRAP_PORT } from './domain/key-wrap.js';
import { SealedEnvelopeKeyWrap } from './infrastructure/sealed-envelope.js';

/**
 * Provider keys, part 1: the seal side of KeyWrapPort, bound in both processes from `KEK_PUBLIC_KEYS` and
 * `KEK_ACTIVE_VERSION`. The unsealer is deliberately not here: `bootstrap/worker.module.ts` binds it (layer rule L3).
 * Fails at construction, so the process does not start, when the maps are unreadable or not RSA-3072.
 */
@Module({})
export class ProviderKeysModule {
  static register(
    env: Readonly<Record<string, string | undefined>>,
    role: 'api' | 'worker',
  ): DynamicModule {
    if (role === 'api' && env['KEK_PRIVATE_KEYS'] !== undefined) {
      throw new Error('KEK_PRIVATE_KEYS must be absent in the api process');
    }
    return {
      module: ProviderKeysModule,
      providers: [{ provide: KEY_WRAP_PORT, useValue: SealedEnvelopeKeyWrap.fromEnv(env) }],
      exports: [KEY_WRAP_PORT],
    };
  }
}
