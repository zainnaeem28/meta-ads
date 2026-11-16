// KeyWrapPort (ARCHITECTURE §1.3, ADR-004): the api seals, only the worker opens. No framework or SDK import here.

export const KEY_WRAP_PORT = Symbol('KEY_WRAP_PORT');

export const PROVIDERS = ['openai', 'wavespeed'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** What is bound to a ciphertext: a value moved to another user, provider, row or version fails to open. */
export interface KeyAad {
  readonly userId: string;
  readonly provider: Provider;
  readonly keyId: string;
  readonly version: number;
}

/** The stored form: ciphertext is the encrypted key followed by the 16-byte GCM tag. */
export interface Sealed {
  readonly ciphertext: Buffer;
  /** 96 bits, random per seal. */
  readonly nonce: Buffer;
  /** The data key wrapped with RSA-OAEP-SHA-256 under the public key of `kekVersion` (384 bytes for RSA-3072). */
  readonly wrappedDek: Buffer;
  readonly kekVersion: number;
}

export interface KeyWrapPort {
  /** Plaintext travels as a Buffer. The caller zeroes its own copy. */
  seal(plaintext: Buffer, aad: KeyAad): Sealed;
}

/** The worker binding only (layer rule L3). */
export interface KeyUnwrapPort {
  unseal(sealed: Sealed, aad: KeyAad): Buffer;
}

/** Any failure to open a sealed value (wrong AAD, tampered bytes, unknown or missing KEK version). Carries no detail. */
export class UnsealFailed extends Error {
  constructor() {
    super('unseal failed');
    this.name = 'UnsealFailed';
  }
}

/** `user_id|provider|key_id|version` (SECURITY-DESIGN §9.2). */
export function aadBytes(aad: KeyAad): Buffer {
  return Buffer.from(`${aad.userId}|${aad.provider}|${aad.keyId}|${String(aad.version)}`, 'utf8');
}

export const GCM_TAG_BYTES = 16;
export const NONCE_BYTES = 12;
export const WRAPPED_DEK_BYTES = 384;
export const MAX_CIPHERTEXT_BYTES = 1024;
