import 'reflect-metadata';
import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { DomainError } from '../http/domain-error.js';
import { RATE_LIMIT_OPTIONS, RateLimit, RateLimitGuard, clientIp, isExempt } from './rate-limit.guard.js';
import type { IdentifiedRequest, RateLimitOptions } from './rate-limit.guard.js';
import { JOB_CREATE_ROUTE, rateLimitOptionsFrom } from './rate-limit.module.js';
import { GENERAL_IP_LIMIT, GENERAL_USER_LIMIT, RateLimitedError, RateLimiter, ipSubject } from './rate-limiter.js';

/** A fake `execute` that counts per (scope, subject, window) like the upsert does. */
function fakeDb(fail = false) {
  const counts = new Map<string, number>();
  const calls: unknown[] = [];
  return {
    calls,
    db: {
      execute: (query: { queryChunks: unknown[] }) => {
        if (fail) return Promise.reject(new Error('connection refused'));
        calls.push(query);
        const key = JSON.stringify(query.queryChunks.filter((chunk) => typeof chunk !== 'object'));
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return Promise.resolve({ rows: [{ count: next }] });
      },
    },
  };
}

describe('RateLimiter.consume', () => {
  it('allows up to the limit and refuses the next request with the seconds left in the window', async () => {
    const { db } = fakeDb();
    const limiter = new RateLimiter(db as never, () => Date.UTC(2026, 0, 1, 0, 0, 20));
    for (let n = 1; n <= 3; n++) expect((await limiter.consume('s', 'u', 3, 60)).allowed).toBe(true);
    const over = await limiter.consume('s', 'u', 3, 60);
    expect(over).toMatchObject({ allowed: false, count: 4, limit: 3, retryAfterSeconds: 40 });
  });

  it('starts a new window at the edge and keeps subjects and scopes apart', async () => {
    const { db } = fakeDb();
    let now = Date.UTC(2026, 0, 1, 0, 0, 59, 500);
    const limiter = new RateLimiter(db as never, () => now);
    expect((await limiter.consume('s', 'u', 1, 60)).retryAfterSeconds).toBe(1);
    expect((await limiter.consume('s', 'u', 1, 60)).allowed).toBe(false);
    expect((await limiter.consume('s', 'other', 1, 60)).allowed).toBe(true);
    expect((await limiter.consume('t', 'u', 1, 60)).allowed).toBe(true);
    now += 1000;
    expect((await limiter.consume('s', 'u', 1, 60)).allowed).toBe(true);
  });

  it('is 503 service_unavailable when the database fails, never a pass-through', async () => {
    const limiter = new RateLimiter(fakeDb(true).db as never);
    await expect(limiter.consume('s', 'u', 1, 60)).rejects.toMatchObject({ code: 'service_unavailable', status: 503 });
  });

  it('rejects arguments the table cannot hold', async () => {
    const limiter = new RateLimiter(fakeDb().db as never);
    await expect(limiter.consume('', 'u', 1, 60)).rejects.toThrow(RangeError);
    await expect(limiter.consume('x'.repeat(49), 'u', 1, 60)).rejects.toThrow(RangeError);
    await expect(limiter.consume('s', '', 1, 60)).rejects.toThrow(RangeError);
    await expect(limiter.consume('s', 'x'.repeat(65), 1, 60)).rejects.toThrow(RangeError);
    await expect(limiter.consume('s', 'u', 0, 60)).rejects.toThrow(RangeError);
    await expect(limiter.consume('s', 'u', 1, 0.5)).rejects.toThrow(RangeError);
  });

  it('enforce throws 429 rate_limited naming the wait', async () => {
    const limiter = new RateLimiter(fakeDb().db as never, () => 0);
    await limiter.enforce('s', 'u', { limit: 1, windowSeconds: 60 });
    const error = await limiter.enforce('s', 'u', { limit: 1, windowSeconds: 60 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({ code: 'rate_limited', status: 429, retryAfterSeconds: 60 });
    expect((error as DomainError).safeMessage).toBe('Too many attempts. Try again in 60 seconds.');
  });
});

describe('addresses', () => {
  it('hashes an address to 64 hex characters that depend on the key', () => {
    const a = ipSubject('k'.repeat(32), '203.0.113.5');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(ipSubject('j'.repeat(32), '203.0.113.5'));
    expect(a).not.toContain('203.0.113.5');
  });

  it('takes the entry TRUST_PROXY_HOPS places from the right of X-Forwarded-For', () => {
    const req = (header: string | string[] | undefined) => ({ ip: '10.0.0.1', headers: { 'x-forwarded-for': header } }) as never;
    expect(clientIp(req('6.6.6.6, 1.2.3.4'), 1)).toBe('1.2.3.4');
    expect(clientIp(req('6.6.6.6, 1.2.3.4, 10.1.1.1'), 2)).toBe('1.2.3.4');
    expect(clientIp(req(['1.1.1.1', '2.2.2.2']), 1)).toBe('2.2.2.2');
    expect(clientIp(req('1.2.3.4'), 3)).toBe('1.2.3.4');
    expect(clientIp(req(undefined), 1)).toBe('10.0.0.1');
    expect(clientIp(req('1.2.3.4'), 0)).toBe('10.0.0.1');
  });

  it('exempts health and internal metrics only', () => {
    for (const url of ['/health/live', '/health/ready?x=1', '/health', '/internal/metrics', '/internal/metrics/window'])
      expect(isExempt(url)).toBe(true);
    for (const url of ['/api/v1/me', '/healthy', '/internal/metricsx', '/api/v1/health/live']) expect(isExempt(url)).toBe(false);
  });
});

describe('configuration', () => {
  it('derives the job-create limit from the configured count and minutes', () => {
    const options = rateLimitOptionsFrom({ RATE_LIMIT_IP_KEY: 'k'.repeat(32), JOB_CREATE_RATE_LIMIT: 7, JOB_CREATE_RATE_WINDOW_MIN: 2, TRUST_PROXY_HOPS: 2 });
    expect(options).toMatchObject({ trustProxyHops: 2, routes: { [JOB_CREATE_ROUTE]: { limit: 7, windowSeconds: 120 } } });
    expect(rateLimitOptionsFrom({ RATE_LIMIT_IP_KEY: 'k'.repeat(32) })).toMatchObject({
      trustProxyHops: 1,
      routes: { [JOB_CREATE_ROUTE]: { limit: 60, windowSeconds: 600 } },
    });
    expect(() => rateLimitOptionsFrom({})).toThrow('RATE_LIMIT_IP_KEY');
  });
});

@Controller('x')
class Probe {
  @Get('plain')
  plain(): void {}
  @Get('job')
  @RateLimit(JOB_CREATE_ROUTE)
  job(): void {}
  @Get('missing')
  @RateLimit('nope')
  missing(): void {}
}

function context(request: Partial<IdentifiedRequest>, handler: keyof Probe, headers: Record<string, string>) {
  const sent: Record<string, string> = {};
  const reply = { header: (name: string, value: string) => void (sent[name] = value) };
  const ctx = {
    getType: () => 'http',
    getHandler: () => Probe.prototype[handler],
    getClass: () => Probe,
    switchToHttp: () => ({ getRequest: () => ({ ip: '9.9.9.9', headers, url: '/api/v1/x', ...request }), getResponse: () => reply }),
  } as unknown as ExecutionContext;
  return { ctx, sent };
}

describe('RateLimitGuard', () => {
  const options: RateLimitOptions = { ipKey: 'k'.repeat(32), trustProxyHops: 1, routes: { [JOB_CREATE_ROUTE]: { limit: 2, windowSeconds: 600 } } };
  const guard = (db = fakeDb()) => new RateLimitGuard(new RateLimiter(db.db as never, () => 0), new Reflector(), options);

  it('limits unauthenticated requests by IP at 60 per minute and sets Retry-After', async () => {
    const g = guard();
    const { ctx, sent } = context({}, 'plain', { 'x-forwarded-for': '1.2.3.4' });
    for (let n = 0; n < GENERAL_IP_LIMIT.limit; n++) expect(await g.canActivate(ctx)).toBe(true);
    await expect(g.canActivate(ctx)).rejects.toBeInstanceOf(RateLimitedError);
    expect(sent['Retry-After']).toBe('60');
  });

  it('limits a signed-in user at 300 per minute by user ID', async () => {
    const g = guard();
    const { ctx } = context({ userId: 'u1' }, 'plain', {});
    for (let n = 0; n < GENERAL_USER_LIMIT.limit; n++) await g.canActivate(ctx);
    await expect(g.canActivate(ctx)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(await g.canActivate(context({ userId: 'u2' }, 'plain', {}).ctx)).toBe(true);
  });

  it('applies the named per-route limit on top and fails on an unknown name', async () => {
    const g = guard();
    const { ctx, sent } = context({ userId: 'u1' }, 'job', {});
    await g.canActivate(ctx);
    await g.canActivate(ctx);
    await expect(g.canActivate(ctx)).rejects.toBeInstanceOf(RateLimitedError);
    expect(sent['Retry-After']).toBe('600');
    await expect(g.canActivate(context({}, 'missing', {}).ctx)).rejects.toThrow('"nope" is not configured');
  });

  it('skips exempt URLs and non-http contexts and fails closed when the database fails', async () => {
    const g = guard(fakeDb(true));
    expect(await g.canActivate(context({ url: '/health/live' }, 'plain', {}).ctx)).toBe(true);
    const rpc = { getType: () => 'rpc' } as unknown as ExecutionContext;
    expect(await g.canActivate(rpc)).toBe(true);
    await expect(g.canActivate(context({}, 'plain', {}).ctx)).rejects.toMatchObject({ code: 'service_unavailable' });
  });

  it('is provided through the options token', () => {
    expect(typeof RATE_LIMIT_OPTIONS).toBe('symbol');
  });
});
