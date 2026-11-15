import {
  constants,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

// Foundation form of KeyWrapPort (ARCHITECTURE §1.3, TD-D5): AES-256-GCM with a random 96-bit
// nonce and AAD `user_id|provider|key_id|version`, the DEK wrapped with RSA-OAEP-SHA-256 under the
// public key `KEK_V{n}`. The api binding gets the public key only and has no `unseal`.

export interface Sealed {
  ciphertext: Buffer; // ciphertext || 16-byte GCM tag
  nonce: Buffer;
  wrappedDek: Buffer;
  kekVersion: number;
}

export interface KeyAad {
  userId: string;
  provider: string;
  keyId: string;
  version: number;
}

export const aadBytes = (aad: KeyAad): Buffer =>
  Buffer.from(`${aad.userId}|${aad.provider}|${aad.keyId}|${aad.version}`, 'utf8');

export class UnsealFailed extends Error {
  constructor() {
    super('unseal failed');
    this.name = 'UnsealFailed';
  }
}

export function generateKek(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 0x10001 });
}

function sealWith(publicKeys: Map<number, KeyObject>, currentVersion: number) {
  return (plaintext: Buffer, aad: KeyAad): Sealed => {
    const kek = publicKeys.get(currentVersion);
    if (!kek) throw new Error(`no public key for KEK_V${currentVersion}`);
    const dek = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dek, nonce);
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
    dek.fill(0);
    return { ciphertext, nonce, wrappedDek, kekVersion: currentVersion };
  };
}

// api binding: seal only. There is no private key in its environment and no unseal function.
export function createApiBinding(publicKeys: Map<number, KeyObject>, currentVersion: number) {
  return Object.freeze({ seal: sealWith(publicKeys, currentVersion) });
}

// worker binding: seal and unseal.
export function createWorkerBinding(
  publicKeys: Map<number, KeyObject>,
  privateKeys: Map<number, KeyObject>,
  currentVersion: number,
) {
  return Object.freeze({
    seal: sealWith(publicKeys, currentVersion),
    unseal(sealed: Sealed, aad: KeyAad): Buffer {
      try {
        const kek = privateKeys.get(sealed.kekVersion);
        if (!kek) throw new Error('unknown kek version');
        const dek = privateDecrypt(
          { key: kek, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
          sealed.wrappedDek,
        );
        const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - 16);
        const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - 16);
        const decipher = createDecipheriv('aes-256-gcm', dek, sealed.nonce);
        decipher.setAAD(aadBytes(aad));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
        dek.fill(0);
        return plaintext;
      } catch {
        throw new UnsealFailed();
      }
    },
  });
}
