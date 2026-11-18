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

// The web's local-session route (`/local-token`, AUTH_MODE=local) asks the api for a bearer with POST /api/v1/dev/token,
// a route that exists only with IDENTITY_MODE=local. This stack runs the clerk identity path, so that one call is
// answered here with a token signed by the same throwaway key the api verifies against, for the synthetic account whose
// email the web's session cookie carries (sessions file written by the stack harness). Any other email is refused.
const signingKeyFile = process.env.BASELINE_SIGNING_KEY_FILE;
const sessionsFile = process.env.BASELINE_SESSIONS_FILE;
const issuer = process.env.CLERK_JWT_ISSUER;
if (signingKeyFile && sessionsFile) {
  const { createPrivateKey, createSign } = await import('node:crypto');
  const { Server } = await import('node:http');
  const b64u = (v) => Buffer.from(v).toString('base64url');
  const realEmit = Server.prototype.emit;
  Server.prototype.emit = function baselineEmit(event, req, res, ...rest) {
    if (
      event !== 'request' ||
      req.method !== 'POST' ||
      req.url?.split('?')[0] !== '/api/v1/dev/token'
    )
      return realEmit.call(this, event, req, res, ...rest);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      try {
        const email = String(
          JSON.parse(Buffer.concat(chunks).toString('utf8')).email ?? '',
        ).toLowerCase();
        const sessions = JSON.parse(readFileSync(sessionsFile, 'utf8'));
        const match = sessions.find((s) => s.email.toLowerCase() === email);
        if (!match) return send(404, { success: false });
        const key = createPrivateKey(readFileSync(signingKeyFile));
        const now = Math.floor(Date.now() / 1000);
        const head = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: match.kid }))}.${b64u(
          JSON.stringify({
            iss: issuer,
            sub: match.sub,
            sid: `sess_${match.sub}`,
            iat: now,
            exp: now + 3600,
            fva: [1, 1],
          }),
        )}`;
        const token = `${head}.${createSign('RSA-SHA256').update(head).sign(key).toString('base64url')}`;
        return send(200, {
          success: true,
          data: { token, sub: match.sub, expiresInSeconds: 3600 },
        });
      } catch {
        return send(400, { success: false });
      }
    });
    return true;
  };
}
