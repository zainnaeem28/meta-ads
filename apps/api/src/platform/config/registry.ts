import { z } from 'zod';
import {
  anchoredRegex,
  anyUrl,
  base64Min32,
  bool,
  decimal,
  domainList,
  egressHosts,
  email,
  httpsUrl,
  int,
  logLevel,
  nonEmpty,
  pathSafe,
  postgresUrl,
  privatePem,
  rsaPublicPem,
  secretMin32,
  versionedMap,
} from './fields.js';
import { PROVIDER_VENDORS } from './compliance-register.js';

// ARCHITECTURE section 6: every application key with its type, the processes that read it, the processes that
// must have it, its default and its class. Values are never part of this file except owner-register defaults.

export const PROCESS_KINDS = ['api', 'worker', 'release'] as const;
export type ProcessKind = (typeof PROCESS_KINDS)[number];

export const APP_ENVS = ['development', 'test', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export type KeyClass = 'public' | 'secret';

export interface KeyDefinition {
  readonly type: z.ZodType;
  /** Processes that read the key. A secret set in any other process is refused at startup. */
  readonly processes: readonly ProcessKind[];
  /** Processes that fail to start without it (conditional requirements live in cross-checks). */
  readonly requiredIn?: readonly ProcessKind[];
  /** Raw string default, parsed by `type` like any configured value. */
  readonly default?: string;
  readonly class: KeyClass;
}

const ALL: readonly ProcessKind[] = ['api', 'worker', 'release'];
const A: readonly ProcessKind[] = ['api'];
const W: readonly ProcessKind[] = ['worker'];
const AW: readonly ProcessKind[] = ['api', 'worker'];
const R: readonly ProcessKind[] = ['release'];

const pub = <T extends z.ZodType>(
  type: T,
  processes: readonly ProcessKind[],
  rest: Partial<Pick<KeyDefinition, 'requiredIn' | 'default'>> = {},
): KeyDefinition & { readonly type: T } => ({ type, processes, class: 'public', ...rest });
const secret = <T extends z.ZodType>(
  type: T,
  processes: readonly ProcessKind[],
  rest: Partial<Pick<KeyDefinition, 'requiredIn' | 'default'>> = {},
): KeyDefinition & { readonly type: T } => ({ type, processes, class: 'secret', ...rest });

const positive = int(1);
const positiveDecimal = decimal(0, Number.MAX_VALUE, true);

const en = (values: readonly string[]) => z.enum(values as [string, ...string[]]);

const vendorModeKeys = Object.fromEntries(
  PROVIDER_VENDORS.map((vendor) => [
    `PROVIDER_DATA_MODE_${vendor}`,
    pub(en(['synthetic', 'real']), W, { default: 'synthetic' }),
  ]),
) as Record<
  `PROVIDER_DATA_MODE_${(typeof PROVIDER_VENDORS)[number]}`,
  ReturnType<typeof pub<ReturnType<typeof en>>>
>;

export const REGISTRY = {
  APP_ENV: pub(en([...APP_ENVS]), ALL, { requiredIn: ALL }),
  RELEASE_SHA: pub(z.string().regex(/^[0-9a-f]{7,40}$/i), ALL),
  API_PORT: pub(int(1, 65535), A, { default: '4000' }),
  WEB_ORIGIN: pub(anyUrl, A, { requiredIn: A }),
  TRUST_PROXY_HOPS: pub(int(0, 3), A, { default: '1' }),
  LOG_LEVEL: pub(logLevel, ALL, { default: 'info' }),
  DATABASE_URL: secret(postgresUrl, AW, { requiredIn: AW }),
  MIGRATION_DATABASE_URL: secret(postgresUrl, R, { requiredIn: R }),
  DATABASE_POOL_MAX: pub(int(1, 50), AW, { default: '10' }),
  DATABASE_ACQUIRE_TIMEOUT_MS: pub(int(100, 30000), AW, { default: '5000' }),
  CLERK_SECRET_KEY: secret(z.string().regex(/^sk_.+/), AW, { requiredIn: AW }),
  CLERK_JWT_ISSUER: pub(httpsUrl, A, { requiredIn: A }),
  OWNER_EMAIL: pub(email, A),
  MFA_REQUIRED_FOR: pub(en(['all', 'admins']), A, { default: 'all' }),
  RECENT_AUTH_MAX_AGE_MIN: pub(int(1, 60), A, { default: '10' }),
  INVITE_EMAIL_DOMAINS: pub(domainList, A, { default: '' }),
  INVITE_EXPIRY_DAYS: pub(int(1, 30), A, { default: '7' }),
  ACCESS_REQUEST_FORM_ENABLED: pub(bool, A, { default: 'false' }),
  SIGNUP_OPEN_EMAIL_VERIFICATION: pub(bool, A, { default: 'false' }),
  SIGNUP_OPEN_RATE_LIMIT: pub(bool, A, { default: 'false' }),
  SIGNUP_OPEN_ABUSE_LIMITS: pub(bool, A, { default: 'false' }),
  KEK_PUBLIC_KEYS: pub(versionedMap(rsaPublicPem), AW, { requiredIn: AW }),
  KEK_ACTIVE_VERSION: pub(int(1), AW, { requiredIn: AW }),
  KEK_PRIVATE_KEYS: secret(versionedMap(privatePem), W, { requiredIn: W }),
  KEY_FINGERPRINT_PEPPERS: secret(versionedMap(base64Min32), A, { requiredIn: A }),
  KEY_FINGERPRINT_PEPPER_ACTIVE: pub(int(1), A, { requiredIn: A }),
  KEY_ENTRY_ATTEMPTS_PER_WINDOW: pub(int(1, 50), A, { default: '5' }),
  KEY_ENTRY_WINDOW_MIN: pub(int(1, 60), A, { default: '10' }),
  KEY_AUTO_DISABLE_THRESHOLD: pub(int(1, 20), W, { default: '5' }),
  KEY_FORMAT_OPENAI: pub(anchoredRegex, A, { default: '^sk-[A-Za-z0-9_-]{20,}$' }),
  KEY_FORMAT_WAVESPEED: pub(anchoredRegex, A, { default: '^[A-Za-z0-9_-]{20,}$' }),
  PROBE_TIMEOUT_MS: pub(int(1000, 10000), A, { default: '5000' }),
  R2_ENDPOINT: pub(anyUrl, AW, { requiredIn: AW }),
  R2_BUCKET: pub(nonEmpty, AW, { requiredIn: AW }),
  R2_ACCESS_KEY_ID: secret(nonEmpty, AW, { requiredIn: AW }),
  R2_SECRET_ACCESS_KEY: secret(nonEmpty, AW, { requiredIn: AW }),
  R2_LEDGER_BUCKET: pub(nonEmpty, W, { requiredIn: W }),
  R2_LEDGER_ACCESS_KEY_ID: secret(nonEmpty, W, { requiredIn: W }),
  R2_LEDGER_SECRET_ACCESS_KEY: secret(nonEmpty, W, { requiredIn: W }),
  STORAGE_PUBLIC_ORIGIN: pub(anyUrl, A),
  MEDIA_MAX_UPLOAD_BYTES: pub(int(10485760, 10485760), A, { default: '10485760' }),
  MEDIA_MAX_PIXEL_DIMENSION: pub(positive, W, { default: '8000' }),
  MEDIA_MAX_PIXELS: pub(positive, W, { default: '40000000' }),
  MEDIA_BROWSER_URL_TTL_SEC: pub(int(300, 900), A, { default: '300' }),
  PROVIDER_FETCH_URL_TTL_SEC: pub(int(600, 7200), W, { default: '3600' }),
  MEDIA_UNATTACHED_TTL_HOURS: pub(int(1, 168), W, { default: '24' }),
  STORAGE_QUOTA_BYTES: pub(positive, A, { default: '21474836480' }),
  SPEND_CAP_DAILY_USD: pub(positiveDecimal, A, { default: '50' }),
  SPEND_CAP_MONTHLY_USD: pub(positiveDecimal, A, { default: '500' }),
  JOB_BURST_ALERT_COUNT: pub(positive, A, { default: '20' }),
  JOB_BURST_WINDOW_MIN: pub(positive, A, { default: '10' }),
  PROVIDER_AUTH_SPIKE_COUNT: pub(positive, W, { default: '5' }),
  PROVIDER_AUTH_SPIKE_WINDOW_MIN: pub(positive, W, { default: '10' }),
  JOB_CREATE_RATE_LIMIT: pub(positive, A, { default: '60' }),
  JOB_CREATE_RATE_WINDOW_MIN: pub(positive, A, { default: '10' }),
  RATE_LIMIT_IP_KEY: secret(secretMin32, A, { requiredIn: A }),
  RUNNING_JOBS_PER_USER: pub(int(1, 20), W, { default: '5' }),
  ASSEMBLY_RENDERS_PER_USER_PER_DAY: pub(int(1, 200), A, { default: '20' }),
  ASSEMBLY_ADAPTER: pub(en(['ffmpeg', 'shotstack']), W, { default: 'ffmpeg' }),
  ASSEMBLY_VENDOR_PLATFORM_CAP: pub(positiveDecimal, W),
  SHOTSTACK_API_KEY: secret(nonEmpty, W),
  ASSEMBLY_CONCURRENCY: pub(int(1, 4), W, { default: '1' }),
  THUMBSTOPPER_FRAME_SECONDS: pub(decimal(0.5, 5), W, { default: '1.5' }),
  PROVIDER_HTTP_TIMEOUT_MS: pub(positive, W, { default: '120000' }),
  SUBMIT_JOB_EXPIRE_SEC: pub(positive, W, { default: '150' }),
  SUBMIT_ORPHAN_AFTER_SEC: pub(positive, W, { default: '300' }),
  POLL_INTERVAL_SEC: pub(int(2), W, { default: '5' }),
  POLL_LEASE_SEC: pub(int(2), W, { default: '60' }),
  VIDEO_JOB_DEADLINE_MIN: pub(int(5, 180), W, { default: '30' }),
  PROVIDER_OUTPUT_COPY_WINDOW_HOURS: pub(int(1, 72), W, { default: '24' }),
  INVITATION_SEND_STALE_MIN: pub(int(5, 1440), W, { default: '15' }),
  PROVIDER_OUTPUT_MAX_BYTES: pub(positive, W, { default: '209715200' }),
  EGRESS_ALLOWED_HOSTS: pub(egressHosts, AW, {
    default: '{"openai":["api.openai.com"],"wavespeed":["api.wavespeed.ai"]}',
  }),
  WAVESPEED_MODEL_I2V: pub(pathSafe, W, { default: 'bytedance/seedance-2.0/image-to-video' }),
  WAVESPEED_MODEL_T2V: pub(pathSafe, W, { default: 'bytedance/seedance-2.0/text-to-video' }),
  VIDEO_RESOLUTION: pub(en(['480p', '720p', '1080p']), W, { default: '1080p' }),
  VIDEO_ASPECT_RATIO: pub(en(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']), W, {
    default: '9:16',
  }),
  VIDEO_SEGMENT_SECONDS: pub(int(1, 15), W, { default: '15' }),
  OPENAI_TEXT_MODEL: pub(nonEmpty, W),
  OPENAI_VISION_MODEL: pub(nonEmpty, W),
  OPENAI_TRANSCRIBE_MODEL: pub(nonEmpty, W, { default: 'gpt-transcribe' }),
  OPENAI_IMAGE_MODEL: pub(nonEmpty, W),
  QC_MAX_WORD_ERROR_RATE: pub(decimal(0, 1), W, { default: '0.20' }),
  IDEMPOTENCY_TTL_HOURS: pub(int(1, 168), A, { default: '24' }),
  CURSOR_SIGNING_KEY: secret(secretMin32, A, { requiredIn: A }),
  REPORT_DEFAULT_WINDOW_DAYS: pub(int(1, 366), A, { default: '30' }),
  REPORT_MAX_WINDOW_DAYS: pub(int(1, 366), A, { default: '366' }),
  ERASURE_HOLD_PERIOD_HOURS: pub(int(0), A, { default: '0' }),
  DELETION_RETRY_LIMIT: pub(int(1, 50), W, { default: '10' }),
  WORKER_WATCHDOG_SECONDS: pub(positive, W, { default: '180' }),
  WORKER_DRAIN_SECONDS: pub(int(1, 29), W, { default: '25' }),
  API_DRAIN_SECONDS: pub(int(1, 29), A, { default: '20' }),
  WORKER_CONCURRENCY_PROVIDER: pub(positive, W, { default: '20' }),
  WORKER_CONCURRENCY_SANITIZE: pub(positive, W, { default: '2' }),
  WORKER_CONCURRENCY_DELETION: pub(positive, W, { default: '2' }),
  ...vendorModeKeys,
  HEARTBEAT_URL_WORKER: secret(httpsUrl, W),
  METRICS_TOKEN: secret(z.string().min(43), A),
  SENTRY_DSN: secret(httpsUrl, AW),
  SENTRY_ENVIRONMENT: pub(z.string().regex(/^[a-z0-9-]{1,32}$/), AW),
  SENTRY_ERRORS_SAMPLE_RATE: pub(decimal(0, 1), AW, { default: '1.0' }),
  SENTRY_TRACES_SAMPLE_RATE: pub(decimal(0, 1), AW, { default: '0' }),
} as const satisfies Record<string, KeyDefinition>;

export type RegistryKey = keyof typeof REGISTRY;

export function keysFor(kind: ProcessKind): RegistryKey[] {
  return (Object.keys(REGISTRY) as RegistryKey[]).filter((key) =>
    (REGISTRY[key] as KeyDefinition).processes.includes(kind),
  );
}

export function secretKeys(): RegistryKey[] {
  return (Object.keys(REGISTRY) as RegistryKey[]).filter(
    (key) => (REGISTRY[key] as KeyDefinition).class === 'secret',
  );
}
