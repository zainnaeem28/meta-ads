import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { record } from './support/cells.js';
import { ORIGIN } from '../security/support/stack.js';
import { operations } from './support/spec.js';
import { bootWorld } from './support/world.js';
import type { Account, World } from './support/world.js';

// TC-OPS-08 (every route of the running app is in the file and the reverse), TD-D34/TD-D37 (405 and 404 are decided by the
// router before authentication), TC-ZT-05 (CORS preflight), TC-AUT-06 (only the declared routes answer).

let w: World;
let user: Account;
beforeAll(async () => {
  w = await bootWorld('t65router');
  user = await w.account('router');
}, 300_000);
afterAll(async () => {
  await w?.close();
});

const ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const ALL = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const concrete = (template: string): string =>
  template.replace(/\{[^}]+\}/g, (m) =>
    m === '{position}' ? '1' : m === '{provider}' ? 'openai' : crypto.randomUUID(),
  );
const prefixed = (template: string, root: boolean): string =>
  root ? template : `/api/v1${template}`;

/** Path templates of the file with the methods each declares. */
function declared(): Map<string, { root: boolean; methods: Set<string> }> {
  const out = new Map<string, { root: boolean; methods: Set<string> }>();
  for (const op of operations()) {
    const entry = out.get(op.path) ?? { root: op.root, methods: new Set<string>() };
    entry.methods.add(op.method);
    if (op.method === 'GET') entry.methods.add('HEAD');
    out.set(op.path, entry);
  }
  return out;
}

/** Mounted only for IDENTITY_MODE=local in development/test and deliberately not in OpenAPI; its absence under any other identity mode is proven by the AIU-251 dev-token test. */
const LOCAL_ONLY_ROUTE = 'POST /api/v1/dev/token';

describe('the routes of the running app and the file agree (TC-OPS-08)', () => {
  it('every route of the app is an operation of the file, and every operation is a route', () => {
    const fromFile = new Set(
      operations().flatMap((op) => [
        `${op.method} ${prefixed(op.path, op.root).replace(/\{([^}]+)\}/g, ':$1')}`,
        ...(op.method === 'GET'
          ? [`HEAD ${prefixed(op.path, op.root).replace(/\{([^}]+)\}/g, ':$1')}`]
          : []),
      ]),
    );
    const fromApp = new Set(
      w.index
        .entries()
        .map((entry) => entry.replace(/^(\w+) \/?/, '$1 /'))
        .filter((entry) => !entry.includes('/probe/boom') && entry !== LOCAL_ONLY_ROUTE),
    );
    expect(
      [...fromApp].filter((entry) => !fromFile.has(entry)),
      'routes the file does not declare',
    ).toEqual([]);
    expect(
      [...fromFile].filter((entry) => !fromApp.has(entry)),
      'operations without a route',
    ).toEqual([]);
    expect(operations().length).toBeGreaterThanOrEqual(57);
  });
});

describe('a method the path does not declare is 405 with Allow, decided before authentication (TD-D34, TD-D37)', () => {
  it('every path template with every undeclared method, with and without a token', async () => {
    let checked = 0;
    for (const [template, { root, methods }] of declared()) {
      const allow = ORDER.filter((m) => methods.has(m)).join(', ');
      for (const method of ALL.filter((m) => !methods.has(m))) {
        const url = prefixed(concrete(template), root);
        const bare = await w.raw(method, url);
        const authed = await w.raw(method, url, { authorization: `Bearer ${user.token}` });
        const garbage = await w.raw(method, url, { authorization: 'Bearer not.a.token' });
        for (const res of [bare, authed, garbage]) {
          expect([method, template, res.status, res.body.error?.code]).toEqual([
            method,
            template,
            405,
            'method_not_allowed',
          ]);
          expect(res.headers['allow'], `${method} ${template}`).toBe(allow);
          expect(res.headers['content-type']).toContain('application/json');
          expect(res.body.metaData).toMatchObject({ requestId: res.headers['x-request-id'] });
        }
        expect(authed.body.error?.message).toBe(bare.body.error?.message);
        record({ op: 'router', method, status: 405, code: 'method_not_allowed' });
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(150);
  });

  it('OPTIONS is never listed in Allow and HEAD follows GET', async () => {
    const res = await w.raw('POST', '/api/v1/campaigns');
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('GET, HEAD');
    expect(String(res.headers['allow'])).not.toContain('OPTIONS');
  });
});

describe('a path no template matches is 404 not_found, the same with or without a token and never 401 (TD-D34)', () => {
  const unknown = [
    '/api/v1/nothing-here',
    '/api/v1/campaigns/123/unknown',
    '/api/v2/me',
    '/api/v1',
    '/unknown',
    '/api/v1/admin',
    '/internal/other',
    '/health',
    '/api/v1/me/extra/segments/deep',
  ];
  for (const path of unknown) {
    it(`${path}`, async () => {
      const bare = await w.raw('GET', path);
      const authed = await w.raw('GET', path, { authorization: `Bearer ${user.token}` });
      const post = await w.raw('POST', path, { authorization: `Bearer ${user.token}` }, {});
      for (const res of [bare, authed, post]) {
        expect([res.status, res.body.error?.code]).toEqual([404, 'not_found']);
        expect(res.headers['allow']).toBeUndefined();
      }
      expect(authed.body.error?.message).toBe(bare.body.error?.message);
    });
  }
});

describe('CORS: the API reads no cookies and never refuses by origin (TC-ZT-05, TD-D40(c))', () => {
  const preflight = (origin: string, path = '/api/v1/campaigns', method = 'POST') =>
    w.raw('OPTIONS', path, {
      origin,
      'access-control-request-method': method,
      'access-control-request-headers': 'authorization,content-type,idempotency-key',
    });

  it('a preflight from another origin is 204 without Access-Control-Allow-Origin', async () => {
    for (const origin of [
      'https://evil.example',
      'http://localhost:3001',
      'null',
      `${ORIGIN}.evil.example`,
    ]) {
      const res = await preflight(origin);
      expect(res.status, origin).toBe(204);
      expect(res.headers['access-control-allow-origin'], origin).toBeUndefined();
    }
  });

  it('a preflight from the web origin is 204 with its own origin echoed and Vary: Origin', async () => {
    for (const path of ['/api/v1/campaigns', '/api/v1/me', '/api/v1/admin/users']) {
      const res = await preflight(ORIGIN, path, 'GET');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(String(res.headers['vary'])).toContain('Origin');
    }
  });

  it('no response carries Access-Control-Allow-Origin: * and a foreign-origin call is answered like any other, without credentials', async () => {
    for (const op of operations().filter((o) => !o.root)) {
      const res = await w.raw(op.method, `/api/v1${concrete(op.path)}`, {
        origin: 'https://evil.example',
        authorization: `Bearer ${user.token}`,
      });
      expect(res.headers['access-control-allow-origin'], op.id).toBeUndefined();
      expect(res.headers['access-control-allow-credentials'], op.id).toBeUndefined();
      expect(res.status, op.id).toBeLessThan(500);
    }
    const ok = await w.raw('GET', '/api/v1/me', {
      origin: ORIGIN,
      authorization: `Bearer ${user.token}`,
    });
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('no status is a CSRF refusal: a cross-origin state change with a Bearer token is processed, with a cookie alone it is 401', async () => {
    const created = await w.raw(
      'POST',
      '/api/v1/drafts',
      {
        origin: 'https://evil.example',
        authorization: `Bearer ${user.token}`,
        'content-type': 'application/json',
      },
      { productName: 'From elsewhere' },
    );
    expect(created.status).toBe(201);
    const cookieOnly = await w.raw(
      'POST',
      '/api/v1/drafts',
      {
        origin: 'https://evil.example',
        cookie: `__session=${user.token}`,
        'content-type': 'application/json',
      },
      { productName: 'Cookie' },
    );
    expect(cookieOnly.status).toBe(401);
  });
});
