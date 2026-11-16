import { Inject, Injectable, createParamDecorator } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { DomainError } from './domain-error.js';
import { SCOPE_KEY, needsSession } from './scope-registry.js';
import type { RouteScope } from './scope-registry.js';

export type ActorRole = 'user' | 'admin';

/**
 * The account behind a request, read from `users` on every request (ARCHITECTURE 5.1): role and status are never
 * carried over from an earlier request or from the token.
 */
export interface ActorContext {
  readonly userId: string;
  readonly role: ActorRole;
  readonly sessionId: string;
  readonly mfa: { readonly required: boolean; readonly satisfied: boolean };
  readonly recentAuth: { readonly satisfied: boolean; readonly maxAgeSeconds: number };
  /** Minutes since the first factor (`fva[0]`); null when the token carries no factor evidence. */
  readonly authAgeMin: number | null;
}

/** A verified token whose subject has no `users` row and no basis to get one: reaches scope T only. */
export interface UnlinkedSession {
  readonly subject: string;
}

export type AuthResult =
  | { readonly linked: true; readonly actor: ActorContext }
  | { readonly linked: false; readonly session: UnlinkedSession };

/** The identity module's side of the guard: token to account, or a `DomainError` with the registry code. */
export interface SessionAuthenticator {
  /** 401 unauthenticated, 503 service_unavailable, 403 account_suspended / account_removed. */
  authenticate(token: string): Promise<AuthResult>;
  /** Audit `auth.denied` for a refused request of a known account (admin routes). Never throws. */
  recordDenied(actor: ActorContext, requestId: string): Promise<void>;
}

export const SESSION_AUTHENTICATOR = Symbol('SESSION_AUTHENTICATOR');

export interface AuthenticatedRequest extends FastifyRequest {
  userId?: string;
  auth?: AuthResult;
}

export function requireRole(actor: ActorContext, role: ActorRole): void {
  if (actor.role !== role) throw new DomainError('forbidden_role', 'You do not have access to this.');
}

/** Server-side MFA (TR-08): enforced from `fva` whatever the provider screen did. */
export function requireMfa(actor: ActorContext): void {
  if (actor.mfa.required && !actor.mfa.satisfied) {
    throw new DomainError('mfa_required', 'Multi-factor authentication is required.');
  }
}

export function requireRecentAuth(actor: ActorContext): void {
  if (!actor.recentAuth.satisfied) {
    throw new DomainError('recent_auth_required', 'Confirm your sign-in to continue.');
  }
}

/** `Authorization: Bearer <token>` (scheme case-insensitive); anything else is no token. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer +([^\s]+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Applies the declared scope in the decision order of SECURITY-DESIGN 7.1: token (401), link and status (403
 * not_linked, account_suspended, account_removed), MFA, role, recent authentication. T (token only) stops after the
 * link decision, so an unlinked or MFA-less session can still read API-001 and API-002.
 */
export function authorizeScope(scope: RouteScope, result: AuthResult): ActorContext | undefined {
  if (!result.linked) {
    if (scope === 'T') return undefined;
    throw new DomainError('not_linked', 'This account is not linked to ShrooMap yet.');
  }
  const { actor } = result;
  if (scope === 'T') return actor;
  requireMfa(actor);
  if (scope === 'A') requireRole(actor, 'admin');
  if (scope === 'U+RA') requireRecentAuth(actor);
  return actor;
}

/** The authenticated account of the request (set by `AuthGuard`); handlers of scope T use `@Session()` instead. */
export const CurrentActor = createParamDecorator((_data: unknown, context: ExecutionContext): ActorContext | undefined => {
  const result = context.switchToHttp().getRequest<AuthenticatedRequest>().auth;
  return result?.linked === true ? result.actor : undefined;
});

export const CurrentSession = createParamDecorator((_data: unknown, context: ExecutionContext): AuthResult | undefined =>
  context.switchToHttp().getRequest<AuthenticatedRequest>().auth,
);

/**
 * The global session guard (default deny): a route without a declared scope never gets here (startup check), a
 * route of scope Pub or M reads no session, every other route needs a verified Bearer token.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SESSION_AUTHENTICATOR) private readonly sessions: SessionAuthenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const scope = this.reflector.getAllAndOverride<RouteScope | undefined>(SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (scope === undefined) throw new DomainError('forbidden_role', 'You do not have access to this.');
    if (!needsSession(scope)) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request.headers.authorization);
    if (token === undefined) throw new DomainError('unauthenticated', 'Sign in to continue.');
    const result = await this.sessions.authenticate(token);
    request.auth = result;
    if (result.linked) request.userId = result.actor.userId;
    try {
      authorizeScope(scope, result);
    } catch (error) {
      if (scope === 'A' && result.linked && error instanceof DomainError) {
        await this.sessions.recordDenied(result.actor, request.id);
      }
      throw error;
    }
    return true;
  }
}
