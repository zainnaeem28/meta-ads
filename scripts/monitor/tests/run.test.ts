import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readWindow } from '../src/reader.ts';
import { loadThresholds } from '../src/rules.ts';
import { run } from '../src/run.ts';
import { createSink, parseDsn, sentryEnvelope } from '../src/sinks.ts';
import { body, json, quiet, startStubs, TOKEN } from './support/stubs.ts';
import type { Stubs } from './support/stubs.ts';

// The same code as the process tests, in-process: reader failure codes, sinks, and one run's report.

let stubs: Stubs;
beforeAll(async () => void (stubs = await startStubs()));
afterAll(async () => stubs.close());

describe('readWindow', () => {
  it('reads a valid 200', async () => {
    stubs.answer((_r, res) => json(res, 200, body({ w10: quiet, w15: quiet })));
    expect((await readWindow(stubs.url, TOKEN, 2000)).ok).toBe(true);
  });
  it('maps each failure to a fixed reason', async () => {
    stubs.answer((_r, res) => json(res, 503, {}));
    expect(await readWindow(stubs.url, TOKEN, 2000)).toEqual({
      ok: false,
      reason: 'status',
      status: 503,
    });
    stubs.answer((_r, res) => void res.end('nope'));
    expect(await readWindow(stubs.url, TOKEN, 2000)).toMatchObject({
      ok: false,
      reason: 'invalid_body',
    });
    stubs.answer(() => undefined);
    expect(await readWindow(stubs.url, TOKEN, 200)).toMatchObject({ ok: false, reason: 'timeout' });
    expect(await readWindow('http://127.0.0.1:9', TOKEN, 2000)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
    stubs.answer((_r, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"success":');
      setTimeout(() => res.destroy(), 20);
    });
    expect(['invalid_body', 'timeout', 'unreachable']).toContain(
      ((await readWindow(stubs.url, TOKEN, 2000)) as { reason: string }).reason,
    );
  });
});

describe('sinks', () => {
  it('parses a DSN and refuses a malformed one', () => {
    expect(parseDsn('https://abc@o1.ingest.example.test/42')).toEqual({
      endpoint: 'https://o1.ingest.example.test/api/42/envelope/',
      key: 'abc',
    });
    for (const bad of [
      '',
      'not a url',
      'https://o1.ingest.example.test/42',
      'https://abc@o1.ingest.example.test/x',
    ])
      expect(parseDsn(bad)).toBeNull();
  });
  it('builds an envelope of rule and numbers only, with one fingerprint per rule', () => {
    const lines = sentryEnvelope(
      {
        rule: 'ALR-3',
        state: 'alert',
        severity: 'ticket',
        numbers: { requests15m: 300, p95Ms15m: 900 },
      },
      'staging',
      new Date(0),
    )
      .trim()
      .split('\n');
    const event = JSON.parse(lines[2] ?? '{}') as Record<string, unknown>;
    expect(event).toMatchObject({
      level: 'warning',
      environment: 'staging',
      fingerprint: ['ALR-3'],
      extra: { requests15m: 300, p95Ms15m: 900 },
    });
    expect(Object.keys(event).sort()).toEqual([
      'environment',
      'event_id',
      'extra',
      'fingerprint',
      'level',
      'logger',
      'message',
      'platform',
      'tags',
      'timestamp',
    ]);
  });
  it('is off without a DSN and reports a bad DSN as an undelivered event', async () => {
    const off = createSink({});
    expect(
      await off.report(
        { rule: 'ALR-2', state: 'alert', severity: 'page-worthy', numbers: {} },
        undefined,
      ),
    ).toBe(true);
    expect(await off.heartbeat()).toBe(true);
    const bad = createSink({ sentryDsn: 'garbage' });
    expect(
      await bad.report(
        { rule: 'ALR-2', state: 'alert', severity: 'page-worthy', numbers: {} },
        undefined,
      ),
    ).toBe(false);
    const down = createSink({ heartbeatUrl: 'http://127.0.0.1:9/x' });
    expect(await down.heartbeat()).toBe(false);
  });
});

describe('run', () => {
  it('returns the results, the alert list and the heartbeat state, and logs numbers only', async () => {
    stubs.envelopes.length = 0;
    stubs.answer((_r, res) =>
      json(
        res,
        200,
        body({ w10: { requests: 100, errors5xx: 9, p95Ms: 100 }, w15: quiet, dropped10m: 2 }),
      ),
    );
    const lines: string[] = [];
    const report = await run({
      apiUrl: stubs.url,
      metricsToken: TOKEN,
      thresholds: loadThresholds(),
      sink: createSink({
        sentryDsn: `http://k@${stubs.url.slice(7)}/1`,
        heartbeatUrl: `${stubs.url}/heartbeat`,
      }),
      environment: 'staging',
      log: (l) => lines.push(l),
    });
    expect(report.alerts).toEqual(['ALR-2', 'ALR-9']);
    expect(report).toMatchObject({ delivered: true, heartbeat: true });
    expect(stubs.envelopes).toHaveLength(2);
    expect(lines.join('')).not.toContain(TOKEN);
  });
});
