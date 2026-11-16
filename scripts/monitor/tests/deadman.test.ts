import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateDeadMan, loadHeartbeats, startReceiver } from '../src/deadman.ts';
import type { HeartbeatReceiver } from '../src/deadman.ts';
import { body, json, quiet, startStubs } from './support/stubs.ts';
import type { Stubs } from './support/stubs.ts';

// Missing-data signal in the local stack: the monitor cron pings its heartbeat after every run; stop it and the
// dead-man rule fires once the expected interval plus the grace has passed. (The vendor does this in production.)

let receiver: HeartbeatReceiver;
let stubs: Stubs;
let clock = Date.parse('2026-11-16T12:00:00Z');
const minute = 60_000;

function runMonitorOnce(): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'node',
      [join(import.meta.dirname, '..', 'src', 'main.ts'), '--api-url', stubs.url],
      {
        env: {
          PATH: process.env['PATH'] ?? '',
          METRICS_TOKEN: stubs.token,
          HEARTBEAT_URL_MONITOR: receiver.url('monitor'),
        },
      },
    );
    child.on('close', resolve);
  });
}

beforeAll(async () => {
  stubs = await startStubs();
  stubs.answer((_req, res) => json(res, 200, body({ w10: quiet, w15: quiet })));
  receiver = await startReceiver(() => clock);
});
afterAll(async () => {
  await stubs.close();
  await receiver.close();
});

describe('dead-man switch', () => {
  const defs = loadHeartbeats();

  it('defines the worker, monitor and backup heartbeats with their alerts', () => {
    expect(defs.map((d) => [d.id, d.alert])).toEqual([
      ['worker', 'ALR-4'],
      ['monitor', 'ALR-9'],
      ['backup', 'ALR-6'],
    ]);
    expect(defs.find((d) => d.id === 'backup')).toMatchObject({
      expectEveryMinutes: 1440,
      graceMinutes: 120,
    });
  });

  it('is quiet while the monitor keeps pinging and fires after it stops', async () => {
    expect(await runMonitorOnce()).toBe(0);
    const monitor = defs.filter((d) => d.id === 'monitor');
    expect(evaluateDeadMan(monitor, receiver.lastPing, clock)[0]?.state).toBe('ok');
    clock += 5 * minute;
    expect(await runMonitorOnce()).toBe(0);
    expect(evaluateDeadMan(monitor, receiver.lastPing, clock + 10 * minute)[0]?.state).toBe('ok');
    // The heartbeat stops: no run, time passes, the rule fires after expectEvery + grace (15 minutes).
    expect(evaluateDeadMan(monitor, receiver.lastPing, clock + 16 * minute)[0]).toMatchObject({
      state: 'fired',
      alert: 'ALR-9',
    });
  });

  it('fires for a heartbeat that never arrived, and the backup rule is the 26-hour rule', () => {
    const all = evaluateDeadMan(defs, receiver.lastPing, clock);
    expect(all.find((r) => r.id === 'worker')).toMatchObject({
      state: 'fired',
      silentMinutes: null,
    });
    const backup = defs.filter((d) => d.id === 'backup');
    const pings = new Map([['backup', clock]]);
    expect(evaluateDeadMan(backup, pings, clock + 26 * 60 * minute)[0]?.state).toBe('ok');
    expect(evaluateDeadMan(backup, pings, clock + 26 * 60 * minute + 1)[0]?.state).toBe('fired');
  });

  it('the receiver ignores paths that are not a heartbeat', async () => {
    const before = receiver.lastPing.size;
    expect((await fetch(receiver.url('x').replace('/ping/x', '/other'))).status).toBe(404);
    expect(receiver.lastPing.size).toBe(before);
  });
});
