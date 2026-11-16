// What the backup identity must never hold (SB v6 section 7.1 D). The list mirrors `backupForbidden` in
// config/registry.json (a test compares the two) and adds the names the test plan names (TC-BKP-12).
export const FORBIDDEN_NAMES: readonly string[] = [
  'KEK_PRIVATE_KEYS',
  'KEY_FINGERPRINT_PEPPERS',
  'HMAC_PEPPER',
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_LEDGER_ACCESS_KEY_ID',
  'R2_LEDGER_SECRET_ACCESS_KEY',
  'CLERK_SECRET_KEY',
  'CURSOR_SIGNING_KEY',
  'RATE_LIMIT_IP_KEY',
  'METRICS_TOKEN',
  'SHOTSTACK_API_KEY',
  'RENDER_API_KEY',
  'GHCR_PULL_TOKEN',
  'SENTRY_AUTH_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'AGE_SECRET_KEY',
  'AGE_PRIVATE_KEY',
  'BACKUP_AGE_IDENTITY',
];

/** `KEK_V1`, `KEK_V2`, ...: every private key version, whatever its number. */
const KEK_VERSION = /^KEK_V\d+$/;
/** An age private key is recognisable by its value, whatever the variable is called. */
const AGE_IDENTITY_VALUE = /^\s*AGE-SECRET-KEY-1[A-Z0-9]+/;

/** Names (never values) of the forbidden variables present in `env`. */
export function forbiddenPresent(env: NodeJS.ProcessEnv): string[] {
  const found: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (FORBIDDEN_NAMES.includes(name) || KEK_VERSION.test(name)) found.push(name);
    else if (AGE_IDENTITY_VALUE.test(value)) found.push(name);
  }
  return found.sort();
}
