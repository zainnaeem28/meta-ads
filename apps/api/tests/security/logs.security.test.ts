import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLogger } from '../../src/platform/logging/index.js';
import { canaries, runImageAnalysis, seedSubject } from './support/data.js';
import type { Seeded } from './support/data.js';
import { OPENAI_CANARY, bootStack, failWith, rowsHolding, silentJobLog } from './support/stack.js';
import type { Account, Stack } from './support/stack.js';

// TASK-116: TC-LOG-01, TC-LOG-03, TC-NFR-09 (log scan); SECT-LOG-01, 03, 05; SECT-PD-06 (no personal data in logs), through the
// real api and worker composition roots on real PostgreSQL. A full journey runs with synthetic subjects (key entry, a failing
// provider call, a 500 carrying the canaries, reads, an image analysis, a campaign deletion, suspend, reinstate and removal
// with its erasure run); then every sink the product writes is scanned for the canaries.

let s: Stack;
let boss: Account;
let u: Account;
let seeded: Seeded;
const SECOND_KEY = `${OPENAI_CANARY}-second`;
const responses: string[] = [];
const description = canaries('logs0001').description;
let signedUrl = '';
let analysisText: string | null = null;

async function call(...args: Parameters<Stack['call']>) {
  const res = await s.call(...args);
  responses.push(res.raw);
  return res;
}

beforeAll(async () => {
  s = await bootStack('t116log');
  boss = await s.admin('logboss');
  u = await s.account('logjourney');
  seeded = await seedSubject(s, u, 'logs0001');

  // Key entry, a failing provider probe whose body echoes the key, a timeout, replacement and deletion.
  s.probe.answer = 401;
  expect(
    (await call('PUT', '/me/provider-keys/openai', u.token, { apiKey: SECOND_KEY })).status,
  ).toBeGreaterThanOrEqual(400);
  s.probe.answer = 'timeout';
  await call('PUT', '/me/provider-keys/openai', u.token, { apiKey: `${SECOND_KEY}-t` });
  s.probe.answer = 200;
  expect(
    (await call('PUT', '/me/provider-keys/openai', u.token, { apiKey: `${SECOND_KEY}-ok` })).status,
  ).toBe(200);
  // Reads of the subject's own data, with a signed URL.
  for (const url of [
    '/me',
    '/me/provider-keys',
    '/me/key-events',
    '/campaigns',
    `/media/${seeded.upload}`,
  ])
    expect((await call('GET', url, u.token)).status).toBe(200);
  const url = await call('GET', `/media/${seeded.upload}/url`, u.token);
  expect(url.status).toBe(200);
  signedUrl = url.body.data.url as string;
  // A 500 whose message carries every canary, an email and a bearer token.
  failWith(
    `db failed for ${u.email} with ${SECOND_KEY} and Bearer ${u.token} reading ${seeded.canaries.dialogue}`,
  );
  const boom = await call('GET', '/probe/boom', u.token);
  expect(boom.status).toBe(500);
  // An image analysis through the worker; the model answers with the canary description.
  const analysis = await runImageAnalysis(s, u, description);
  expect(analysis.state).toBe('completed');
  analysisText = analysis.resultText;
  // The campaign is deleted by the owner, then the account is suspended, reinstated and removed.
  const del = await call('DELETE', `/campaigns/${seeded.campaign}`, u.token, undefined, {
    'idempotency-key': 'log-del-1',
  });
  expect([200, 202, 204]).toContain(del.status);
  await call('POST', `/admin/users/${u.id}/suspend`, boss.token);
  await call('POST', `/admin/users/${u.id}/reinstate`, boss.token);
  const removed = await call('POST', `/admin/users/${u.id}/remove`, boss.token, {
    confirmation: u.email,
  });
  expect(removed.status).toBe(202);
  const runId = removed.body.data.deletionRunId as string;
  await s.until(
    async () =>
      (await s.one<{ step: number }>('select step from deletion_runs where id = $1', [runId]))
        .step === 4,
    'step 4',
  );
  await s.pool.query(`update deletion_runs set not_before = now() where id = $1`, [runId]);
  expect(await s.erasure.run(runId, silentJobLog)).toBe('completed');
  await new Promise((resolve) => setTimeout(resolve, 500)); // let the last log lines flush
}, 300_000);

afterAll(async () => {
  await s?.close();
});

const logText = () => s.logs.join('');

describe('log scan after a full journey (TC-LOG-03, SECT-LOG-01, 03, 05)', () => {
  it('has real log output to scan: request lines, worker lines and the failed provider call', () => {
    expect(s.logs.length).toBeGreaterThan(30);
    expect(logText()).toMatch(/"req"|"requestId"|request/i);
    expect(analysisText).toBe(description); // positive control: the description is in the store the journey wrote
    expect(JSON.stringify(responses)).toContain(seeded.canaries.productName); // the owner's own reads carry it; the logs must not
  });

  it('finds no canary key, email, auth ID, token or campaign text in the api or worker log (TC-LOG-01, 03)', () => {
    const text = logText();
    for (const secret of [
      OPENAI_CANARY,
      SECOND_KEY,
      'canary-OPENAI',
      u.email,
      boss.email,
      u.sub,
      boss.sub,
      u.token,
      u.noFactor,
      boss.token,
    ]) {
      expect(text.includes(secret), `a log line holds ${secret.slice(0, 24)}`).toBe(false);
    }
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@example\.test/);
    expect(text).not.toMatch(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/);
    expect(text).not.toMatch(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/);
    for (const content of [
      seeded.canaries.dialogue,
      seeded.canaries.prompt,
      seeded.canaries.productName,
      seeded.canaries.productText,
      description,
      seeded.canaries.transcript,
    ]) {
      expect(text.includes(content), `a log line holds content ${content}`).toBe(false);
    }
  });

  it('never logs a signed URL or its query string (SECT-LOG-03)', () => {
    expect(signedUrl).toMatch(/X-Amz-Signature=/);
    const text = logText();
    expect(text).not.toContain(new URL(signedUrl).search);
    expect(text).not.toMatch(/X-Amz-(Signature|Credential|Security-Token)/i);
    expect(text).not.toContain(signedUrl);
    expect(text).not.toContain(new URL(signedUrl).pathname.split('/').slice(-1)[0] as string);
  });

  it('keeps the 500 response generic: no message, key, email or token comes back to the caller', async () => {
    failWith(`canary-500-text ${u.email} ${SECOND_KEY}`);
    const res = await s.call('GET', '/probe/boom', boss.token);
    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBeTruthy();
    for (const secret of [u.email, SECOND_KEY, 'canary-500-text', boss.email])
      expect(res.raw.includes(secret), secret).toBe(false);
  });

  it('keeps every canary out of the other sinks: audit, usage, key events, alerts, queue, runs and the ledger (SECT-LOG-05)', async () => {
    const secrets = [
      OPENAI_CANARY,
      'canary-OPENAI',
      SECOND_KEY,
      u.email,
      u.sub,
      u.token,
      description,
      seeded.canaries.dialogue,
      seeded.canaries.productName,
    ];
    const sinks = [
      'audit_events',
      'usage_events',
      'key_events',
      'admin_alerts',
      'deletion_runs',
      'rate_limit_buckets',
      'idempotency_records',
    ];
    for (const secret of secrets) {
      const found = await rowsHolding(s.pool, secret, ['public', 'pgboss']);
      expect(Object.keys(found), secret).toEqual([]);
    }
    // No address at all (the journey's, the administrator's, a sent invitation's) sits in a history table or the queue.
    const anyEmail = Object.keys(await rowsHolding(s.pool, '@example.test', ['public', 'pgboss']));
    for (const place of anyEmail)
      expect(['users.email', 'invitations.email', 'access_requests.email'], place).toContain(place);
    for (const sink of sinks)
      expect(
        anyEmail.some((place) => place.startsWith(`${sink}.`)),
        sink,
      ).toBe(false);
    const ledger = [...s.stand.objects.entries()]
      .filter(([name]) => name.startsWith('ledger/'))
      .map(([, o]) => o.toString())
      .join('');
    expect(ledger.length).toBeGreaterThan(0);
    for (const secret of secrets) expect(ledger.includes(secret), secret).toBe(false);
    for (const name of s.stand.objects.keys()) expect(name.includes(u.email), name).toBe(false);
  });
});

describe('the logger itself (TC-LOG-01, SECT-LOG-01, 05)', () => {
  it('drops transcript and description fields and scrubs key, email, token and signed-URL shapes in fields, messages and errors', () => {
    const lines: string[] = [];
    const { logger } = buildLogger({
      level: 'debug',
      destination: new Writable({
        write(chunk: Buffer, _e, done) {
          lines.push(chunk.toString());
          done();
        },
      }),
    });
    const c = canaries('logger01');
    logger.info(
      {
        module: 'probe',
        email: u.email,
        transcript: c.transcript,
        description: c.description,
        apiKey: SECOND_KEY,
        nested: { token: u.token, url: signedUrl, email: u.email },
      },
      `user ${u.email} was served with ${SECOND_KEY}`,
    );
    logger.error(
      { err: new Error(`failed with ${SECOND_KEY} for ${u.email}`) },
      `error ${SECOND_KEY}`,
    );
    const text = lines.join('');
    for (const secret of [SECOND_KEY, u.email, u.token, c.transcript, c.description, signedUrl])
      expect(text.includes(secret), secret.slice(0, 20)).toBe(false);
  });
});
