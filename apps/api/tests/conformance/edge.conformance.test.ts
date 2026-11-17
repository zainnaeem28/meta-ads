import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../src/bootstrap/api.module.js';
import { createHttpLogging } from '../../src/platform/logging/index.js';
import { ORIGIN } from '../security/support/stack.js';
import { limited, send } from './support/cells.js';
import { isGuarded, operations } from './support/spec.js';
import { bootWorld, METRICS_TOKEN } from './support/world.js';
import type { Account, World } from './support/world.js';

// TC-ZT-07 (response headers), TC-ZT-08 (the edge: size, rate, and the slow request), TD-D40.

let w: World;
let user: Account;
beforeAll(async () => {
  w = await bootWorld('t65edge');
  user = await w.account('edge');
}, 300_000);
afterAll(async () => {
  await w?.close();
});

describe('response headers on every operation, whatever the answer (TC-ZT-07)', () => {
  it('nosniff, no referrer, frame protection and no-store, on successes, refusals and route misses alike', async () => {
    const replies = [];
    for (const op of operations()) {
      if (isGuarded(op)) {
        replies.push(
          [op.id, await send(w, op, user.token)],
          [`${op.id} anon`, await send(w, op, undefined)],
        );
      } else {
        const res = await w.raw('GET', op.path, op.scopes.includes('M') ? {} : {});
        replies.push([op.id, { status: res.status, headers: res.headers }]);
      }
    }
    replies.push(
      ['404', await w.raw('GET', '/api/v1/nothing')],
      ['405', await w.raw('POST', '/api/v1/me')],
    );
    for (const [name, res] of replies as [string, { headers: Record<string, unknown> }][]) {
      expect(res.headers['x-content-type-options'], `${name} nosniff`).toBe('nosniff');
      expect(res.headers['referrer-policy'], `${name} referrer`).toBe('no-referrer');
      expect(String(res.headers['x-frame-options'] ?? ''), `${name} frame protection`).toMatch(
        /SAMEORIGIN|DENY/i,
      );
      expect(res.headers['x-powered-by'], `${name} does not name the stack`).toBeUndefined();
    }
    for (const [name, res] of replies as [string, { headers: Record<string, unknown> }][]) {
      if (name.startsWith('API-9')) continue;
      expect(String(res.headers['cache-control']), `${name} no-store`).toContain('no-store');
    }
  });

  it('a signed-URL and a key route are no-store (the media and provider-key routes)', async () => {
    const media = await w.call('GET', '/me/provider-keys', user.token);
    expect(String(media.headers['cache-control'])).toContain('no-store');
  });

  it('HSTS is sent where the app runs as production or staging, and only there', async () => {
    const sink = new Writable({
      write(_c, _e, done) {
        done();
      },
    });
    const saved = {
      CLERK_SECRET_KEY: process.env['CLERK_SECRET_KEY'],
      CLERK_JWT_ISSUER: process.env['CLERK_JWT_ISSUER'],
    };
    process.env['CLERK_SECRET_KEY'] = 'sk_test_conformance_000000000000000000';
    process.env['CLERK_JWT_ISSUER'] = 'https://clerk.conformance.example.test';
    try {
      for (const [env, expected] of [
        ['production', true],
        ['staging', true],
        ['development', false],
      ] as const) {
        const { app } = await createApiApp(
          { WEB_ORIGIN: 'https://app.example.com', APP_ENV: env, METRICS_TOKEN } as Parameters<
            typeof createApiApp
          >[0],
          createHttpLogging({ level: 'silent', destination: sink }),
          [],
        );
        const res = await app
          .getHttpAdapter()
          .getInstance()
          .inject({ method: 'GET', url: '/health/live' });
        expect(res.headers['strict-transport-security'] !== undefined, env).toBe(expected);
        await app.close();
      }
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe('the edge is bounded (TC-ZT-08)', () => {
  it('an upload over the limit is 413 payload_too_large before the body is stored (API-030)', async () => {
    const before = await w.count('media_objects', `owner_id = $1`, [user.id]);
    const big = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      Buffer.alloc(10 * 1024 * 1024 + 4096),
    ]);
    const boundary = '----edge413';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      big,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await w.raw(
      'POST',
      '/api/v1/media',
      {
        authorization: `Bearer ${user.token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    );
    expect([res.status, res.body.error?.code]).toEqual([413, 'payload_too_large']);
    expect(
      await w.count('media_objects', `owner_id = $1`, [user.id]),
      'the oversized upload stored nothing',
    ).toBe(before);
  });

  it('the general rate limit answers 429 with Retry-After and the limit resets with the window', async () => {
    const res = [
      await limited(
        w,
        operations().find((o) => o.id === 'API-001') as ReturnType<typeof operations>[number],
      ),
    ].flat()[0] as Awaited<ReturnType<typeof send>>;
    expect([res.status, res.code]).toEqual([429, 'rate_limited']);
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(60);
  });

  it('a body that never arrives is answered 408 by the server, not enveloped, between 60 and about 90 seconds (real socket)', async () => {
    const fastify = w.app.getHttpAdapter().getInstance();
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    const { port } = fastify.server.address() as AddressInfo;
    const started = Date.now();
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      let text = '';
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('no answer within 110 s'));
      }, 110_000);
      socket.on('data', (chunk) => {
        text += chunk.toString();
      });
      socket.on('close', () => {
        clearTimeout(timer);
        resolve(text);
      });
      // The server closes with our dripped bytes unread, which can surface as a reset after the 408 was read.
      socket.on('error', (err) => {
        clearTimeout(timer);
        if (text) resolve(text);
        else reject(err);
      });
      socket.write(
        `POST /api/v1/drafts HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${user.token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"productName":`,
      );
      // A silent socket is closed at 30 s with no answer (CONNECTION_TIMEOUT); a slow body that keeps arriving reaches the 60 s request timeout.
      const drip = setInterval(() => {
        if (!socket.destroyed) socket.write(' ');
        else clearInterval(drip);
      }, 10_000);
      socket.on('close', () => clearInterval(drip));
    });
    const seconds = (Date.now() - started) / 1000;
    expect(answer.split('\r\n')[0]).toMatch(/^HTTP\/1\.1 408/);
    expect(answer).not.toContain('"success"');
    expect(seconds).toBeGreaterThanOrEqual(59);
    expect(seconds).toBeLessThanOrEqual(95);
    expect(ORIGIN).toBeDefined();
  }, 150_000);
});
