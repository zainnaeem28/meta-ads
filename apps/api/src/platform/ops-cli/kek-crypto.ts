import {
  constants,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

// The cryptography of `kek:rewrap` (ADR-004): the data key of a sealed value is opened with the private key of its
// `kek_version` and wrapped again with the public key of the active version. The ciphertext, nonce and AAD never change,
// so the value itself is never touched. The AAD is `user_id|provider|key_id|version` (SECURITY-DESIGN §9.2).

const GCM_TAG_BYTES = 16;
const NONCE_BYTES = 12;
const MODULUS_BITS = 3072;

export class KekMapError extends Error {
  constructor(variable: string, reason: string) {
    super(`${variable}: ${reason}`);
    this.name = 'KekMapError';
  }
}

/** What a row holds of a sealed value, plus what is bound to it. */
export interface SealedRow {
  readonly id: string;
  readonly ownerId: string;
  readonly provider: string;
  readonly version: number;
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly wrappedDek: Buffer;
  readonly kekVersion: number;
}

export type Keys = ReadonlyMap<number, KeyObject>;

function versionOf(variable: string, key: string): number {
  const version = Number(key);
  if (!Number.isInteger(version) || version <= 0 || version > 32767) {
    throw new KekMapError(variable, 'versions must be positive integers');
  }
  return version;
}

function parse(variable: string, map: unknown, make: (pem: string) => KeyObject): Keys {
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    throw new KekMapError(variable, 'must be a map of version to PEM');
  }
  const keys = new Map<number, KeyObject>();
  for (const [name, pem] of Object.entries(map)) {
    let key: KeyObject;
    try {
      if (typeof pem !== 'string') throw new TypeError('not a string');
      key = make(pem);
    } catch {
      throw new KekMapError(variable, 'holds an unreadable key');
    }
    if (
      key.asymmetricKeyType !== 'rsa' ||
      key.asymmetricKeyDetails?.modulusLength !== MODULUS_BITS
    ) {
      throw new KekMapError(
        variable,
        `keys must be RSA with a ${String(MODULUS_BITS)}-bit modulus`,
      );
    }
    keys.set(versionOf(variable, name), key);
  }
  return keys;
}

/** `KEK_PUBLIC_KEYS` and `KEK_PRIVATE_KEYS` as the validated configuration holds them (maps of version to PEM). */
export const publicKeysOf = (map: unknown): Keys =>
  parse('KEK_PUBLIC_KEYS', map, (pem) => createPublicKey(pem));
export const privateKeysOf = (map: unknown): Keys =>
  parse('KEK_PRIVATE_KEYS', map, (pem) => createPrivateKey(pem));

const OAEP = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' } as const;

const aadOf = (row: SealedRow): Buffer =>
  Buffer.from(`${row.ownerId}|${row.provider}|${row.id}|${String(row.version)}`, 'utf8');

/** True when the data key opens the ciphertext under the row's AAD: the proof that the value is readable. */
function opens(row: SealedRow, dek: Buffer): boolean {
  if (row.nonce.length !== NONCE_BYTES || row.ciphertext.length <= GCM_TAG_BYTES) return false;
  try {
    const split = row.ciphertext.length - GCM_TAG_BYTES;
    const decipher = createDecipheriv('aes-256-gcm', dek, row.nonce, {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAAD(aadOf(row));
    decipher.setAuthTag(row.ciphertext.subarray(split));
    const plain = Buffer.concat([
      decipher.update(row.ciphertext.subarray(0, split)),
      decipher.final(),
    ]);
    plain.fill(0);
    return true;
  } catch {
    return false;
  }
}

export type RewrapResult =
  | { readonly ok: true; readonly wrappedDek: Buffer }
  | { readonly ok: false; readonly reason: 'no_private_key' | 'unreadable' | 'verify_failed' };

/**
 * The new wrapped data key of `row` under `active`, or why it cannot be had. The value must open before and the new
 * wrapping must open to the same data key after, so a rewrapped row is never one nobody can read. The data key is
 * zeroed before returning.
 */
export function rewrapRow(
  row: SealedRow,
  privateKeys: Keys,
  publicKeys: Keys,
  active: number,
): RewrapResult {
  const oldKey = privateKeys.get(row.kekVersion);
  const activePrivate = privateKeys.get(active);
  const activePublic = publicKeys.get(active);
  if (oldKey === undefined || activePrivate === undefined || activePublic === undefined) {
    return { ok: false, reason: 'no_private_key' };
  }
  let dek: Buffer | undefined;
  let check: Buffer | undefined;
  try {
    try {
      dek = privateDecrypt({ key: oldKey, ...OAEP }, row.wrappedDek);
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
    if (!opens(row, dek)) return { ok: false, reason: 'unreadable' };
    const wrappedDek = publicEncrypt({ key: activePublic, ...OAEP }, dek);
    try {
      check = privateDecrypt({ key: activePrivate, ...OAEP }, wrappedDek);
    } catch {
      return { ok: false, reason: 'verify_failed' };
    }
    if (!check.equals(dek) || !opens(row, check)) return { ok: false, reason: 'verify_failed' };
    return { ok: true, wrappedDek };
  } finally {
    dek?.fill(0);
    check?.fill(0);
  }
}
