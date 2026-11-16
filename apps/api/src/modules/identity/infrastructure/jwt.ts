import { createPublicKey, verify } from 'node:crypto';
import { IdentityTokenInvalid, IdentityUnavailable } from '../domain/identity-port.js';
import type { Claims } from '../domain/identity-port.js';

/** One public key of a JWKS document. */
export interface JwkEntry {
  kty?: string;
  n?: string;
  e?: string;
  kid?: string;
  alg?: string;
  use?: string;
}

/** Keys by `kid`; refreshed after `ttlMs` and, at most once a minute, when a token names a key we do not hold. */
export class JwksCache {
  private keys = new Map<string, JwkEntry>();
  private loadedAt = Number.NEGATIVE_INFINITY;
  private lastMissRefresh = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly load: () => Promise<readonly JwkEntry[]>,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly missRefreshMs = 60_000,
  ) {}

  async get(kid: string): Promise<JwkEntry | undefined> {
    const at = this.now();
    if (at - this.loadedAt >= this.ttlMs) {
      await this.refresh(at);
    } else if (!this.keys.has(kid) && at - this.lastMissRefresh >= this.missRefreshMs) {
      this.lastMissRefresh = at;
      await this.refresh(at);
    }
    return this.keys.get(kid);
  }

  private async refresh(at: number): Promise<void> {
    const loaded = await this.load();
    this.keys = new Map(
      loaded.flatMap((key): [string, JwkEntry][] =>
        key.kid === undefined ? [] : [[key.kid, key]],
      ),
    );
    this.loadedAt = at;
  }
}

export interface VerifyOptions {
  /** Required `iss`. */
  readonly issuer: string;
  /** When non-empty, a present `azp` must be one of these. */
  readonly authorizedParties?: readonly string[];
  readonly clockSkewMs?: number;
  readonly now?: () => number;
}

function decode(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('shape');
  return value as Record<string, unknown>;
}

function fvaOf(value: unknown): readonly [number, number] | null {
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
  ) {
    return [value[0] as number, value[1] as number];
  }
  return null;
}

/**
 * Verifies an RS256 session token against a cached key set and returns its claims. Messages carry the reason only,
 * never the token or a claim value.
 */
export async function verifySessionToken(
  token: string,
  keys: JwksCache,
  options: VerifyOptions,
): Promise<Claims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new IdentityTokenInvalid('malformed');
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decode(parts[0] as string);
    payload = decode(parts[1] as string);
  } catch {
    throw new IdentityTokenInvalid('malformed');
  }
  if (header['alg'] !== 'RS256') throw new IdentityTokenInvalid('algorithm');
  const kid = header['kid'];
  if (typeof kid !== 'string' || kid === '') throw new IdentityTokenInvalid('key id');

  let jwk: JwkEntry | undefined;
  try {
    jwk = await keys.get(kid);
  } catch (error) {
    if (error instanceof IdentityUnavailable) throw error;
    throw new IdentityUnavailable('verifyToken', 'keys');
  }
  if (jwk === undefined) throw new IdentityTokenInvalid('unknown key');

  let valid: boolean;
  try {
    valid = verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(parts[2] as string, 'base64url'),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new IdentityTokenInvalid('signature');

  const nowMs = (options.now ?? Date.now)();
  const skew = options.clockSkewMs ?? 5_000;
  const { sub, sid, iat, exp, nbf, iss, azp } = payload as Record<string, unknown>;
  if (iss !== options.issuer) throw new IdentityTokenInvalid('issuer');
  if (typeof sub !== 'string' || sub === '' || typeof sid !== 'string' || sid === '') {
    throw new IdentityTokenInvalid('subject');
  }
  if (typeof exp !== 'number' || typeof iat !== 'number') throw new IdentityTokenInvalid('time');
  if (exp * 1000 <= nowMs - skew) throw new IdentityTokenInvalid('expired');
  if (iat * 1000 > nowMs + skew) throw new IdentityTokenInvalid('not yet valid');
  if (nbf !== undefined && (typeof nbf !== 'number' || nbf * 1000 > nowMs + skew)) {
    throw new IdentityTokenInvalid('not yet valid');
  }
  if (azp !== undefined && typeof azp !== 'string') throw new IdentityTokenInvalid('party');
  const parties = options.authorizedParties ?? [];
  if (typeof azp === 'string' && parties.length > 0 && !parties.includes(azp)) {
    throw new IdentityTokenInvalid('party');
  }
  return {
    sub,
    sid,
    fva: fvaOf(payload['fva']),
    iat,
    exp,
    azp: typeof azp === 'string' ? azp : null,
  };
}
