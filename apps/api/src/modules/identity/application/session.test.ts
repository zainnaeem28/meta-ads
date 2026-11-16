import { describe, expect, it } from 'vitest';
import type { DomainError } from '../../../platform/http/domain-error.js';
import { IdentityTokenInvalid, IdentityUnavailable } from '../domain/identity-port.js';
import type { Claims, IdentityPort } from '../domain/identity-port.js';
import { MeService } from './me.service.js';
import { authOptionsFrom } from './ports.js';
import type { AuthOptions, UserRecord } from './ports.js';
import { SessionService, actorOf, mfaSatisfied } from './session.service.js';
import type { ActorContext } from '../../../platform/http/auth.guard.js';

const options = (over: Partial<AuthOptions> = {}): AuthOptions => ({
  ownerEmail: undefined,
  mfaRequiredFor: 'all',
  recentAuthMaxAgeMin: 10,
  inviteEmailDomains: [],
  accessRequestFormEnabled: false,
  webOrigin: undefined,
  ...over,
});
const claims = (fva: Claims['fva']): Claims => ({ sub: 'sub1', sid: 'sid1', fva, iat: 1, exp: 2, azp: null });
const user = (over: Partial<UserRecord> = {}): UserRecord => ({
  id: 'u1',
  idpSubject: 'sub1',
  email: 'a@example.test',
  role: 'user',
  status: 'active',
  ...over,
});

describe('actorOf (TR-08, L-1)', () => {
  it('derives MFA and recent authentication from fva', () => {
    expect(mfaSatisfied(null)).toBe(false);
    expect(mfaSatisfied([1, -1])).toBe(false);
    expect(mfaSatisfied([1, 0])).toBe(true);
    const a = actorOf(user(), claims([4, 5]), options());
    expect(a).toMatchObject({ role: 'user', mfa: { required: true, satisfied: true }, recentAuth: { satisfied: true, maxAgeSeconds: 600 }, authAgeMin: 4, sessionId: 'sid1' });
    expect(actorOf(user(), claims([10, 10]), options()).recentAuth.satisfied).toBe(true);
    expect(actorOf(user(), claims([11, 5]), options()).recentAuth.satisfied).toBe(false);
    expect(actorOf(user(), claims([5, 11]), options()).recentAuth.satisfied).toBe(false);
    expect(actorOf(user(), claims([5, -1]), options()).recentAuth.satisfied).toBe(false);
    expect(actorOf(user(), claims([-1, 5]), options())).toMatchObject({ authAgeMin: null, recentAuth: { satisfied: false } });
    expect(actorOf(user(), claims(null), options())).toMatchObject({ authAgeMin: null, mfa: { satisfied: false } });
  });
  it('requires MFA of admins only when MFA_REQUIRED_FOR is admins, and ignores the second factor age for others', () => {
    const admins = options({ mfaRequiredFor: 'admins' });
    expect(actorOf(user(), claims([1, -1]), admins)).toMatchObject({ mfa: { required: false }, recentAuth: { satisfied: true } });
    expect(actorOf(user({ role: 'admin' }), claims([1, -1]), admins)).toMatchObject({ role: 'admin', mfa: { required: true, satisfied: false } });
  });
});

describe('authOptionsFrom', () => {
  it('reads the registry names with their defaults', () => {
    expect(authOptionsFrom({}, undefined)).toEqual(options());
    expect(
      authOptionsFrom(
        { OWNER_EMAIL: ' Owner@Example.test ', MFA_REQUIRED_FOR: 'admins', RECENT_AUTH_MAX_AGE_MIN: '5', INVITE_EMAIL_DOMAINS: 'A.test, b.test,', ACCESS_REQUEST_FORM_ENABLED: 'true' },
        'http://w',
      ),
    ).toEqual({ ownerEmail: 'owner@example.test', mfaRequiredFor: 'admins', recentAuthMaxAgeMin: 5, inviteEmailDomains: ['a.test', 'b.test'], accessRequestFormEnabled: true, webOrigin: 'http://w' });
    expect(authOptionsFrom({ OWNER_EMAIL: '' }, undefined).ownerEmail).toBeUndefined();
  });
  it('refuses a bad value', () => {
    expect(() => authOptionsFrom({ MFA_REQUIRED_FOR: 'some' }, undefined)).toThrow(/MFA_REQUIRED_FOR/);
    expect(() => authOptionsFrom({ RECENT_AUTH_MAX_AGE_MIN: '0' }, undefined)).toThrow(/RECENT_AUTH/);
    expect(() => authOptionsFrom({ RECENT_AUTH_MAX_AGE_MIN: 'x' }, undefined)).toThrow(/RECENT_AUTH/);
  });
});

describe('SessionService', () => {
  function build(over: { verify?: () => Promise<Claims>; row?: UserRecord | undefined; linked?: UserRecord | undefined; audit?: { record: () => Promise<string> } } = {}) {
    const log = { linking: 0, audit: [] as unknown[] };
    const identity = { verifyToken: over.verify ?? (async () => claims([1, 1])) } as unknown as IdentityPort;
    const service = new SessionService(
      identity,
      { db: {} as never },
      { findBySubject: async () => ('row' in over ? over.row : user()) } as never,
      options(),
      { linkOnFirstToken: async () => { log.linking += 1; return over.linked; } },
      (over.audit ?? { record: async (_db: unknown, event: unknown) => { log.audit.push(event); return 'id'; } }) as never,
    );
    return { service, log };
  }
  const codeOf = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as DomainError).code;

  it('builds the actor from the row and the token, without linking an existing account', async () => {
    const { service, log } = build();
    expect(await service.authenticate('t')).toMatchObject({ linked: true, actor: { userId: 'u1', role: 'user' } });
    expect(log.linking).toBe(0);
  });
  it('maps token and provider failures to 401 and 503, and rethrows anything else', async () => {
    expect(await codeOf(build({ verify: () => Promise.reject(new IdentityTokenInvalid('expired')) }).service.authenticate('t'))).toBe('unauthenticated');
    expect(await codeOf(build({ verify: () => Promise.reject(new IdentityUnavailable('verifyToken', 'keys')) }).service.authenticate('t'))).toBe('service_unavailable');
    await expect(build({ verify: () => Promise.reject(new Error('boom')) }).service.authenticate('t')).rejects.toThrow('boom');
  });
  it('links on the first token and reports an unlinked session when there is no basis', async () => {
    const linkedRow = build({ row: undefined, linked: user({ role: 'admin' }) });
    expect(await linkedRow.service.authenticate('t')).toMatchObject({ linked: true, actor: { role: 'admin' } });
    expect(linkedRow.log.linking).toBe(1);
    expect(await build({ row: undefined, linked: undefined }).service.authenticate('t')).toEqual({ linked: false, session: { subject: 'sub1' } });
  });
  it('refuses a suspended or removed account', async () => {
    expect(await codeOf(build({ row: user({ status: 'suspended' }) }).service.authenticate('t'))).toBe('account_suspended');
    expect(await codeOf(build({ row: user({ status: 'removed' }) }).service.authenticate('t'))).toBe('account_removed');
  });
  it('audits a denial and never lets a failed audit write change the refusal', async () => {
    const actor = { userId: 'u1', role: 'admin' } as ActorContext;
    const ok = build();
    await ok.service.recordDenied(actor, 'r1');
    expect(ok.log.audit).toEqual([{ actorId: 'u1', actorType: 'admin', action: 'auth.denied', objectType: 'route', objectId: null, outcome: 'denied', requestId: 'r1' }]);
    await expect(build({ audit: { record: () => Promise.reject(new Error('db')) } }).service.recordDenied({ ...actor, role: 'user' }, 'r2')).resolves.toBeUndefined();
    const none = new SessionService({} as never, { db: {} as never }, {} as never, options(), {} as never);
    await expect(none.recordDenied(actor, 'r3')).resolves.toBeUndefined();
  });
});

describe('MeService (API-001)', () => {
  const me = (notices?: { noticesFor: () => Promise<never[]> | Promise<{ provider: 'openai'; status: 'disabled' }[]> }, form = true) =>
    new MeService({ db: {} as never }, options({ accessRequestFormEnabled: form }), { stateOfSubject: async () => 'pending' }, notices as never);
  const actor = { userId: 'u1', role: 'user', mfa: { required: true, satisfied: false }, recentAuth: { satisfied: false, maxAgeSeconds: 600 } } as ActorContext;
  it('returns the linked view with key notices, none when no module supplies them', async () => {
    expect(await me().me({ linked: true, actor })).toEqual({ linkState: 'linked', id: 'u1', role: 'user', status: 'active', mfa: actor.mfa, recentAuth: actor.recentAuth, keyNotices: [] });
    const notices = [{ provider: 'openai' as const, status: 'disabled' as const }];
    expect(((await me({ noticesFor: async () => notices }).me({ linked: true, actor })) as { keyNotices: unknown }).keyNotices).toEqual(notices);
  });
  it('returns the not-linked view with the access request state', async () => {
    expect(await me().me({ linked: false, session: { subject: 's' } })).toEqual({ linkState: 'not_linked', accessRequest: { formEnabled: true, state: 'pending' } });
  });
});
