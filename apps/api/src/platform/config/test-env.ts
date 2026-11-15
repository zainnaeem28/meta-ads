import { generateKeyPairSync } from 'node:crypto';

// Test fixtures: a complete valid environment per process, with throwaway key material generated at load.

const rsa = generateKeyPairSync('rsa', { modulusLength: 3072 });
const PUBLIC_PEM = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const PRIVATE_PEM = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

export const SENTINEL = 'bad-sentinel-1';
const b64 = (seed: string) => Buffer.alloc(32, seed).toString('base64');

export type Env = Record<string, string>;

const common: Env = {
  APP_ENV: 'development',
  KEK_PUBLIC_KEYS: JSON.stringify({ '1': PUBLIC_PEM }),
  KEK_ACTIVE_VERSION: '1',
  R2_ENDPOINT: 'https://r2.example.test',
  R2_BUCKET: 'app',
  R2_ACCESS_KEY_ID: 'tok-key-id-1',
  R2_SECRET_ACCESS_KEY: 'tok-secret-1',
  CLERK_SECRET_KEY: 'sk_test_fixture',
};

export function validEnv(kind: 'api' | 'worker' | 'release', overrides: Env = {}): Env {
  const base: Env =
    kind === 'api'
      ? {
          ...common,
          DATABASE_URL: 'postgres://app_api@localhost:5432/app',
          WEB_ORIGIN: 'http://localhost:3000',
          CLERK_JWT_ISSUER: 'https://clerk.example.test',
          KEY_FINGERPRINT_PEPPERS: JSON.stringify({ '1': b64('p') }),
          KEY_FINGERPRINT_PEPPER_ACTIVE: '1',
          RATE_LIMIT_IP_KEY: 'r'.repeat(40),
          CURSOR_SIGNING_KEY: 'c'.repeat(40),
        }
      : kind === 'worker'
        ? {
            ...common,
            DATABASE_URL: 'postgres://app_worker@localhost:5432/app',
            KEK_PRIVATE_KEYS: JSON.stringify({ '1': PRIVATE_PEM }),
            R2_LEDGER_BUCKET: 'ledger',
            R2_LEDGER_ACCESS_KEY_ID: 'tok-key-id-3',
            R2_LEDGER_SECRET_ACCESS_KEY: 'tok-secret-3',
          }
        : {
            APP_ENV: 'development',
            MIGRATION_DATABASE_URL: 'postgres://migrator@localhost:5432/app',
          };
  return { ...base, ...overrides };
}

/** Staging/production additions the hardened environments require. */
export const hardened = (kind: 'api' | 'worker' | 'release'): Env => ({
  APP_ENV: 'production',
  RELEASE_SHA: 'abcdef1234567',
  ...(kind === 'api'
    ? {
        WEB_ORIGIN: 'https://app.example.test',
        OWNER_EMAIL: 'owner@example.test',
        METRICS_TOKEN: 'm'.repeat(43),
        DATABASE_URL: 'postgres://app_api@db.example.test:5432/app?sslmode=require',
      }
    : kind === 'worker'
      ? { DATABASE_URL: 'postgres://app_worker@db.example.test:5432/app?sslmode=require' }
      : {
          MIGRATION_DATABASE_URL:
            'postgres://migrator@db.example.test:5432/app?sslmode=verify-full',
        }),
});
