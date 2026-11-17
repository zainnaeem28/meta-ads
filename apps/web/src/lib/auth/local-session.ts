/**
 * The local session (AUTH_MODE=local): a signed, expiring cookie that stands in for a Clerk session so the web runs and
 * is tested with no Clerk account. Edge-safe (Web Crypto only). The signing secret is a fixed development value because
 * `AUTH_MODE=local` is refused in a hosted environment, so no real session is ever protected by it.
 */
export const LOCAL_SESSION_COOKIE = 'shroomap_local_session';
export const LOCAL_SESSION_TTL_SECONDS = 12 * 60 * 60;
const SECRET = 'shroomap-local-auth-development-only';

export interface LocalSession {
  readonly sub: string;
  readonly email: string;
  /** Seconds since the epoch. */
  readonly exp: number;
}

export type LocalSessionState =
  | { readonly status: 'none' }
  | { readonly status: 'expired' }
  | { readonly status: 'active'; readonly session: LocalSession };

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

const fromBase64Url = (text: string): Uint8Array => {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
};

const key = (usage: 'sign' | 'verify') =>
  crypto.subtle.importKey('raw', encoder.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, [
    usage,
  ]);

/** The user id of a local account: stable per email, never the email itself. */
export async function localSubject(email: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(email.trim().toLowerCase()));
  return `user_local_${toBase64Url(new Uint8Array(digest)).slice(0, 16)}`;
}

export async function signLocalSession(session: LocalSession): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(session)));
  const signature = await crypto.subtle.sign('HMAC', await key('sign'), encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Reads the cookie value: no cookie is `none`; a forged, malformed or timed-out one is `expired`. */
export async function readLocalSession(
  value: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<LocalSessionState> {
  if (!value) return { status: 'none' };
  const [payload, signature, ...rest] = value.split('.');
  if (!payload || !signature || rest.length > 0) return { status: 'expired' };
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await key('verify'),
      fromBase64Url(signature) as BufferSource,
      encoder.encode(payload),
    );
    if (!valid) return { status: 'expired' };
    const parsed = JSON.parse(
      new TextDecoder().decode(fromBase64Url(payload)),
    ) as Partial<LocalSession>;
    if (
      typeof parsed.sub !== 'string' ||
      typeof parsed.email !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      return { status: 'expired' };
    }
    if (parsed.exp <= nowSeconds) return { status: 'expired' };
    return { status: 'active', session: { sub: parsed.sub, email: parsed.email, exp: parsed.exp } };
  } catch {
    return { status: 'expired' };
  }
}
