import { constants, createDecipheriv, privateDecrypt } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { GCM_TAG_BYTES, NONCE_BYTES, UnsealFailed, aadBytes } from '../domain/key-wrap.js';
import type { KeyAad, KeyUnwrapPort, Sealed } from '../domain/key-wrap.js';
import { parsePrivateKeys } from './kek-config.js';

/**
 * The only code that opens a sealed provider key, and the only holder of `KEK_PRIVATE_KEYS`. Layer rule L3: this file
 * is imported by `bootstrap/worker.module.ts` alone, so `app.get(KeyUnsealer)` in the api process throws.
 * Every failure is the same typed `UnsealFailed`, with no detail that could tell an attacker which check failed.
 */
export class KeyUnsealer implements KeyUnwrapPort {
  constructor(private readonly privateKeys: ReadonlyMap<number, KeyObject>) {
    if (privateKeys.size === 0) throw new Error('KEK_PRIVATE_KEYS has no version');
  }

  static fromEnv(env: Readonly<Record<string, string | undefined>>): KeyUnsealer {
    const raw = env['KEK_PRIVATE_KEYS'];
    if (raw === undefined) throw new Error('KEK_PRIVATE_KEYS is required');
    return new KeyUnsealer(parsePrivateKeys(raw));
  }

  /** The key versions this worker can open (for the startup check against the rows still in use). */
  versions(): number[] {
    return [...this.privateKeys.keys()].sort((a, b) => a - b);
  }

  unseal(sealed: Sealed, aad: KeyAad): Buffer {
    let dek: Buffer | undefined;
    try {
      const kek = this.privateKeys.get(sealed.kekVersion);
      if (kek === undefined) throw new UnsealFailed();
      if (sealed.nonce.length !== NONCE_BYTES || sealed.ciphertext.length <= GCM_TAG_BYTES) {
        throw new UnsealFailed();
      }
      dek = privateDecrypt(
        { key: kek, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        sealed.wrappedDek,
      );
      const split = sealed.ciphertext.length - GCM_TAG_BYTES;
      const decipher = createDecipheriv('aes-256-gcm', dek, sealed.nonce, {
        authTagLength: GCM_TAG_BYTES,
      });
      decipher.setAAD(aadBytes(aad));
      decipher.setAuthTag(sealed.ciphertext.subarray(split));
      return Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, split)), decipher.final()]);
    } catch {
      throw new UnsealFailed();
    } finally {
      dek?.fill(0);
    }
  }
}
