import { createHmac } from 'node:crypto';
import type { Fingerprinter } from '../application/ports.js';

/** HMAC-SHA-256 of a key under the active pepper (TD-D6). Old fingerprints keep their own pepper version. */
export class HmacFingerprinter implements Fingerprinter {
  constructor(
    private readonly peppers: ReadonlyMap<number, Buffer>,
    private readonly active: number,
  ) {
    if (!peppers.has(active)) throw new Error('KEY_FINGERPRINT_PEPPER_ACTIVE must name a version in KEY_FINGERPRINT_PEPPERS');
  }

  fingerprint(key: Buffer): { readonly hex: string; readonly pepperVersion: number } {
    const pepper = this.peppers.get(this.active) as Buffer;
    return { hex: createHmac('sha256', pepper).update(key).digest('hex'), pepperVersion: this.active };
  }
}
