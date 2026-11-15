import { describe, expect, it } from 'vitest';
import { PROVIDER_VENDORS, complianceRegister } from './compliance-register.js';
import type { ComplianceRegister } from './compliance-register.js';
import { validateConfig } from './schema.js';
import { validEnv } from './test-env.js';

describe('TC-NFR-09: PROVIDER_DATA_MODE_<VENDOR> gate keys', () => {
  it('every vendor defaults to synthetic', () => {
    const result = validateConfig('worker', validEnv('worker'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const vendor of PROVIDER_VENDORS) {
        expect((result.config as Record<string, unknown>)[`PROVIDER_DATA_MODE_${vendor}`]).toBe(
          'synthetic',
        );
      }
    }
  });

  it('the shipped compliance register records no contract yet', () => {
    for (const vendor of PROVIDER_VENDORS)
      expect(complianceRegister.hasRecordedContract(vendor)).toBe(false);
  });

  for (const vendor of PROVIDER_VENDORS) {
    const key = `PROVIDER_DATA_MODE_${vendor}`;
    it(`${key}=real is refused without a recorded contract (negative test)`, () => {
      const result = validateConfig('worker', validEnv('worker', { [key]: 'real' }));
      expect(result).toEqual({ ok: false, issues: [{ key, fault: 'invalid' }] });
    });
    it(`${key}=real is accepted once the register records that vendor, and only that vendor`, () => {
      const register: ComplianceRegister = { hasRecordedContract: (v) => v === vendor };
      expect(validateConfig('worker', validEnv('worker', { [key]: 'real' }), { register }).ok).toBe(
        true,
      );
      const other = PROVIDER_VENDORS.find((v) => v !== vendor) as string;
      expect(
        validateConfig('worker', validEnv('worker', { [`PROVIDER_DATA_MODE_${other}`]: 'real' }), {
          register,
        }).ok,
      ).toBe(false);
    });
    it(`${key} rejects values other than synthetic and real`, () => {
      expect(validateConfig('worker', validEnv('worker', { [key]: 'live' })).ok).toBe(false);
    });
  }

  it('an unknown vendor key is refused rather than ignored', () => {
    const result = validateConfig(
      'worker',
      validEnv('worker', { PROVIDER_DATA_MODE_ACME: 'synthetic' }),
    );
    expect(result).toEqual({
      ok: false,
      issues: [{ key: 'PROVIDER_DATA_MODE_ACME', fault: 'invalid' }],
    });
  });
});
