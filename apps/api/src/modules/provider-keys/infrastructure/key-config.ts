import { HmacFingerprinter } from './fingerprinter.js';
import { PROVIDERS } from '../domain/key-wrap.js';
import type { Provider } from '../domain/key-wrap.js';
import type { KeyPolicy } from '../application/ports.js';

// Reads the provider-keys settings of the api environment (ARCHITECTURE §6). Errors name the variable, never a value.

export class KeyConfigError extends Error {
  constructor(variable: string, reason: string) {
    super(`${variable}: ${reason}`);
    this.name = 'KeyConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const DEFAULT_FORMATS: Record<Provider, string> = {
  openai: '^sk-[A-Za-z0-9_-]{20,}$',
  wavespeed: '^[A-Za-z0-9_-]{20,}$',
};
const FORMAT_VARIABLES: Record<Provider, string> = {
  openai: 'KEY_FORMAT_OPENAI',
  wavespeed: 'KEY_FORMAT_WAVESPEED',
};

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new KeyConfigError(name, `must be an integer from ${String(min)} to ${String(max)}`);
  }
  return value;
}

function format(env: Env, provider: Provider): RegExp {
  const name = FORMAT_VARIABLES[provider];
  const raw = env[name] ?? DEFAULT_FORMATS[provider];
  if (!raw.startsWith('^') || !raw.endsWith('$')) throw new KeyConfigError(name, 'must be anchored (^...$)');
  try {
    return new RegExp(raw);
  } catch {
    throw new KeyConfigError(name, 'is not a valid expression');
  }
}

export function keyPolicyFromEnv(env: Env): KeyPolicy {
  return {
    attemptsPerWindow: integer(env, 'KEY_ENTRY_ATTEMPTS_PER_WINDOW', 5, 1, 50),
    windowMinutes: integer(env, 'KEY_ENTRY_WINDOW_MIN', 10, 1, 60),
    autoDisableThreshold: integer(env, 'KEY_AUTO_DISABLE_THRESHOLD', 5, 1, 20),
    formats: Object.fromEntries(PROVIDERS.map((p) => [p, format(env, p)])) as Record<Provider, RegExp>,
  };
}

/** `KEY_FINGERPRINT_PEPPERS` (JSON map of version to base64, at least 32 bytes each) and `KEY_FINGERPRINT_PEPPER_ACTIVE`. */
export function fingerprinterFromEnv(env: Env): HmacFingerprinter {
  const raw = env['KEY_FINGERPRINT_PEPPERS'];
  if (raw === undefined) throw new KeyConfigError('KEY_FINGERPRINT_PEPPERS', 'is required');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KeyConfigError('KEY_FINGERPRINT_PEPPERS', 'is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new KeyConfigError('KEY_FINGERPRINT_PEPPERS', 'must be a JSON map of version to base64');
  }
  const peppers = new Map<number, Buffer>();
  for (const [version, value] of Object.entries(parsed)) {
    const number = Number(version);
    const bytes = typeof value === 'string' ? Buffer.from(value, 'base64') : undefined;
    if (!Number.isInteger(number) || number <= 0 || number > 32767 || bytes === undefined || bytes.length < 32) {
      throw new KeyConfigError('KEY_FINGERPRINT_PEPPERS', 'versions must be positive integers with at least 32 bytes of base64');
    }
    peppers.set(number, bytes);
  }
  const active = Number(env['KEY_FINGERPRINT_PEPPER_ACTIVE']);
  if (!peppers.has(active)) {
    throw new KeyConfigError('KEY_FINGERPRINT_PEPPER_ACTIVE', 'must name a version present in KEY_FINGERPRINT_PEPPERS');
  }
  return new HmacFingerprinter(peppers, active);
}
