import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Heartbeat, PING_EVERY_BEATS } from './heartbeat.js';
import { runRecoverySweep } from './sweep.js';
import { SweepRegistry } from './sweep-registry.js';
import { EXIT_WATCHDOG, Watchdog } from './watchdog.js';

function log() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe('Watchdog (TC-RSE watchdog)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('exits 70 when the sweep stops finishing for longer than the limit', () => {
    const exit = vi.fn();
    const onStall = vi.fn();
    const dog = new Watchdog({ limitSec: 30, exit, onStall });
    dog.start();
    vi.advanceTimersByTime(25_000);
    dog.sweepDone();
    vi.advanceTimersByTime(25_000);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(EXIT_WATCHDOG);
    expect(onStall).toHaveBeenCalledWith('sweep', expect.any(Number));
    vi.advanceTimersByTime(120_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits 70 when the event loop was blocked past the limit', () => {
    let now = 1_000;
    const exit = vi.fn();
    const onStall = vi.fn();
    const dog = new Watchdog({ limitSec: 10, exit, onStall, now: () => now });
    now += 1_000;
    dog.check();
    dog.sweepDone();
    now += 11_000; // the loop did not run for 11 s
    dog.sweepDone();
    dog.check();
    expect(exit).toHaveBeenCalledWith(70);
    expect(onStall).toHaveBeenCalledWith('loop', 11);
  });

  it('stays quiet while the loop and the sweep both progress', () => {
    const exit = vi.fn();
    const dog = new Watchdog({ limitSec: 10, exit });
    dog.start();
    dog.start();
    for (let i = 0; i < 30; i += 1) {
      vi.advanceTimersByTime(5_000);
      dog.sweepDone();
    }
    dog.stop();
    dog.stop();
    expect(exit).not.toHaveBeenCalled();
  });

  it('refuses a non-positive limit', () => {
    expect(() => new Watchdog({ limitSec: 0, exit: vi.fn() })).toThrow('positive');
  });
});

describe('Heartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('logs worker_heartbeat every minute and pings the monitor every fifth beat', async () => {
    const out = log();
    const ping = vi.fn().mockResolvedValue(undefined);
    const beat = new Heartbeat({ log: out, pingUrl: 'https://hc.example/secret-token', ping });
    beat.start();
    beat.start();
    await vi.advanceTimersByTimeAsync(60_000 * PING_EVERY_BEATS);
    beat.stop();
    beat.stop();
    expect(out.info.mock.calls.filter((c) => c[1] === 'worker_heartbeat')).toHaveLength(5);
    expect(ping).toHaveBeenCalledExactlyOnceWith('https://hc.example/secret-token');
  });

  it('never logs the monitor URL and survives a failing ping', async () => {
    const out = log();
    const beat = new Heartbeat({
      log: out,
      pingUrl: 'https://hc.example/secret-token',
      ping: () => Promise.reject(new Error('https://hc.example/secret-token refused')),
    });
    for (let i = 0; i < PING_EVERY_BEATS; i += 1) await beat.beat();
    expect(out.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...out.info.mock.calls, ...out.warn.mock.calls])).not.toContain('secret-token');
  });

  it('does not ping without a URL, and the default ping rejects a non-2xx answer', async () => {
    const out = log();
    const none = new Heartbeat({ log: out });
    for (let i = 0; i < PING_EVERY_BEATS; i += 1) await none.beat();
    expect(out.warn).not.toHaveBeenCalled();

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    const real = new Heartbeat({ log: out, pingUrl: 'https://hc.example/x' });
    for (let i = 0; i < PING_EVERY_BEATS * 2; i += 1) await real.beat();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(out.warn).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});

describe('runRecoverySweep', () => {
  it('skips the tick when another worker holds the lock', async () => {
    const out = log();
    const registry = new SweepRegistry();
    const run = vi.fn();
    registry.register({ name: 'h', run });
    const result = await runRecoverySweep({
      registry,
      log: out,
      inTx: (fn) => fn({} as never),
      acquire: () => Promise.resolve(null),
    });
    expect(result).toEqual({ kind: 'skipped' });
    expect(run).not.toHaveBeenCalled();
  });

  it('runs every hook, reports a failing one without stopping the rest, and releases the lock', async () => {
    const out = log();
    const registry = new SweepRegistry();
    registry.register({ name: 'bad', run: () => Promise.reject(new Error('boom')) });
    registry.register({ name: 'good', run: () => Promise.resolve({ swept: 3 }) });
    const release = vi.fn().mockResolvedValue(undefined);
    const result = await runRecoverySweep({
      registry,
      log: out,
      inTx: (fn) => fn({} as never),
      acquire: () => Promise.resolve({ release }),
    });
    expect(result.kind).toBe('ran');
    if (result.kind === 'ran') {
      expect(result.results).toEqual([
        { name: 'bad', swept: 0, error: 'boom' },
        { name: 'good', swept: 3 },
      ]);
    }
    expect(out.warn).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the lock when the registry itself throws', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const registry = new SweepRegistry();
    vi.spyOn(registry, 'runAll').mockRejectedValue(new Error('down'));
    await expect(
      runRecoverySweep({
        registry,
        log: log(),
        inTx: (fn) => fn({} as never),
        acquire: () => Promise.resolve({ release }),
      }),
    ).rejects.toThrow('down');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
