import { describe, expect, it } from 'vitest';
import { EgressError } from '../../../../platform/egress/index.js';
import type { Egress } from '../../../../platform/egress/index.js';
import { ProviderCallFailed, ProviderInvalidResponse } from '../../application/worker/ports.js';
import { WaveSpeedVideoGen } from './wavespeed-video-gen.js';

const credential = { apiKey: Buffer.from('ws-secret-key') };
const input = { model: 'bytedance/seedance-2.0/image-to-video', prompt: 'p', imageUrl: 'https://signed.example/x', durationSeconds: 15, resolution: '1080p', aspectRatio: '9:16' };

type Fetch = Pick<Egress, 'fetch'>['fetch'];
interface Sent { provider: string; url: string; method?: string; headers?: Record<string, string>; body?: string | Buffer }

function adapter(answer: { status?: number; body?: unknown; raw?: string; fail?: unknown }) {
  const sent: Sent[] = [];
  const fetch: Fetch = async (provider, req) => {
    sent.push({ provider, url: req.url, ...(req.method === undefined ? {} : { method: req.method }), ...(req.headers === undefined ? {} : { headers: req.headers }), ...(req.body === undefined ? {} : { body: req.body }) });
    if (answer.fail !== undefined) throw answer.fail;
    return { status: answer.status ?? 200, headers: {}, body: Buffer.from(answer.raw ?? JSON.stringify(answer.body ?? {})) };
  };
  return { port: new WaveSpeedVideoGen({ fetch }, {}), sent };
}

async function failure(promise: Promise<unknown>): Promise<ProviderCallFailed> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ProviderCallFailed);
  return error as ProviderCallFailed;
}

describe('WaveSpeedVideoGen.submit', () => {
  it('posts the model path once with the key and the clip options, and returns the task id', async () => {
    const { port, sent } = adapter({ body: { code: 200, data: { id: 'abc-123', status: 'created' } } });
    expect(await port.submit(credential, input)).toBe('abc-123');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ provider: 'wavespeed', url: 'https://api.wavespeed.ai/api/v3/bytedance/seedance-2.0/image-to-video', method: 'POST' });
    expect(sent[0]?.headers?.['authorization']).toBe('Bearer ws-secret-key');
    expect(JSON.parse(sent[0]?.body as string)).toEqual({ prompt: 'p', duration: 15, resolution: '1080p', aspect_ratio: '9:16', image: 'https://signed.example/x' });
  });

  it('sends no image for text-to-video', async () => {
    const { port, sent } = adapter({ body: { data: { id: 't1' } } });
    await port.submit(credential, { ...input, imageUrl: null });
    expect(JSON.parse(sent[0]?.body as string)).not.toHaveProperty('image');
  });

  it('refuses a model name that could change the path', async () => {
    const { port, sent } = adapter({});
    await expect(port.submit(credential, { ...input, model: '../predictions/delete' })).rejects.toThrow(RangeError);
    await expect(port.submit(credential, { ...input, model: 'a b' })).rejects.toThrow(RangeError);
    expect(sent).toHaveLength(0);
  });

  it.each([
    [401, {}, 'configuration', true],
    [403, {}, 'configuration', false],
    [402, {}, 'credit', false],
    [400, { message: 'Insufficient balance' }, 'credit', false],
    [429, {}, 'temporary', false],
    [422, {}, 'temporary', false],
    [500, {}, 'outcome_unknown', false],
    [503, {}, 'outcome_unknown', false],
  ])('classifies HTTP %i', async (status, body, cause, auth) => {
    const { port } = adapter({ status, body });
    const error = await failure(port.submit(credential, input));
    expect(error.classification).toMatchObject({ causeClass: cause, countsAsAuthFailure: auth });
    expect(error.status).toBe(status);
    expect(JSON.stringify(error)).not.toContain('ws-secret-key');
  });

  it('reads a refusal reported in the body of a 200 answer', async () => {
    const { port } = adapter({ body: { code: 401, message: 'bad key' } });
    expect((await failure(port.submit(credential, input))).classification.causeClass).toBe('configuration');
  });

  it('treats an accepted answer with no usable task id as an unknown outcome', async () => {
    for (const answer of [{ body: { code: 200, data: {} } }, { raw: '<html>gateway</html>' }, { body: { data: { id: '../x' } } }]) {
      const { port } = adapter(answer);
      expect((await failure(port.submit(credential, input))).classification.causeClass).toBe('outcome_unknown');
    }
  });

  it('classifies egress failures by phase: refused before sending is temporary, after sending is unknown', async () => {
    const before = adapter({ fail: new EgressError('connection_failed', 'before_send', 'x') });
    expect((await failure(before.port.submit(credential, input))).classification).toMatchObject({ causeClass: 'temporary', usageEvent: 'none' });
    const after = adapter({ fail: new EgressError('timeout', 'after_send', 'x') });
    expect((await failure(after.port.submit(credential, input))).classification).toMatchObject({ causeClass: 'outcome_unknown', usageEvent: 'unconfirmed' });
    const other = adapter({ fail: new Error('socket') });
    expect((await failure(other.port.submit(credential, input))).classification.causeClass).toBe('outcome_unknown');
  });
});

describe('WaveSpeedVideoGen.status', () => {
  const read = (data: unknown) => adapter({ body: { code: 200, data } });

  it('reads the result path and maps the four states', async () => {
    const running = read({ status: 'processing' });
    expect(await running.port.status(credential, 'abc')).toEqual({ state: 'processing' });
    expect(running.sent[0]).toMatchObject({ url: 'https://api.wavespeed.ai/api/v3/predictions/abc/result', method: 'GET' });
    expect(await read({ status: 'created' }).port.status(credential, 'abc')).toEqual({ state: 'created' });
    expect(await read({ status: 'completed', outputs: ['https://cdn/x.mp4'] }).port.status(credential, 'abc')).toEqual({ state: 'completed', outputUrl: 'https://cdn/x.mp4' });
    expect(await read({ status: 'failed', error: 'content policy' }).port.status(credential, 'abc')).toEqual({ state: 'failed', errorClass: 'other' });
    expect(await read({ status: 'failed', error: 'Invalid API key' }).port.status(credential, 'abc')).toEqual({ state: 'failed', errorClass: 'auth' });
  });

  it('refuses an answer that is not one of the states or a finished task without an output', async () => {
    await expect(read({ status: 'weird' }).port.status(credential, 'abc')).rejects.toThrow(ProviderInvalidResponse);
    await expect(read({ status: 'completed', outputs: [] }).port.status(credential, 'abc')).rejects.toThrow(ProviderInvalidResponse);
    await expect(read({ status: 'completed', outputs: [''] }).port.status(credential, 'abc')).rejects.toThrow(ProviderInvalidResponse);
  });

  it('refuses a task id that is not an id, and reports a missing task as a 404', async () => {
    const { port, sent } = adapter({});
    await expect(port.status(credential, '../x')).rejects.toThrow(RangeError);
    expect(sent).toHaveLength(0);
    const gone = adapter({ status: 404, body: { message: 'not found' } });
    expect((await failure(gone.port.status(credential, 'abc'))).status).toBe(404);
  });
});

describe('WaveSpeedVideoGen.deleteTask', () => {
  it('posts the task id to the delete path', async () => {
    const { port, sent } = adapter({ body: { code: 200 } });
    await port.deleteTask(credential, 'abc');
    expect(sent[0]).toMatchObject({ url: 'https://api.wavespeed.ai/api/v3/predictions/delete', method: 'POST' });
    expect(JSON.parse(sent[0]?.body as string)).toEqual({ ids: ['abc'] });
  });

  it('uses the configured base URL when one is set (a test stand-in)', async () => {
    const sent: string[] = [];
    const port = new WaveSpeedVideoGen({ fetch: async (_p, req) => { sent.push(req.url); return { status: 200, headers: {}, body: Buffer.from('{}') }; } }, { baseUrl: 'https://stand-in.test:1234' });
    await port.deleteTask(credential, 'abc');
    expect(sent).toEqual(['https://stand-in.test:1234/api/v3/predictions/delete']);
  });
});
