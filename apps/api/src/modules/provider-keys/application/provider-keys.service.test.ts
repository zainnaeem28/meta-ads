import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '../../../platform/http/index.js';
import { RateLimitedError } from '../../../platform/rate-limit/index.js';
import { ProviderKeysService } from './provider-keys.service.js';
import type { KeyPolicy, KeyRecord } from './ports.js';
import type { ProbeResult } from '../domain/provider-probe.js';

const OWNER = 'u1';
const KEY = 'sk-abcdefghijklmnopqrstuvwxyz';
const policy: KeyPolicy = {
  attemptsPerWindow: 5,
  windowMinutes: 10,
  autoDisableThreshold: 5,
  formats: { openai: /^sk-[A-Za-z0-9_-]{20,}$/, wavespeed: /^[A-Za-z0-9_-]{20,}$/ },
};

const record = (over: Partial<KeyRecord> = {}): KeyRecord => ({
  id: 'k1',
  ownerId: OWNER,
  provider: 'openai',
  status: 'active',
  version: 1,
  last4: 'wxyz',
  fingerprint: 'abcdef0123456789',
  consecutiveAuthFailures: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  lastValidatedAt: new Date('2026-01-02T00:00:00Z'),
  ...over,
});

function build(
  opts: {
    probe?: ProbeResult;
    existing?: KeyRecord | null;
    allowed?: boolean;
    count?: number;
    writes?: boolean;
  } = {},
) {
  const tx = { tag: 'tx' };
  const db = { tag: 'db' };
  const keys = {
    find: vi.fn(() => Promise.resolve(opts.existing === undefined ? null : opts.existing)),
    list: vi.fn(() => Promise.resolve(opts.existing ? [opts.existing] : [])),
    insert: vi.fn(() => Promise.resolve(opts.writes ?? true)),
    replace: vi.fn(() => Promise.resolve(opts.writes ?? true)),
    delete: vi.fn((): Promise<string | null> => Promise.resolve('k1')),
    deleteAll: vi.fn(() => Promise.resolve([{ id: 'k1', provider: 'openai' as const }])),
    recordFailure: vi.fn(),
    recordSuccess: vi.fn(),
    disableAll: vi.fn(() =>
      Promise.resolve([{ id: 'k1', ownerId: OWNER, provider: 'openai' as const }]),
    ),
  };
  const events = {
    insert: vi.fn<(db: unknown, e: { kind: string }) => Promise<void>>(() => Promise.resolve()),
    list: vi.fn(() => Promise.resolve([])),
  };
  const announce = vi.fn();
  const audit = { record: vi.fn(() => Promise.resolve()) };
  const alerts = { raiseAlert: vi.fn(() => Promise.resolve({ announce })) };
  const limiter = {
    consume: vi.fn(() =>
      Promise.resolve({
        allowed: opts.allowed ?? true,
        count: opts.count ?? 1,
        limit: 5,
        retryAfterSeconds: 42,
      }),
    ),
  };
  const wrap = {
    seal: vi.fn(() => ({
      ciphertext: Buffer.alloc(1),
      nonce: Buffer.alloc(12),
      wrappedDek: Buffer.alloc(1),
      kekVersion: 1,
    })),
  };
  const service = new ProviderKeysService(
    { db, uow: { run: (fn: (t: unknown) => Promise<unknown>) => fn(tx) } } as never,
    keys as never,
    events as never,
    { probe: vi.fn(() => Promise.resolve(opts.probe ?? 'valid')) } as never,
    wrap as never,
    { fingerprint: () => ({ hex: 'f'.repeat(64), pepperVersion: 1 }) },
    { countForKey: () => Promise.resolve(2) },
    limiter,
    audit as never,
    alerts as never,
    policy,
  );
  return { service, keys, events, audit, alerts, announce, limiter, wrap };
}

describe('ProviderKeysService', () => {
  it('lists one entry per provider with the fingerprint cut to 12 characters', async () => {
    const { service } = build({ existing: record() });
    const views = await service.keyStatus(OWNER);
    expect(views.map((v) => v.provider)).toEqual(['openai', 'wavespeed']);
    expect(views[0]).toMatchObject({
      configured: true,
      last4: 'wxyz',
      fingerprint: 'abcdef012345',
      inFlightJobCount: 2,
    });
    expect(views[1]).toMatchObject({ configured: false, status: null, inFlightJobCount: 0 });
  });

  it('stores a first valid key as active with added and test_passed events', async () => {
    const { service, keys, events, audit } = build({ existing: null });
    keys.find.mockResolvedValueOnce(null).mockResolvedValue(record() as never);
    const view = await service.storeKey(OWNER, 'openai', `${KEY} \n`, { requestId: 'r1' });
    expect(view.probe).toBe('valid');
    expect(keys.insert).toHaveBeenCalledOnce();
    expect(events.insert.mock.calls.map((c) => c[1])).toMatchObject([
      { kind: 'test_passed' },
      { kind: 'added' },
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'key.added', requestId: 'r1' }),
    );
  });

  it('replaces conditionally on version and stores untested when the probe is unknown', async () => {
    const { service, keys, events } = build({ existing: record(), probe: 'unknown' });
    const view = await service.storeKey(OWNER, 'openai', KEY);
    expect(view.probe).toBe('unknown');
    expect(keys.replace).toHaveBeenCalledWith(
      expect.anything(),
      'k1',
      1,
      expect.objectContaining({ status: 'untested', version: 2, validatedAt: null }),
    );
    expect(events.insert.mock.calls.map((c) => c[1].kind)).toEqual(['stored_untested', 'replaced']);
  });

  it('refuses a rejected key without storing and leaves a test_failed event', async () => {
    const { service, keys, events } = build({ probe: 'invalid', existing: record() });
    await expect(service.storeKey(OWNER, 'openai', KEY)).rejects.toMatchObject({
      code: 'key_invalid',
    });
    expect(keys.replace).not.toHaveBeenCalled();
    expect(events.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'test_failed' }),
    );
  });

  it.each([
    ['openai', 'short', 'format'],
    ['wavespeed', KEY, 'wrong_provider'],
  ] as const)('refuses a bad format (%s)', async (provider, key, reason) => {
    const { service } = build();
    const error = (await service
      .storeKey(OWNER, provider, key)
      .catch((e: unknown) => e)) as DomainError;
    expect(error).toBeInstanceOf(DomainError);
    expect(JSON.stringify(error)).not.toContain(key.length > 10 ? key : 'never-matches');
    expect(error.code).toBe('key_invalid');
    expect(JSON.stringify(error.details ?? error)).toContain(reason);
  });

  it('answers the 6th attempt with rate_limited and records one event for the first refusal only', async () => {
    const first = build({ allowed: false, count: 6 });
    await expect(first.service.storeKey(OWNER, 'openai', KEY)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(first.events.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'attempt_rate_limited' }),
    );
    const later = build({ allowed: false, count: 7 });
    await expect(later.service.storeKey(OWNER, 'openai', KEY)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(later.events.insert).not.toHaveBeenCalled();
  });

  it('gives up with state_conflict after two lost races', async () => {
    const { service, keys } = build({ writes: false });
    await expect(service.storeKey(OWNER, 'openai', KEY)).rejects.toMatchObject({
      code: 'state_conflict',
    });
    expect(keys.insert).toHaveBeenCalledTimes(2);
  });

  it('deletes a key with an event and audit, and reports not_found when none', async () => {
    const { service, keys, events, audit } = build();
    await service.deleteKey(OWNER, 'openai');
    expect(events.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'deleted' }),
    );
    expect(audit.record).toHaveBeenCalledOnce();
    keys.delete.mockResolvedValueOnce(null);
    await expect(service.deleteKey(OWNER, 'openai')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('deleteAllForOwner removes every key with one event each', async () => {
    const { service, events } = build();
    expect(await service.deleteAllForOwner({} as never, OWNER)).toBe(1);
    expect(events.insert).toHaveBeenCalledOnce();
  });

  it('lists events through the repository', async () => {
    const { service, events } = build();
    await service.listEvents(OWNER, { limit: 3 });
    expect(events.list).toHaveBeenCalledOnce();
  });

  it('disableAll disables, records, and announces the alert after commit', async () => {
    const { service, events, audit, alerts, announce } = build();
    expect(await service.disableAll()).toBe(1);
    expect(events.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'disabled_by_operator' }),
    );
    expect(audit.record).toHaveBeenCalledOnce();
    expect(alerts.raiseAlert).toHaveBeenCalledWith(expect.anything(), 'keys_disabled_all', null, {
      keys: 1,
    });
    expect(announce).toHaveBeenCalledOnce();
  });

  describe('recordAuthResult', () => {
    const row = {
      id: 'k1',
      ownerId: OWNER,
      provider: 'openai' as const,
      status: 'active' as const,
      consecutiveAuthFailures: 1,
    };

    it('success that activates leaves validated_by_job', async () => {
      const { service, keys, events } = build();
      keys.recordSuccess.mockResolvedValue({ row, activated: true });
      await service.recordAuthResult('k1', 1, true);
      expect(events.insert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: 'validated_by_job' }),
      );
    });

    it('success without change or a stale key records nothing', async () => {
      const { service, keys, events } = build();
      keys.recordSuccess
        .mockResolvedValueOnce({ row, activated: false })
        .mockResolvedValueOnce(null);
      await service.recordAuthResult('k1', 1, true);
      await service.recordAuthResult('k1', 1, true);
      expect(events.insert).not.toHaveBeenCalled();
    });

    it('a failure below the threshold records auth_failed only', async () => {
      const { service, keys, events, audit } = build();
      keys.recordFailure.mockResolvedValue(row);
      await service.recordAuthResult('k1', 1, false);
      expect(events.insert.mock.calls.map((c) => c[1].kind)).toEqual(['auth_failed']);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('the failure that reaches the threshold disables the key with audit', async () => {
      const { service, keys, events, audit } = build();
      keys.recordFailure.mockResolvedValue({ ...row, status: 'disabled' });
      await service.recordAuthResult('k1', 1, false);
      expect(events.insert.mock.calls.map((c) => c[1].kind)).toEqual(['auth_failed', 'disabled']);
      expect(audit.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'key.disabled' }),
      );
    });

    it('a failure for a replaced key counts for nothing', async () => {
      const { service, keys, events } = build();
      keys.recordFailure.mockResolvedValue(null);
      await service.recordAuthResult('k1', 1, false);
      expect(events.insert).not.toHaveBeenCalled();
    });
  });
});
