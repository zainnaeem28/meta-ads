// ProviderProbePort (ARCHITECTURE §1.3, TD-D8): a non-billing authentication check of a key. No framework import here.

import type { Provider } from './key-wrap.js';

export const PROVIDER_PROBE_PORT = Symbol('PROVIDER_PROBE_PORT');

/** `valid`: the provider accepted the key. `invalid`: it refused it (401). `unknown`: anything else (403, 429, 5xx, timeout). */
export type ProbeResult = 'valid' | 'invalid' | 'unknown';

export interface ProviderProbePort {
  /** Never throws on a provider or network failure (that is `unknown`) and never logs or returns the key. */
  probe(provider: Provider, key: string): Promise<ProbeResult>;
}
