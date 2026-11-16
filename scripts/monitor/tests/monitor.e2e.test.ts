import { spawn } from 'node:child_process';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { body, json, quiet, startStubs, TOKEN } from './support/stubs.ts';
import type { Sample, Stubs } from './support/stubs.ts';

// TC-ALR-04..06 through the real entry point: `node src/main.ts` as a fresh process per body (no state between runs,
// no database), against a stub of API-903 with a Sentry ingest and a heartbeat endpoint.

const main = join(import.meta.dirname, '..', 'src', 'main.ts');
let stubs: Stubs;

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
  states: Record<string, string>;
}

function runMonitor(
  extra: Record<string, string> = {},
  args: string[] = ['--api-url', stubs.url],
): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn('node', [main, ...args], {
      env: {
        PATH: process.env['PATH'] ?? '',
        METRICS_TOKEN: TOKEN,
        SENTRY_DSN: `http://publickey@${stubs.url.slice('http://'.length)}/1`,
        SENTRY_ENVIRONMENT: 'staging',
        HEARTBEAT_URL_MONITOR: `${stubs.url}/heartbeat`,
        ...extra,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('close', (code) => {
      const line = stdout.split('\n').find((l) => l.startsWith('{'));
      const results =
        line === undefined
          ? []
          : (JSON.parse(line) as { results: { rule: string; state: string }[] }).results;
      resolve({
        code,
        stdout,
        stderr,
        states: Object.fromEntries(results.map((r) => [r.rule, r.state])),
      });
    });
  });
}

const feed = (value: unknown): void => stubs.answer((_req, res) => json(res, 200, value));
const s = (requests: number, errors5xx: number, p95Ms: number | null = 100): Sample => ({
  requests,
  errors5xx,
  p95Ms,
});
const fresh = (): void => {
  stubs.envelopes.length = 0;
  stubs.heartbeats = 0;
};
const events = (): {
  message: string;
  tags: Record<string, string>;
  extra: Record<string, unknown>;
}[] => stubs.envelopes.map((e) => JSON.parse(e.split('\n')[2] ?? '{}') as never);

beforeAll(async () => {
  stubs = await startStubs();
});
afterAll(async () => {
  await stubs.close();
});

describe('ALR-2 and ALR-3 from API-903 (TC-ALR-04)', () => {
  it('(a) 99 requests with 50 errors: "insufficient data" is the state, no event', async () => {
    fresh();
    feed(body({ w10: s(99, 50), w15: s(99, 50) }));
    const out = await runMonitor();
    expect(out.code).toBe(0);
    expect(out.states['ALR-2']).toBe('insufficient_data');
    expect(events()).toHaveLength(0);
  });
  it('(b) 2% is no alert; (c) 3% sends one scrubbed ALR-2 event with numbers only', async () => {
    fresh();
    feed(body({ w10: s(100, 2), w15: s(100, 2) }));
    expect((await runMonitor()).states['ALR-2']).toBe('ok');
    expect(events()).toHaveLength(0);
    feed(body({ w10: s(100, 3), w15: s(100, 3) }));
    const out = await runMonitor();
    expect(out.states['ALR-2']).toBe('alert');
    const [event] = events();
    expect(events()).toHaveLength(1);
    expect(event).toMatchObject({
      message: 'ALR-2 alert',
      tags: { rule: 'ALR-2' },
      extra: { requests10m: 100, errors5xx10m: 3 },
    });
  });
  it('(d) recovery from windows[1] sends no event', async () => {
    fresh();
    feed(body({ w10: s(10, 0), w15: s(100, 0) }));
    expect((await runMonitor()).states['ALR-2']).toBe('recovered');
    expect(events()).toHaveLength(0);
  });
  it('(e) to (h) latency: insufficient, alert, null p95, recovery', async () => {
    fresh();
    const states: string[] = [];
    for (const w15 of [s(199, 0, 900), s(200, 0, 501), s(300, 0, null), s(200, 0, 500)]) {
      feed(body({ w10: quiet, w15 }));
      states.push((await runMonitor()).states['ALR-3'] ?? '');
    }
    expect(states).toEqual(['insufficient_data', 'alert', 'insufficient_data', 'recovered']);
    expect(events().map((e) => e.tags.rule)).toEqual(['ALR-3']);
  });
});

describe('ALR-7 (TC-ALR-05)', () => {
  it('fires one ticket event above the threshold and none below, a fresh process each time', async () => {
    fresh();
    feed(body({ w10: quiet, w15: quiet, pool: { acquisitions: 40, waited: 12, p95WaitMs: 400 } }));
    expect((await runMonitor()).states['ALR-7']).toBe('alert');
    expect(events()).toHaveLength(1);
    expect(events()[0]?.tags['severity']).toBe('ticket');
    fresh();
    feed(body({ w10: quiet, w15: quiet, pool: { acquisitions: 40, waited: 1, p95WaitMs: 20 } }));
    expect((await runMonitor()).states['ALR-7']).toBe('recovered');
    expect(events()).toHaveLength(0);
  });
});

describe('ALR-9 (TC-ALR-06)', () => {
  const failures: [string, (req: unknown, res: ServerResponse) => void][] = [
    ['404', (_r, res) => json(res, 404, { success: false })],
    ['500', (_r, res) => json(res, 500, { success: false })],
    ['timeout', () => undefined],
    ['malformed body', (_r, res) => json(res, 200, { success: true, data: { windows: [] } })],
    ['not JSON', (_r, res) => void res.end('<html>')],
  ];
  for (const [name, handler] of failures) {
    it(`(a to d) ${name} raises ALR-9 only, exits 0, still pings the heartbeat, and leaks no token`, async () => {
      fresh();
      stubs.answer(handler);
      const out = await runMonitor({}, ['--api-url', stubs.url, '--timeout-ms', '400']);
      expect(out.code).toBe(0);
      expect(Object.keys(out.states)).toEqual(['ALR-9']);
      expect(events()).toHaveLength(1);
      expect(events()[0]?.tags['rule']).toBe('ALR-9');
      expect(stubs.heartbeats).toBe(1);
      for (const sink of [out.stdout, out.stderr, ...stubs.envelopes])
        expect(sink).not.toContain(TOKEN);
    }, 30_000);
  }
  it('clears when a valid 200 returns', async () => {
    fresh();
    feed(body({ w10: quiet, w15: quiet }));
    const out = await runMonitor();
    expect(out.states['ALR-9']).toBe('ok');
    expect(events()).toHaveLength(0);
  });
  it('(e) fires on telemetryDropped10m only: 3 alerts; total 4 with 0 in the window does not; (f) restart does not', async () => {
    fresh();
    feed(body({ w10: quiet, w15: quiet, dropped10m: 3, droppedTotal: 3 }));
    expect((await runMonitor()).states['ALR-9']).toBe('alert');
    expect(events()).toHaveLength(1);
    fresh();
    feed(body({ w10: quiet, w15: quiet, dropped10m: 0, droppedTotal: 4 }));
    expect((await runMonitor()).states['ALR-9']).toBe('ok');
    feed(body({ w10: quiet, w15: quiet, dropped10m: 0, droppedTotal: 0 }));
    expect((await runMonitor()).states['ALR-9']).toBe('ok');
    expect(events()).toHaveLength(0);
  });
});

describe('process contract', () => {
  it('sends the token as a bearer header to API-903', async () => {
    feed(body({ w10: quiet, w15: quiet }));
    stubs.headers.length = 0;
    await runMonitor();
    expect(stubs.headers.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
  });
  it('a wrong token is the 404 of the api: ALR-9, and the wrong token is not echoed', async () => {
    fresh();
    const wrong = 'w'.repeat(43);
    const out = await runMonitor({ METRICS_TOKEN: wrong });
    expect(out.states['ALR-9']).toBe('alert');
    for (const sink of [out.stdout, out.stderr, ...stubs.envelopes])
      expect(sink).not.toContain(wrong);
  });
  it('stays quiet and exits 0 with no DSN and no heartbeat URL (the adapter is off)', async () => {
    fresh();
    feed(body({ w10: s(100, 50), w15: s(100, 50) }));
    const out = await runMonitor({ SENTRY_DSN: '', HEARTBEAT_URL_MONITOR: '' });
    expect(out.code).toBe(0);
    expect(out.states['ALR-2']).toBe('alert');
    expect(stubs.envelopes).toHaveLength(0);
    expect(stubs.heartbeats).toBe(0);
  });
  it('reports a delivery failure without printing the DSN, and exits 0', async () => {
    feed(body({ w10: s(100, 50), w15: s(100, 50) }));
    const dsn = 'http://secretkey123@127.0.0.1:9/1';
    const out = await runMonitor({ SENTRY_DSN: dsn });
    expect(out.code).toBe(0);
    expect(out.stderr).toContain('could not be delivered');
    expect(out.stdout + out.stderr).not.toContain('secretkey123');
  });
  it('exits 64 without METRICS_TOKEN or without --api-url', async () => {
    expect((await runMonitor({ METRICS_TOKEN: '' })).code).toBe(64);
    expect((await runMonitor({}, [])).code).toBe(64);
  });
});
