import { Inject, Injectable } from '@nestjs/common';
import { assertNoEgress } from '../../../platform/db/index.js';
import { EGRESS } from '../../../platform/egress/index.js';
import type { Egress } from '../../../platform/egress/index.js';
import type { Provider } from '../domain/key-wrap.js';
import type { ProbeResult, ProviderProbePort } from '../domain/provider-probe.js';

/** One fixed non-billing endpoint per provider (TD-D8). The URL is built here, never from a caller's input. */
export const PROBE_URLS: Readonly<Record<Provider, string>> = {
  openai: 'https://api.openai.com/v1/models',
  wavespeed: 'https://api.wavespeed.ai/api/v3/balance',
};

export const PROBE_TIMEOUT_MS = 5000;
/** The body is never read for meaning; this only bounds how much of it is drained. */
const PROBE_MAX_BYTES = 64 * 1024;

/**
 * ProviderProbePort over the egress client (allow-listed host, pinned address, 5 s whole-call limit). 401 is `invalid`,
 * 200 is `valid`, everything else (403, 429, 5xx, a timeout, a refused connection) is `unknown`. The request, the
 * response body and the key are never logged, and a provider error body that echoes the key goes nowhere (TC-KEY-06).
 */
@Injectable()
export class EgressProviderProbe implements ProviderProbePort {
  constructor(@Inject(EGRESS) private readonly egress: Pick<Egress, 'fetch'>) {}

  async probe(provider: Provider, key: string): Promise<ProbeResult> {
    assertNoEgress('provider key probe');
    try {
      const response = await this.egress.fetch(provider, {
        url: PROBE_URLS[provider],
        method: 'GET',
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        maxBytes: PROBE_MAX_BYTES,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (response.status === 401) return 'invalid';
      return response.status === 200 ? 'valid' : 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
