import { describe, expect, it, vi } from 'vitest';
import { encodeCursor } from '../../../platform/http/cursor.js';
import type { DomainError } from '../../../platform/http/domain-error.js';
import { IdentityNotFound, IdentityUnavailable } from '../domain/identity-port.js';
import type { IdentityPort } from '../domain/identity-port.js';
import type { ExpireOutcome } from './invitations.jobs.js';
import { InvitationJobs, settleProviderRevoke } from './invitations.jobs.js';
import {
  INVITE_MESSAGE,
  InvitationService,
  invitationOptionsFrom,
} from './invitations.service.js';
import type { InvitationOptions } from './invitations.service.js';
import type { InvitationAdminStorePort, InvitationListRow, InvitationRow } from './invitations.store.js';
import { InvitationsController } from '../transport/invitations.controller.js';
import { PageResult } from '../../../platform/http/response.js';

const KEY = 'k'.repeat(40);
const ACTOR = { userId: 'admin-1', requestId: 'req-1' };
const NOW = Date.now();

const row = (over: Partial<InvitationRow> = {}): InvitationRow => ({
  id: 'inv-1',
  email: 'a@example.test',
  invitedBy: 'admin-1',
  state: 'invited',
  sendState: 'sent',
  idpInvitationId: 'h-old',
  expiresAt: new Date(NOW + 86_400_000),
  createdAt: new Date(NOW - 1000),
  updatedAt: new Date(NOW - 1000),
  ...over,
});

const options = (over: Partial<InvitationOptions> = {}): InvitationOptions => ({
  allowedDomains: ['example.test'],
  expiryDays: 7,
  sendStaleMin: 15,
  webOrigin: 'http://localhost:3000',
  cursorKey: KEY,
  ...over,
});

function fakes(initial?: InvitationRow) {
  let current: InvitationRow | undefined = initial;
  const store = {
    lockEmail: vi.fn(async () => undefined),
    hasAccount: vi.fn(async () => false),
    findById: vi.fn(async () => current),
    revokeInvitedByEmail: vi.fn(async () => undefined as InvitationRow | undefined),
    insertInvited: vi.fn(async () => undefined),
    revoke: vi.fn(async () => true),
    expire: vi.fn(async () => true),
    restart: vi.fn(async () => true),
    markSent: vi.fn(async () => true),
    markSendFailed: vi.fn(async () => true),
    clearHandle: vi.fn(async () => undefined),
    list: vi.fn(async () => [] as InvitationListRow[]),
    dueForExpiry: vi.fn(async () => [] as string[]),
    failStaleSends: vi.fn(async () => 0),
    revokesOwed: vi.fn(async () => [] as { id: string; handle: string }[]),
  };
  const identity = {
    createInvitation: vi.fn(async () => 'h-new'),
    revokeInvitation: vi.fn(async () => undefined),
  };
  const audit = { record: vi.fn(async () => 'a1') };
  const limiter = { enforce: vi.fn(async () => undefined) };
  const database = {
    db: {} as never,
    uow: { run: <T>(fn: (tx: never) => Promise<T>) => fn({} as never) },
  };
  const service = (opts = options()) =>
    new InvitationService(
      store as unknown as InvitationAdminStorePort,
      database as never,
      identity as unknown as IdentityPort,
      audit as never,
      limiter as never,
      opts,
    );
  return { store, identity, audit, limiter, database, service, set: (r: InvitationRow | undefined) => (current = r) };
}

const failure = async (promise: Promise<unknown>): Promise<DomainError> =>
  promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: unknown) => error as DomainError,
  );

describe('invitationOptionsFrom', () => {
  it('reads the expiry, the stale window and the cursor key with the registry defaults', () => {
    expect(invitationOptionsFrom({}, ['a.test'], 'http://x')).toEqual({
      allowedDomains: ['a.test'],
      expiryDays: 7,
      sendStaleMin: 15,
      webOrigin: 'http://x',
      cursorKey: undefined,
    });
    expect(
      invitationOptionsFrom({ INVITE_EXPIRY_DAYS: '3', INVITATION_SEND_STALE_MIN: '30', CURSOR_SIGNING_KEY: KEY }, [], undefined),
    ).toMatchObject({ expiryDays: 3, sendStaleMin: 30, cursorKey: KEY });
    expect(invitationOptionsFrom({ INVITE_EXPIRY_DAYS: 'x', INVITATION_SEND_STALE_MIN: '0' }, [], undefined)).toMatchObject({
      expiryDays: 7,
      sendStaleMin: 15,
    });
  });
});

describe('create (API-111)', () => {
  it('limits the rate, refuses a foreign domain and answers a registered address without a row', async () => {
    const f = fakes();
    const service = f.service();
    expect((await failure(service.create(ACTOR, 'x@elsewhere.test'))).code).toBe('invite_domain_not_allowed');
    f.store.hasAccount.mockResolvedValueOnce(true);
    expect(await service.create(ACTOR, ' Known@Example.test ')).toEqual({ email: 'known@example.test', message: INVITE_MESSAGE });
    expect(f.store.insertInvited).not.toHaveBeenCalled();
    expect(f.identity.createInvitation).not.toHaveBeenCalled();
    expect(f.limiter.enforce).toHaveBeenCalledTimes(2);
    // any domain is accepted when none is configured
    await fakes().service(options({ allowedDomains: [] })).create(ACTOR, 'x@anywhere.test');
  });

  it('writes the row and the audit event before the provider call, then marks it sent', async () => {
    const f = fakes();
    const order: string[] = [];
    f.store.insertInvited.mockImplementation(async () => void order.push('insert'));
    f.audit.record.mockImplementation(async () => (order.push('audit'), 'a'));
    f.identity.createInvitation.mockImplementation(async () => (order.push('provider'), 'h-new'));
    f.store.markSent.mockImplementation(async () => (order.push('sent'), true));
    await f.service().create(ACTOR, 'a@example.test');
    expect(order).toEqual(['insert', 'audit', 'provider', 'sent']);
    expect(f.identity.createInvitation).toHaveBeenCalledWith('a@example.test', 7, 'http://localhost:3000/sign-in');
  });

  it('revokes a replaced invitation at the provider only when it has a handle', async () => {
    const withHandle = fakes();
    withHandle.store.revokeInvitedByEmail.mockResolvedValue(row({ idpInvitationId: 'h-old' }));
    await withHandle.service().create(ACTOR, 'a@example.test');
    expect(withHandle.identity.revokeInvitation).toHaveBeenCalledWith('h-old');
    expect(withHandle.store.clearHandle).toHaveBeenCalled();

    const pending = fakes();
    pending.store.revokeInvitedByEmail.mockResolvedValue(row({ idpInvitationId: null, sendState: 'pending' }));
    await pending.service().create(ACTOR, 'a@example.test');
    expect(pending.identity.revokeInvitation).not.toHaveBeenCalled();
  });

  it('marks the send failed when the provider fails, and revokes a provider invitation nobody owns any more', async () => {
    const failing = fakes();
    failing.identity.createInvitation.mockRejectedValue(new IdentityUnavailable('createInvitation', 'timeout'));
    expect((await failing.service().create(ACTOR, 'a@example.test')).message).toBe(INVITE_MESSAGE);
    expect(failing.store.markSendFailed).toHaveBeenCalledWith(expect.anything(), expect.any(String), false);
    expect(failing.store.markSent).not.toHaveBeenCalled();

    const orphan = fakes();
    orphan.store.markSent.mockResolvedValue(false);
    await orphan.service().create(ACTOR, 'a@example.test');
    expect(orphan.identity.revokeInvitation).toHaveBeenCalledWith('h-new');
  });
});

describe('resend (API-112)', () => {
  it('answers 404 for an unknown id and 409 for a row that is not waiting', async () => {
    const f = fakes();
    expect((await failure(f.service().resend(ACTOR, 'inv-1'))).code).toBe('not_found');
    for (const over of [{ state: 'accepted' }, { state: 'revoked' }, { state: 'expired' }, { expiresAt: new Date(NOW - 1000) }] as const) {
      f.set(row(over));
      expect((await failure(f.service().resend(ACTOR, 'inv-1'))).code).toBe('state_conflict');
    }
    expect(f.store.restart).not.toHaveBeenCalled();
  });

  it('revokes the old provider invitation, then creates and stores the new one', async () => {
    const f = fakes(row());
    f.store.findById.mockResolvedValueOnce(row()).mockResolvedValue(row({ idpInvitationId: 'h-new' }));
    const view = await f.service().resend(ACTOR, 'inv-1');
    expect(f.identity.revokeInvitation).toHaveBeenCalledWith('h-old');
    expect(f.store.markSent).toHaveBeenCalledWith(expect.anything(), 'inv-1', 'h-new');
    expect(view).toMatchObject({ id: 'inv-1', state: 'invited', sendState: 'sent' });
    expect(JSON.stringify(view)).not.toContain('h-new');
  });

  it('makes no provider revoke without a handle, and treats a provider that does not know it as done', async () => {
    const none = fakes(row({ idpInvitationId: null, sendState: 'pending' }));
    await none.service().resend(ACTOR, 'inv-1');
    expect(none.identity.revokeInvitation).not.toHaveBeenCalled();
    expect(none.store.markSent).toHaveBeenCalled();

    const unknown = fakes(row());
    unknown.identity.revokeInvitation.mockRejectedValue(new IdentityNotFound('revokeInvitation'));
    await unknown.service().resend(ACTOR, 'inv-1');
    expect(unknown.store.markSent).toHaveBeenCalled();
  });

  it('keeps the old handle and ends send_failed when the provider cannot revoke it', async () => {
    const f = fakes(row());
    f.identity.revokeInvitation.mockRejectedValue(new IdentityUnavailable('revokeInvitation', 'provider'));
    await f.service().resend(ACTOR, 'inv-1');
    expect(f.store.markSendFailed).toHaveBeenCalledWith(expect.anything(), 'inv-1');
    expect(f.identity.createInvitation).not.toHaveBeenCalled();
  });

  it('clears the revoked handle when the new invitation then fails', async () => {
    const f = fakes(row());
    f.identity.createInvitation.mockRejectedValue(new Error('down'));
    await f.service().resend(ACTOR, 'inv-1');
    expect(f.store.markSendFailed).toHaveBeenCalledWith(expect.anything(), 'inv-1', true);
  });
});

describe('revoke (API-113)', () => {
  it('answers 404, 409 and returns a revoked row unchanged without a second event', async () => {
    const f = fakes();
    expect((await failure(f.service().revoke(ACTOR, 'inv-1'))).code).toBe('not_found');
    f.set(row({ state: 'accepted' }));
    expect((await failure(f.service().revoke(ACTOR, 'inv-1'))).code).toBe('state_conflict');
    f.set(row({ state: 'revoked' }));
    expect((await f.service().revoke(ACTOR, 'inv-1')).state).toBe('revoked');
    expect(f.store.revoke).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
    expect(f.identity.revokeInvitation).not.toHaveBeenCalled();
  });

  it('revokes at the provider only when a handle is set, and leaves a failed revoke owed', async () => {
    const withHandle = fakes(row());
    await withHandle.service().revoke(ACTOR, 'inv-1');
    expect(withHandle.identity.revokeInvitation).toHaveBeenCalledWith('h-old');
    expect(withHandle.audit.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'invitation.revoked', objectId: 'inv-1', actorType: 'admin' }));

    const none = fakes(row({ idpInvitationId: null }));
    await none.service().revoke(ACTOR, 'inv-1');
    expect(none.identity.revokeInvitation).not.toHaveBeenCalled();

    const owed = fakes(row());
    owed.identity.revokeInvitation.mockRejectedValue(new IdentityUnavailable('revokeInvitation', 'provider'));
    await owed.service().revoke(ACTOR, 'inv-1');
    expect(owed.store.clearHandle).not.toHaveBeenCalled();
  });
});

describe('list (API-110)', () => {
  const A = '00000000-0000-4000-8000-00000000000a';
  const B = '00000000-0000-4000-8000-00000000000b';
  const C = '00000000-0000-4000-8000-00000000000c';
  const listRow = (over: Partial<InvitationRow>, at: string): InvitationListRow => ({ ...row(over), createdAtText: at });

  it('needs the cursor signing key', async () => {
    await expect(fakes().service(options({ cursorKey: undefined })).list(ACTOR, { limit: 5 })).rejects.toThrow('CURSOR_SIGNING_KEY');
  });

  it('shows overdue rows as expired and stale pending sends as send_failed, and builds the next cursor', async () => {
    const f = fakes();
    f.store.list.mockResolvedValue([
      listRow({ id: A, expiresAt: new Date(NOW - 1000) }, '2026-11-16 10:00:00.123456+00'),
      listRow({ id: B, sendState: 'pending', idpInvitationId: null, updatedAt: new Date(NOW - 3_600_000) }, '2026-11-16 09:00:00.000001+00'),
      listRow({ id: C, sendState: 'pending', idpInvitationId: null }, '2026-11-16 08:00:00+00'),
    ]);
    const page = await f.service().list(ACTOR, { limit: 2 });
    expect(page).toBeInstanceOf(PageResult);
    expect(page.items.map((i) => [i.id, i.state, i.sendState])).toEqual([
      [A, 'expired', 'sent'],
      [B, 'invited', 'send_failed'],
    ]);
    expect(page.pagination).toMatchObject({ hasNextPage: true, returnedCount: 2 });
    expect(page.pagination.nextCursor).not.toBeNull();
    // the cursor feeds the next query at the same position
    await f.service().list(ACTOR, { limit: 2, cursor: page.pagination.nextCursor as string });
    expect(f.store.list).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ after: { createdAt: '2026-11-16 09:00:00.000001+00', id: B } }));
  });

  it('refuses a cursor of another admin, another filter, or whose position is not a timestamp and an id', async () => {
    const f = fakes();
    const own = { owner: ACTOR.userId, filters: { state: null } };
    expect((await failure(f.service().list(ACTOR, { limit: 5, cursor: encodeCursor(KEY, own, 'junk') }))).code).toBe('validation_failed');
    expect((await failure(f.service().list({ ...ACTOR, userId: 'other' }, { limit: 5, cursor: encodeCursor(KEY, own, 'x|y') }))).code).toBe('validation_failed');
    expect((await failure(f.service().list(ACTOR, { limit: 5, state: 'invited', cursor: encodeCursor(KEY, own, 'x|y') }))).code).toBe('validation_failed');
  });
});

describe('jobs', () => {
  it('settles a provider revoke: done on success or not found, owed on any other failure', async () => {
    const store = { clearHandle: vi.fn(async () => undefined) };
    const db = {} as never;
    expect(await settleProviderRevoke({ revokeInvitation: async () => undefined }, store, db, 'i', 'h')).toBe(true);
    expect(await settleProviderRevoke({ revokeInvitation: () => Promise.reject(new IdentityNotFound('x')) }, store, db, 'i', 'h')).toBe(true);
    expect(store.clearHandle).toHaveBeenCalledTimes(2);
    expect(await settleProviderRevoke({ revokeInvitation: () => Promise.reject(new IdentityUnavailable('x', 'timeout')) }, store, db, 'i', 'h')).toBe(false);
    store.clearHandle.mockRejectedValueOnce(new Error('db'));
    expect(await settleProviderRevoke({ revokeInvitation: async () => undefined }, store, db, 'i', 'h')).toBe(false);
  });

  it('expires the overdue, fails the stale sends and retries the owed revokes', async () => {
    const f = fakes();
    f.store.dueForExpiry.mockResolvedValueOnce(['x', 'y']).mockResolvedValue([]);
    f.store.expire.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    f.store.failStaleSends.mockResolvedValue(3);
    f.store.revokesOwed.mockResolvedValue([
      { id: 'r1', handle: 'h1' },
      { id: 'r2', handle: 'h2' },
    ]);
    f.identity.revokeInvitation.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new IdentityUnavailable('x', 'provider'));
    const jobs = new InvitationJobs(f.store as unknown as InvitationAdminStorePort, f.database as never, f.identity as unknown as IdentityPort, { sendStaleMin: 20 });
    const outcome: ExpireOutcome = await jobs.run();
    expect(outcome).toEqual({ expired: 1, staleSends: 3, revoked: 1, revokesOwed: 1 });
    expect(f.store.failStaleSends).toHaveBeenCalledWith(expect.anything(), 20);
  });

  it('keeps expiring while full batches come back, and stops when a batch makes no progress', async () => {
    const f = fakes();
    const batch = Array.from({ length: 200 }, (_, i) => `i${String(i)}`);
    f.store.dueForExpiry.mockResolvedValueOnce(batch).mockResolvedValueOnce(batch).mockResolvedValue(['z']);
    f.store.expire.mockResolvedValueOnce(true).mockResolvedValue(false);
    const jobs = new InvitationJobs(f.store as unknown as InvitationAdminStorePort, f.database as never, f.identity as unknown as IdentityPort, { sendStaleMin: 15 });
    expect((await jobs.run()).expired).toBe(1);
    expect(f.store.dueForExpiry).toHaveBeenCalledTimes(2);
  });
});

describe('controller input', () => {
  const controller = (service: Partial<InvitationService> = {}) => new InvitationsController(service as InvitationService);
  const request = { id: 'req-9' } as never;
  const actor = { userId: 'admin-1' } as never;

  it('parses the body, the query and the id before the service sees them', async () => {
    const create = vi.fn(async () => ({ email: 'a@example.test', message: INVITE_MESSAGE }));
    const list = vi.fn(async () => new PageResult([], { type: 'cursor', limit: 20, returnedCount: 0, hasNextPage: false, nextCursor: null }));
    const resend = vi.fn(async () => ({}) as never);
    const c = controller({ create, list, resend } as never);
    await c.create(actor, request, { email: '  A@Example.test ' });
    expect(create).toHaveBeenCalledWith({ userId: 'admin-1', requestId: 'req-9' }, 'A@Example.test');
    await c.list(actor, request, {});
    expect(list).toHaveBeenCalledWith(expect.anything(), { limit: 20 });
    await c.list(actor, request, { limit: '5', state: 'expired' });
    expect(list).toHaveBeenLastCalledWith(expect.anything(), { limit: 5, state: 'expired' });
    await c.resend(actor, request, '00000000-0000-4000-8000-000000000001');
    expect(resend).toHaveBeenCalled();
    expect(() => c.create(actor, request, { email: 'bad' })).toThrow();
    expect(() => c.list(actor, request, { limit: '99' })).toThrow();
    expect(() => c.revoke(actor, request, 'nope')).toThrow();
    expect(() => c.resend(undefined, request, '00000000-0000-4000-8000-000000000001')).toThrow();
  });
});
