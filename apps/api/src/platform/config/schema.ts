import { isIP } from 'node:net';
import { z } from 'zod';
import { complianceRegister, PROVIDER_VENDORS } from './compliance-register.js';
import type { ComplianceRegister } from './compliance-register.js';
import { APP_ENVS, REGISTRY, keysFor } from './registry.js';
import type { AppEnv, KeyDefinition, ProcessKind, RegistryKey } from './registry.js';

// One schema per process (api, worker, release step). Validation reports key names only: the issues carry
// no value, and nothing downstream reads a Zod message.

export type ConfigFault = 'missing' | 'invalid' | 'forbidden';
export interface ConfigIssue {
  readonly key: string;
  readonly fault: ConfigFault;
}

type RegistryOutput = { [K in RegistryKey]: z.output<(typeof REGISTRY)[K]['type']> };
export type ProcessConfig = Readonly<Partial<RegistryOutput>> &
  Readonly<{ APP_ENV: AppEnv; LOG_LEVEL: z.output<(typeof REGISTRY)['LOG_LEVEL']['type']> }>;

export type ConfigResult =
  | { readonly ok: true; readonly config: ProcessConfig }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

export interface SchemaOptions {
  readonly register?: ComplianceRegister;
}

const SECONDS = 1000;
const GRACE_PRODUCTION = new Set<AppEnv>(['staging', 'production']);

const definition = (key: RegistryKey): KeyDefinition => REGISTRY[key];

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/** The Zod object schema for one process: every key it reads, required or optional per the registry. */
export function schemaFor(kind: ProcessKind): z.ZodType<ProcessConfig> {
  const shape: Record<string, z.ZodType> = {};
  for (const key of keysFor(kind)) {
    const def = definition(key);
    shape[key] = def.requiredIn?.includes(kind) ? def.type : def.type.optional();
  }
  return z.object(shape) as unknown as z.ZodType<ProcessConfig>;
}

/** Apply registry defaults to the raw environment; a configured value always wins. */
function withDefaults(kind: ProcessKind, env: Readonly<Record<string, string | undefined>>) {
  const raw: Record<string, string | undefined> = {};
  for (const key of keysFor(kind)) {
    const value = env[key];
    raw[key] = isPresent(value) ? value : definition(key).default;
  }
  return raw;
}

function mapVersions(map: unknown): Set<string> {
  return new Set(Object.keys((map ?? {}) as Record<string, unknown>));
}

/** The environments that may point the provider calls at a local stand-in. */
const ORIGIN_OVERRIDE_ENVS = new Set<AppEnv>(['development', 'test']);

/**
 * `WORKER_PROVIDER_ORIGIN_OVERRIDE`: refused outside development and test, a bare https origin (no path, query,
 * credentials or port other than 443, a name rather than an IP) whose host is named exactly (no wildcard) by both the
 * `openai` and `wavespeed` entries of `EGRESS_ALLOWED_HOSTS`. The egress layer checks the host again on every call.
 */
function providerOriginCheck(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
  c: Record<string, unknown>,
  fail: (key: string, fault?: ConfigFault) => void,
): void {
  const raw = env['WORKER_PROVIDER_ORIGIN_OVERRIDE'];
  if (!isPresent(raw)) return;
  const key = 'WORKER_PROVIDER_ORIGIN_OVERRIDE';
  if (!ORIGIN_OVERRIDE_ENVS.has(appEnv)) return fail(key, 'forbidden');
  const origin = parseProviderOrigin(raw);
  if (origin === undefined) return fail(key);
  const hosts = (c['EGRESS_ALLOWED_HOSTS'] ?? {}) as Record<string, readonly string[] | undefined>;
  for (const vendor of ['openai', 'wavespeed']) {
    if (!(hosts[vendor] ?? []).some((h) => h.toLowerCase() === origin.hostname)) return fail(key);
  }
}

/** The origin an override value names, or undefined when it is anything more or less than an https host (name, port 443). */
export function parseProviderOrigin(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'https:' ||
    url.username !== '' || url.password !== '' ||
    url.port !== '' ||
    url.search !== '' || url.hash !== '' ||
    (url.pathname !== '/' && url.pathname !== '') ||
    isIP(bare) !== 0 || /^\d+(\.\d+)*$/.test(bare)
  ) return undefined;
  return url;
}

/** Rules that span keys or depend on APP_ENV. Each pushes the key it blames. */
function crossChecks(
  kind: ProcessKind,
  env: Readonly<Record<string, string | undefined>>,
  c: Record<string, unknown>,
  register: ComplianceRegister,
  fail: (key: string, fault?: ConfigFault) => void,
): void {
  const appEnv = c['APP_ENV'] as AppEnv;
  const hardened = GRACE_PRODUCTION.has(appEnv);
  const isSet = (key: string) => isPresent(env[key]);
  const num = (key: string) => c[key] as number | undefined;

  if (hardened && !isSet('RELEASE_SHA')) fail('RELEASE_SHA', 'missing');
  const https = (key: string) => {
    const raw = env[key];
    if (hardened && isPresent(raw) && !raw.startsWith('https://')) fail(key);
  };

  if (kind !== 'release') {
    https('WEB_ORIGIN');
    https('R2_ENDPOINT');
    if (hardened && isPresent(env['DATABASE_URL'])) {
      const mode = new URL(env['DATABASE_URL']).searchParams.get('sslmode');
      if (mode === null || !['require', 'verify-ca', 'verify-full'].includes(mode))
        fail('DATABASE_URL');
    }
    const publicKeys = mapVersions(c['KEK_PUBLIC_KEYS']);
    const active = c['KEK_ACTIVE_VERSION'];
    if (active !== undefined && !publicKeys.has(String(active))) fail('KEK_ACTIVE_VERSION');
    if (kind === 'worker' && c['KEK_PRIVATE_KEYS'] !== undefined) {
      const privateKeys = mapVersions(c['KEK_PRIVATE_KEYS']);
      if (active !== undefined && !privateKeys.has(String(active))) fail('KEK_PRIVATE_KEYS');
    }
  }
  if (hardened && kind === 'release' && isPresent(env['MIGRATION_DATABASE_URL'])) {
    const mode = new URL(env['MIGRATION_DATABASE_URL']).searchParams.get('sslmode');
    if (mode === null || !['require', 'verify-ca', 'verify-full'].includes(mode))
      fail('MIGRATION_DATABASE_URL');
  }

  if (kind === 'api') {
    https('STORAGE_PUBLIC_ORIGIN');
    if (appEnv === 'production' && !isSet('OWNER_EMAIL')) fail('OWNER_EMAIL', 'missing');
    if (hardened && !isSet('METRICS_TOKEN')) fail('METRICS_TOKEN', 'missing');
    const peppers = mapVersions(c['KEY_FINGERPRINT_PEPPERS']);
    const pepperActive = c['KEY_FINGERPRINT_PEPPER_ACTIVE'];
    if (pepperActive !== undefined && !peppers.has(String(pepperActive)))
      fail('KEY_FINGERPRINT_PEPPER_ACTIVE');
    const daily = num('SPEND_CAP_DAILY_USD');
    const monthly = num('SPEND_CAP_MONTHLY_USD');
    if (daily !== undefined && monthly !== undefined && monthly < daily)
      fail('SPEND_CAP_MONTHLY_USD');
    const rate = num('JOB_CREATE_RATE_LIMIT');
    const burst = num('JOB_BURST_ALERT_COUNT');
    if (rate !== undefined && burst !== undefined && rate <= burst) fail('JOB_CREATE_RATE_LIMIT');
    const defaultWindow = num('REPORT_DEFAULT_WINDOW_DAYS');
    const maxWindow = num('REPORT_MAX_WINDOW_DAYS');
    if (defaultWindow !== undefined && maxWindow !== undefined && defaultWindow > maxWindow) {
      fail('REPORT_DEFAULT_WINDOW_DAYS');
    }
  }

  if (kind === 'worker') {
    providerOriginCheck(appEnv, env, c, fail);
    if (env['R2_LEDGER_BUCKET'] !== undefined && env['R2_LEDGER_BUCKET'] === env['R2_BUCKET']) {
      fail('R2_LEDGER_BUCKET');
    }
    if (
      isSet('R2_LEDGER_ACCESS_KEY_ID') &&
      env['R2_LEDGER_ACCESS_KEY_ID'] === env['R2_ACCESS_KEY_ID']
    ) {
      fail('R2_LEDGER_ACCESS_KEY_ID');
    }
    if (
      isSet('R2_LEDGER_SECRET_ACCESS_KEY') &&
      env['R2_LEDGER_SECRET_ACCESS_KEY'] === env['R2_SECRET_ACCESS_KEY']
    ) {
      fail('R2_LEDGER_SECRET_ACCESS_KEY');
    }
    const timeoutSec = (num('PROVIDER_HTTP_TIMEOUT_MS') ?? 0) / SECONDS;
    const expire = num('SUBMIT_JOB_EXPIRE_SEC') ?? 0;
    const orphan = num('SUBMIT_ORPHAN_AFTER_SEC') ?? 0;
    if (!(timeoutSec < expire)) fail('SUBMIT_JOB_EXPIRE_SEC');
    if (!(expire < orphan)) fail('SUBMIT_ORPHAN_AFTER_SEC');
    if (c['ASSEMBLY_ADAPTER'] === 'shotstack') {
      if (!isSet('ASSEMBLY_VENDOR_PLATFORM_CAP')) fail('ASSEMBLY_VENDOR_PLATFORM_CAP', 'missing');
      if (!isSet('SHOTSTACK_API_KEY')) fail('SHOTSTACK_API_KEY', 'missing');
    } else {
      if (isSet('ASSEMBLY_VENDOR_PLATFORM_CAP') !== isSet('SHOTSTACK_API_KEY')) {
        fail(
          isSet('SHOTSTACK_API_KEY') ? 'ASSEMBLY_VENDOR_PLATFORM_CAP' : 'SHOTSTACK_API_KEY',
          'missing',
        );
      }
    }
    for (const vendor of PROVIDER_VENDORS) {
      const key = `PROVIDER_DATA_MODE_${vendor}`;
      if (c[key] === 'real' && !register.hasRecordedContract(vendor)) fail(key);
    }
    for (const key of Object.keys(env)) {
      const match = /^PROVIDER_DATA_MODE_(.+)$/.exec(key);
      if (
        match !== null &&
        !(PROVIDER_VENDORS as readonly string[]).includes(match[1] ?? '') &&
        isSet(key)
      ) {
        fail(key);
      }
    }
  }
}

/**
 * Validate the environment for one process. Pure: takes the environment as data, returns key names only.
 * A secret key set in a process that does not read it is refused (per-process secret sets).
 */
export function validateConfig(
  kind: ProcessKind,
  env: Readonly<Record<string, string | undefined>>,
  options: SchemaOptions = {},
): ConfigResult {
  const issues = new Map<string, ConfigFault>();
  const fail = (key: string, fault: ConfigFault = 'invalid') => {
    if (!issues.has(key)) issues.set(key, fault);
  };
  const register = options.register ?? complianceRegister;

  const appEnvRaw = env['APP_ENV'];
  const appEnvOk = (APP_ENVS as readonly string[]).includes(appEnvRaw ?? '');

  for (const [key, raw] of Object.entries(REGISTRY)) {
    const def = raw as KeyDefinition;
    if (def.class === 'secret' && !def.processes.includes(kind) && isPresent(env[key])) {
      fail(key, 'forbidden');
    }
  }

  const parsed = schemaFor(kind).safeParse(
    withDefaults(kind, { ...env, APP_ENV: appEnvOk ? appEnvRaw : undefined }),
  );
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? 'APP_ENV');
      fail(key, isPresent(env[key]) ? 'invalid' : 'missing');
    }
  } else if (issues.size === 0) {
    const c = { ...parsed.data } as Record<string, unknown>;
    if (kind === 'api' && c['STORAGE_PUBLIC_ORIGIN'] === undefined)
      c['STORAGE_PUBLIC_ORIGIN'] = c['R2_ENDPOINT'];
    if (c['SENTRY_ENVIRONMENT'] === undefined && kind !== 'release')
      c['SENTRY_ENVIRONMENT'] = c['APP_ENV'];
    crossChecks(kind, env, c, register, fail);
    if (issues.size === 0)
      return { ok: true, config: Object.freeze(c) as unknown as ProcessConfig };
  }
  if (!appEnvOk && !issues.has('APP_ENV'))
    fail('APP_ENV', isPresent(appEnvRaw) ? 'invalid' : 'missing');
  return { ok: false, issues: [...issues].map(([key, fault]) => ({ key, fault })) };
}
