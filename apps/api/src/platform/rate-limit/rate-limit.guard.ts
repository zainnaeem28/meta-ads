import { Inject, Injectable, SetMetadata } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  GENERAL_IP_LIMIT,
  GENERAL_USER_LIMIT,
  RateLimitedError,
  RateLimiter,
  ipSubject,
} from './rate-limiter.js';
import type { LimitRule } from './rate-limiter.js';

export const RATE_LIMIT_OPTIONS = Symbol('RATE_LIMIT_OPTIONS');

export interface RateLimitOptions {
  /** HMAC key of the client IP (`RATE_LIMIT_IP_KEY`). */
  readonly ipKey: string;
  /** `TRUST_PROXY_HOPS`: proxies in front of the api; 0 ignores X-Forwarded-For. */
  readonly trustProxyHops: number;
  /** Named per-route limits, from configuration; a route opts in with `@RateLimit(name)`. */
  readonly routes: Readonly<Record<string, LimitRule>>;
}

const ROUTE_KEY = 'rate-limit:route';

/** Applies the named per-route limit (on top of the general limit) to a route. */
export const RateLimit = (name: string): MethodDecorator & ClassDecorator => SetMetadata(ROUTE_KEY, name);

/** Health probes (API-900/901) and internal metrics (API-902/903) are exempt (ARCHITECTURE 3.7). */
export function isExempt(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return path === '/health' || path.startsWith('/health/') || path === '/internal/metrics' || path.startsWith('/internal/metrics/');
}

/** The client address: the entry `hops` places from the right of X-Forwarded-For (the proxy appends the peer it saw). */
export function clientIp(request: Pick<FastifyRequest, 'headers' | 'ip'>, hops: number): string {
  if (hops < 1) return request.ip;
  const header = request.headers['x-forwarded-for'];
  const entries = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return entries[Math.max(0, entries.length - hops)] ?? request.ip;
}

/**
 * The session guard publishes the signed-in user as `request.userId`; until it does (and for every
 * unauthenticated route) the subject is the HMAC of the client IP (`clientIp`, honouring TRUST_PROXY_HOPS).
 */
export interface IdentifiedRequest extends FastifyRequest {
  userId?: string;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RATE_LIMIT_OPTIONS) private readonly options: RateLimitOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const http = context.switchToHttp();
    const request = http.getRequest<IdentifiedRequest>();
    if (isExempt(request.url)) return true;
    const reply = http.getResponse<FastifyReply>();
    const userId = request.userId;
    const subject = userId ?? ipSubject(this.options.ipKey, clientIp(request, this.options.trustProxyHops));
    const general = userId === undefined ? GENERAL_IP_LIMIT : GENERAL_USER_LIMIT;
    const checks: [string, LimitRule][] = [[userId === undefined ? 'general-ip' : 'general-user', general]];
    const name = this.reflector.getAllAndOverride<string | undefined>(ROUTE_KEY, [context.getHandler(), context.getClass()]);
    if (name !== undefined) {
      const rule = this.options.routes[name];
      if (rule === undefined) throw new Error(`rate limit "${name}" is not configured`);
      checks.push([name, rule]);
    }
    for (const [scope, rule] of checks) {
      const result = await this.limiter.consume(scope, subject, rule.limit, rule.windowSeconds);
      if (!result.allowed) {
        void reply.header('Retry-After', String(result.retryAfterSeconds));
        throw new RateLimitedError(result.retryAfterSeconds);
      }
    }
    return true;
  }
}
