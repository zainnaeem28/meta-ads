import {
  generateKeyPairSync,
  privateDecrypt,
  constants,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as cryptoModule from './crypto.ts';
import {
  createApiBinding,
  createWorkerBinding,
  generateKek,
  UnsealFailed,
  type KeyAad,
  type Sealed,
} from './crypto.ts';

const aad: KeyAad = { userId: 'u1', provider: 'openai', keyId: 'k1', version: 1 };
const secret = Buffer.from('sk-test-0123456789abcdefghijklmnop');

const kek = generateKek();
const pub = new Map<number, KeyObject>([[1, kek.publicKey]]);
const priv = new Map<number, KeyObject>([[1, kek.privateKey]]);
const api = createApiBinding(pub, 1);
const worker = createWorkerBinding(pub, priv, 1);

describe('KeyWrapPort foundation form (TC-KEY)', () => {
  it('KEK is RSA 3072', () => {
    const details = kek.publicKey.asymmetricKeyDetails;
    expect(kek.publicKey.asymmetricKeyType).toBe('rsa');
    expect(details?.modulusLength).toBe(3072);
  });

  it('api seals, worker unseals; wrapped DEK is 384 bytes, nonce 12, tag appended', () => {
    const sealed = api.seal(secret, aad);
    expect(sealed.kekVersion).toBe(1);
    expect(sealed.wrappedDek).toHaveLength(384);
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.ciphertext).toHaveLength(secret.length + 16);
    expect(sealed.ciphertext.includes(secret)).toBe(false);
    expect(worker.unseal(sealed, aad).equals(secret)).toBe(true);
  });

  it('nonce and DEK are fresh on every seal', () => {
    const a = api.seal(secret, aad);
    const b = api.seal(secret, aad);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('every AAD field mismatch fails with UnsealFailed', () => {
    const sealed = api.seal(secret, aad);
    for (const wrong of [
      { ...aad, userId: 'u2' },
      { ...aad, provider: 'wavespeed' },
      { ...aad, keyId: 'k2' },
      { ...aad, version: 2 },
    ]) {
      expect(() => worker.unseal(sealed, wrong)).toThrow(UnsealFailed);
    }
  });

  it('tampered ciphertext, tag, nonce, wrapped DEK or a different KEK fail', () => {
    const sealed = api.seal(secret, aad);
    const flip = (b: Buffer, i: number) => {
      const c = Buffer.from(b);
      c[i] = (c[i] as number) ^ 1;
      return c;
    };
    const variants: Sealed[] = [
      { ...sealed, ciphertext: flip(sealed.ciphertext, 0) },
      { ...sealed, ciphertext: flip(sealed.ciphertext, sealed.ciphertext.length - 1) },
      { ...sealed, nonce: flip(sealed.nonce, 0) },
      { ...sealed, wrappedDek: flip(sealed.wrappedDek, 10) },
      { ...sealed, kekVersion: 9 },
    ];
    for (const v of variants) expect(() => worker.unseal(v, aad)).toThrow(UnsealFailed);
    const other = generateKek();
    const stranger = createWorkerBinding(pub, new Map([[1, other.privateKey]]), 1);
    expect(() => stranger.unseal(sealed, aad)).toThrow(UnsealFailed);
  });

  it('the wrapped DEK is RSA-OAEP with SHA-256 (SHA-1 OAEP is refused, PKCS#1 v1.5 never yields the DEK)', () => {
    const sealed = api.seal(secret, aad);
    const dek = privateDecrypt(
      { key: kek.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      sealed.wrappedDek,
    );
    expect(dek).toHaveLength(32);
    expect(() =>
      privateDecrypt(
        { key: kek.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
        sealed.wrappedDek,
      ),
    ).toThrow();
    // OpenSSL 3 implicit rejection: PKCS#1 v1.5 decryption of an OAEP block returns random bytes or throws,
    // never the DEK
    const v15 = (() => {
      try {
        return privateDecrypt(
          { key: kek.privateKey, padding: constants.RSA_PKCS1_PADDING },
          sealed.wrappedDek,
        );
      } catch {
        return null;
      }
    })();
    expect(v15 === null || !v15.equals(dek)).toBe(true);
  });

  it('rotation: a value sealed under KEK_V1 still opens after KEK_V2 becomes current', () => {
    const second = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const pub2 = new Map(pub).set(2, second.publicKey);
    const priv2 = new Map(priv).set(2, second.privateKey);
    const old = api.seal(secret, aad);
    const rotatedApi = createApiBinding(pub2, 2);
    const rotatedWorker = createWorkerBinding(pub2, priv2, 2);
    expect(rotatedApi.seal(secret, aad).kekVersion).toBe(2);
    expect(rotatedWorker.unseal(old, aad).equals(secret)).toBe(true);
  });

  it('the api binding has no unsealer and the module separates the two bindings', () => {
    expect(Object.keys(api)).toEqual(['seal']);
    expect((api as Record<string, unknown>)['unseal']).toBeUndefined();
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(worker).sort()).toEqual(['seal', 'unseal']);
    // the api constructor takes public keys only: sealing needs no private key material
    expect(createApiBinding.length).toBe(2);
    expect(() => createApiBinding(new Map(), 1).seal(secret, aad)).toThrow(/no public key/);
    expect(Object.keys(cryptoModule)).not.toContain('unseal');
  });

  it('plaintext is random-length safe: empty and 4 KiB values round-trip', () => {
    for (const value of [Buffer.alloc(0), randomBytes(4096)]) {
      expect(worker.unseal(api.seal(value, aad), aad).equals(value)).toBe(true);
    }
  });
});
