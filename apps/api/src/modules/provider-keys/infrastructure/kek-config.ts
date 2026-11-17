import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

// Parses the KEK maps of the environment (ARCHITECTURE §6): JSON `{version: PEM}`, RSA with a 3072-bit modulus.
// Errors name the variable, never a value or a PEM.

export class KekConfigError extends Error {
  constructor(variable: string, reason: string) {
    super(`${variable}: ${reason}`);
    this.name = 'KekConfigError';
  }
}

const MODULUS_BITS = 3072;

function entries(variable: string, raw: string): [number, string][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KekConfigError(variable, 'is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new KekConfigError(variable, 'must be a JSON map of version to PEM');
  }
  const out: [number, string][] = [];
  for (const [key, value] of Object.entries(parsed)) {
    const version = Number(key);
    if (
      !Number.isInteger(version) ||
      version <= 0 ||
      version > 32767 ||
      typeof value !== 'string'
    ) {
      throw new KekConfigError(variable, 'versions must be positive integers with a PEM string');
    }
    out.push([version, value]);
  }
  if (out.length === 0) throw new KekConfigError(variable, 'has no version');
  return out;
}

function checked(variable: string, make: () => KeyObject, kind: 'public' | 'private'): KeyObject {
  let key: KeyObject;
  try {
    key = make();
  } catch {
    throw new KekConfigError(variable, `holds an unreadable ${kind} key`);
  }
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== MODULUS_BITS) {
    throw new KekConfigError(
      variable,
      `keys must be RSA with a ${String(MODULUS_BITS)}-bit modulus`,
    );
  }
  return key;
}

export function parsePublicKeys(raw: string): Map<number, KeyObject> {
  const map = new Map<number, KeyObject>();
  for (const [version, pem] of entries('KEK_PUBLIC_KEYS', raw)) {
    map.set(
      version,
      checked('KEK_PUBLIC_KEYS', () => createPublicKey(pem), 'public'),
    );
  }
  return map;
}

export function parsePrivateKeys(raw: string): Map<number, KeyObject> {
  const map = new Map<number, KeyObject>();
  for (const [version, pem] of entries('KEK_PRIVATE_KEYS', raw)) {
    map.set(
      version,
      checked('KEK_PRIVATE_KEYS', () => createPrivateKey(pem), 'private'),
    );
  }
  return map;
}

export function parseActiveVersion(
  raw: string | undefined,
  available: ReadonlyMap<number, unknown>,
): number {
  const version = Number(raw);
  if (raw === undefined || !Number.isInteger(version) || !available.has(version)) {
    throw new KekConfigError(
      'KEK_ACTIVE_VERSION',
      'must name a version present in KEK_PUBLIC_KEYS',
    );
  }
  return version;
}
