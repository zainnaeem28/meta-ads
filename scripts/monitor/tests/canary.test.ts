import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLogger, runLoggedJob } from '../../../apps/api/src/platform/logging/index.ts';
import { CANARY_EMAIL, capture } from '../../../apps/api/src/platform/logging/test-support.ts';
import { createSentryAdapter } from '../../../apps/api/src/platform/metrics/sentry.ts';
import { startStubs, TOKEN } from './support/stubs.ts';
import type { Stubs } from './support/stubs.ts';

// TC-LOG-01 (REQ-019), TC-LOG-03 (NFR-09): a canary key is sent through every log path of the api's logger, through
// the REAL @sentry/node SDK wired by the api's adapter (so beforeSend, beforeBreadcrumb and the SDK's own request,
// user and extra channels are exercised, not a fake), and through monitor's token path. Every sink is captured and
// searched; the canary is absent from all of them. The canary values are minted per run and never printed.

const apiRequire = createRequire(
  join(import.meta.dirname, '..', '..', '..', 'apps', 'api', 'package.json'),
);
const sentry = apiRequire('@sentry/node') as {
  init(o: Record<string, unknown>): void;
  getClient(): { on(h: string, cb: (...a: unknown[]) => void): void } | undefined;
  captureException(e: unknown, hint?: unknown): void;
  addBreadcrumb(b: object): void;
  setUser(u: object): void;
  setContext(n: string, c: object): void;
  setExtra(k: string, v: unknown): void;
  setTag(k: string, v: string): void;
  flush(ms: number): Promise<boolean>;
  close(ms: number): Promise<boolean>;
};

const mint = (prefix: string): string =>
  `${prefix}canary-KEY-91ab-${randomBytes(8).toString('hex')}`;
const CANARY_KEY = mint('');
const CANARY_PROVIDER_KEY = mint('sk-');
const CANARY_BEARER = mint('');

const sinks: Record<string, string> = {};
let ingest: { url: string; bodies: string[]; close(): Promise<void> };
let stubs: Stubs;

beforeAll(async () => {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString());
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  ingest = {
    url: `http://canary@127.0.0.1:${port}/1`,
    bodies,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  stubs = await startStubs();
});

afterAll(async () => {
  await ingest.close();
  await stubs.close();
});

describe('canary key through every log path (TC-LOG-01, TC-LOG-03)', () => {
  it('the api logger: message, fields, error, child bindings, request headers, a failing job', async () => {
    const sink = capture();
    const { logger, scrub } = buildLogger({
      level: 'debug',
      releaseSha: 'abc1234',
      secretValues: [CANARY_KEY],
      destination: sink.stream,
    });
    scrub.learn(CANARY_BEARER);
    logger.info(`entry ${CANARY_KEY}`);
    logger.info(
      {
        apiKey: CANARY_KEY,
        email: CANARY_EMAIL,
        token: CANARY_BEARER,
        note: `rotated ${CANARY_PROVIDER_KEY}`,
      },
      'fields',
    );
    logger.info(
      { req: { headers: { authorization: `Bearer ${CANARY_BEARER}`, cookie: CANARY_BEARER } } },
      'request',
    );
    logger
      .child({ providerKey: CANARY_KEY, owner: CANARY_EMAIL })
      .warn(`provider said ${CANARY_PROVIDER_KEY}`);
    logger.error(
      new Error(`provider call failed with ${CANARY_KEY} for ${CANARY_EMAIL}`),
      `failing provider call ${CANARY_PROVIDER_KEY}`,
    );
    await expect(
      runLoggedJob(logger, { id: 'job-1', name: 'render' }, async () => {
        throw Object.assign(new Error(`500 from provider ${CANARY_KEY}`), { code: 'provider_500' });
      }),
    ).rejects.toThrow();
    sinks['api logger'] = sink.text();
    expect(sink.text().length).toBeGreaterThan(0);
  });

  it('the error reporter: the real SDK, through the adapter, to a local ingest', async () => {
    const dropped: number[] = [];
    const { createScrubber } = await import('../../../apps/api/src/platform/logging/redact.ts');
    const adapter = createSentryAdapter(
      { SENTRY_DSN: ingest.url, SENTRY_ENVIRONMENT: 'staging', RELEASE_SHA: 'abc1234' },
      {
        sdk: sentry as never,
        scrub: createScrubber([CANARY_KEY, CANARY_BEARER]),
        onDropped: () => dropped.push(1),
      },
    );
    expect(adapter).not.toBeNull();
    sentry.setUser({ email: CANARY_EMAIL, id: 'u-1', ip_address: '203.0.113.9' });
    sentry.setContext('provider', { apiKey: CANARY_KEY, note: CANARY_PROVIDER_KEY });
    sentry.setExtra('header', `Bearer ${CANARY_BEARER}`);
    sentry.setTag('owner', CANARY_EMAIL);
    sentry.addBreadcrumb({
      category: 'http',
      message: `GET /x?key=${CANARY_KEY}`,
      data: { url: `https://p.example.test/v1?token=${CANARY_BEARER}`, email: CANARY_EMAIL },
    });
    const failure = new Error(`provider failed with ${CANARY_KEY} for ${CANARY_EMAIL}`, {
      cause: new Error(`inner ${CANARY_PROVIDER_KEY}`),
    });
    adapter?.captureException(failure);
    await sentry.flush(5000);
    await adapter?.close();
    sinks['error reporter (real SDK, ingest bodies)'] = ingest.bodies.join('\n');
    expect(ingest.bodies.length, 'the SDK sent at least one envelope').toBeGreaterThan(0);
    expect(ingest.bodies.join('')).toContain('provider failed');
    expect(dropped).toEqual([]);
  });

  it('monitor: its token and DSN never reach stdout, stderr, the Sentry event or the heartbeat', async () => {
    const token = mint('');
    stubs.answer((_req, res) => {
      res.statusCode = 500;
      res.end(`internal error mentioning ${token}`);
    });
    const out = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
      const child = spawn(
        'node',
        [join(import.meta.dirname, '..', 'src', 'main.ts'), '--api-url', stubs.url],
        {
          env: {
            PATH: process.env['PATH'] ?? '',
            METRICS_TOKEN: token,
            SENTRY_DSN: `http://${CANARY_KEY}@${stubs.url.slice(7)}/1`,
            HEARTBEAT_URL_MONITOR: `${stubs.url}/heartbeat`,
          },
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c));
      child.stderr.on('data', (c: Buffer) => (stderr += c));
      child.on('close', () => resolve({ stdout, stderr }));
    });
    sinks['monitor stdout'] = out.stdout;
    sinks['monitor stderr'] = out.stderr;
    sinks['monitor Sentry events'] = stubs.envelopes.join('\n');
    expect(stubs.envelopes).toHaveLength(1);
    expect(out.stdout + out.stderr + stubs.envelopes.join('')).not.toContain(token);
    sinks['canary token of the monitor run'] = token;
  });

  it('negative probe: with redaction off the same detector finds the canary (the check can fail)', () => {
    const sink = capture();
    const { logger } = buildLogger({ destination: sink.stream, redaction: false });
    logger.info({ note: `leak ${CANARY_PROVIDER_KEY}` }, `entry ${CANARY_KEY}`);
    expect(sink.text()).toContain(CANARY_KEY);
    expect(sink.text()).toContain(CANARY_PROVIDER_KEY);
  });

  it('the canary is absent from every sink', () => {
    const canaries = [
      CANARY_KEY,
      CANARY_PROVIDER_KEY,
      CANARY_BEARER,
      CANARY_EMAIL,
      'canary-KEY-91ab',
      TOKEN,
    ];
    const lines: string[] = [];
    for (const [name, text] of Object.entries(sinks)) {
      if (name === 'canary token of the monitor run') continue;
      const hits = canaries.filter((c) => text.includes(c));
      const monitorToken = sinks['canary token of the monitor run'] ?? '';
      if (monitorToken !== '' && text.includes(monitorToken)) hits.push('monitor token');
      lines.push(
        `${hits.length === 0 ? 'CLEAN' : 'LEAK '} ${name}: ${text.length} bytes searched for ${canaries.length + 1} canaries, ${hits.length} found`,
      );
      expect(hits, name).toEqual([]);
    }
    const file = process.env['CANARY_EVIDENCE_FILE'];
    if (file !== undefined && file !== '') {
      writeFileSync(
        file,
        `# TC-LOG-01 / TC-LOG-03 canary run (TASK-010). Canary values are minted per run and are never written here.\n`,
      );
      appendFileSync(file, `${lines.join('\n')}\n`);
    }
  });
});
