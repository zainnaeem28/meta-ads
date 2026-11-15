import { generateKeyPairSync } from 'node:crypto';

// A complete, throwaway api configuration (ARCHITECTURE section 6) for tests that start the built api process.
// The api validates its configuration at startup and exits 78 without it. Nothing here is a real credential.
export function apiEnv(port: number): Record<string, string> {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  return {
    APP_ENV: 'test',
    API_PORT: String(port),
    WEB_ORIGIN: 'http://localhost:3000',
    DATABASE_URL: 'postgres://app_api@localhost:5432/app',
    CLERK_SECRET_KEY: 'sk_test_fixture',
    CLERK_JWT_ISSUER: 'https://clerk.example.test',
    KEK_PUBLIC_KEYS: JSON.stringify({
      '1': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }),
    KEK_ACTIVE_VERSION: '1',
    KEY_FINGERPRINT_PEPPERS: JSON.stringify({ '1': Buffer.alloc(32, 'p').toString('base64') }),
    KEY_FINGERPRINT_PEPPER_ACTIVE: '1',
    R2_ENDPOINT: 'https://r2.example.test',
    R2_BUCKET: 'app',
    R2_ACCESS_KEY_ID: 'fixture-key-id',
    R2_SECRET_ACCESS_KEY: 'fixture-secret',
    RATE_LIMIT_IP_KEY: 'r'.repeat(40),
    CURSOR_SIGNING_KEY: 'c'.repeat(40),
  };
}
