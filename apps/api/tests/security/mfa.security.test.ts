import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openApiOperations } from './support/data.js';
import { ORIGIN, bootStack, openDefect, rowsHolding } from './support/stack.js';
import type { Account, Stack } from './support/stack.js';

// TASK-116: SECT-MFA-01, 03, 04, 08 and SECT-ADM-07; TEST-CASES TC-ACC-15, 16, 17 and TC-ZT-11 at the API. The recovery
// part of TC-ZT-11 that needs a real identity provider (its own recovery flow, admin verification in its dashboard) is the
// human case TC-H-02 of TEST-CASES §11, run on the provider's test tenant; here the provider is the local stub and what is
// proven is the server-side effect: recovery by email alone never yields a session the API accepts without a second factor
// (TD-D40(e): recovery happens in the provider, the API has no reset operation). SECT-MFA-09 (invalid `MFA_REQUIRED_FOR`
// stops startup) is the unit case TC-ACC-18 of the startup configuration suite; SECT-MFA-05..07, 10, 11 belong to the
// admin MFA-reset operation, which the frozen OpenAPI design.5 does not contain.

/** A key-shaped canary, assembled so no scanner reads the source as a real key. */
const fakeKey = (tag: string): string => ['sk', `canary-OPENAI-${tag}-0123456789abcdef`].join('-');
let ops: ReturnType<typeof openApiOperations>;
const urlOf = (path: string) =>
  path
    .replace(/\{position\}/g, '1')
    .replace(/\{provider\}/g, 'openai')
    .replace(/\{[^}]+\}/g, () => randomUUID());

describe('MFA_REQUIRED_FOR=all (TC-ACC-15, SECT-MFA-01, SECT-MFA-03, TC-ZT-11)', () => {
  let s: Stack;
  let person: Account;
  let boss: Account;
  const routed = (op: { method: string; path: string }) =>
    s.index.match(op.method, `/api/v1${urlOf(op.path)}`).kind === 'found';
  const guarded = () =>
    ops.filter(
      (op) =>
        !op.scopes.includes('Pub') &&
        !op.scopes.includes('M') &&
        !op.scopes.includes('T') &&
        routed(op),
    );
  const hit = (op: { method: string; path: string }, token: string) =>
    s.call(
      op.method as 'GET',
      urlOf(op.path),
      token,
      op.method === 'GET' || op.method === 'DELETE' ? undefined : {},
    );

  beforeAll(async () => {
    s = await bootStack('t116mfa', { mfa: 'all' });
    ops = openApiOperations();
    person = await s.account('mfa-user');
    boss = await s.admin('mfa-boss');
  }, 300_000);
  afterAll(async () => {
    await s?.close();
  });

  it('refuses every guarded operation with 403 mfa_required when the token carries no, first-factor-only or negative factor evidence (direct API call, provider screens bypassed)', async () => {
    expect(guarded().length).toBeGreaterThan(35);
    const shapes: ([number, number] | null)[] = [null, [5, -1], [-1, -1]];
    for (const who of [person, boss]) {
      for (const fva of shapes) {
        const token = s.local.issueToken({
          sub: who.sub,
          azp: ORIGIN,
          ...(fva === null ? {} : { fva }),
        });
        for (const op of guarded()) {
          const res = await hit(op, token);
          expect([
            who === boss ? 'admin' : 'user',
            JSON.stringify(fva),
            op.id,
            res.status,
            res.body.error?.code,
          ]).toEqual([
            who === boss ? 'admin' : 'user',
            JSON.stringify(fva),
            op.id,
            403,
            'mfa_required',
          ]);
        }
      }
    }
  });

  it('lets API-001 report the missing factor without serving anything else, and serves the same identity once a factor is evidenced', async () => {
    const me = await s.call('GET', '/me', person.noFactor);
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ mfa: { required: true, satisfied: false } });
    expect(Object.keys(me.body.data).sort()).toEqual([
      'id',
      'keyNotices',
      'linkState',
      'mfa',
      'recentAuth',
      'role',
      'status',
    ]);
    expect(me.body.data.keyNotices).toEqual([]);
    expect((await s.call('GET', '/campaigns', person.noFactor)).body.error?.code).toBe(
      'mfa_required',
    );
    expect((await s.call('GET', '/campaigns', person.token)).status).toBe(200);
  });

  it('has no reset, recovery or factor operation in the contract or on the router, so an email-only reset has nothing to call (TC-ACC-17, TD-D40(e))', async () => {
    expect(
      ops
        .filter((op) => /mfa|reset|recover|factor|totp|password/i.test(op.path))
        .map((op) => `${op.id} ${op.path}`),
    ).toEqual([]);
    for (const [method, path] of [
      ['POST', '/me/mfa/reset'],
      ['POST', '/me/mfa'],
      ['PUT', '/me/mfa'],
      ['DELETE', '/me/mfa'],
      ['POST', '/auth/reset'],
      ['POST', '/auth/recover'],
      ['POST', `/admin/users/${person.id}/mfa-reset`],
      ['POST', `/admin/users/${person.id}/mfa/reset`],
      ['POST', '/me/recovery-codes'],
      ['POST', '/password/reset'],
    ] as const) {
      for (const token of [person.token, person.noFactor, boss.token]) {
        const res = await s.call(method, path, token, { email: person.email });
        expect([method, path, res.status], 'no route').toEqual([method, path, 404]);
      }
    }
    expect(s.workerIdentity.sessionRevocations.filter((sub) => sub === person.sub)).toEqual([]);
  });

  it('keeps MFA required after the "email-only recovery" the provider stub allows: a fresh session of a verified address with no factor still gets nothing (TC-ZT-11)', async () => {
    // Recovery at the provider: the account is reached again by email (verified) and a new session is minted, factors absent.
    s.local.addUser(person.sub, person.email, true);
    const recovered = [
      s.local.issueToken({ sub: person.sub, azp: ORIGIN, sid: 'sess_after_email_recovery' }),
      s.local.issueToken({
        sub: person.sub,
        azp: ORIGIN,
        sid: 'sess_after_email_recovery_2',
        fva: [0, -1],
      }),
    ];
    for (const token of recovered) {
      for (const op of guarded()) {
        const res = await hit(op, token);
        expect([op.id, res.status, res.body.error?.code]).toEqual([op.id, 403, 'mfa_required']);
      }
    }
    // Role changes, reinstatement and a new invitation for the same address do not lift the requirement.
    await s.pool.query(`update users set role = 'admin' where id = $1`, [person.id]);
    expect((await s.call('GET', '/admin/users', recovered[0] as string)).body.error?.code).toBe(
      'mfa_required',
    );
    await s.pool.query(`update users set role = 'user' where id = $1`, [person.id]);
    expect((await s.call('POST', `/admin/users/${person.id}/suspend`, boss.token)).status).toBe(
      200,
    );
    expect((await s.call('POST', `/admin/users/${person.id}/reinstate`, boss.token)).status).toBe(
      200,
    );
    expect((await s.call('GET', '/campaigns', recovered[0] as string)).body.error?.code).toBe(
      'mfa_required',
    );
    // The administrator who "verified" the person cannot enrol or reset them through any admin route either: all admin
    // operations that name a user leave the factor state alone (the API has none to change).
    const columns = (
      await s.pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema in ('public', 'pgboss')`,
      )
    ).rows.map((r) => r.column_name);
    for (const name of columns)
      expect(name, 'a factor, secret or recovery-code column').not.toMatch(
        /mfa|totp|factor|recovery|backup_code|otp/i,
      );
  });

  it('requires recent authentication for key actions and admin routes: stale first or second factor is 403 recent_auth_required, fresh succeeds (SECT-MFA-04, SECT-ADM-07)', async () => {
    s.probe.answer = 200;
    for (const fva of [
      [30, 1],
      [1, 30],
      [11, 1],
      [1, 11],
    ] as [number, number][]) {
      const token = s.local.issueToken({ sub: person.sub, azp: ORIGIN, fva });
      const put = await s.call('PUT', '/me/provider-keys/openai', token, {
        apiKey: fakeKey('stale'),
      });
      expect([JSON.stringify(fva), put.status, put.body.error?.code]).toEqual([
        JSON.stringify(fva),
        403,
        'recent_auth_required',
      ]);
      expect((await s.call('DELETE', '/me/provider-keys/openai', token)).body.error?.code).toBe(
        'recent_auth_required',
      );
    }
    expect(await s.count('provider_keys', 'owner_id = $1', [person.id])).toBe(0);
    const fresh = s.local.issueToken({ sub: person.sub, azp: ORIGIN, fva: [1, 1] });
    expect(
      (await s.call('PUT', '/me/provider-keys/openai', fresh, { apiKey: fakeKey('fresh') })).status,
    ).toBe(200);
    expect(
      (
        await s.call(
          'GET',
          '/admin/users',
          s.local.issueToken({ sub: boss.sub, azp: ORIGIN, fva: [1, 1] }),
        )
      ).status,
    ).toBe(200);
    // Refusals for a non-admin on an admin route are audited, never silent (SECT-ADM-07).
    const before = await s.count('audit_events', `action = 'auth.denied'`);
    expect((await s.call('GET', '/admin/users', person.token)).body.error?.code).toBe(
      'forbidden_role',
    );
    expect(await s.count('audit_events', `action = 'auth.denied'`)).toBe(before + 1);
  });

  openDefect(
    'SEC116-F2',
    'an admin operation with a stale sign-in is refused with 403 recent_auth_required (x-scope A = admin, MFA, recent auth; SECT-ADM-07, TC-ACC-15, 16)',
    async () => {
      const stale = s.local.issueToken({ sub: boss.sub, azp: ORIGIN, fva: [30, 30] });
      for (const op of guarded().filter((o) => o.scopes.includes('A'))) {
        const res = await hit(op, stale);
        expect([op.id, res.status, res.body.error?.code]).toEqual([
          op.id,
          403,
          'recent_auth_required',
        ]);
      }
    },
  );

  it('writes no factor material anywhere: no recovery code, secret or digest in responses, the database or the logs (SECT-MFA-08)', async () => {
    expect(s.logs.join('')).not.toMatch(/recovery[-_ ]?code|totp|otpauth|backup[-_ ]?code/i);
    for (const word of ['otpauth://', 'recovery_code', 'totp'])
      expect(await rowsHolding(s.pool, word, ['public', 'pgboss']), word).toEqual({});
  });
});

describe('MFA_REQUIRED_FOR=admins (TC-ACC-16)', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await bootStack('t116mfa2', { mfa: 'admins' });
    ops = openApiOperations();
  }, 300_000);
  afterAll(async () => {
    await s?.close();
  });

  it('lets a non-admin sign in with no factor step and still refuses an admin without one', async () => {
    const user = await s.account('adm-user');
    const boss = await s.admin('adm-boss');
    const bare = (a: Account) => s.local.issueToken({ sub: a.sub, azp: ORIGIN });
    for (const url of ['/me', '/campaigns', '/drafts', '/me/provider-keys'])
      expect((await s.call('GET', url, bare(user))).status, url).toBe(200);
    // Recent authentication of a key action is a separate rule and still needs a factor evidence.
    expect(
      (await s.call('PUT', '/me/provider-keys/openai', bare(user), { apiKey: fakeKey('bare') }))
        .body.error?.code,
    ).toBe('recent_auth_required');
    for (const url of ['/admin/users', '/admin/erasures', '/admin/alerts']) {
      const res = await s.call('GET', url, bare(boss));
      expect([url, res.status, res.body.error?.code]).toEqual([url, 403, 'mfa_required']);
      expect(
        (await s.call('GET', url, s.local.issueToken({ sub: boss.sub, azp: ORIGIN, fva: [1, 1] })))
          .status,
      ).toBe(200);
    }
    // A role change to admin makes the same bare token refused on the next request.
    await s.pool.query(`update users set role = 'admin' where id = $1`, [user.id]);
    expect((await s.call('GET', '/campaigns', bare(user))).body.error?.code).toBe('mfa_required');
  });
});
