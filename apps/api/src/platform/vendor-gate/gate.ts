import { hasRecordedContract } from './register.js';
import type { VendorEntry, VendorRegister } from './register.js';

export type DataMode = 'synthetic' | 'real';

export class VendorGateError extends Error {
  constructor(
    readonly vendor: string,
    readonly reason: 'no-contract-record' | 'adapter-absent' | 'invalid-mode' | 'unknown-vendor',
  ) {
    super(`vendor gate: ${vendor} refused (${reason})`);
    this.name = 'VendorGateError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Enforces PROVIDER_DATA_MODE_<VENDOR> (T-14): a vendor adapter may run `real` only when the register holds its contract
 * record. Unset means `synthetic`. Checked at startup for every vendor and again before each adapter call.
 */
export class VendorGate {
  constructor(
    private readonly register: VendorRegister,
    private readonly env: Env,
  ) {}

  private entry(vendor: string): VendorEntry {
    const found = this.register.vendors.find((v) => v.id === vendor);
    if (found === undefined) throw new VendorGateError(vendor, 'unknown-vendor');
    return found;
  }

  /** The configured mode; a value other than `synthetic` or `real` is refused. */
  modeOf(vendor: string): DataMode {
    const key = this.entry(vendor).dataModeKey;
    const value = key === null ? undefined : this.env[key];
    if (value === undefined || value === '' || value === 'synthetic') return 'synthetic';
    if (value === 'real') return 'real';
    throw new VendorGateError(vendor, 'invalid-mode');
  }

  /** Throws unless the vendor's current mode is allowed; returns the mode otherwise. */
  assertAllowed(vendor: string): DataMode {
    const entry = this.entry(vendor);
    const mode = this.modeOf(vendor);
    if (mode === 'synthetic') return mode;
    if (this.register.absentAdapters.includes(vendor)) throw new VendorGateError(vendor, 'adapter-absent');
    if (!hasRecordedContract(entry)) throw new VendorGateError(vendor, 'no-contract-record');
    return mode;
  }

  /** The start-up check: every vendor with a mode key, plus any absent adapter that is asked for. */
  assertStartup(): void {
    for (const v of this.register.vendors) {
      if (v.dataModeKey !== null) this.assertAllowed(v.id);
    }
    if (this.register.absentAdapters.includes('shotstack') && this.env['ASSEMBLY_ADAPTER'] === 'shotstack') {
      throw new VendorGateError('shotstack', 'adapter-absent');
    }
  }

  /** Call-time guard: runs `call` only after the gate allows the vendor's mode again. */
  async guard<T>(vendor: string, call: (mode: DataMode) => Promise<T>): Promise<T> {
    return call(this.assertAllowed(vendor));
  }
}

/** Wraps an adapter so every function property passes the call-time check first. */
export function gatedAdapter<A extends object>(gate: VendorGate, vendor: string, adapter: A): A {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        gate.assertAllowed(vendor);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
