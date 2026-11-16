import { Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiApp } from '../../bootstrap/api.module.js';
import type { ApiApp } from '../../bootstrap/api.module.js';
import { createHttpLogging } from '../logging/index.js';
import { corsOptions } from './cors.js';
import { MethodIndex } from './method-index.js';
import {
  Scope,
  assertScopesDeclared,
  collectRouteScopes,
  needsSession,
  scopeProblems,
} from './scope-registry.js';

// TC-ERR-03, TC-ZT-05, TC-ZT-08, TC-AUT-01 through the api composition root (in process).

const ORIGIN = 'https://app.example.test';

class Deny implements CanActivate {
  canActivate(): boolean {
    throw new Error('guard must not run for route misses');
  }
}

@Controller('drafts')
@Scope('U')
@UseGuards(Deny)
class DraftsController {
  @Get()
  list(): unknown[] {
    return [];
  }
  @Post()
  create(): { ok: true } {
    return { ok: true };
  }
  @Get(':draftId')
  one(): { ok: true } {
    return { ok: true };
  }
  @Put(':draftId')
  put(): { ok: true } {
    return { ok: true };
  }
}

@Controller('loose')
class UnscopedController {
  @Get()
  loose(): string {
    return 'z';
  }
}

@Controller('metrics-bare')
class BareMetricsController {
  @Get()
  @Scope('M')
  bare(): string {
    return 'z';
  }
}

let current: ApiApp | undefined;
const logging = () => createHttpLogging({ level: 'silent' });
const boot = async (
  extra: (new () => object)[] = [DraftsController],
  env = 'development' as const,
) => {
  current = await createApiApp({ WEB_ORIGIN: ORIGIN, APP_ENV: env }, logging(), extra);
  return current;
};

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

describe('method index (TC-ERR-03)', () => {
  it('answers 405 with the fixed Allow order, before any guard, never 401', async () => {
    const { app } = await boot();
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/drafts' });
    expect(res.statusCode).toBe(405);
    expect(res.headers['allow']).toBe('GET, HEAD, POST');
    expect(res.json()).toMatchObject({ success: false, error: { code: 'method_not_allowed' } });
    expect(res.json().metaData.requestId).toBe(res.headers['x-request-id']);
    const template = await app.inject({
      method: 'PATCH',
      url: '/api/v1/drafts/0198a5e0-0000-7000-8000-000000000001',
    });
    expect(template.statusCode).toBe(405);
    expect(template.headers['allow']).toBe('GET, HEAD, PUT');
    const withToken = await app.inject({
      method: 'DELETE',
      url: '/api/v1/drafts',
      headers: { authorization: 'Bearer x' },
    });
    expect(withToken.statusCode).toBe(405);
  });

  it('answers 404 for an unknown path with or without a token', async () => {
    const { app } = await boot();
    for (const headers of [{}, { authorization: 'Bearer nope' }]) {
      const res = await app.inject({ method: 'GET', url: '/api/v1/nowhere/at/all', headers });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
      expect(res.headers['allow']).toBeUndefined();
    }
    expect((await app.inject({ method: 'GET', url: '/api/v1/drafts/a/b' })).statusCode).toBe(404);
  });

  it('answers an undeclared method on the metrics paths with 405 and Allow: GET, HEAD', async () => {
    const { app } = await boot();
    for (const url of ['/internal/metrics', '/internal/metrics/window']) {
      for (const method of ['POST', 'PUT', 'DELETE'] as const) {
        const res = await app.inject({ method, url });
        expect(res.statusCode).toBe(405);
        expect(res.headers['allow']).toBe('GET, HEAD');
      }
    }
  });

  it('keeps OPTIONS out of the index and counts HEAD with GET', () => {
    const index = new MethodIndex();
    index.add('GET', '/a/:id');
    index.add('OPTIONS', '/a/:id');
    index.add('POST', '/a/:id');
    expect(index.entries().sort()).toEqual(['GET /a/:id', 'HEAD /a/:id', 'POST /a/:id']);
    expect(index.match('HEAD', '/a/7?x=1')).toEqual({ kind: 'found' });
    expect(index.match('OPTIONS', '/a/7')).toEqual({
      kind: 'method_not_allowed',
      allow: 'GET, HEAD, POST',
    });
    expect(index.match('GET', '/a/')).toEqual({ kind: 'not_found' });
  });

  it('serves a declared route normally', async () => {
    const { app, index } = await boot();
    const res = await app.inject({ method: 'POST', url: '/api/v1/drafts' });
    expect(res.statusCode).toBe(500); // the guard of this fixture throws; proves a matched route is not a route miss
    expect(index.entries()).toContain('GET /api/v1/drafts/:draftId');
    expect(index.entries()).toContain('GET /health/live');
  });
});

describe('CORS, headers and bounds (TC-ZT-05, TC-ZT-08)', () => {
  it('answers a foreign-origin preflight with 204 and no allow-origin', async () => {
    const { app } = await boot();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/drafts',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows the web origin only, with the documented methods and headers', async () => {
    const { app } = await boot();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/drafts',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'authorization,if-match',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-methods']).toBe('GET, POST, PUT, PATCH, DELETE');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    const actual = await app.inject({
      method: 'GET',
      url: '/api/v1/nowhere',
      headers: { origin: ORIGIN },
    });
    expect(actual.headers['access-control-expose-headers']).toBe(
      'X-Request-ID, ETag, Retry-After, Location',
    );
    expect(actual.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(corsOptions(ORIGIN).origin).toEqual([ORIGIN]);
  });

  it('sends security headers and no-store on every /api/v1 response, including misses', async () => {
    const { app } = await boot();
    for (const [method, url] of [
      ['GET', '/api/v1/nowhere'],
      ['DELETE', '/api/v1/drafts'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['content-security-policy']).toBeUndefined();
    }
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.headers['x-content-type-options']).toBe('nosniff');
    expect(live.headers['cache-control']).not.toBe('no-store');
    expect(live.headers['strict-transport-security']).toBeUndefined();
  });

  it('sends HSTS in production', async () => {
    // A hosted environment runs the Clerk adapter (TASK-033), which needs its two keys.
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_fixture');
    vi.stubEnv('CLERK_JWT_ISSUER', 'https://clerk.example.test');
    try {
      const { app } = await boot([DraftsController], 'production' as never);
      const res = await app.inject({ method: 'GET', url: '/health/live' });
      expect(res.headers['strict-transport-security']).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses a JSON body over 64 KiB with 413 in the envelope', async () => {
    const { app } = await boot();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/drafts',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('payload_too_large');
  });
});

describe('default-deny scope registry (TC-AUT-01)', () => {
  it('fails startup for a route without a scope', async () => {
    await expect(boot([UnscopedController])).rejects.toThrow(
      /UnscopedController\.loose: no scope declared/,
    );
  });

  it('fails startup for scope M without the metrics-token guard', async () => {
    await expect(boot([BareMetricsController])).rejects.toThrow(
      /scope M without the metrics-token guard/,
    );
  });

  it('accepts scope M with the guard and treats M and Pub as no session', async () => {
    const { app } = await boot();
    expect(() => assertScopesDeclared(app)).not.toThrow();
    const metrics = collectRouteScopes(app).filter((r) => r.scope === 'M');
    expect(metrics).toHaveLength(2);
    expect(metrics.every((r) => r.hasMetricsGuard)).toBe(true);
    expect(['M', 'Pub'].map((s) => needsSession(s as 'M'))).toEqual([false, false]);
    expect(['T', 'U', 'U+RA', 'A'].every((s) => needsSession(s as 'U'))).toBe(true);
  });

  it('reports an unknown scope', () => {
    expect(scopeProblems([{ route: 'X.y', scope: 'Q' as never, hasMetricsGuard: false }])).toEqual([
      'X.y: unknown scope Q',
    ]);
  });
});
