/* global process, Response */
// Preloaded into the api process of the baseline stack (`node --import`). The api verifies session tokens against the
// identity provider's key set, fetched from the provider's backend API. The baseline stack has no provider account, so
// this answers that one call (GET /v1/jwks) from the key set file the stack harness wrote; every other request goes
// through untouched. The product code is not changed and no provider is contacted.
import { readFileSync } from 'node:fs';

const jwksFile = process.env.BASELINE_JWKS_FILE;
if (!jwksFile) throw new Error('BASELINE_JWKS_FILE is required by the baseline preload');

const realFetch = globalThis.fetch;
globalThis.fetch = async function baselineFetch(input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('https://api.clerk.com/v1/jwks')) {
    return new Response(readFileSync(jwksFile, 'utf8'), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(input, init);
};
