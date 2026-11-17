import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDER_VENDORS, complianceRegister } from '../config/index.js';
import { VendorGate, VendorGateError, gateInstance, gatedAdapter } from './gate.js';
import { EMPTY_REGISTER, REQUIRED_VENDOR_IDS, diffRegister, loadRegister, locateRegister, parseRegister } from './register.js';
import type { VendorRegister } from './register.js';

// TC-NFR-09, TC-ZT-vendor: the vendor register and the PROVIDER_DATA_MODE_<VENDOR> gate.

const shipped = loadRegister();
const MODE_KEY: Record<string, string> = {
  clerk: 'PROVIDER_DATA_MODE_CLERK',
  'cloudflare-r2': 'PROVIDER_DATA_MODE_R2',
  openai: 'PROVIDER_DATA_MODE_OPENAI',
  wavespeed: 'PROVIDER_DATA_MODE_WAVESPEED',
};

function recorded(register: VendorRegister, id: string): VendorRegister {
  return {
    ...register,
    vendors: register.vendors.map((v) =>
      v.id === id ? { ...v, contractStatus: 'recorded', contractRecord: { reference: 'CREG-1', recordedOn: '2026-12-01' } } : v,
    ),
  };
}

describe('the shipped register', () => {
  it('is complete against the ARCHITECTURE §12 integration records (diff)', () => {
    expect(locateRegister()).toMatch(/docs\/compliance\/vendor-register\.json$/);
    expect(diffRegister(shipped)).toEqual({ missing: [], unexpected: [], duplicates: [] });
    for (const v of shipped.vendors) {
      expect(v.receives.length).toBeGreaterThan(0);
      expect(v.contractNeeded.length).toBeGreaterThan(0);
    }
  });

  it('records no contract yet, and agrees with the configuration check', () => {
    for (const v of shipped.vendors) expect(v.contractRecord).toBeNull();
    for (const vendor of PROVIDER_VENDORS) expect(complianceRegister.hasRecordedContract(vendor)).toBe(false);
  });

  it('the diff reports a missing, an unexpected and a duplicate vendor', () => {
    const reduced: VendorRegister = {
      ...shipped,
      vendors: [...shipped.vendors.filter((v) => v.id !== 'clerk'), { ...shipped.vendors[0]!, id: 'acme' }, shipped.vendors[1]!],
    };
    const diff = diffRegister(reduced);
    expect(diff.missing).toContain('clerk');
    expect(diff.unexpected).toContain('acme');
    expect(diff.duplicates).toContain(shipped.vendors[1]!.id);
    expect(REQUIRED_VENDOR_IDS).toContain('clerk');
  });
});

describe('register parsing fails closed', () => {
  it('a missing path, bad JSON and bad shapes yield the empty register', () => {
    expect(loadRegister('/nonexistent/vendor-register.json')).toBe(EMPTY_REGISTER);
    expect(parseRegister('not json')).toBe(EMPTY_REGISTER);
    expect(parseRegister('{}')).toBe(EMPTY_REGISTER);
    expect(parseRegister('{"vendors":[1],"absentAdapters":[]}')).toBe(EMPTY_REGISTER);
    const e = { ...shipped.vendors[0]! };
    const bad = (patch: object, absent: unknown = []) =>
      parseRegister(JSON.stringify({ vendors: [{ ...e, ...patch }], absentAdapters: absent }));
    expect(bad({ contractStatus: 'maybe' })).toBe(EMPTY_REGISTER);
    expect(bad({ id: '' })).toBe(EMPTY_REGISTER);
    expect(bad({ dataModeKey: 5 })).toBe(EMPTY_REGISTER);
    expect(bad({ contractRecord: 'x' })).toBe(EMPTY_REGISTER);
    expect(bad({ contractRecord: { reference: '' } })).toBe(EMPTY_REGISTER);
    expect(bad({}, [1])).toBe(EMPTY_REGISTER);
    expect(bad({}).vendors).toHaveLength(1);
    expect(bad({ contractStatus: 'recorded', contractRecord: { reference: 'r', recordedOn: 'd' } }).vendors[0]!.contractRecord).not.toBeNull();
  });

  for (const [vendor, key] of Object.entries(MODE_KEY)) {
    it(`an empty register refuses to start with ${key}=real, and with no mode set`, () => {
      expect(() => new VendorGate(EMPTY_REGISTER, { [key]: 'real' }).assertStartup()).toThrow(VendorGateError);
      expect(() => new VendorGate(EMPTY_REGISTER, {}).assertStartup()).toThrow(/register-incomplete/);
      expect(vendor).toBeTruthy();
    });
  }

  it('a mode key for a vendor the register does not know is refused', () => {
    expect(() => new VendorGate(shipped, { PROVIDER_DATA_MODE_ACME: 'real' }).assertStartup()).toThrowError(
      new VendorGateError('acme', 'unknown-vendor'),
    );
  });

  it('gateInstance wraps a live class instance (inherited methods too) and refuses once the env turns real', () => {
    class Base { ping(): string { return 'pong'; } }
    class Adapter extends Base { value = 1; send(x: string): string { return x; } }
    const env: Record<string, string | undefined> = {};
    const gate = new VendorGate(shipped, env);
    const a = new Adapter();
    gateInstance(gate, 'openai', a);
    gateInstance(gate, 'openai', a);
    expect(a.send('ok')).toBe('ok');
    expect(a.value).toBe(1);
    env['PROVIDER_DATA_MODE_OPENAI'] = 'real';
    expect(() => a.send('x')).toThrow(VendorGateError);
    expect(() => a.ping()).toThrow(VendorGateError);
  });

  it('with an empty register every real mode is refused', () => {
    expect(() => new VendorGate(EMPTY_REGISTER, {}).assertAllowed('openai')).toThrow(VendorGateError);
  });
});

describe('every adapter refuses real without a register record (one test per vendor)', () => {
  for (const [vendor, key] of Object.entries(MODE_KEY)) {
    it(`${vendor}: ${key}=real is refused at startup and at call time, allowed once recorded`, async () => {
      const env = { [key]: 'real' };
      const gate = new VendorGate(shipped, env);
      expect(() => gate.assertStartup()).toThrowError(new VendorGateError(vendor, 'no-contract-record'));
      const calls: string[] = [];
      const adapter = gatedAdapter(gate, vendor, { send: (x: string) => calls.push(x), name: 'adapter' });
      expect(() => adapter.send('payload')).toThrow(VendorGateError);
      await expect(gate.guard(vendor, () => Promise.resolve('x'))).rejects.toBeInstanceOf(VendorGateError);
      expect(calls).toEqual([]);
      expect(adapter.name).toBe('adapter');
      // Recording only this vendor lets only this vendor through.
      const open = new VendorGate(recorded(shipped, vendor), env);
      expect(() => open.assertStartup()).not.toThrow();
      expect(gatedAdapter(open, vendor, { send: (x: string) => x }).send('ok')).toBe('ok');
      await expect(open.guard(vendor, (m) => Promise.resolve(m))).resolves.toBe('real');
      const other = Object.keys(MODE_KEY).find((v) => v !== vendor)!;
      expect(() => new VendorGate(recorded(shipped, other), env).assertStartup()).toThrow(VendorGateError);
    });
  }

  it('real Clerk, R2, OpenAI and WaveSpeed stay off in a default configuration', () => {
    const gate = new VendorGate(shipped, {});
    expect(() => gate.assertStartup()).not.toThrow();
    for (const vendor of Object.keys(MODE_KEY)) {
      expect(gate.modeOf(vendor)).toBe('synthetic');
      expect(gate.assertAllowed(vendor)).toBe('synthetic');
    }
    expect(new VendorGate(shipped, { PROVIDER_DATA_MODE_OPENAI: '' }).modeOf('openai')).toBe('synthetic');
  });

  it('a mode other than synthetic or real, and an unknown vendor, are refused', () => {
    expect(() => new VendorGate(shipped, { PROVIDER_DATA_MODE_OPENAI: 'live' }).assertStartup()).toThrowError(
      new VendorGateError('openai', 'invalid-mode'),
    );
    expect(() => new VendorGate(shipped, {}).assertAllowed('acme')).toThrowError(new VendorGateError('acme', 'unknown-vendor'));
    expect(new VendorGate(shipped, {}).modeOf('render')).toBe('synthetic');
  });
});

describe('Shotstack and KMS are descoped by ruling', () => {
  it('real Shotstack is refused even with a recorded contract, and so is the shotstack assembly adapter', () => {
    const open = recorded(shipped, 'shotstack');
    expect(() => new VendorGate(open, { PROVIDER_DATA_MODE_SHOTSTACK: 'real' }).assertStartup()).toThrowError(
      new VendorGateError('shotstack', 'adapter-absent'),
    );
    expect(() => new VendorGate(shipped, { ASSEMBLY_ADAPTER: 'shotstack' }).assertStartup()).toThrowError(
      new VendorGateError('shotstack', 'adapter-absent'),
    );
    expect(shipped.absentAdapters).toEqual(expect.arrayContaining(['shotstack', 'kms']));
  });

  it('no Shotstack or KMS adapter exists in the source tree', () => {
    const root = join(import.meta.dirname, '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/(shotstack|kms)/i.test(name) && !name.includes('vendor-gate')) offenders.push(path);
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !path.includes('vendor-gate')) {
          const text = readFileSync(path, 'utf8');
          if (/@aws-sdk\/client-kms|new\s+\w*(Shotstack|Kms)\w*(Adapter|Client)\b|api\.shotstack\.io/i.test(text)) offenders.push(path);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
