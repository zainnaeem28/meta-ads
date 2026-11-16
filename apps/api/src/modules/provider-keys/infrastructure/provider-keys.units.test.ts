import { describe, expect, it, vi } from 'vitest';
import { HmacFingerprinter } from './fingerprinter.js';
import { NoJobsInFlight } from './in-flight.js';
import { KeyConfigError, fingerprinterFromEnv, keyPolicyFromEnv } from './key-config.js';
import { EgressProviderProbe, PROBE_URLS } from './provider-probe.js';
import { checkKeyFormat, lastFour, normalizeKey } from '../domain/key-policy.js';

const PEPPER = Buffer.alloc(32, 7).toString('base64');

describe('key policy', () => {
  const formats = keyPolicyFromEnv({}).formats;
  it('trims, hints and checks formats', () => {
    expect(normalizeKey('  abc \n')).toBe('abc');
    expect(lastFour('sk-abcd')).toBe('abcd');
    expect(checkKeyFormat('wavespeed', 'sk-' + 'a'.repeat(30), formats)).toBe('wrong_provider');
    expect(checkKeyFormat('openai', 'nope', formats)).toBe('format');
    expect(checkKeyFormat('openai', 'sk-' + 'a'.repeat(30), formats)).toBeUndefined();
  });
});

describe('key config', () => {
  it('uses defaults and reads overrides', () => {
    expect(keyPolicyFromEnv({})).toMatchObject({ attemptsPerWindow: 5, windowMinutes: 10, autoDisableThreshold: 5 });
    expect(keyPolicyFromEnv({ KEY_ENTRY_ATTEMPTS_PER_WINDOW: '3' }).attemptsPerWindow).toBe(3);
  });
  it.each([
    [{ KEY_ENTRY_WINDOW_MIN: '0' }],
    [{ KEY_ENTRY_WINDOW_MIN: 'x' }],
    [{ KEY_FORMAT_OPENAI: 'sk-.*' }],
    [{ KEY_FORMAT_OPENAI: '^($' }],
  ])('rejects %j', (env) => {
    expect(() => keyPolicyFromEnv(env)).toThrow(KeyConfigError);
  });
  it('builds the fingerprinter and refuses bad settings', () => {
    const f = fingerprinterFromEnv({ KEY_FINGERPRINT_PEPPERS: JSON.stringify({ '1': PEPPER }), KEY_FINGERPRINT_PEPPER_ACTIVE: '1' });
    const a = f.fingerprint(Buffer.from('k'));
    expect(a.hex).toHaveLength(64);
    expect(a.pepperVersion).toBe(1);
    const bad: Record<string, string | undefined>[] = [
      {},
      { KEY_FINGERPRINT_PEPPERS: 'not json' },
      { KEY_FINGERPRINT_PEPPERS: '[]' },
      { KEY_FINGERPRINT_PEPPERS: JSON.stringify({ '1': 'c2hvcnQ=' }) },
      { KEY_FINGERPRINT_PEPPERS: JSON.stringify({ '1': PEPPER }), KEY_FINGERPRINT_PEPPER_ACTIVE: '2' },
    ];
    for (const env of bad) expect(() => fingerprinterFromEnv(env)).toThrow(KeyConfigError);
    expect(() => new HmacFingerprinter(new Map(), 1)).toThrow();
  });
});

describe('NoJobsInFlight', () => {
  it('is zero', async () => {
    expect(await new NoJobsInFlight().countForKey()).toBe(0);
  });
});

describe('EgressProviderProbe', () => {
  const probeWith = (impl: () => Promise<{ status: number }>) => {
    const fetch = vi.fn(impl);
    return { probe: new EgressProviderProbe({ fetch } as never), fetch };
  };
  it.each([
    [401, 'invalid'],
    [200, 'valid'],
    [403, 'unknown'],
    [429, 'unknown'],
    [500, 'unknown'],
  ])('maps %i to %s', async (status, expected) => {
    const { probe, fetch } = probeWith(() => Promise.resolve({ status }));
    expect(await probe.probe('openai', 'k')).toBe(expected);
    expect(fetch).toHaveBeenCalledWith('openai', expect.objectContaining({ url: PROBE_URLS.openai, timeoutMs: 5000 }));
  });
  it('maps a failure to unknown without throwing', async () => {
    const { probe } = probeWith(() => Promise.reject(new Error('boom')));
    expect(await probe.probe('wavespeed', 'k')).toBe('unknown');
  });
});
