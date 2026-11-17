import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Egress, hostAllowed, validateAllowList } from './egress.js';
import type { EgressOptions } from './egress.js';
import { EgressError } from './errors.js';
import { assertAllowList, egressOptionsFrom } from './egress.module.js';
import { startServer } from './test-support.js';
import type { Handler } from './test-support.js';

const ALLOWED = { openai: ['api.openai.com'], other: ['*.example.net'] };

let handler: Handler = (_req, res) => {
  res.end('ok');
};
let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  server = await startServer((req, res) => handler(req, res));
});
afterAll(async () => {
  await server.close();
});

function egress(
  extra: Partial<EgressOptions> = {},
  resolver: EgressOptions['resolver'] = async () => ['127.0.0.1'],
): Egress {
  return new Egress({
    allowedHosts: ALLOWED,
    timeoutMs: 5000,
    maxBytes: 1024,
    resolver,
    testing: { isBlockedAddress: () => false, tls: { ca: server.ca }, port: server.port },
    ...extra,
  });
}
const url = (host: string, path = '/v1/x') => `https://${host}:${server.port}${path}`;

async function refused(promise: Promise<unknown>): Promise<EgressError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EgressError);
  return error as EgressError;
}

describe('egress fetch', () => {
  it('fetches an allow-listed https host through the pinned address', async () => {
    handler = (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{"a":1}');
    };
    const res = await egress().fetch('openai', {
      url: url('api.openai.com'),
      contentTypes: ['application/json'],
    });
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('{"a":1}');
  });

  it('sends method, headers and body', async () => {
    let seen = '';
    handler = (req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (chunk: Buffer) => parts.push(chunk));
      req.on('end', () => {
        seen = `${req.method} ${req.headers['x-k']} ${Buffer.concat(parts).toString()}`;
        res.end('done');
      });
    };
    await egress().fetch('openai', {
      url: url('api.openai.com'),
      method: 'POST',
      headers: { 'x-k': 'v' },
      body: 'payload',
    });
    expect(seen).toBe('POST v payload');
  });

  it('refuses unknown providers, non-https, credentials, bad URLs, IP literals and unlisted hosts (TC-EGR-01)', async () => {
    const e = egress();
    expect((await refused(e.fetch('nobody', { url: url('api.openai.com') }))).reason).toBe(
      'provider_unknown',
    );
    expect((await refused(e.fetch('openai', { url: 'http://api.openai.com/' }))).reason).toBe(
      'not_https',
    );
    expect((await refused(e.fetch('openai', { url: 'not a url' }))).reason).toBe('invalid_url');
    expect((await refused(e.fetch('openai', { url: 'https://u:p@api.openai.com/' }))).reason).toBe(
      'invalid_url',
    );
    expect((await refused(e.fetch('openai', { url: 'https://127.0.0.1/' }))).reason).toBe(
      'host_not_allowed',
    );
    expect((await refused(e.fetch('openai', { url: 'https://[::1]/' }))).reason).toBe(
      'host_not_allowed',
    );
    expect((await refused(e.fetch('openai', { url: url('evil.example.com') }))).reason).toBe(
      'host_not_allowed',
    );
    expect(
      (
        await refused(
          egress({ testing: { tls: { ca: server.ca } } }).fetch('openai', {
            url: 'https://api.openai.com:8443/',
          }),
        )
      ).reason,
    ).toBe('host_not_allowed');
  });

  it.each(['127.0.0.1', '10.0.0.5', '169.254.169.254', 'fe80::1', '::ffff:127.0.0.1'])(
    'blocks a host that resolves to %s after resolution (TC-EGR-01)',
    async (address) => {
      const e = new Egress({
        allowedHosts: ALLOWED,
        timeoutMs: 2000,
        maxBytes: 1024,
        resolver: async () => [address],
      });
      const error = await refused(e.fetch('openai', { url: 'https://api.openai.com/v1/x' }));
      expect(error.reason).toBe('blocked_address');
      expect(error.phase).toBe('before_send');
    },
  );

  it('blocks when any one of several answers is private', async () => {
    const e = new Egress({
      allowedHosts: ALLOWED,
      timeoutMs: 2000,
      maxBytes: 1024,
      resolver: async () => ['8.8.8.8', '10.0.0.5'],
    });
    expect((await refused(e.fetch('openai', { url: 'https://api.openai.com/' }))).reason).toBe(
      'blocked_address',
    );
  });

  it('classifies resolver failures as dns_failure before sending', async () => {
    const failing = new Egress({
      allowedHosts: ALLOWED,
      timeoutMs: 2000,
      maxBytes: 1,
      resolver: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    const error = await refused(failing.fetch('openai', { url: 'https://api.openai.com/' }));
    expect([error.reason, error.phase]).toEqual(['dns_failure', 'before_send']);
    const empty = new Egress({
      allowedHosts: ALLOWED,
      timeoutMs: 2000,
      maxBytes: 1,
      resolver: async () => [],
    });
    expect((await refused(empty.fetch('openai', { url: 'https://api.openai.com/' }))).reason).toBe(
      'dns_failure',
    );
  });

  it('is not fooled by DNS rebinding: one resolution, the second answer is never used (TC-EGR-02)', async () => {
    let calls = 0;
    const answers = [['127.0.0.1'], ['10.0.0.5']];
    handler = (_req, res) => {
      res.end('pinned');
    };
    const e = egress({}, async () => answers[Math.min(calls++, 1)] as string[]);
    const res = await e.fetch('openai', { url: url('api.openai.com') });
    expect(res.body.toString()).toBe('pinned');
    expect(calls).toBe(1);
  });

  it('refuses a redirect to another host and any redirect to http (TC-EGR-02)', async () => {
    handler = (_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', `https://evil.example.com:${server.port}/x`);
      res.end();
    };
    const error = await refused(egress().fetch('openai', { url: url('api.openai.com') }));
    expect(error.reason).toBe('redirect_refused');
    handler = (_req, res) => {
      res.statusCode = 301;
      res.setHeader('location', 'http://api.openai.com/x');
      res.end();
    };
    expect((await refused(egress().fetch('openai', { url: url('api.openai.com') }))).reason).toBe(
      'redirect_refused',
    );
    handler = (_req, res) => {
      res.statusCode = 302;
      res.end();
    };
    expect((await refused(egress().fetch('openai', { url: url('api.openai.com') }))).reason).toBe(
      'redirect_refused',
    );
  });

  it('follows a same-host redirect a limited number of times, re-validating each hop', async () => {
    handler = (req, res) => {
      if (req.url === '/final') {
        res.end('arrived');
        return;
      }
      res.statusCode = 303;
      res.setHeader('location', '/final');
      res.end();
    };
    expect(
      (
        await egress().fetch('openai', {
          url: url('api.openai.com', '/start'),
          method: 'POST',
          body: 'x',
        })
      ).body.toString(),
    ).toBe('arrived');
    handler = (_req, res) => {
      res.statusCode = 307;
      res.setHeader('location', '/loop');
      res.end();
    };
    expect((await refused(egress().fetch('openai', { url: url('api.openai.com') }))).reason).toBe(
      'redirect_refused',
    );
  });

  it('refuses an oversize body, declared or streamed (TC-EGR-02)', async () => {
    handler = (_req, res) => {
      res.end(Buffer.alloc(4096));
    };
    expect((await refused(egress().fetch('openai', { url: url('api.openai.com') }))).reason).toBe(
      'too_large',
    );
    handler = (_req, res) => {
      res.write(Buffer.alloc(600));
      setTimeout(() => res.end(Buffer.alloc(600)), 50);
    };
    expect((await refused(egress().fetch('openai', { url: url('api.openai.com') }))).reason).toBe(
      'too_large',
    );
    handler = (_req, res) => {
      res.end(Buffer.alloc(300));
    };
    expect(
      (await refused(egress().fetch('openai', { url: url('api.openai.com'), maxBytes: 100 })))
        .reason,
    ).toBe('too_large');
  });

  it('refuses a slow body and a slow answer within the time bound (TC-EGR-02)', async () => {
    handler = (_req, res) => {
      res.write('a'); /* never ends */
    };
    const slowBody = await refused(
      egress({ timeoutMs: 300 }).fetch('openai', { url: url('api.openai.com') }),
    );
    expect([slowBody.reason, slowBody.phase]).toEqual(['timeout', 'after_send']);
    handler = () => {
      /* never answers */
    };
    expect(
      (await refused(egress().fetch('openai', { url: url('api.openai.com'), timeoutMs: 300 })))
        .reason,
    ).toBe('timeout');
  });

  it('refuses a wrong content type', async () => {
    handler = (_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<html>');
    };
    expect(
      (
        await refused(
          egress().fetch('openai', { url: url('api.openai.com'), contentTypes: ['video/mp4'] }),
        )
      ).reason,
    ).toBe('wrong_type');
    handler = (_req, res) => {
      res.end('no type');
    };
    expect(
      (
        await refused(
          egress().fetch('openai', { url: url('api.openai.com'), contentTypes: ['video/mp4'] }),
        )
      ).reason,
    ).toBe('wrong_type');
  });

  it('reports a refused connection as before_send and a dropped one as after_send', async () => {
    const dead = new Egress({
      allowedHosts: ALLOWED,
      timeoutMs: 2000,
      maxBytes: 1024,
      resolver: async () => ['127.0.0.1'],
      testing: { isBlockedAddress: () => false, tls: { ca: server.ca }, port: 1 },
    });
    const refusedConn = await refused(dead.fetch('openai', { url: 'https://api.openai.com:1/' }));
    expect([refusedConn.reason, refusedConn.phase]).toEqual(['connection_failed', 'before_send']);
    handler = (req) => {
      req.socket.destroy();
    };
    const dropped = await refused(egress().fetch('openai', { url: url('api.openai.com') }));
    expect(dropped.phase).toBe('after_send');
  });

  it('matches wildcard hosts one level or deeper and nothing else', () => {
    expect(hostAllowed('a.example.net', ['*.example.net'])).toBe(true);
    expect(hostAllowed('a.b.example.net', ['*.example.net'])).toBe(true);
    expect(hostAllowed('example.net', ['*.example.net'])).toBe(false);
    expect(hostAllowed('evilexample.net', ['*.example.net'])).toBe(false);
    expect(hostAllowed('API.OpenAI.com', ['api.openai.com'])).toBe(true);
  });

  it('never logs or exposes the body or the URL path in an error', async () => {
    handler = (_req, res) => {
      res.end(Buffer.alloc(4096, 'S'));
    };
    const error = await refused(
      egress().fetch('openai', {
        url: url('api.openai.com', '/v1/secret-path?token=abc'),
        body: 'REQ-SECRET',
        method: 'POST',
      }),
    );
    expect(error.message).not.toMatch(/secret-path|token=abc|REQ-SECRET|SSSS/);
  });
});

describe('allow-list validation', () => {
  it('rejects IP literals, local names and over-broad wildcards', () => {
    expect(validateAllowList({ a: ['api.openai.com', '*.example.net'] })).toEqual([]);
    expect(validateAllowList({ a: ['10.0.0.5'] })).toHaveLength(1);
    expect(validateAllowList({ a: ['*.10.0.0.5'] })).toHaveLength(1);
    expect(validateAllowList({ a: ['localhost'] })).toHaveLength(1);
    expect(validateAllowList({ a: ['x.localhost'] })).toHaveLength(1);
    expect(validateAllowList({ a: ['*.com'] })).toHaveLength(1);
    expect(() => assertAllowList({ a: ['10.0.0.5'] })).toThrow(/EGRESS_ALLOWED_HOSTS/);
  });
  it('takes limits from the process configuration with documented defaults', () => {
    expect(egressOptionsFrom({})).toMatchObject({
      allowedHosts: {},
      timeoutMs: 120000,
      maxBytes: 209715200,
    });
    expect(
      egressOptionsFrom({ PROVIDER_HTTP_TIMEOUT_MS: 5, PROVIDER_OUTPUT_MAX_BYTES: 7 }),
    ).toMatchObject({ timeoutMs: 5, maxBytes: 7 });
  });
});
