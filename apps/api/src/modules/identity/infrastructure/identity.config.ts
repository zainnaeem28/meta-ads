export type IdentityMode = 'local' | 'clerk';

export interface IdentityConfig {
  readonly mode: IdentityMode;
  /** `clerk` mode only. */
  readonly secretKey?: string;
  readonly issuer?: string;
  readonly authorizedParties?: readonly string[];
}

const HOSTED = new Set(['staging', 'production']);

/**
 * Reads `IDENTITY_MODE` (registry: `local` or `clerk`, `local` refused when `APP_ENV` is staging or production).
 * Unset means `local` away from a hosted environment and `clerk` on one.
 */
export function identityConfigFrom(
  env: Readonly<Record<string, string | undefined>>,
  appEnv: string,
  webOrigin: string | undefined,
): IdentityConfig {
  const hosted = HOSTED.has(appEnv);
  const raw = env['IDENTITY_MODE'];
  const mode = raw === undefined || raw === '' ? (hosted ? 'clerk' : 'local') : raw;
  if (mode !== 'local' && mode !== 'clerk') throw new Error('IDENTITY_MODE must be local or clerk');
  if (mode === 'local') {
    if (hosted) throw new Error(`IDENTITY_MODE=local is refused when APP_ENV is ${appEnv}`);
    return { mode };
  }
  const secretKey = env['CLERK_SECRET_KEY'];
  const issuer = env['CLERK_JWT_ISSUER'];
  if (secretKey === undefined || issuer === undefined) {
    throw new Error('IDENTITY_MODE=clerk needs CLERK_SECRET_KEY and CLERK_JWT_ISSUER');
  }
  return {
    mode,
    secretKey,
    issuer,
    ...(webOrigin === undefined ? {} : { authorizedParties: [webOrigin] }),
  };
}
