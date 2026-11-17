import { describe, expect, it } from 'vitest';
import { AlertsController, cursorKeyFrom } from './alerts.controller.js';
import type { ActorContext } from '../../../platform/http/index.js';

const actor = (recent: boolean): ActorContext => ({
  userId: '00000000-0000-4000-8000-000000000001',
  role: 'admin',
  sessionId: 's',
  mfa: { required: true, satisfied: true },
  recentAuth: { satisfied: recent, maxAgeSeconds: 600 },
  authAgeMin: 1,
});
const record = (n: number, ack: string | null = null) => ({
  id: `00000000-0000-4000-8000-00000000010${String(n)}`,
  kind: 'job_burst' as const,
  subjectUserId: null,
  counts: { jobs: n },
  raisedAt: `2026-01-0${String(n)} 00:00:00.123456+00`,
  acknowledgedAt: ack,
  acknowledgedBy: ack === null ? null : actor(true).userId,
});
const request = { id: 'req-1' } as never;

function build(rows = [record(3), record(2), record(1)]) {
  const events: unknown[] = [];
  const queries: unknown[] = [];
  const alerts = {
    listAlerts: (_db: unknown, q: unknown) => (queries.push(q), Promise.resolve(rows)),
    acknowledge: (_db: unknown, id: string) =>
      Promise.resolve(
        id === record(1).id
          ? { status: 'acknowledged', alert: record(1, '2026-02-01 00:00:00+01') }
          : { status: 'not_found' },
      ),
  };
  const audit = { record: (_db: unknown, e: unknown) => (events.push(e), Promise.resolve('id')) };
  const controller = new AlertsController(
    alerts as never,
    audit as never,
    { db: {} } as never,
    'k'.repeat(40),
  );
  return { controller, events, queries };
}

describe('AlertsController', () => {
  it('lists with limit + 1, keeps microseconds and pages through a signed cursor', async () => {
    const { controller, queries } = build();
    const page = await controller.list(actor(true), request, { limit: '2' });
    expect(queries[0]).toMatchObject({ limit: 3 });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.raisedAt).toBe('2026-01-03T00:00:00.123456Z');
    expect(page.pagination.hasNextPage).toBe(true);
    await controller.list(actor(true), request, { limit: '2', cursor: page.pagination.nextCursor });
    expect(queries[1]).toMatchObject({
      after: { acknowledgedAt: null, raisedAt: record(2).raisedAt },
    });
  });

  it('audits and refuses a missing recent authentication, even when the audit write fails', async () => {
    const { controller, events } = build();
    await expect(controller.list(actor(false), request, {})).rejects.toMatchObject({
      code: 'recent_auth_required',
    });
    expect(events).toMatchObject([
      { action: 'auth.denied', outcome: 'denied', requestId: 'req-1' },
    ]);
    const broken = new AlertsController(
      {} as never,
      { record: () => Promise.reject(new Error('down')) } as never,
      { db: {} } as never,
      'k',
    );
    await expect(broken.acknowledge(actor(false), request, {})).rejects.toMatchObject({
      code: 'recent_auth_required',
    });
  });

  it('refuses a request with no actor or no database, and maps not found and a bad ID', async () => {
    const { controller } = build();
    await expect(controller.list(undefined, request, {})).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    const noDb = new AlertsController({} as never, {} as never, undefined, 'k');
    await expect(noDb.list(actor(true), request, {})).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    await expect(
      controller.acknowledge(actor(true), request, { alertId: 'x' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      controller.acknowledge(actor(true), request, {
        alertId: '00000000-0000-4000-8000-000000000999',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const done = await controller.acknowledge(actor(true), request, { alertId: record(1).id });
    expect(done.acknowledgedAt).toBe('2026-01-31T23:00:00.000Z');
  });

  it('rejects malformed cursor positions and falls back to a per-process key', async () => {
    const { controller } = build();
    await expect(
      controller.list(actor(true), request, { cursor: 'garbage' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(cursorKeyFrom({ CURSOR_SIGNING_KEY: 'abc' })).toBe('abc');
    expect(cursorKeyFrom({})).toHaveLength(64);
  });
});
