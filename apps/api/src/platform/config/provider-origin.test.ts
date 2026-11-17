import { describe, expect, it } from 'vitest';
import { providerOriginOf } from '../../bootstrap/worker.module.js';
import { Egress } from '../egress/egress.js';
import { validateConfig } from './schema.js';
import { hardened, validEnv } from './test-env.js';
import type { Env } from './test-env.js';

const KEY = 'WORKER_PROVIDER_ORIGIN_OVERRIDE';
const STUB = 'provider-stubs.test';
const ALLOWED = JSON.stringify({ openai: ['api.openai.com', STUB], wavespeed: ['api.wavespeed.ai', STUB] });
const worker = (extra: Env): Env => ({ ...validEnv('worker'), EGRESS_ALLOWED_HOSTS: ALLOWED, ...extra });

describe('WORKER_PROVIDER_ORIGIN_OVERRIDE (startup config)', () => {
  it.each(['development', 'test'])('is honoured in %s when the host is allow-listed for both providers', (appEnv) => {
    const result = validateConfig('worker', worker({ APP_ENV: appEnv, [KEY]: `https://${STUB}` }));
    expect(result.ok).toBe(true);
  });

  it.each(['staging', 'production'])('is refused in %s', (appEnv) => {
    const base = { ...validEnv('worker'), ...hardened('worker'), APP_ENV: appEnv, EGRESS_ALLOWED_HOSTS: ALLOWED };
    expect(validateConfig('worker', base).ok).toBe(true);
    const result = validateConfig('worker', { ...base, [KEY]: `https://${STUB}` });
    expect(result).toEqual({ ok: false, issues: [{ key: KEY, fault: 'forbidden' }] });
  });

  const wild = JSON.stringify({ openai: ['api.openai.com', STUB, '*.stubs.test'], wavespeed: ['api.wavespeed.ai', STUB, '*.stubs.test'] });
  it.each([
    ['a host that is not allow-listed', 'https://evil.example.com'],
    ['a wildcard-only match', 'https://x.stubs.test'],
    ['http', `http://${STUB}`],
    ['a path', `https://${STUB}/redirect`],
    ['a non-443 port', `https://${STUB}:8443`],
    ['credentials', `https://u:p@${STUB}`],
    ['an IP literal', 'https://127.0.0.1'],
  ])('refuses %s', (_name, value) => {
    expect(validateConfig('worker', worker({ APP_ENV: 'test', EGRESS_ALLOWED_HOSTS: wild, [KEY]: value })).ok).toBe(false);
  });

  it('refuses a host allow-listed for only one provider', () => {
    const only = JSON.stringify({ openai: ['api.openai.com', STUB], wavespeed: ['api.wavespeed.ai'] });
    expect(validateConfig('worker', worker({ APP_ENV: 'test', EGRESS_ALLOWED_HOSTS: only, [KEY]: `https://${STUB}` })).ok).toBe(false);
  });
});

describe('providerOriginOf (worker composition root)', () => {
  const allowed = { openai: ['api.openai.com', STUB], wavespeed: ['api.wavespeed.ai', STUB] };
  it('returns the origin in test, nothing when unset', () => {
    expect(providerOriginOf({ APP_ENV: 'test', EGRESS_ALLOWED_HOSTS: allowed, WORKER_PROVIDER_ORIGIN_OVERRIDE: `https://${STUB}` } as never)).toBe(`https://${STUB}`);
    expect(providerOriginOf({ APP_ENV: 'production' } as never)).toBeUndefined();
  });
  it('throws in production and for a host off the allow-list', () => {
    expect(() => providerOriginOf({ APP_ENV: 'production', EGRESS_ALLOWED_HOSTS: allowed, WORKER_PROVIDER_ORIGIN_OVERRIDE: `https://${STUB}` } as never)).toThrow(/refused/);
    expect(() => providerOriginOf({ APP_ENV: 'test', EGRESS_ALLOWED_HOSTS: allowed, WORKER_PROVIDER_ORIGIN_OVERRIDE: 'https://evil.example.com' } as never)).toThrow(/EGRESS_ALLOWED_HOSTS/);
  });
});

describe('the egress layer still enforces the allow-list on an overridden origin', () => {
  it('refuses a host the list does not name', async () => {
    const egress = new Egress({ allowedHosts: { wavespeed: ['api.wavespeed.ai'] }, timeoutMs: 1000, maxBytes: 1000 });
    await expect(egress.fetch('wavespeed', { url: `https://${STUB}/v1/x` })).rejects.toMatchObject({ reason: 'host_not_allowed' });
  });
});

describe('createWorkerApp (the real composition root) reads the setting', () => {
  const base = {
    DATABASE_URL: 'postgres://u@localhost:1/none',
    DATABASE_POOL_MAX: 1,
    DATABASE_ACQUIRE_TIMEOUT_MS: 100,
    EGRESS_ALLOWED_HOSTS: { openai: ['api.openai.com', STUB], wavespeed: ['api.wavespeed.ai', STUB] },
    WORKER_PROVIDER_ORIGIN_OVERRIDE: `https://${STUB}`,
  };
  const options = { logger: { info: () => undefined } as never, env: {}, exit: () => undefined };

  it.each(['production', 'staging'] as const)('stops the start-up in %s before anything is built', async (APP_ENV) => {
    const { createWorkerApp } = await import('../../bootstrap/worker.module.js');
    await expect(createWorkerApp({ ...base, APP_ENV } as never, options)).rejects.toThrow(/WORKER_PROVIDER_ORIGIN_OVERRIDE is refused/);
  });

  it('stops the start-up for a host the allow-list does not name', async () => {
    const { createWorkerApp } = await import('../../bootstrap/worker.module.js');
    const config = { ...base, APP_ENV: 'test', EGRESS_ALLOWED_HOSTS: { openai: ['api.openai.com'], wavespeed: ['api.wavespeed.ai'] } };
    await expect(createWorkerApp(config as never, options)).rejects.toThrow(/EGRESS_ALLOWED_HOSTS/);
  });
});
