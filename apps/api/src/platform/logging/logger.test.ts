import { describe, expect, it } from 'vitest';
import { buildLogger, jobLogger, runLoggedJob } from './logger.js';
import { scrubReportEvent, scrubSpanAttributes } from './redact.js';
import {
  CANARIES,
  CANARY_EMAIL,
  CANARY_KEY,
  CANARY_SECRET,
  CANARY_TOKEN,
  capture,
  expectNoCanary,
} from './test-support.js';

const SHA = 'abcdef1234567';

function make(redaction = true) {
  const sink = capture();
  const { logger, scrub } = buildLogger({
    level: 'debug',
    releaseSha: SHA,
    secretValues: [CANARY_SECRET],
    destination: sink.stream,
    redaction,
  });
  if (redaction) scrub.learn(CANARY_TOKEN);
  return { sink, logger, scrub };
}

/** Sends the canaries down every path a process has: message, fields, errors, children, jobs, reporter, trace. */
async function sendCanaryEverywhere(
  logger: ReturnType<typeof make>['logger'],
  scrub: ReturnType<typeof make>['scrub'],
  reported: unknown[],
) {
  logger.info(`entry ${CANARY_KEY}`);
  logger.info({ apiKey: CANARY_KEY, email: CANARY_EMAIL, token: CANARY_TOKEN }, 'fields');
  logger.info(
    { req: { headers: { authorization: `Bearer ${CANARY_TOKEN}`, cookie: CANARY_TOKEN } } },
    'req',
  );
  logger.warn({ code: 'E_PROVIDER', msg: CANARY_SECRET }, `rotation ${CANARY_SECRET}`);
  logger.error({ err: new Error(`provider said ${CANARY_KEY}`) }, `500 ${CANARY_EMAIL}`);
  logger.child({ userId: 'u1', apiKey: CANARY_KEY }).info('child');
  const job = {
    id: 'job-1',
    name: 'render',
    data: { correlationId: 'req-12345678', apiKey: CANARY_KEY, transcript: CANARY_TOKEN },
  };
  await runLoggedJob(logger, job, async (log) => {
    log.info({ provider: 'openai' }, `submitting ${CANARY_KEY}`);
  });
  await expect(
    runLoggedJob(logger, job, async () => {
      throw Object.assign(new Error(`failed with ${CANARY_KEY} for ${CANARY_EMAIL}`), {
        code: 'E_X',
      });
    }),
  ).rejects.toThrow();
  await expect(
    runLoggedJob(logger, job, async () => {
      throw 'not an error';
    }),
  ).rejects.toBe('not an error');
  reported.push(
    scrubReportEvent({ message: `x ${CANARY_KEY}`, extra: { email: CANARY_EMAIL } }, scrub),
  );
  reported.push(scrubSpanAttributes({ 'http.url': `/k/${CANARY_TOKEN}` }, scrub));
}

describe('logger', () => {
  it('writes JSON with releaseSha, ISO time and a level label on every line', () => {
    const { sink, logger } = make();
    logger.info({ requestId: 'abc-12345678', status: 200 }, 'hello');
    logger.child({ jobId: 'j1', jobType: 'render' }).info('child');
    const [first, second] = sink.lines();
    expect(first).toMatchObject({
      level: 'info',
      msg: 'hello',
      requestId: 'abc-12345678',
      status: 200,
      releaseSha: SHA,
    });
    expect(first?.['time']).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(second).toMatchObject({ jobId: 'j1', jobType: 'render', releaseSha: SHA });
    for (const line of sink.lines()) {
      expect(
        Object.keys(line).every((k) =>
          [
            'time',
            'level',
            'msg',
            'requestId',
            'status',
            'jobId',
            'jobType',
            'releaseSha',
          ].includes(k),
        ),
      ).toBe(true);
    }
  });

  it('defaults the level and release SHA', () => {
    const sink = capture();
    const { logger } = buildLogger({ destination: sink.stream });
    logger.debug('hidden');
    logger.info('shown');
    expect(sink.lines()).toHaveLength(1);
    expect(sink.lines()[0]).toMatchObject({ releaseSha: 'unknown' });
  });

  it('drops an unlisted field and scrubs email, token and key shapes (TC-LOG-03)', () => {
    const { sink, logger } = make();
    logger.info(
      {
        transcript: 'my private words',
        imageDescription: 'a face',
        email: CANARY_EMAIL,
        route: '/api/v1/x',
      },
      `contact ${CANARY_EMAIL} token Bearer abcdef0123456789`,
    );
    const text = sink.text();
    expect(text).not.toMatch(/private words|a face|@example|abcdef0123456789/);
    expect(sink.lines()[0]).toMatchObject({ route: '/api/v1/x' });
  });

  it('keeps the canary out of every request path, error path, job payload, reporter and trace (TC-LOG-01)', async () => {
    const { sink, logger, scrub } = make();
    const reported: unknown[] = [];
    await sendCanaryEverywhere(logger, scrub, reported);
    const everything = sink.text() + JSON.stringify(reported);
    expect(expectNoCanary(everything)).toEqual([]);
    expect(sink.lines().length).toBeGreaterThan(8);
  });

  it('negative probe: with redaction disabled the canary appears, so the test would fail', async () => {
    const { sink, logger, scrub } = make(false);
    const reported: unknown[] = [];
    await sendCanaryEverywhere(logger, scrub, reported);
    const found = expectNoCanary(sink.text() + JSON.stringify(reported));
    expect(found.length).toBeGreaterThan(0);
    expect(found).toEqual(expect.arrayContaining(CANARIES.slice(0, 3)));
  });

  it('logs a job with its jobId, jobType, correlationId, outcome and code only', async () => {
    const { sink, logger } = make();
    const job = { id: 'job-9', name: 'render', data: { correlationId: 'req-98765432' } };
    await runLoggedJob(logger, job, async () => 'done');
    await expect(
      runLoggedJob(logger, job, async () => {
        throw Object.assign(new Error('nope'), { code: 'E_NOPE' });
      }),
    ).rejects.toThrow('nope');
    const [ok, failed] = sink.lines();
    expect(ok).toMatchObject({
      jobId: 'job-9',
      jobType: 'render',
      correlationId: 'req-98765432',
      outcome: 'ok',
    });
    expect(failed).toMatchObject({ outcome: 'error', code: 'E_NOPE', level: 'error' });
    expect(jobLogger(logger, { id: 'j', name: 'n' })).toBeDefined();
  });
});
