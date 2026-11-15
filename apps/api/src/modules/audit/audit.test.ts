import { describe, expect, it } from 'vitest';
import { AlertService, AuditService } from './application/audit.service.js';
import type { AlertSink, AuditEventInput, AuditRepository, Executor } from './application/ports.js';
import { ALERT_KINDS, AUDIT_ACTIONS, assertCounts, dedupeKeyOf } from './domain/catalogue.js';

const db = {} as Executor;
const UUID = '0197a1b2-0000-7000-8000-000000000001';

function fakeRepository(open = new Set<string>()) {
  const events: AuditEventInput[] = [];
  const repository = {
    insertEvent: (_db, _id, event) => {
      events.push(event);
      return Promise.resolve();
    },
    insertAlert: (_db, alert) => {
      if (open.has(alert.dedupeKey)) return Promise.resolve(false);
      open.add(alert.dedupeKey);
      return Promise.resolve(true);
    },
    listAlerts: () => Promise.resolve([]),
    acknowledge: () => Promise.resolve(null),
    findAlert: () => Promise.resolve(null),
  } satisfies AuditRepository;
  return { repository, events };
}

const event: AuditEventInput = {
  actorId: UUID,
  actorType: 'admin',
  action: 'role.granted',
  objectType: 'user',
  objectId: UUID,
  outcome: 'allowed',
};

describe('audit catalogue (ARCHITECTURE §7.4)', () => {
  it('lists every action once and every alert kind of admin_alerts.kind', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    expect(AUDIT_ACTIONS).toHaveLength(32);
    expect(ALERT_KINDS).toHaveLength(8);
  });

  it('accepts integer counts and refuses values, long keys and more than ten keys', () => {
    expect(() => assertCounts({ stuck: 3, failed: 0 })).not.toThrow();
    expect(() => assertCounts({ email: 'a@b.c' as unknown as number })).toThrow(/integers/);
    expect(() => assertCounts({ 'a@b.c': 1 })).toThrow(/snake_case/);
    const eleven = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${String(i)}`, i]));
    expect(() => assertCounts(eleven)).toThrow(/at most 10/);
  });

  it('keys one open alert per kind and subject', () => {
    expect(dedupeKeyOf('job_burst', null)).toBe('job_burst:-');
    expect(dedupeKeyOf('job_burst', UUID)).toBe(`job_burst:${UUID}`);
  });
});

describe('AuditService.record', () => {
  it('writes the event with the stated fields', async () => {
    const { repository, events } = fakeRepository();
    const id = await new AuditService(repository).record(db, { ...event, requestId: 'req-1' });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(events).toEqual([{ ...event, requestId: 'req-1' }]);
  });

  it('refuses an action outside the catalogue, a bad actor type, a bad outcome and an anonymous user', async () => {
    const service = new AuditService(fakeRepository().repository);
    await expect(service.record(db, { ...event, action: 'x.y' as never })).rejects.toThrow(
      /catalogue/,
    );
    await expect(service.record(db, { ...event, actorType: 'bot' as never })).rejects.toThrow(
      /actor type/,
    );
    await expect(service.record(db, { ...event, outcome: 'maybe' as never })).rejects.toThrow(
      /outcome/,
    );
    await expect(service.record(db, { ...event, actorId: null })).rejects.toThrow(/actor ID/);
    await expect(
      service.record(db, { ...event, actorId: null, actorType: 'system' }),
    ).resolves.toBeTypeOf('string');
  });
});

describe('AlertService', () => {
  function build(open?: Set<string>) {
    const emitted: unknown[] = [];
    const sink: AlertSink = { emit: (alert) => emitted.push(alert) };
    return { service: new AlertService(fakeRepository(open).repository, sink), emitted };
  }

  it('announces once, only when asked, and not for a duplicate open alert', async () => {
    const { service, emitted } = build();
    const first = await service.raiseAlert(db, 'job_burst', UUID, { jobs: 40 });
    expect(first.raised).toBe(true);
    expect(emitted).toEqual([]);
    first.announce();
    first.announce();
    expect(emitted).toEqual([{ id: first.alertId, kind: 'job_burst', subjectUserId: UUID }]);
    const again = await service.raiseAlert(db, 'job_burst', UUID, { jobs: 41 });
    expect(again).toMatchObject({ raised: false, alertId: null });
    again.announce();
    expect(emitted).toHaveLength(1);
  });

  it('refuses an unknown kind and bad counts before writing', async () => {
    const { service } = build();
    await expect(service.raiseAlert(db, 'nope' as never, null, {})).rejects.toThrow(/kind/);
    await expect(service.raiseAlert(db, 'job_burst', null, { a: 1.5 })).rejects.toThrow(/integers/);
  });

  it('bounds the page size and reports acknowledge outcomes', async () => {
    const { service } = build();
    await expect(service.listAlerts(db, { limit: 0 })).rejects.toThrow(RangeError);
    await expect(service.listAlerts(db, { limit: 101 })).rejects.toThrow(RangeError);
    await expect(service.listAlerts(db, { limit: 10 })).resolves.toEqual([]);
    await expect(service.acknowledge(db, UUID, UUID)).resolves.toEqual({ status: 'not_found' });
  });
});

describe('LogAlertSink', () => {
  it('logs the kind and subject only, never counts', async () => {
    const { LogAlertSink } = await import('./infrastructure/log-alert-sink.js');
    const calls: unknown[][] = [];
    new LogAlertSink({ warn: (...args: unknown[]) => void calls.push(args) } as never).emit({
      id: UUID,
      kind: 'job_burst',
      subjectUserId: null,
    });
    expect(calls).toEqual([
      [{ module: 'audit', code: 'job_burst', userId: null, jobId: UUID }, 'admin_alert'],
    ]);
  });
});
