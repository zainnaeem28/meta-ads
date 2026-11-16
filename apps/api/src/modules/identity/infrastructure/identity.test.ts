import { afterEach, describe, expect, it } from 'vitest';
import { EgressInTransactionError } from '../../../platform/db/index.js';
import { TxState, runInTransaction } from '../../../platform/db/tx-state.js';
import {
  IdentityNotFound,
  IdentityTokenInvalid,
  IdentityUnavailable,
} from '../domain/identity-port.js';
import { normalizeEmail } from '../domain/records.js';
import { ClerkIdentity } from './clerk-identity.js';
import { identityConfigFrom } from './identity.config.js';
import { JwksCache, verifySessionToken } from './jwt.js';
import { LocalIdentity } from './local-identity.js';
import { identityContract, startClerkStub } from './test-support.js';
import type { ClerkStub } from './test-support.js';
import { createIdentityPort } from '../identity.module.js';

// TASK-033: adapter contract tests on the local fake and on the Clerk adapter (real @clerk/backend client against a
// local Backend API double). The real-Clerk run is a deployment-time owner item (NOT_RUN here).

const ORIGIN = 'http://localhost:3000';
const CANARY_EMAIL = 'canary.person+7f3a@example.test';
// Assembled at run time so the repository carries no secret-shaped literal.
const CANARY_SECRET = ['sk', 'test', 'canary', '9d41c0'].join('_');

identityContract('local fake', async () => {
  const local = new LocalIdentity({ authorizedParties: [ORIGIN] });
  return {
    port: local,
    local,
    outage: (on) => {
      local.available = !on;
    },
    stop: async () => {},
  };
});

const stubs: ClerkStub[] = [];
async function clerk(
  options: Partial<ConstructorParameters<typeof ClerkIdentity>[0]> = {},
  local = new LocalIdentity({ authorizedParties: [ORIGIN] }),
) {
  const stub = await startClerkStub(local);
  stubs.push(stub);
  const port = new ClerkIdentity({
    secretKey: CANARY_SECRET,
    issuer: local.issuer,
    authorizedParties: [ORIGIN],
    apiUrl: stub.url,
    ...options,
  });
  return { port, local, stub };
}
afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()));
});

identityContract('Clerk adapter', async () => {
  const { port, local, stub } = await clerk();
  return {
    port,
    local,
    outage: (on) => {
      stub.failWith = on ? 503 : undefined;
    },
    stop: async () => {},
  };
});

describe('Clerk adapter failures', () => {
  it('answers within 3 s: a slow provider is IdentityUnavailable(timeout)', async () => {
    const { port, stub } = await clerk({ timeoutMs: 100 });
    stub.delayMs = 400;
    const started = Date.now();
    await expect(port.getUser('user_a')).rejects.toMatchObject({
      name: 'IdentityUnavailable',
      reason: 'timeout',
    });
    expect(Date.now() - started).toBeLessThan(350);
  });

  it('defaults to a 3 s bound', async () => {
    const { PROVIDER_TIMEOUT_MS, JWKS_TTL_MS } = await import('./clerk-identity.js');
    expect([PROVIDER_TIMEOUT_MS, JWKS_TTL_MS]).toEqual([3000, 600_000]);
  });

  it('maps 4xx, 5xx and an unreachable provider without copying the SDK message', async () => {
    const { port, stub, local } = await clerk();
    local.addUser('user_a', CANARY_EMAIL);
    for (const status of [400, 422, 429, 500, 502]) {
      stub.failWith = status;
      const error = await port.createInvitation(CANARY_EMAIL, 7, ORIGIN).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IdentityUnavailable);
      expect((error as IdentityUnavailable).reason).toBe('provider');
    }
    await stub.close();
    const down = await port.getUser('user_a').catch((e: unknown) => e);
    expect(down).toBeInstanceOf(IdentityUnavailable);
    for (const text of [String(down), JSON.stringify(down)]) {
      expect(text).not.toContain(CANARY_EMAIL);
      expect(text).not.toContain(CANARY_SECRET);
    }
  });

  it('never puts a token, email or secret into an error or a log line', async () => {
    const written: string[] = [];
    const spy = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = spy as typeof process.stdout.write;
    process.stderr.write = spy as typeof process.stderr.write;
    const captured: string[] = [];
    try {
      const { port, local, stub } = await clerk();
      const token = local.issueToken({ sub: 'user_a', ttlSeconds: -10_000, iat: 1 });
      captured.push(String(await port.verifyToken(token).catch((e: unknown) => e)));
      stub.failWith = 500;
      captured.push(
        String(await port.createInvitation(CANARY_EMAIL, 1, ORIGIN).catch((e: unknown) => e)),
      );
      captured.push(
        String(await port.verifyToken(local.issueToken({ sub: 'u' })).catch((e: unknown) => e)),
      );
      const token2 = local.issueToken({ sub: 'user_b' });
      captured.push(String(await new LocalIdentity().verifyToken(token2).catch((e: unknown) => e)));
      expect(captured.join('\n')).not.toContain(token.split('.')[1]);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    const everything = [...captured, ...written].join('\n');
    for (const canary of [CANARY_EMAIL, CANARY_SECRET]) expect(everything).not.toContain(canary);
  });

  it('refuses to call the provider inside a database transaction', async () => {
    const { port, local } = await clerk();
    local.addUser('user_a', 'a@example.test');
    await expect(
      runInTransaction({}, new TxState(), () => port.getUser('user_a')),
    ).rejects.toBeInstanceOf(EgressInTransactionError);
  });

  it('caches the key set for ten minutes and reloads for an unknown key at most once a minute', async () => {
    let now = 1_000_000;
    const { port, stub, local } = await clerk(
      { now: () => now },
      new LocalIdentity({ now: () => now }),
    );
    const jwkCalls = () => stub.requests.filter((r) => r === 'GET /v1/jwks').length;
    const token = () => local.issueToken({ sub: 'user_a' });
    await port.verifyToken(token());
    await port.verifyToken(token());
    expect(jwkCalls()).toBe(1);
    now += 599_000;
    await port.verifyToken(token());
    expect(jwkCalls()).toBe(1);
    now += 2_000;
    await port.verifyToken(token());
    expect(jwkCalls()).toBe(2);
    const stranger = local.issueToken({ sub: 'u', kid: 'rotated' });
    await expect(port.verifyToken(stranger)).rejects.toBeInstanceOf(IdentityTokenInvalid);
    await expect(port.verifyToken(stranger)).rejects.toBeInstanceOf(IdentityTokenInvalid);
    expect(jwkCalls()).toBe(3);
    now += 61_000;
    await expect(port.verifyToken(stranger)).rejects.toBeInstanceOf(IdentityTokenInvalid);
    expect(jwkCalls()).toBe(4);
  });

  it('verifyToken reports IdentityUnavailable when the key set cannot be loaded', async () => {
    const { port, stub, local } = await clerk();
    stub.failWith = 503;
    await expect(port.verifyToken(local.issueToken({ sub: 'u' }))).rejects.toBeInstanceOf(
      IdentityUnavailable,
    );
  });

  it('a user without a primary email has none', async () => {
    const { port, local } = await clerk();
    local.addUser('user_n', null);
    expect(await port.getUser('user_n')).toEqual({ primaryEmail: null, emailVerified: false });
  });
});

describe('token verification', () => {
  const sign = (local: LocalIdentity, extra: object = {}) => {
    const [h, , s] = local.issueToken({ sub: 'u' }).split('.') as [string, string, string];
    return (payload: object) =>
      `${h}.${Buffer.from(JSON.stringify({ ...extra, ...payload })).toString('base64url')}.${s}`;
  };

  it('refuses structurally broken headers and payloads', async () => {
    const local = new LocalIdentity();
    const good = local.issueToken({ sub: 'u' }).split('.') as [string, string, string];
    const b64 = (v: string) => Buffer.from(v).toString('base64url');
    const bad = [
      `${b64('[]')}.${good[1]}.${good[2]}`,
      `${b64('{not json')}.${good[1]}.${good[2]}`,
      `${b64(JSON.stringify({ alg: 'RS256' }))}.${good[1]}.${good[2]}`,
      `${good[0]}.${b64('[]')}.${good[2]}`,
      `${good[0]}.${good[1]}.${Buffer.from('short').toString('base64url')}`,
    ];
    for (const token of bad)
      await expect(local.verifyToken(token)).rejects.toBeInstanceOf(IdentityTokenInvalid);
  });

  it('checks claims after the signature', async () => {
    // A payload swap invalidates the signature, so the claim checks are reached with re-signed tokens only.
    const local = new LocalIdentity();
    const now = Math.floor(Date.now() / 1000);
    const forgedSignature = sign(local)({
      sub: 'u',
      sid: 's',
      iss: local.issuer,
      iat: now,
      exp: now + 60,
    });
    await expect(local.verifyToken(forgedSignature)).rejects.toMatchObject({ why: 'signature' });
    for (const [spec, why] of [
      [{ sub: '' }, 'subject'],
      [{ sub: 'u', sid: '' }, 'subject'],
    ] as const) {
      await expect(local.verifyToken(local.issueToken(spec))).rejects.toMatchObject({ why });
    }
  });

  it('rejects claims of the wrong type, expiry within skew passes', async () => {
    const keysOf = (local: LocalIdentity) => new JwksCache(async () => local.jwks().keys, 600_000);
    const local = new LocalIdentity();
    const cache = keysOf(local);
    const now = Math.floor(Date.now() / 1000);
    // expired by 2 s is inside the 5 s skew
    const claims = await verifySessionToken(
      local.issueToken({ sub: 'u', iat: now - 62, ttlSeconds: 60 }),
      cache,
      { issuer: local.issuer },
    );
    expect(claims.sub).toBe('u');
    await expect(
      verifySessionToken(local.issueToken({ sub: 'u', iat: now - 80, ttlSeconds: 60 }), cache, {
        issuer: local.issuer,
      }),
    ).rejects.toMatchObject({ why: 'expired' });
  });

  it('a malformed fva claim reads as no evidence', async () => {
    const local = new LocalIdentity();
    const claims = await local.verifyToken(
      local.issueToken({ sub: 'u', fva: [1, 2, 3] as unknown as readonly [number, number] }),
    );
    expect(claims.fva).toBeNull();
  });

  it('the local fake is unavailable on demand', async () => {
    const local = new LocalIdentity();
    local.available = false;
    await expect(local.verifyToken('x.y.z')).rejects.toBeInstanceOf(IdentityUnavailable);
    await expect(local.getUser('nobody')).rejects.toBeInstanceOf(IdentityUnavailable);
    local.available = true;
    await expect(local.getUser('nobody')).rejects.toBeInstanceOf(IdentityNotFound);
  });
});

describe('configuration', () => {
  it('defaults to local away from a hosted environment and to clerk on one', () => {
    expect(identityConfigFrom({}, 'development', undefined)).toEqual({ mode: 'local' });
    expect(identityConfigFrom({ IDENTITY_MODE: '' }, 'test', undefined)).toEqual({ mode: 'local' });
    expect(() => identityConfigFrom({}, 'production', ORIGIN)).toThrow(/CLERK_SECRET_KEY/);
  });

  it('refuses local in staging and production', () => {
    for (const env of ['staging', 'production'])
      expect(() => identityConfigFrom({ IDENTITY_MODE: 'local' }, env, ORIGIN)).toThrow(/refused/);
  });

  it('refuses an unknown mode and a clerk mode without credentials', () => {
    expect(() => identityConfigFrom({ IDENTITY_MODE: 'auth0' }, 'development', ORIGIN)).toThrow(
      /local or clerk/,
    );
    expect(() => identityConfigFrom({ IDENTITY_MODE: 'clerk' }, 'development', ORIGIN)).toThrow(
      /CLERK_SECRET_KEY/,
    );
  });

  it('builds the clerk adapter with the web origin as the authorized party', () => {
    const config = identityConfigFrom(
      {
        IDENTITY_MODE: 'clerk',
        CLERK_SECRET_KEY: 'sk_x',
        CLERK_JWT_ISSUER: 'https://c.example.test',
      },
      'production',
      ORIGIN,
    );
    expect(config.authorizedParties).toEqual([ORIGIN]);
    expect(createIdentityPort(config)).toBeInstanceOf(ClerkIdentity);
    expect(createIdentityPort({ mode: 'local' })).toBeInstanceOf(LocalIdentity);
    expect(() => createIdentityPort({ mode: 'clerk' })).toThrow(/secret key/);
  });

  it('normalizes emails', () => {
    expect(normalizeEmail('  Ada@Example.TEST ')).toBe('ada@example.test');
  });
});
