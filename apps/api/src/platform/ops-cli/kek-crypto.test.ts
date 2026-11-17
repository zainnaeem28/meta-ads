import { constants, createCipheriv, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KekMapError, privateKeysOf, publicKeysOf, rewrapRow } from './kek-crypto.js';
import type { SealedRow } from './kek-crypto.js';

const pair = () => generateKeyPairSync('rsa', { modulusLength: 3072 });
const v1 = pair();
const v2 = pair();
const OAEP = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' } as const;
const pem = (key: KeyObject): string => key.export(key.type === 'private' ? { type: 'pkcs8', format: 'pem' } : { type: 'spki', format: 'pem' }).toString();

const ids = { id: '0190a1b2-0000-7000-8000-000000000001', ownerId: '0190a1b2-0000-7000-8000-000000000002', provider: 'wavespeed', version: 3 };

/** A value sealed as the api does: AES-256-GCM under a fresh data key, bound to `user|provider|key|version`. */
function sealed(secret: string, under: KeyObject, kekVersion: number): SealedRow {
  const dek = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`${ids.ownerId}|${ids.provider}|${ids.id}|${String(ids.version)}`));
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { ...ids, nonce, ciphertext: Buffer.concat([body, cipher.getAuthTag()]), wrappedDek: publicEncrypt({ key: under, ...OAEP }, dek), kekVersion };
}

const privateKeys = privateKeysOf({ '1': pem(v1.privateKey), '2': pem(v2.privateKey) });
const publicKeys = publicKeysOf({ '1': pem(v1.publicKey), '2': pem(v2.publicKey) });

describe('kek:rewrap cryptography', () => {
  it('wraps the same data key under the active version, leaving the value alone', () => {
    const row = sealed('sk-live-value', v1.publicKey, 1);
    const result = rewrapRow(row, privateKeys, publicKeys, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wrappedDek).toHaveLength(384);
    const before = privateDecrypt({ key: v1.privateKey, ...OAEP }, row.wrappedDek);
    const after = privateDecrypt({ key: v2.privateKey, ...OAEP }, result.wrappedDek);
    expect(after.equals(before)).toBe(true);
    expect(() => privateDecrypt({ key: v1.privateKey, ...OAEP }, result.wrappedDek)).toThrow();
  });

  it('refuses a row whose private key is gone or whose value does not open', () => {
    const row = sealed('sk-live-value', v1.publicKey, 1);
    expect(rewrapRow(row, new Map([[2, v2.privateKey]]), publicKeys, 2)).toEqual({ ok: false, reason: 'no_private_key' });
    expect(rewrapRow(row, privateKeys, new Map(), 2)).toEqual({ ok: false, reason: 'no_private_key' });
    expect(rewrapRow({ ...row, kekVersion: 2 }, privateKeys, publicKeys, 2)).toEqual({ ok: false, reason: 'unreadable' });
    expect(rewrapRow({ ...row, version: 4 }, privateKeys, publicKeys, 2)).toEqual({ ok: false, reason: 'unreadable' });
    expect(rewrapRow({ ...row, ciphertext: Buffer.from(row.ciphertext).fill(7, 0, 4) }, privateKeys, publicKeys, 2)).toEqual({ ok: false, reason: 'unreadable' });
    expect(rewrapRow({ ...row, nonce: Buffer.alloc(8) }, privateKeys, publicKeys, 2)).toEqual({ ok: false, reason: 'unreadable' });
    expect(rewrapRow({ ...row, ciphertext: Buffer.alloc(10) }, privateKeys, publicKeys, 2)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('a public key that does not match its private key is caught before anything is written', () => {
    const row = sealed('sk-live-value', v1.publicKey, 1);
    const crossed = publicKeysOf({ '2': pem(pair().publicKey) });
    expect(rewrapRow(row, privateKeys, crossed, 2)).toEqual({ ok: false, reason: 'verify_failed' });
  });

  it('reads the key maps and names only the variable on a fault', () => {
    expect(publicKeysOf({ '1': pem(v1.publicKey) }).size).toBe(1);
    const weak = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const faults: [() => unknown, string][] = [
      [() => publicKeysOf('x'), 'KEK_PUBLIC_KEYS: must be a map'],
      [() => publicKeysOf([]), 'KEK_PUBLIC_KEYS: must be a map'],
      [() => publicKeysOf({ '1': 'not a pem' }), 'KEK_PUBLIC_KEYS: holds an unreadable key'],
      [() => privateKeysOf({ '1': 5 }), 'KEK_PRIVATE_KEYS: holds an unreadable key'],
      [() => publicKeysOf({ '1': pem(weak.publicKey) }), 'KEK_PUBLIC_KEYS: keys must be RSA'],
      [() => publicKeysOf({ zero: pem(v1.publicKey) }), 'KEK_PUBLIC_KEYS: versions must be positive integers'],
      [() => publicKeysOf({ '0': pem(v1.publicKey) }), 'KEK_PUBLIC_KEYS: versions must be positive integers'],
    ];
    for (const [make, message] of faults) {
      expect(make).toThrow(KekMapError);
      expect(make).toThrow(message);
    }
  });
});
