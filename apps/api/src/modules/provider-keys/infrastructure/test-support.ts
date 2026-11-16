import { generateKeyPairSync } from 'node:crypto';
import type { KeyAad } from '../domain/key-wrap.js';

// Test-only: RSA-3072 key pairs as the environment carries them (JSON maps of version to PEM).

export interface Kek {
  readonly publicPem: string;
  readonly privatePem: string;
}

export function generateKek(bits = 3072): Kek {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: bits,
    publicExponent: 0x10001,
  });
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function kekEnv(
  keks: Readonly<Record<number, Kek>>,
  active: number,
  withPrivate: boolean,
): Record<string, string> {
  const pick = (field: keyof Kek) =>
    JSON.stringify(Object.fromEntries(Object.entries(keks).map(([v, k]) => [v, k[field]])));
  return {
    KEK_PUBLIC_KEYS: pick('publicPem'),
    KEK_ACTIVE_VERSION: String(active),
    ...(withPrivate ? { KEK_PRIVATE_KEYS: pick('privatePem') } : {}),
  };
}

export const AAD: KeyAad = {
  userId: '0197a1b2-0000-7000-8000-000000000001',
  provider: 'openai',
  keyId: '0197a1b2-0000-7000-8000-0000000000a1',
  version: 1,
};
