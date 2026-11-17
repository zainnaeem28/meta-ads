import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { MetricsTokenGuardMarker } from '../http/scope-registry.js';

export const METRICS_TOKEN = Symbol('METRICS_TOKEN');

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Scope M (TD-D41): `Authorization: Bearer <METRICS_TOKEN>`, compared in constant time on SHA-256 digests. Anything
 * else (no header, another scheme, an empty, prefix or wrong value, a session token, no token configured) is the
 * unknown-path 404, never 401 or 403, so the route's existence is not disclosed.
 */
@MetricsTokenGuardMarker()
@Injectable()
export class MetricsTokenGuard implements CanActivate {
  private readonly expected: Buffer | null;

  constructor(@Inject(METRICS_TOKEN) token: string | undefined) {
    this.expected = token === undefined || token === '' ? null : digest(token);
  }

  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<FastifyRequest>().headers.authorization;
    const presented =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    // Always hash and compare so the work does not depend on whether a token is configured or presented.
    const equal = timingSafeEqual(digest(presented), this.expected ?? digest(''));
    if (this.expected === null || presented === '' || !equal) throw new NotFoundException();
    return true;
  }
}
