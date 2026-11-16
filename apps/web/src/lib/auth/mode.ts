export type AuthMode = 'local' | 'clerk';

const HOSTED = new Set(['staging', 'production']);

/**
 * Reads `AUTH_MODE` (registry: `local` or `clerk`; `local` is refused when `APP_ENV` is staging or production).
 * Unset means `clerk` when a Clerk key is set or the environment is hosted, otherwise `local`.
 */
export function resolveAuthMode(env: Readonly<Record<string, string | undefined>>): AuthMode {
  const hosted = HOSTED.has(env['APP_ENV'] ?? '');
  const raw = env['AUTH_MODE'];
  const mode =
    raw === undefined || raw === ''
      ? hosted || Boolean(env['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'])
        ? 'clerk'
        : 'local'
      : raw;
  if (mode !== 'local' && mode !== 'clerk') throw new Error('AUTH_MODE must be local or clerk');
  if (mode === 'local' && hosted) {
    throw new Error(`AUTH_MODE=local is refused when APP_ENV is ${env['APP_ENV']}`);
  }
  return mode;
}
