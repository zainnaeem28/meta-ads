import { Writable } from 'node:stream';
import { pino } from 'pino';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProviderKeysModule } from '../provider-keys.module.js';
import { KEY_WRAP_PORT, UnsealFailed, aadBytes } from '../domain/key-wrap.js';
import type { KeyAad, Sealed } from '../domain/key-wrap.js';
import {
  KekConfigError,
  parseActiveVersion,
  parsePrivateKeys,
  parsePublicKeys,
} from './kek-config.js';
import { KeyUnsealer } from './key-unsealer.js';
import { SealedEnvelopeKeyWrap } from './sealed-envelope.js';
import { AAD, generateKek, kekEnv } from './test-support.js';
import type { Kek } from './test-support.js';

// TC-KEY-01..: the sealed envelope (ADR-004). A key is sealed under the active KEK_V{n} public key and opened only by
// the unsealer that holds the private map.

const PLAINTEXT = 'test-plaintext-provider-key-0123456789';
let v1: Kek;
let v2: Kek;
let other: Kek;
let sealer: SealedEnvelopeKeyWrap;
let unsealer: KeyUnsealer;

beforeAll(() => {
  v1 = generateKek();
  v2 = generateKek();
  other = generateKek();
  sealer = SealedEnvelopeKeyWrap.fromEnv(kekEnv({ 1: v1 }, 1, false));
  unsealer = KeyUnsealer.fromEnv(kekEnv({ 1: v1 }, 1, true));
}, 120_000);

const seal = (aad: KeyAad = AAD, s: SealedEnvelopeKeyWrap = sealer) =>
  s.seal(Buffer.from(PLAINTEXT), aad);
const clone = (s: Sealed, change: Partial<Sealed>): Sealed => ({ ...s, ...change });
const flip = (b: Buffer, at: number): Buffer => {
  const copy = Buffer.from(b);
  copy[at] = (copy[at] ?? 0) ^ 0x01;
  return copy;
};

describe('seal and unseal', () => {
  it('round-trips and has the stored sizes (RSA-3072 wrapped DEK 384, nonce 12, ciphertext = plaintext + 16-byte tag)', () => {
    const sealed = seal();
    expect(sealed.kekVersion).toBe(1);
    expect(sealed.wrappedDek).toHaveLength(384);
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.ciphertext).toHaveLength(PLAINTEXT.length + 16);
    expect(sealed.ciphertext.includes(Buffer.from(PLAINTEXT))).toBe(false);
    expect(unsealer.unseal(sealed, AAD).toString()).toBe(PLAINTEXT);
  });

  it('never repeats a nonce, data key or ciphertext for the same plaintext', () => {
    const a = seal();
    const b = seal();
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('binds user, provider, key id and version: a changed AAD field fails with UnsealFailed', () => {
    const sealed = seal();
    const moved: KeyAad[] = [
      { ...AAD, userId: '0197a1b2-0000-7000-8000-000000000002' },
      { ...AAD, provider: 'wavespeed' },
      { ...AAD, keyId: '0197a1b2-0000-7000-8000-0000000000a2' },
      { ...AAD, version: 2 },
    ];
    for (const aad of moved) expect(() => unsealer.unseal(sealed, aad)).toThrow(UnsealFailed);
    expect(aadBytes(AAD).toString()).toBe(`${AAD.userId}|openai|${AAD.keyId}|1`);
  });

  it('fails on a flipped bit in the ciphertext, the tag, the nonce or the wrapped data key', () => {
    const sealed = seal();
    const bad = [
      clone(sealed, { ciphertext: flip(sealed.ciphertext, 0) }),
      clone(sealed, { ciphertext: flip(sealed.ciphertext, sealed.ciphertext.length - 1) }),
      clone(sealed, { nonce: flip(sealed.nonce, 3) }),
      clone(sealed, { wrappedDek: flip(sealed.wrappedDek, 100) }),
    ];
    for (const s of bad) expect(() => unsealer.unseal(s, AAD)).toThrow(UnsealFailed);
  });

  it('fails on truncated or wrongly sized parts and on an unknown KEK version, with the same typed error', () => {
    const sealed = seal();
    const bad = [
      clone(sealed, { kekVersion: 9 }),
      clone(sealed, { nonce: sealed.nonce.subarray(0, 8) }),
      clone(sealed, { ciphertext: sealed.ciphertext.subarray(0, 16) }),
      clone(sealed, { ciphertext: Buffer.alloc(0) }),
      clone(sealed, { wrappedDek: sealed.wrappedDek.subarray(0, 100) }),
    ];
    for (const s of bad) {
      const error = (() => {
        try {
          unsealer.unseal(s, AAD);
        } catch (e) {
          return e as Error;
        }
        return undefined;
      })();
      expect(error).toBeInstanceOf(UnsealFailed);
      expect(error?.message).toBe('unseal failed');
    }
  });

  it('a different KEK cannot open the value', () => {
    const wrong = KeyUnsealer.fromEnv(kekEnv({ 1: other }, 1, true));
    expect(() => wrong.unseal(seal(), AAD)).toThrow(UnsealFailed);
  });

  it('rotation: a value sealed under KEK_V1 still opens after KEK_V2 is active, and new seals use V2', () => {
    const old = seal();
    const rotatedEnv = kekEnv({ 1: v1, 2: v2 }, 2, true);
    const rotated = SealedEnvelopeKeyWrap.fromEnv(rotatedEnv);
    const both = KeyUnsealer.fromEnv(rotatedEnv);
    expect(both.versions()).toEqual([1, 2]);
    expect(both.unseal(old, AAD).toString()).toBe(PLAINTEXT);
    const fresh = seal(AAD, rotated);
    expect(fresh.kekVersion).toBe(2);
    expect(both.unseal(fresh, AAD).toString()).toBe(PLAINTEXT);
    // The V1-only worker cannot open a V2 row: a configuration error, not a crash.
    expect(() => unsealer.unseal(fresh, AAD)).toThrow(UnsealFailed);
  });

  it('puts no key material into an error or a log line', () => {
    const lines: string[] = [];
    const log = pino(
      { level: 'debug' },
      new Writable({
        write(chunk: Buffer, _enc, done) {
          lines.push(chunk.toString());
          done();
        },
      }),
    );
    const sealed = seal();
    try {
      unsealer.unseal(clone(sealed, { ciphertext: flip(sealed.ciphertext, 2) }), AAD);
    } catch (error) {
      log.error({ err: error }, 'unseal failed');
    }
    log.info({ module: 'provider-keys', outcome: 'ok' }, 'sealed');
    const text = lines.join('');
    expect(text).not.toContain(PLAINTEXT);
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain(sealed.ciphertext.toString('base64'));
  });
});

describe('KEK configuration', () => {
  const fails = (fn: () => unknown, text: RegExp) => {
    expect(fn).toThrow(KekConfigError);
    expect(fn).toThrow(text);
  };

  it('refuses malformed maps, naming the variable and never a value', () => {
    fails(() => parsePublicKeys('not json'), /KEK_PUBLIC_KEYS: is not valid JSON/);
    fails(() => parsePublicKeys('[]'), /JSON map/);
    fails(() => parsePublicKeys('"x"'), /JSON map/);
    fails(() => parsePublicKeys('null'), /JSON map/);
    fails(() => parsePublicKeys('{}'), /has no version/);
    fails(() => parsePublicKeys('{"0":"x"}'), /positive integers/);
    fails(() => parsePublicKeys('{"1.5":"x"}'), /positive integers/);
    fails(() => parsePublicKeys('{"1":5}'), /positive integers/);
    fails(() => parsePublicKeys('{"1":"not a pem"}'), /unreadable public key/);
    fails(
      () => parsePrivateKeys('{"1":"not a pem"}'),
      /KEK_PRIVATE_KEYS: holds an unreadable private key/,
    );
  });

  it('refuses a key that is not RSA-3072', () => {
    const small = generateKek(2048);
    fails(() => parsePublicKeys(JSON.stringify({ 1: small.publicPem })), /3072-bit/);
    fails(() => parsePrivateKeys(JSON.stringify({ 1: small.privatePem })), /3072-bit/);
  });

  it('requires an active version that exists', () => {
    const keys = parsePublicKeys(JSON.stringify({ 1: v1.publicPem }));
    expect(parseActiveVersion('1', keys)).toBe(1);
    fails(() => parseActiveVersion(undefined, keys), /KEK_ACTIVE_VERSION/);
    fails(() => parseActiveVersion('2', keys), /KEK_ACTIVE_VERSION/);
    fails(() => parseActiveVersion('x', keys), /KEK_ACTIVE_VERSION/);
  });

  it('the constructors and fromEnv refuse missing variables', () => {
    expect(() => SealedEnvelopeKeyWrap.fromEnv({})).toThrow('KEK_PUBLIC_KEYS is required');
    expect(() => KeyUnsealer.fromEnv({})).toThrow('KEK_PRIVATE_KEYS is required');
    expect(() => new KeyUnsealer(new Map())).toThrow('no version');
    expect(() => new SealedEnvelopeKeyWrap(new Map(), 1)).toThrow('active KEK version');
  });
});

describe('ProviderKeysModule', () => {
  it('binds the seal port from the environment and refuses a private map in the api role', () => {
    const env = kekEnv({ 1: v1 }, 1, false);
    const mod = ProviderKeysModule.register(env, 'api');
    expect(mod.exports).toContain(KEY_WRAP_PORT);
    expect(() => ProviderKeysModule.register(kekEnv({ 1: v1 }, 1, true), 'api')).toThrow(
      'KEK_PRIVATE_KEYS must be absent in the api process',
    );
    expect(() => ProviderKeysModule.register(kekEnv({ 1: v1 }, 1, true), 'worker')).not.toThrow();
  });
});
