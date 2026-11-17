import { constants, createCipheriv, publicEncrypt, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { GCM_TAG_BYTES, NONCE_BYTES, aadBytes } from '../domain/key-wrap.js';
import type { KeyAad, KeyWrapPort, Sealed } from '../domain/key-wrap.js';
import { parseActiveVersion, parsePublicKeys } from './kek-config.js';

/**
 * The seal side of KeyWrapPort on `node:crypto` (ADR-004, TD-D5): a fresh random 256-bit data key per seal,
 * AES-256-GCM with a random 96-bit nonce and AAD `user_id|provider|key_id|version`, the data key wrapped with
 * RSA-OAEP-SHA-256 under the public key of the active `KEK_V{n}`. It holds public keys only and has no unseal.
 */
export class SealedEnvelopeKeyWrap implements KeyWrapPort {
  constructor(
    private readonly publicKeys: ReadonlyMap<number, KeyObject>,
    readonly activeVersion: number,
  ) {
    if (!publicKeys.has(activeVersion)) throw new Error('no public key for the active KEK version');
  }

  static fromEnv(env: Readonly<Record<string, string | undefined>>): SealedEnvelopeKeyWrap {
    const raw = env['KEK_PUBLIC_KEYS'];
    if (raw === undefined) throw new Error('KEK_PUBLIC_KEYS is required');
    const keys = parsePublicKeys(raw);
    return new SealedEnvelopeKeyWrap(keys, parseActiveVersion(env['KEK_ACTIVE_VERSION'], keys));
  }

  seal(plaintext: Buffer, aad: KeyAad): Sealed {
    const kek = this.publicKeys.get(this.activeVersion);
    if (kek === undefined) throw new Error('no public key for the active KEK version');
    const dek = randomBytes(32);
    try {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', dek, nonce, { authTagLength: GCM_TAG_BYTES });
      cipher.setAAD(aadBytes(aad));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      const wrappedDek = publicEncrypt(
        { key: kek, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        dek,
      );
      return { ciphertext, nonce, wrappedDek, kekVersion: this.activeVersion };
    } finally {
      dek.fill(0);
    }
  }
}
