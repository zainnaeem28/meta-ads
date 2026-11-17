import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { ORIGIN } from '../../security/support/stack.js';
import type { World } from './world.js';
import type { Account } from './world.js';

// Tokens that the identity provider did not issue, or issued for another purpose: the forged identities of TC-ZT-01 and TC-ZT-02.

const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

interface Claims {
  sub: string;
  [name: string]: unknown;
}

export const baseClaims = (
  w: World,
  who: Pick<Account, 'sub'>,
  over: Record<string, unknown> = {},
): Claims => {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: w.local.issuer,
    sub: who.sub,
    sid: `sess_${who.sub}`,
    iat: now,
    exp: now + 300,
    azp: ORIGIN,
    fva: [1, 1],
    ...over,
  };
};

/** A token signed with the provider's own key, with whatever claims the caller adds (a user token with an admin claim copied in). */
export function signedWith(w: World, claims: Record<string, unknown>): string {
  const key = (w.local as unknown as { privateKey: KeyObject }).privateKey;
  const kid = (w.local.jwks().keys[0] as { kid: string }).kid;
  const head = `${part({ alg: 'RS256', typ: 'JWT', kid })}.${part(claims)}`;
  return `${head}.${createSign('RSA-SHA256').update(head).sign(key).toString('base64url')}`;
}

/** The forged and invalid shapes the matrix presents on every guarded operation. */
export function forgedTokens(w: World, who: Account, victim: Account): Record<string, string> {
  const kid = (w.local.jwks().keys[0] as { kid: string }).kid;
  const claims = baseClaims(w, who);
  const unsigned = `${part({ alg: 'none', typ: 'JWT', kid })}.${part(claims)}.`;
  const hs256 = (() => {
    const head = `${part({ alg: 'HS256', typ: 'JWT', kid })}.${part(claims)}`;
    return `${head}.${Buffer.from('secret').toString('base64url')}`;
  })();
  const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const head = `${part({ alg: 'RS256', typ: 'JWT', kid })}.${part(claims)}`;
  const foreignSignature = `${head}.${createSign('RSA-SHA256').update(head).sign(otherKey).toString('base64url')}`;
  const [h, , s] = signedWith(w, claims).split('.') as [string, string, string];
  const tampered = `${h}.${part({ ...claims, sub: victim.sub })}.${s}`;
  const truncated = signedWith(w, claims).split('.').slice(0, 2).join('.');
  const now = Math.floor(Date.now() / 1000);
  return {
    'alg none': unsigned,
    'alg HS256 with a guessed secret': hs256,
    'signed by another key': foreignSignature,
    'payload swapped to another subject': tampered,
    'signature removed': truncated,
    expired: signedWith(w, baseClaims(w, who, { iat: now - 900, exp: now - 600 })),
    'not yet valid': signedWith(
      w,
      baseClaims(w, who, { iat: now + 3600, exp: now + 3900, nbf: now + 3600 }),
    ),
    'wrong authorized party': signedWith(
      w,
      baseClaims(w, who, { azp: 'https://evil.example.com' }),
    ),
    'wrong issuer': signedWith(w, baseClaims(w, who, { iss: 'https://other-issuer.invalid' })),
    'no subject': signedWith(w, { ...claims, sub: '' }),
    'empty token': '',
    'three dots': '...',
  };
}
