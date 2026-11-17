export type IdentityMode = 'local' | 'clerk';

export interface IdentityConfig {
  readonly mode: IdentityMode;
  /**
   * The local/test token route (`POST /api/v1/dev/token`) is mounted. Set only by `identityConfigFrom` for
   * `IDENTITY_MODE=local` with `APP_ENV` development or test; never in staging, production or `clerk` mode.
   */
  readonly devTokens?: boolean;
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
    return { mode, devTokens: devTokenRouteAllowed(mode, appEnv) };
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

/** The one rule for the local token route: local identity and a non-hosted `APP_ENV` (development or test). */
export function devTokenRouteAllowed(mode: string, appEnv: string): boolean {
  return mode === 'local' && (appEnv === 'development' || appEnv === 'test');
}

/** Startup check: the token route is never configured outside local/test with local identity. */
export function assertDevTokenRoute(config: IdentityConfig, appEnv: string): void {
  if (config.devTokens === true && !devTokenRouteAllowed(config.mode, appEnv)) {
    throw new Error(
      `the local token route is refused with IDENTITY_MODE=${config.mode} and APP_ENV=${appEnv}`,
    );
  }
}
