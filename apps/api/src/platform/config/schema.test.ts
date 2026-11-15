import { describe, expect, it } from 'vitest';
import { REGISTRY, keysFor, secretKeys } from './registry.js';
import type { KeyDefinition, ProcessKind } from './registry.js';
import { validateConfig, schemaFor } from './schema.js';
import { loadConfigOrExit } from './startup.js';
import { hardened, SENTINEL, validEnv } from './test-env.js';
import type { Env } from './test-env.js';

const KINDS: ProcessKind[] = ['api', 'worker', 'release'];
const requiredKeys = (kind: ProcessKind) =>
  keysFor(kind).filter((key) => (REGISTRY[key] as KeyDefinition).requiredIn?.includes(kind));

class Exited extends Error {
  constructor(readonly code: number) {
    super('exit');
  }
}

function startup(kind: ProcessKind, env: Env) {
  const lines: string[] = [];
  let code: number | undefined;
  try {
    loadConfigOrExit(kind, {
      env,
      stderr: (line) => lines.push(line),
      exit: (c) => {
        throw new Exited(c);
      },
    });
  } catch (error) {
    if (!(error instanceof Exited)) throw error;
    code = error.code;
  }
  return { code, stderr: lines.join('\n') };
}

describe('TC-OPS-02: one startup test per required key', () => {
  for (const kind of KINDS) {
    it(`the ${kind} fixture is valid`, () => {
      expect(validateConfig(kind, validEnv(kind)).ok).toBe(true);
    });
    for (const key of requiredKeys(kind)) {
      it(`${kind}: missing ${key} exits 78 naming only the key`, () => {
        const env = validEnv(kind);
        delete env[key];
        const { code, stderr } = startup(kind, env);
        expect(code).toBe(78);
        expect(stderr).toContain(key);
        for (const value of Object.values(env)) expect(stderr).not.toContain(value);
      });
      const rejectsSentinel = !(REGISTRY[key] as KeyDefinition).type.safeParse(SENTINEL).success;
      it.runIf(rejectsSentinel)(
        `${kind}: invalid ${key} exits 78 naming the key and never the value`,
        () => {
          const env = validEnv(kind, { [key]: SENTINEL });
          const { code, stderr } = startup(kind, env);
          expect(code).toBe(78);
          expect(stderr).toContain(key);
          expect(stderr).not.toContain(SENTINEL);
        },
      );
    }
  }

  it('an empty value counts as missing', () => {
    const result = validateConfig('api', validEnv('api', { CURSOR_SIGNING_KEY: '' }));
    expect(result).toEqual({
      ok: false,
      issues: [{ key: 'CURSOR_SIGNING_KEY', fault: 'missing' }],
    });
  });

  it('reports every faulty key in one pass', () => {
    const env = validEnv('api');
    delete env['WEB_ORIGIN'];
    delete env['DATABASE_URL'];
    const result = validateConfig('api', env);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues.map((i) => i.key).sort()).toEqual(['DATABASE_URL', 'WEB_ORIGIN']);
  });

  it('a missing or unknown APP_ENV is refused', () => {
    expect(validateConfig('api', validEnv('api', { APP_ENV: 'prod' })).ok).toBe(false);
    const env = validEnv('api');
    delete env['APP_ENV'];
    const result = validateConfig('api', env);
    expect(result).toEqual({ ok: false, issues: [{ key: 'APP_ENV', fault: 'missing' }] });
  });

  it('uses process.env, process.stderr and process.exit by default', () => {
    const originalExit = process.exit;
    const originalWrite = process.stderr.write.bind(process.stderr);
    const written: string[] = [];
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Exited(code ?? 0);
    }) as typeof process.exit;
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const saved = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) delete process.env[key];
      expect(() => loadConfigOrExit('api')).toThrow(Exited);
    } finally {
      process.exit = originalExit;
      process.stderr.write = originalWrite;
      Object.assign(process.env, saved);
    }
    expect(exitCode).toBe(78);
    expect(written.join('')).toContain('APP_ENV');
  });
});

describe('per-process secret sets', () => {
  const forbiddenCases: Array<[ProcessKind, string]> = [
    ['api', 'KEK_PRIVATE_KEYS'],
    ['api', 'R2_LEDGER_ACCESS_KEY_ID'],
    ['api', 'R2_LEDGER_SECRET_ACCESS_KEY'],
    ['api', 'MIGRATION_DATABASE_URL'],
    ['worker', 'KEY_FINGERPRINT_PEPPERS'],
    ['worker', 'CURSOR_SIGNING_KEY'],
    ['worker', 'RATE_LIMIT_IP_KEY'],
    ['worker', 'MIGRATION_DATABASE_URL'],
    ['release', 'DATABASE_URL'],
    ['release', 'CLERK_SECRET_KEY'],
  ];
  for (const [kind, key] of forbiddenCases) {
    it(`${kind} refuses ${key}`, () => {
      const result = validateConfig(kind, validEnv(kind, { [key]: SENTINEL }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues).toContainEqual({ key, fault: 'forbidden' });
    });
  }

  it('every secret key has a defined process set, and no process reads another process secrets', () => {
    for (const key of secretKeys())
      expect((REGISTRY[key] as KeyDefinition).processes.length).toBeGreaterThan(0);
    expect(keysFor('worker')).not.toContain('KEY_FINGERPRINT_PEPPERS');
    expect(keysFor('api')).not.toContain('KEK_PRIVATE_KEYS');
  });

  it('the ledger token differs from token B and the ledger bucket from the app bucket', () => {
    const sameBucket = validateConfig('worker', validEnv('worker', { R2_LEDGER_BUCKET: 'app' }));
    expect(sameBucket.ok).toBe(false);
    const sameId = validateConfig(
      'worker',
      validEnv('worker', { R2_LEDGER_ACCESS_KEY_ID: 'tok-key-id-1' }),
    );
    expect(sameId.ok).toBe(false);
    const sameSecret = validateConfig(
      'worker',
      validEnv('worker', { R2_LEDGER_SECRET_ACCESS_KEY: 'tok-secret-1' }),
    );
    expect(sameSecret.ok).toBe(false);
  });
});

describe('owner-register defaults (table test)', () => {
  const table: Array<[ProcessKind, string, unknown, Env]> = [
    ['api', 'SPEND_CAP_DAILY_USD', 50, { SPEND_CAP_DAILY_USD: '60' }],
    ['api', 'SPEND_CAP_MONTHLY_USD', 500, { SPEND_CAP_MONTHLY_USD: '900' }],
    ['api', 'KEY_ENTRY_ATTEMPTS_PER_WINDOW', 5, { KEY_ENTRY_ATTEMPTS_PER_WINDOW: '7' }],
    ['api', 'KEY_ENTRY_WINDOW_MIN', 10, { KEY_ENTRY_WINDOW_MIN: '15' }],
    ['worker', 'KEY_AUTO_DISABLE_THRESHOLD', 5, { KEY_AUTO_DISABLE_THRESHOLD: '6' }],
    ['api', 'JOB_BURST_ALERT_COUNT', 20, { JOB_BURST_ALERT_COUNT: '25' }],
    ['api', 'JOB_BURST_WINDOW_MIN', 10, { JOB_BURST_WINDOW_MIN: '12' }],
    ['worker', 'PROVIDER_AUTH_SPIKE_COUNT', 5, { PROVIDER_AUTH_SPIKE_COUNT: '6' }],
    ['api', 'ASSEMBLY_RENDERS_PER_USER_PER_DAY', 20, { ASSEMBLY_RENDERS_PER_USER_PER_DAY: '30' }],
    ['api', 'INVITE_EMAIL_DOMAINS', [], { INVITE_EMAIL_DOMAINS: 'a.example, b.example' }],
    ['api', 'ERASURE_HOLD_PERIOD_HOURS', 0, { ERASURE_HOLD_PERIOD_HOURS: '48' }],
    ['api', 'MFA_REQUIRED_FOR', 'all', { MFA_REQUIRED_FOR: 'admins' }],
    ['api', 'ACCESS_REQUEST_FORM_ENABLED', false, { ACCESS_REQUEST_FORM_ENABLED: 'true' }],
    ['api', 'OWNER_EMAIL', undefined, { OWNER_EMAIL: 'o@example.test' }],
  ];
  for (const [kind, key, def, override] of table) {
    it(`${kind} ${key}: default ${JSON.stringify(def)} and overridable`, () => {
      const base = validateConfig(kind, validEnv(kind));
      expect(base.ok && (base.config as Record<string, unknown>)[key]).toEqual(def);
      const changed = validateConfig(kind, validEnv(kind, override));
      expect(changed.ok).toBe(true);
      if (changed.ok) expect((changed.config as Record<string, unknown>)[key]).not.toEqual(def);
    });
  }

  it('every registry default parses against its own type, in every process that reads the key', () => {
    for (const kind of KINDS) {
      for (const key of keysFor(kind)) {
        const def = REGISTRY[key] as KeyDefinition;
        if (def.default === undefined) continue;
        expect(def.type.safeParse(def.default).success, `${kind} ${key}`).toBe(true);
      }
    }
  });

  it('a defaulted key set to an invalid value is refused (defaults do not mask bad input)', () => {
    for (const [key, value] of [
      ['SPEND_CAP_DAILY_USD', '-1'],
      ['MFA_REQUIRED_FOR', 'nobody'],
      ['ACCESS_REQUEST_FORM_ENABLED', 'yes'],
      ['INVITE_EMAIL_DOMAINS', 'not a domain'],
      ['ERASURE_HOLD_PERIOD_HOURS', '-3'],
    ] as const) {
      expect(validateConfig('api', validEnv('api', { [key]: value })).ok, key).toBe(false);
    }
  });
});

describe('validation rules', () => {
  const bad = (kind: ProcessKind, overrides: Env, key: string) => {
    const result = validateConfig(kind, validEnv(kind, overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.key)).toContain(key);
  };

  it('range checks', () => {
    bad('api', { API_PORT: '70000' }, 'API_PORT');
    bad('api', { TRUST_PROXY_HOPS: '4' }, 'TRUST_PROXY_HOPS');
    bad('api', { MEDIA_BROWSER_URL_TTL_SEC: '100' }, 'MEDIA_BROWSER_URL_TTL_SEC');
    bad('api', { MEDIA_MAX_UPLOAD_BYTES: '1' }, 'MEDIA_MAX_UPLOAD_BYTES');
    bad('api', { LOG_LEVEL: 'loud' }, 'LOG_LEVEL');
    bad('api', { KEY_FORMAT_OPENAI: 'sk-.*' }, 'KEY_FORMAT_OPENAI');
    bad('api', { KEY_FORMAT_OPENAI: '^(' }, 'KEY_FORMAT_OPENAI');
    bad('api', { EGRESS_ALLOWED_HOSTS: '{"openai":["bad host"]}' }, 'EGRESS_ALLOWED_HOSTS');
    bad('api', { EGRESS_ALLOWED_HOSTS: 'not json' }, 'EGRESS_ALLOWED_HOSTS');
  });

  it('cross-key rules', () => {
    bad(
      'api',
      { SPEND_CAP_DAILY_USD: '100', SPEND_CAP_MONTHLY_USD: '50' },
      'SPEND_CAP_MONTHLY_USD',
    );
    bad('api', { JOB_CREATE_RATE_LIMIT: '20' }, 'JOB_CREATE_RATE_LIMIT');
    bad('api', { REPORT_DEFAULT_WINDOW_DAYS: '400' }, 'REPORT_DEFAULT_WINDOW_DAYS');
    bad(
      'api',
      { REPORT_DEFAULT_WINDOW_DAYS: '90', REPORT_MAX_WINDOW_DAYS: '60' },
      'REPORT_DEFAULT_WINDOW_DAYS',
    );
    bad('api', { KEK_ACTIVE_VERSION: '2' }, 'KEK_ACTIVE_VERSION');
    bad('api', { KEY_FINGERPRINT_PEPPER_ACTIVE: '9' }, 'KEY_FINGERPRINT_PEPPER_ACTIVE');
    bad(
      'worker',
      { KEK_ACTIVE_VERSION: '2', KEK_PUBLIC_KEYS: validEnv('worker')['KEK_PUBLIC_KEYS'] as string },
      'KEK_ACTIVE_VERSION',
    );
    bad('worker', { PROVIDER_HTTP_TIMEOUT_MS: '200000' }, 'SUBMIT_JOB_EXPIRE_SEC');
    bad('worker', { SUBMIT_ORPHAN_AFTER_SEC: '150' }, 'SUBMIT_ORPHAN_AFTER_SEC');
  });

  it('KEK private map must carry the active version; public keys must be RSA 3072', () => {
    const wrongPrivate = JSON.stringify({ '2': validEnv('worker')['KEK_PRIVATE_KEYS'] });
    bad('worker', { KEK_PRIVATE_KEYS: wrongPrivate }, 'KEK_PRIVATE_KEYS');
    bad('api', { KEK_PUBLIC_KEYS: JSON.stringify({ '1': 'not a pem' }) }, 'KEK_PUBLIC_KEYS');
    bad('api', { KEK_PUBLIC_KEYS: '{}' }, 'KEK_PUBLIC_KEYS');
    bad(
      'api',
      { KEY_FINGERPRINT_PEPPERS: JSON.stringify({ '1': 'AAAA' }) },
      'KEY_FINGERPRINT_PEPPERS',
    );
    bad('api', { RATE_LIMIT_IP_KEY: 'short' }, 'RATE_LIMIT_IP_KEY');
  });

  it('shotstack needs its cap and key together; the pair is all-or-nothing otherwise', () => {
    bad('worker', { ASSEMBLY_ADAPTER: 'shotstack' }, 'ASSEMBLY_VENDOR_PLATFORM_CAP');
    bad(
      'worker',
      { ASSEMBLY_ADAPTER: 'shotstack', ASSEMBLY_VENDOR_PLATFORM_CAP: '10' },
      'SHOTSTACK_API_KEY',
    );
    expect(
      validateConfig(
        'worker',
        validEnv('worker', {
          ASSEMBLY_ADAPTER: 'shotstack',
          ASSEMBLY_VENDOR_PLATFORM_CAP: '10',
          SHOTSTACK_API_KEY: 'k',
        }),
      ).ok,
    ).toBe(true);
    bad('worker', { ASSEMBLY_VENDOR_PLATFORM_CAP: '10' }, 'SHOTSTACK_API_KEY');
    bad('worker', { SHOTSTACK_API_KEY: 'k' }, 'ASSEMBLY_VENDOR_PLATFORM_CAP');
  });

  it('STORAGE_PUBLIC_ORIGIN and SENTRY_ENVIRONMENT default from other keys', () => {
    const api = validateConfig('api', validEnv('api'));
    expect(api.ok && api.config.STORAGE_PUBLIC_ORIGIN).toBe('https://r2.example.test');
    expect(api.ok && api.config.SENTRY_ENVIRONMENT).toBe('development');
    const release = validateConfig('release', validEnv('release'));
    expect(release.ok && release.config.SENTRY_ENVIRONMENT).toBeUndefined();
    expect(release.ok && Object.isFrozen(release.config)).toBe(true);
  });

  it('schemaFor yields a Zod schema per process', () => {
    expect(schemaFor('release').safeParse({ APP_ENV: 'test' }).success).toBe(false);
  });
});

describe('staging and production', () => {
  for (const kind of ['api', 'worker', 'release'] as const) {
    it(`${kind} accepts the hardened fixture`, () => {
      const result = validateConfig(kind, validEnv(kind, hardened(kind)));
      expect(result).toMatchObject({ ok: true });
    });
    it(`${kind} requires RELEASE_SHA`, () => {
      const env = validEnv(kind, hardened(kind));
      delete env['RELEASE_SHA'];
      expect(validateConfig(kind, env)).toEqual({
        ok: false,
        issues: [{ key: 'RELEASE_SHA', fault: 'missing' }],
      });
    });
  }

  it('api requires OWNER_EMAIL in production but not in staging', () => {
    const env = validEnv('api', hardened('api'));
    delete env['OWNER_EMAIL'];
    expect(validateConfig('api', env)).toEqual({
      ok: false,
      issues: [{ key: 'OWNER_EMAIL', fault: 'missing' }],
    });
    expect(validateConfig('api', { ...env, APP_ENV: 'staging' }).ok).toBe(true);
  });

  it('api requires a 43+ character METRICS_TOKEN in staging and production only', () => {
    const env = validEnv('api', hardened('api'));
    delete env['METRICS_TOKEN'];
    expect(validateConfig('api', env)).toEqual({
      ok: false,
      issues: [{ key: 'METRICS_TOKEN', fault: 'missing' }],
    });
    expect(validateConfig('api', { ...env, METRICS_TOKEN: 'short' }).ok).toBe(false);
    expect(validateConfig('api', { ...env, APP_ENV: 'development' }).ok).toBe(true);
  });

  it('requires https origins and TLS database URLs', () => {
    const env = validEnv('api', hardened('api'));
    expect(validateConfig('api', { ...env, WEB_ORIGIN: 'http://app.example.test' }).ok).toBe(false);
    expect(
      validateConfig('api', { ...env, DATABASE_URL: 'postgres://u@db.example.test/app' }).ok,
    ).toBe(false);
    expect(
      validateConfig('api', {
        ...env,
        DATABASE_URL: 'postgres://u@db.example.test/app?sslmode=disable',
      }).ok,
    ).toBe(false);
    const release = validEnv('release', hardened('release'));
    expect(
      validateConfig('release', {
        ...release,
        MIGRATION_DATABASE_URL: 'postgres://u@db.example.test/app',
      }).ok,
    ).toBe(false);
  });
});

describe('http object-storage endpoints (local MinIO)', () => {
  const http = 'http://127.0.0.1:9000';
  for (const appEnv of ['development', 'test']) {
    it(`${appEnv}: api and worker accept an http R2_ENDPOINT`, () => {
      for (const kind of ['api', 'worker'] as const) {
        const result = validateConfig(kind, validEnv(kind, { APP_ENV: appEnv, R2_ENDPOINT: http }));
        expect(result).toMatchObject({ ok: true });
      }
    });
    it(`${appEnv}: api accepts an http STORAGE_PUBLIC_ORIGIN`, () => {
      const result = validateConfig(
        'api',
        validEnv('api', { APP_ENV: appEnv, R2_ENDPOINT: http, STORAGE_PUBLIC_ORIGIN: http }),
      );
      expect(result).toMatchObject({ ok: true });
    });
    it(`${appEnv}: STORAGE_PUBLIC_ORIGIN defaults to the http R2_ENDPOINT`, () => {
      const result = validateConfig('api', validEnv('api', { APP_ENV: appEnv, R2_ENDPOINT: http }));
      expect(result).toMatchObject({ ok: true });
      if (result.ok) expect(result.config['STORAGE_PUBLIC_ORIGIN']).toBe(http);
    });
  }

  for (const appEnv of ['staging', 'production']) {
    it(`${appEnv}: rejects http R2_ENDPOINT and STORAGE_PUBLIC_ORIGIN, accepts https`, () => {
      for (const kind of ['api', 'worker'] as const) {
        const env = { ...validEnv(kind, hardened(kind)), APP_ENV: appEnv };
        expect(validateConfig(kind, env).ok).toBe(true);
        expect(validateConfig(kind, { ...env, R2_ENDPOINT: http })).toEqual({
          ok: false,
          issues: [{ key: 'R2_ENDPOINT', fault: 'invalid' }],
        });
      }
      const api = { ...validEnv('api', hardened('api')), APP_ENV: appEnv };
      expect(
        validateConfig('api', { ...api, STORAGE_PUBLIC_ORIGIN: 'https://files.example.test' }).ok,
      ).toBe(true);
      expect(validateConfig('api', { ...api, STORAGE_PUBLIC_ORIGIN: http })).toEqual({
        ok: false,
        issues: [{ key: 'STORAGE_PUBLIC_ORIGIN', fault: 'invalid' }],
      });
    });
  }

  for (const appEnv of ['development', 'test', 'staging', 'production']) {
    it(`${appEnv}: rejects non-http(s) and non-URL values`, () => {
      for (const bad of ['ftp://host/x', 'file:///etc/passwd', 'not a url']) {
        for (const kind of ['api', 'worker'] as const) {
          const env = { ...validEnv(kind, hardened(kind)), APP_ENV: appEnv };
          const r = validateConfig(kind, { ...env, R2_ENDPOINT: bad });
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.issues).toContainEqual({ key: 'R2_ENDPOINT', fault: 'invalid' });
        }
        const api = { ...validEnv('api', hardened('api')), APP_ENV: appEnv };
        const r = validateConfig('api', { ...api, STORAGE_PUBLIC_ORIGIN: bad });
        expect(r.ok).toBe(false);
        if (!r.ok)
          expect(r.issues).toContainEqual({ key: 'STORAGE_PUBLIC_ORIGIN', fault: 'invalid' });
      }
    });
  }
});
