import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { SetMetadata } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import {
  AuthGuard,
  authorizeScope,
  bearerToken,
  requireMfa,
  requireRecentAuth,
  requireRole,
} from './auth.guard.js';
import type {
  ActorContext,
  AuthResult,
  AuthenticatedRequest,
  SessionAuthenticator,
} from './auth.guard.js';
import { DomainError } from './domain-error.js';
import { SCOPE_KEY } from './scope-registry.js';
import type { RouteScope } from './scope-registry.js';

const actor = (over: Partial<ActorContext> = {}): ActorContext => ({
  userId: 'u1',
  role: 'user',
  sessionId: 's1',
  mfa: { required: true, satisfied: true },
  recentAuth: { satisfied: true, maxAgeSeconds: 600 },
  authAgeMin: 1,
  ...over,
});
const linked = (over: Partial<ActorContext> = {}): AuthResult => ({
  linked: true,
  actor: actor(over),
});
const unlinked: AuthResult = { linked: false, session: { subject: 'sub' } };
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as DomainError).code;
  }
  return undefined;
};

describe('bearerToken', () => {
  it('reads one Bearer token, in any case, and nothing else', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer  abc')).toBe('abc');
    for (const header of [undefined, '', 'Basic abc', 'Bearer', 'Bearer a b', ['Bearer a']]) {
      expect(bearerToken(header as string | undefined)).toBeUndefined();
    }
  });
});

describe('requireRole, requireMfa, requireRecentAuth', () => {
  it('refuse with the registry codes', () => {
    expect(codeOf(() => requireRole(actor(), 'admin'))).toBe('forbidden_role');
    expect(codeOf(() => requireRole(actor({ role: 'admin' }), 'admin'))).toBeUndefined();
    expect(codeOf(() => requireMfa(actor({ mfa: { required: true, satisfied: false } })))).toBe(
      'mfa_required',
    );
    expect(
      codeOf(() => requireMfa(actor({ mfa: { required: false, satisfied: false } }))),
    ).toBeUndefined();
    expect(
      codeOf(() =>
        requireRecentAuth(actor({ recentAuth: { satisfied: false, maxAgeSeconds: 600 } })),
      ),
    ).toBe('recent_auth_required');
  });
});

describe('authorizeScope (decision order of SECURITY-DESIGN 7.1)', () => {
  const noMfa = { mfa: { required: true, satisfied: false } };
  const stale = { recentAuth: { satisfied: false, maxAgeSeconds: 600 } };
  it('lets an unlinked session reach only scope T', () => {
    expect(authorizeScope('T', unlinked)).toBeUndefined();
    for (const scope of ['U', 'U+RA', 'A'] as RouteScope[])
      expect(codeOf(() => authorizeScope(scope, unlinked))).toBe('not_linked');
  });
  it('does not enforce MFA, role or recent auth on scope T', () => {
    expect(authorizeScope('T', linked(noMfa))?.userId).toBe('u1');
  });
  it('checks MFA before role before recent authentication', () => {
    expect(codeOf(() => authorizeScope('A', linked(noMfa)))).toBe('mfa_required');
    expect(codeOf(() => authorizeScope('A', linked()))).toBe('forbidden_role');
    expect(codeOf(() => authorizeScope('A', linked({ role: 'admin' })))).toBeUndefined();
    expect(codeOf(() => authorizeScope('U', linked(noMfa)))).toBe('mfa_required');
    expect(codeOf(() => authorizeScope('U', linked(stale)))).toBeUndefined();
    expect(codeOf(() => authorizeScope('U+RA', linked(stale)))).toBe('recent_auth_required');
    expect(codeOf(() => authorizeScope('U+RA', linked()))).toBeUndefined();
  });
});

describe('AuthGuard', () => {
  class Handler {
    handle(): void {}
  }
  function context(
    request: Partial<AuthenticatedRequest>,
    scope: RouteScope | undefined,
  ): ExecutionContext {
    if (scope !== undefined) SetMetadata(SCOPE_KEY, scope)(Handler.prototype.handle);
    else Reflect.deleteMetadata(SCOPE_KEY, Handler.prototype.handle);
    return {
      getType: () => 'http',
      getHandler: () => Handler.prototype.handle,
      getClass: () => Handler,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }
  function setup(result: AuthResult | Error) {
    const calls = { authenticate: [] as string[], denied: [] as string[] };
    const sessions: SessionAuthenticator = {
      authenticate: async (token) => {
        calls.authenticate.push(token);
        if (result instanceof Error) throw result;
        return result;
      },
      recordDenied: async (_actor, requestId) => {
        calls.denied.push(requestId);
      },
    };
    return { guard: new AuthGuard(new Reflector(), sessions), calls };
  }
  const run = async (
    guard: AuthGuard,
    request: Partial<AuthenticatedRequest>,
    scope: RouteScope | undefined,
  ) => {
    try {
      return await guard.canActivate(context(request, scope));
    } catch (error) {
      return (error as DomainError).code;
    }
  };
  const bearer = {
    headers: { authorization: 'Bearer tok' },
    id: 'req1',
  } as Partial<AuthenticatedRequest>;

  it('passes Pub and M without reading a session', async () => {
    const { guard, calls } = setup(new Error('must not run'));
    expect(await run(guard, { headers: {} }, 'Pub')).toBe(true);
    expect(await run(guard, { headers: {} }, 'M')).toBe(true);
    expect(calls.authenticate).toEqual([]);
  });
  it('denies a route without a declared scope', async () => {
    expect(await run(setup(linked()).guard, bearer, undefined)).toBe('forbidden_role');
  });
  it('answers 401 without a Bearer token and passes the authenticator error through', async () => {
    expect(await run(setup(linked()).guard, { headers: {} }, 'U')).toBe('unauthenticated');
    expect(await run(setup(new DomainError('account_suspended', 'x')).guard, bearer, 'U')).toBe(
      'account_suspended',
    );
  });
  it('publishes the actor and user id of an allowed request', async () => {
    const { guard } = setup(linked());
    const request = { ...bearer } as AuthenticatedRequest;
    expect(await run(guard, request, 'U')).toBe(true);
    expect(request.userId).toBe('u1');
    expect(request.auth).toMatchObject({ linked: true });
  });
  it('lets an unlinked token through on T only, without a user id', async () => {
    const { guard } = setup(unlinked);
    const request = { ...bearer } as AuthenticatedRequest;
    expect(await run(guard, request, 'T')).toBe(true);
    expect(request.userId).toBeUndefined();
    expect(await run(guard, bearer, 'U')).toBe('not_linked');
  });
  it('records auth.denied for a refused admin route of a known account only', async () => {
    const { guard, calls } = setup(linked());
    expect(await run(guard, bearer, 'A')).toBe('forbidden_role');
    expect(calls.denied).toEqual(['req1']);
    expect(await run(guard, bearer, 'U+RA')).toBe(true);
    expect(await run(setup(unlinked).guard, bearer, 'A')).toBe('not_linked');
    expect(calls.denied).toHaveLength(1);
  });
});
