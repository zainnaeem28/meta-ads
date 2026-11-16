import { describe, expect, it, vi } from 'vitest';
import { encodeCursor } from '../../../platform/http/cursor.js';
import type { DomainError } from '../../../platform/http/domain-error.js';
import { IdentityNotFound, IdentityUnavailable } from '../domain/identity-port.js';
import type { IdentityPort } from '../domain/identity-port.js';
import { AccessRequestService } from './access-requests.service.js';
import type { AccessRequestOptions } from './access-requests.service.js';
import type { AccessRequestListRow, AccessRequestRow, AccessRequestStorePort } from './access-requests.store.js';
import type { AuthOptions } from './ports.js';
import { SettingsService, settingsOptionsFrom } from './settings.service.js';
import type { SettingsOptions } from './settings.service.js';
import type { SettingsAdminStorePort } from './settings.store.js';
import { accessRequestOptionsFrom } from './access-requests.service.js';

const KEY = 'k'.repeat(40);
const ACTOR = { userId: 'admin-1', requestId: 'req-1' };
const auth = (over: Partial<AuthOptions> = {}): AuthOptions => ({
  ownerEmail: undefined,
  mfaRequiredFor: 'all',
  recentAuthMaxAgeMin: 10,
  inviteEmailDomains: ['example.test'],
  accessRequestFormEnabled: true,
  webOrigin: undefined,
  ...over,
});
const row = (over: Partial<AccessRequestRow> = {}): AccessRequestRow => ({
  id: 'ar-1',
  idpSubject: 'sub-1',
  email: 'a@example.test',
  note: null,
  state: 'pending',
  decidedBy: null,
  userId: null,
  decidedAt: null,
  createdAt: new Date('2026-11-16T10:00:00Z'),
  ...over,
});

function accessFakes(initial?: AccessRequestRow) {
  let current = initial;
  const store = {
    insertPending: vi.fn(async () => true),
    hasAccountForEmail: vi.fn(async () => false),
    findById: vi.fn(async () => current),
    findAccount: vi.fn(async () => undefined as { id: string; idpSubject: string } | undefined),
    insertUser: vi.fn(async () => undefined),
    decide: vi.fn(async (_db: unknown, _id: string, state: 'approved' | 'declined', by: string, userId: string | null) => {
      if (current !== undefined) current = { ...current, state, decidedBy: by, userId, decidedAt: new Date() };
      return true;
    }),
    list: vi.fn(async () => [] as AccessRequestListRow[]),
  };
  const identity = {
    getUser: vi.fn(async () => ({ primaryEmail: 'New@Example.test', emailVerified: true })),
  };
  const audit = { record: vi.fn(async () => 'a1') };
  const limiter = { enforce: vi.fn(async () => undefined) };
  const database = { db: {} as never, uow: { run: <T>(fn: (tx: never) => Promise<T>) => fn({} as never) } };
  const service = (a = auth(), o: AccessRequestOptions = { ipKey: 'i'.repeat(40), cursorKey: KEY }) =>
    new AccessRequestService(
      store as unknown as AccessRequestStorePort,
      database as never,
      identity as unknown as IdentityPort,
      audit as never,
      limiter as never,
      a,
      o,
    );
  return { store, identity, audit, limiter, service };
}

const codeOf = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (e: DomainError) => e.code,
  );

describe('AccessRequestService.create (API-002)', () => {
  it('is 404 not_found when the form is disabled, before any limit is spent', async () => {
    const f = accessFakes();
    expect(await codeOf(f.service(auth({ accessRequestFormEnabled: false })).create('s', false, '1.1.1.1', undefined))).toBe('not_found');
    expect(f.limiter.enforce).not.toHaveBeenCalled();
  });

  it('enforces 3/h per subject and 20/h per IP, and the IP is stored only as a hash', async () => {
    const f = accessFakes();
    await f.service().create('sub-1', false, '1.1.1.1', 'hi');
    expect(f.limiter.enforce).toHaveBeenNthCalledWith(1, 'access-request-subject', 'sub-1', { limit: 3, windowSeconds: 3600 });
    const second = f.limiter.enforce.mock.calls[1] as unknown as [string, string, unknown];
    expect(second[0]).toBe('access-request-ip');
    expect(second[1]).not.toContain('1.1.1.1');
    expect(second[2]).toEqual({ limit: 20, windowSeconds: 3600 });
  });

  it('records a pending request with the provider email, the trimmed note and an audit event', async () => {
    const f = accessFakes();
    expect(await f.service().create('sub-1', false, '1.1.1.1', '  please  ')).toEqual({ state: 'received' });
    expect(f.store.insertPending).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      idpSubject: 'sub-1',
      email: 'new@example.test',
      note: 'please',
    }));
    expect(f.audit.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'access_request.created', actorId: null, actorType: 'system' }));
  });

  it('stores a blank note as null, and writes no audit event when one is already pending', async () => {
    const f = accessFakes();
    await f.service().create('sub-1', false, 'ip', '   ');
    expect(f.store.insertPending).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ note: null }));
    f.store.insertPending.mockResolvedValueOnce(false);
    f.audit.record.mockClear();
    await f.service().create('sub-1', false, 'ip', undefined);
    expect(f.audit.record).not.toHaveBeenCalled();
  });

  it('answers neutrally and stores nothing for a linked caller, an unverified or missing email, an unknown subject or an existing account', async () => {
    const f = accessFakes();
    expect(await f.service().create('u', true, 'ip', undefined)).toEqual({ state: 'received' });
    f.identity.getUser.mockResolvedValueOnce({ primaryEmail: 'a@example.test', emailVerified: false });
    await f.service().create('s', false, 'ip', undefined);
    f.identity.getUser.mockResolvedValueOnce({ primaryEmail: null as unknown as string, emailVerified: true });
    await f.service().create('s', false, 'ip', undefined);
    f.identity.getUser.mockRejectedValueOnce(new IdentityNotFound('getUser'));
    await f.service().create('s', false, 'ip', undefined);
    f.store.hasAccountForEmail.mockResolvedValueOnce(true);
    await f.service().create('s', false, 'ip', undefined);
    expect(f.store.insertPending).not.toHaveBeenCalled();
  });

  it('maps a provider outage to 503 and rethrows anything else; a missing IP key is a configuration error', async () => {
    const f = accessFakes();
    f.identity.getUser.mockRejectedValueOnce(new IdentityUnavailable('getUser', 'timeout'));
    expect(await codeOf(f.service().create('s', false, 'ip', undefined))).toBe('service_unavailable');
    f.identity.getUser.mockRejectedValueOnce(new Error('boom'));
    await expect(f.service().create('s', false, 'ip', undefined)).rejects.toThrow('boom');
    await expect(f.service(auth(), { ipKey: undefined, cursorKey: KEY }).create('s', false, 'ip', undefined)).rejects.toThrow('RATE_LIMIT_IP_KEY');
  });

  it('reads its options from the environment', () => {
    expect(accessRequestOptionsFrom({ RATE_LIMIT_IP_KEY: 'a', CURSOR_SIGNING_KEY: 'b' })).toEqual({ ipKey: 'a', cursorKey: 'b' });
  });
});

describe('AccessRequestService approve and decline (API-116, API-117)', () => {
  it('approve: unknown 404, approved unchanged, declined 409, domain 422', async () => {
    expect(await codeOf(accessFakes().service().approve(ACTOR, 'x'))).toBe('not_found');
    const approved = row({ state: 'approved', userId: 'u1', decidedBy: 'admin-1', decidedAt: new Date() });
    const f1 = accessFakes(approved);
    expect((await f1.service().approve(ACTOR, 'ar-1')).state).toBe('approved');
    expect(f1.store.decide).not.toHaveBeenCalled();
    expect(await codeOf(accessFakes(row({ state: 'declined' })).service().approve(ACTOR, 'ar-1'))).toBe('state_conflict');
    expect(await codeOf(accessFakes(row({ email: 'a@elsewhere.test' })).service().approve(ACTOR, 'ar-1'))).toBe('invite_domain_not_allowed');
  });

  it('approve: any domain is accepted when none is configured; creates the user and audits', async () => {
    const f = accessFakes(row({ email: 'a@elsewhere.test' }));
    const view = await f.service(auth({ inviteEmailDomains: [] })).approve(ACTOR, 'ar-1');
    expect(view).toMatchObject({ state: 'approved', decidedBy: 'admin-1' });
    expect(f.store.insertUser).toHaveBeenCalledOnce();
    expect(f.audit.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'access_request.approved', actorType: 'admin' }));
  });

  it('approve: reuses the subject’s own account, refuses another subject’s, and a lost decide race is a conflict', async () => {
    const own = accessFakes(row());
    own.store.findAccount.mockResolvedValueOnce({ id: 'u-own', idpSubject: 'sub-1' });
    expect((await own.service().approve(ACTOR, 'ar-1')).userId).toBe('u-own');
    expect(own.store.insertUser).not.toHaveBeenCalled();
    const other = accessFakes(row());
    other.store.findAccount.mockResolvedValueOnce({ id: 'u-other', idpSubject: 'sub-2' });
    expect(await codeOf(other.service().approve(ACTOR, 'ar-1'))).toBe('state_conflict');
    const lost = accessFakes(row());
    lost.store.decide.mockResolvedValueOnce(false);
    expect(await codeOf(lost.service().approve(ACTOR, 'ar-1'))).toBe('state_conflict');
  });

  it('approve: a unique violation from a concurrent insert is a conflict, other errors pass through', async () => {
    const f = accessFakes(row());
    f.store.insertUser.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505', constraint: 'users_email_lower_uq' }));
    expect(await codeOf(f.service().approve(ACTOR, 'ar-1'))).toBe('state_conflict');
    f.store.insertUser.mockRejectedValueOnce(new Error('disk'));
    await expect(f.service().approve(ACTOR, 'ar-1')).rejects.toThrow('disk');
  });

  it('decline: unknown 404, declined unchanged, approved 409, lost race 409, pending declined and audited', async () => {
    expect(await codeOf(accessFakes().service().decline(ACTOR, 'x'))).toBe('not_found');
    const f1 = accessFakes(row({ state: 'declined' }));
    expect((await f1.service().decline(ACTOR, 'ar-1')).state).toBe('declined');
    expect(f1.store.decide).not.toHaveBeenCalled();
    expect(await codeOf(accessFakes(row({ state: 'approved' })).service().decline(ACTOR, 'ar-1'))).toBe('state_conflict');
    const lost = accessFakes(row());
    lost.store.decide.mockResolvedValueOnce(false);
    expect(await codeOf(lost.service().decline(ACTOR, 'ar-1'))).toBe('state_conflict');
    const ok = accessFakes(row());
    expect(await ok.service().decline(ACTOR, 'ar-1')).toMatchObject({ state: 'declined', userId: null });
    expect(ok.audit.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'access_request.declined' }));
  });
});

describe('AccessRequestService.list (API-115)', () => {
  const listRow = (n: number): AccessRequestListRow => ({
    ...row({ id: `00000000-0000-4000-8000-00000000000${String(n)}`, createdAt: new Date(Date.UTC(2026, 10, 16, 10, 0, n)) }),
    createdAtText: `2026-11-16 10:00:0${String(n)}.123456+00`,
  });

  it('pages with a signed cursor and passes the decoded position back to the store', async () => {
    const f = accessFakes();
    f.store.list.mockResolvedValueOnce([listRow(3), listRow(2), listRow(1)]);
    const page = await f.service().list(ACTOR, { limit: 2, state: 'pending' });
    expect(page.items).toHaveLength(2);
    const next = (page.pagination as { nextCursor: string }).nextCursor;
    await f.service().list(ACTOR, { limit: 2, state: 'pending', cursor: next });
    expect(f.store.list).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      after: { createdAt: '2026-11-16 10:00:02.123456+00', id: '00000000-0000-4000-8000-000000000002' },
    }));
  });

  it('refuses a forged or foreign cursor, a mis-shaped position, and a missing key', async () => {
    const f = accessFakes();
    expect(await codeOf(f.service().list(ACTOR, { limit: 2, state: 'pending', cursor: 'garbage' }))).toBe('validation_failed');
    const shaped = encodeCursor(KEY, { owner: ACTOR.userId, filters: { state: 'pending' } }, 'not-a-position');
    expect(await codeOf(f.service().list(ACTOR, { limit: 2, state: 'pending', cursor: shaped }))).toBe('validation_failed');
    await expect(f.service(auth(), { ipKey: 'i', cursorKey: undefined }).list(ACTOR, { limit: 2, state: 'pending' })).rejects.toThrow('CURSOR_SIGNING_KEY');
  });
});

describe('SettingsService (API-120, API-121)', () => {
  const options = (over: Partial<SettingsOptions> = {}): SettingsOptions => ({
    emailVerificationRequired: true,
    signupRateLimitEnabled: true,
    abuseLimitsEnabled: true,
    ...over,
  });
  function settingsFakes(mode: 'invited_only' | 'open' = 'invited_only', verification: string | null = 'G4-1') {
    const state = { signupMode: mode, openModeVerificationId: verification };
    const store = {
      read: vi.fn(async () => state),
      setSignupMode: vi.fn(async () => undefined),
    };
    const audit = { record: vi.fn(async () => 'a1') };
    const database = { db: {} as never, uow: { run: <T>(fn: (tx: never) => Promise<T>) => fn({} as never) } };
    const service = (o = options()) =>
      new SettingsService(store as unknown as SettingsAdminStorePort, database as never, audit as never, auth(), o);
    return { store, audit, service };
  }

  it('reads the flags from the environment', () => {
    expect(settingsOptionsFrom({ SIGNUP_OPEN_EMAIL_VERIFICATION: 'true' })).toEqual({
      emailVerificationRequired: true,
      signupRateLimitEnabled: false,
      abuseLimitsEnabled: false,
    });
  });

  it('shows the mode and the configuration', async () => {
    expect(await settingsFakes().service().get()).toEqual({
      signupMode: 'invited_only',
      accessRequestFormEnabled: true,
      mfaRequiredFor: 'all',
      inviteEmailDomains: ['example.test'],
      openModePrerequisites: { emailVerificationRequired: true, signupRateLimitEnabled: true, abuseLimitsEnabled: true, verificationRecordId: 'G4-1' },
    });
  });

  it('names every missing prerequisite and stores nothing', async () => {
    const f = settingsFakes('invited_only', null);
    const err = await f.service(options({ emailVerificationRequired: false, signupRateLimitEnabled: false, abuseLimitsEnabled: false })).setSignupMode(ACTOR, 'open').catch((e: DomainError) => e);
    expect((err as DomainError).code).toBe('signup_open_prerequisites');
    expect((err as DomainError).details?.map((d) => d.field)).toEqual([
      'emailVerificationRequired',
      'signupRateLimitEnabled',
      'abuseLimitsEnabled',
      'verificationRecordId',
    ]);
    expect(f.store.setSignupMode).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
    const blank = settingsFakes('invited_only', '');
    expect(await codeOf(blank.service().setSignupMode(ACTOR, 'open'))).toBe('signup_open_prerequisites');
  });

  it('flips with an audit event; the current mode is unchanged with none; closing needs no prerequisites', async () => {
    const f = settingsFakes();
    expect((await f.service().setSignupMode(ACTOR, 'open')).signupMode).toBe('open');
    expect(f.store.setSignupMode).toHaveBeenCalledWith(expect.anything(), 'open', 'admin-1');
    expect(f.audit.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'signup_mode.changed' }));
    const same = settingsFakes();
    await same.service().setSignupMode(ACTOR, 'invited_only');
    expect(same.audit.record).not.toHaveBeenCalled();
    const closing = settingsFakes('open', null);
    expect((await closing.service(options({ abuseLimitsEnabled: false })).setSignupMode(ACTOR, 'invited_only')).signupMode).toBe('invited_only');
  });
});
