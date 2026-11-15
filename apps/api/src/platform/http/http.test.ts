import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError, ERROR_CODES, ERROR_STATUS, isErrorCode } from './domain-error.js';
import { classify } from './error.filter.js';
import { errorEnvelope, successEnvelope } from './response.js';
import { ALL_CODES, createTestApp } from './test-support.js';
import type { CapturedLog } from './test-support.js';

const contracts = join(import.meta.dirname, '..', '..', '..', '..', '..', 'packages', 'contracts');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

let app: NestFastifyApplication;
let logs: CapturedLog[];
beforeAll(async () => {
  ({ app, logs } = await createTestApp());
});
afterAll(async () => {
  await app.close();
});

const get = (url: string) => app.inject({ method: 'GET', url });
const json = (res: { body: string }) => JSON.parse(res.body) as Json;

describe('registry (TC-ERR-08)', () => {
  it('has the 36 generated codes, each with the status in the openapi comments', () => {
    const generated = [
      ...readFileSync(join(contracts, 'src/generated/error-codes.ts'), 'utf8').matchAll(/^ {2}'([a-z_]+)',$/gm),
    ].map((m) => m[1]);
    expect(generated).toHaveLength(36);
    expect([...ERROR_CODES].sort()).toEqual([...generated].sort());
    const yaml = readFileSync(join(contracts, 'openapi.yaml'), 'utf8');
    const block = yaml.slice(yaml.indexOf('    ErrorCode:'), yaml.indexOf('    MetaData:'));
    const fromYaml = Object.fromEntries(
      [...block.matchAll(/^ {8}- ([a-z_]+)\s+# (\d{3})/gm)].map((m) => [m[1], Number(m[2])]),
    );
    expect(fromYaml).toEqual(ERROR_STATUS);
  });

  it.each(ALL_CODES)('%s yields its registry status and the error envelope', async (code) => {
    const res = await get(`/t/code?c=${code}`);
    const body = json(res);
    expect(res.statusCode).toBe(ERROR_STATUS[code]);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(body['success']).toBe(false);
    expect(body['error']['code']).toBe(code);
    expect(body['error']['message']).toBe('Safe message.');
    expect(body['metaData']['requestId']).toEqual(expect.any(String));
    expect(new Date(body['metaData']['timestamp']).toISOString()).toBe(body['metaData']['timestamp']);
    if (ERROR_STATUS[code] >= 500) expect(body['error']).not.toHaveProperty('details');
    else expect(body['error']['details']).toEqual([{ field: 'x', code: 'invalid', message: 'detail' }]);
    expect(res.statusCode).not.toBe(200);
  });

  it('refuses an unregistered code and clips message and details', () => {
    expect(() => new DomainError('nope' as never, 'x')).toThrow(TypeError);
    expect(isErrorCode('not_found')).toBe(true);
    expect(isErrorCode(5)).toBe(false);
    const error = new DomainError(
      'validation_failed',
      'm'.repeat(600),
      Array.from({ length: 80 }, () => ({ field: 'f'.repeat(300), code: 'c'.repeat(100), message: 'x'.repeat(400) })),
    );
    expect(error.safeMessage).toHaveLength(500);
    expect(error.details).toHaveLength(50);
    expect(error.details?.[0]).toEqual({ field: 'f'.repeat(200), code: 'c'.repeat(64), message: 'x'.repeat(300) });
    expect(error.status).toBe(400);
  });
});

describe('error filter', () => {
  it('turns an unknown error into 500 internal_error, hides the message, logs once with the request ID', async () => {
    logs.length = 0;
    const res = await get('/t/boom');
    const body = json(res);
    expect(res.statusCode).toBe(500);
    expect(body['error']).toEqual({ code: 'internal_error', message: 'Something went wrong. Try again.' });
    expect(res.body).not.toContain('10.0.0.5');
    expect(logs).toHaveLength(1);
    expect(logs[0]?.fields).toMatchObject({ requestId: body['metaData']['requestId'], status: 500, code: 'internal_error' });
  });

  it.each(['57014', '55P03'])('SQLSTATE %s becomes 503 service_unavailable without details', async (state) => {
    logs.length = 0;
    const res = await get(`/t/sqlstate?s=${state}`);
    expect(res.statusCode).toBe(503);
    expect(json(res)['error']['code']).toBe('service_unavailable');
    expect(json(res)['error']).not.toHaveProperty('details');
    expect(logs).toHaveLength(1);
  });

  it('finds the SQLSTATE on a wrapped cause', async () => {
    expect((await get('/t/wrapped')).statusCode).toBe(503);
  });

  it('does not treat other SQLSTATEs as timeouts', async () => {
    expect((await get('/t/sqlstate?s=23505')).statusCode).toBe(500);
  });

  it('maps framework errors: unknown route 404, bad JSON 400, wrong media type 415, oversize 413', async () => {
    expect(json(await get('/t/missing'))['error']['code']).toBe('not_found');
    const badJson = await app.inject({ method: 'POST', url: '/t/body', headers: { 'content-type': 'application/json' }, payload: '{nope' });
    expect(badJson.statusCode).toBe(400);
    expect(json(badJson)['error']['code']).toBe('validation_failed');
    const media = await app.inject({ method: 'POST', url: '/t/body', headers: { 'content-type': 'application/xml' }, payload: '<a/>' });
    expect(media.statusCode).toBe(415);
    expect(json(media)['error']['code']).toBe('unsupported_media_type');
    const big = await app.inject({ method: 'POST', url: '/t/body', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ title: 'x'.repeat(2_000_000) }) });
    expect(big.statusCode).toBe(413);
    expect(json(big)['error']['code']).toBe('payload_too_large');
  });

  it('classify maps status classes of foreign errors', () => {
    const fastify = (statusCode: number) => Object.assign(new Error('x'), { statusCode, code: 'FST_ERR_X' });
    expect(classify(fastify(429)).code).toBe('rate_limited');
    expect(classify(fastify(418)).code).toBe('validation_failed');
    expect(classify(fastify(502)).code).toBe('internal_error');
    expect(classify(fastify(503)).code).toBe('service_unavailable');
    expect(classify({ statusCode: 400 }).code).toBe('internal_error');
    expect(classify('plain string').code).toBe('internal_error');
    expect(classify(null).log).toBeNull();
  });
});

describe('envelope (TC-ENV)', () => {
  it('wraps data with requestId and timestamp and echoes nothing else', async () => {
    const res = await get('/t/ok');
    const body = json(res);
    expect(res.statusCode).toBe(200);
    expect(body['success']).toBe(true);
    expect(body['data']).toEqual({ hello: 'world' });
    expect(Object.keys(body['metaData']).sort()).toEqual(['requestId', 'timestamp']);
  });

  it('wraps an empty result as data null', async () => {
    expect(json(await get('/t/nothing'))['data']).toBeNull();
  });

  it('puts pagination in metaData for a list', async () => {
    const body = json(await get('/t/list'));
    expect(body['data']).toEqual([{ n: 1 }]);
    expect(body['metaData']['pagination']).toEqual({ type: 'cursor', limit: 1, returnedCount: 1, hasNextPage: false, nextCursor: null });
  });

  it('sends 204 with no body and CSV with no envelope', async () => {
    const gone = await app.inject({ method: 'POST', url: '/t/gone' });
    expect(gone.statusCode).toBe(204);
    expect(gone.body).toBe('');
    const csv = await get('/t/csv');
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toBe('attachment; filename="report.csv"');
    expect(csv.body).toBe('a,b\n1,2\n');
  });

  it('leaves a RawResponse handler without an envelope', async () => {
    expect(json(await get('/t/raw'))).toEqual({ status: 'up' });
  });

  it('builds envelopes with an injected clock', () => {
    const now = () => new Date('2026-01-02T03:04:05.000Z');
    expect(successEnvelope(1, 'r1', undefined, now)).toEqual({ success: true, data: 1, metaData: { requestId: 'r1', timestamp: '2026-01-02T03:04:05.000Z' } });
    expect(errorEnvelope('not_found', 'm', 'r1', [], now)).toEqual({ success: false, error: { code: 'not_found', message: 'm' }, metaData: { requestId: 'r1', timestamp: '2026-01-02T03:04:05.000Z' } });
  });

  it('never answers 200 with success:false across every code', async () => {
    for (const code of ALL_CODES) {
      const res = await get(`/t/code?c=${code}`);
      expect(res.statusCode >= 400).toBe(true);
    }
  });
});
