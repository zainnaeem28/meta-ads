import { describe, expect, it } from 'vitest';
import { EgressError } from '../../../../platform/egress/index.js';
import type { Egress } from '../../../../platform/egress/index.js';
import { ProviderCallFailed, ProviderInvalidResponse } from '../../application/worker/ports.js';
import { IMAGE_TIMEOUT_MS, OpenAiImageGen, sniffImage } from './thumb-openai-image.js';

const credential = { apiKey: Buffer.from('sk-openai-secret') };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);

type Fetch = Pick<Egress, 'fetch'>['fetch'];
interface Sent { provider: string; url: string; method?: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number }

function adapter(answer: { status?: number; body?: unknown; raw?: string; fail?: unknown }, config: { imageModel?: string; maxBytes?: number } = {}) {
  const sent: Sent[] = [];
  const fetch: Fetch = async (provider, req) => {
    sent.push({ provider, url: req.url, ...(req.method === undefined ? {} : { method: req.method }), ...(req.headers === undefined ? {} : { headers: req.headers }), ...(req.body === undefined ? {} : { body: req.body }), ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }) });
    if (answer.fail !== undefined) throw answer.fail;
    return { status: answer.status ?? 200, headers: {}, body: Buffer.from(answer.raw ?? JSON.stringify(answer.body ?? {})) };
  };
  const model = 'imageModel' in config ? config.imageModel : 'local-stub-image';
  return { port: new OpenAiImageGen({ fetch }, { imageModel: model, outputMaxBytes: config.maxBytes ?? 1_000_000 }), sent };
}
const image = (bytes: Buffer) => ({ data: [{ b64_json: bytes.toString('base64') }] });

async function failure(promise: Promise<unknown>): Promise<ProviderCallFailed> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ProviderCallFailed);
  return error as ProviderCallFailed;
}

describe('sniffImage', () => {
  it('knows PNG, JPEG and WebP from their first bytes only', () => {
    expect(sniffImage(PNG)).toEqual({ contentType: 'image/png', extension: 'png' });
    expect(sniffImage(JPEG)).toEqual({ contentType: 'image/jpeg', extension: 'jpg' });
    expect(sniffImage(WEBP)).toEqual({ contentType: 'image/webp', extension: 'webp' });
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['html', Buffer.from('<html></html>')],
    ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['gif', Buffer.from('GIF89a......')],
    ['riff that is not webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)])],
    ['a short png signature', PNG.subarray(0, 5)],
  ])('refuses %s', (_name, bytes) => {
    expect(sniffImage(bytes)).toBeNull();
  });
});

describe('OpenAiImageGen', () => {
  it('posts the prompt once, one portrait image, 120 s, with the key, and returns the checked image', async () => {
    const { port, sent } = adapter({ body: image(PNG) });
    const result = await port.generate(credential, { prompt: 'draw "hi"' });
    expect(result).toMatchObject({ contentType: 'image/png', extension: 'png' });
    expect(result.bytes.equals(PNG)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ provider: 'openai', url: 'https://api.openai.com/v1/images/generations', method: 'POST', timeoutMs: IMAGE_TIMEOUT_MS });
    expect(IMAGE_TIMEOUT_MS).toBe(120_000);
    expect(sent[0]?.headers?.['authorization']).toBe('Bearer sk-openai-secret');
    expect(JSON.parse((sent[0]?.body as Buffer).toString('utf8'))).toEqual({ model: 'local-stub-image', prompt: 'draw "hi"', n: 1, size: '1024x1536' });
  });

  it('returns a JPEG and a WebP as what they are, whatever the provider says', async () => {
    expect((await adapter({ body: image(JPEG) }).port.generate(credential, { prompt: 'x' })).contentType).toBe('image/jpeg');
    expect((await adapter({ body: image(WEBP) }).port.generate(credential, { prompt: 'x' })).contentType).toBe('image/webp');
  });

  it.each(['gpt image"\r\n', undefined])('refuses a model name that is not a plain identifier (%j), before any call', async (imageModel) => {
    const { port, sent } = adapter({}, { imageModel });
    await expect(port.generate(credential, { prompt: 'x' })).rejects.toThrow(RangeError);
    expect(sent).toHaveLength(0);
  });

  it.each([
    [401, {}, 'configuration', true],
    [402, {}, 'credit', false],
    [429, { error: { code: 'insufficient_quota' } }, 'credit', false],
    [429, {}, 'temporary', false],
    [500, {}, 'outcome_unknown', false],
  ])('classifies a %i answer (%j) as %s', async (status, body, causeClass, auth) => {
    const { port } = adapter({ status, body });
    const error = await failure(port.generate(credential, { prompt: 'x' }));
    expect(error.classification.causeClass).toBe(causeClass);
    expect(error.classification.countsAsAuthFailure).toBe(auth);
    expect(error.message).not.toContain('sk-openai-secret');
  });

  it('classifies an egress refusal before the request left as unsent, and one after as unknown', async () => {
    const before = await failure(adapter({ fail: new EgressError('blocked_address', 'before_send', 'refused') }).port.generate(credential, { prompt: 'x' }));
    expect(before.classification.usageEvent).toBe('none');
    const after = await failure(adapter({ fail: new EgressError('timeout', 'after_send', 'timed out') }).port.generate(credential, { prompt: 'x' }));
    expect(after.classification.causeClass).toBe('outcome_unknown');
    const plain = await failure(adapter({ fail: new Error('boom') }).port.generate(credential, { prompt: 'x' }));
    expect(plain.classification.causeClass).toBe('outcome_unknown');
  });

  it.each([
    ['not JSON', { raw: '<html>' }],
    ['no data', { body: {} }],
    ['an empty list', { body: { data: [] } }],
    ['an image given as a URL only', { body: { data: [{ url: 'https://example.test/x.png' }] } }],
    ['text that is not base64', { body: { data: [{ b64_json: 'not base64 !!' }] } }],
    ['an empty image', { body: { data: [{ b64_json: '' }] } }],
    ['a non-image payload', { body: image(Buffer.from('<script>alert(1)</script>')) }],
    ['an svg', { body: image(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')) }],
  ])('answers an invalid response for %s (the call was made and is billed)', async (_name, answer) => {
    const { port } = adapter(answer);
    await expect(port.generate(credential, { prompt: 'x' })).rejects.toBeInstanceOf(ProviderInvalidResponse);
  });

  it('refuses an image over the size cap', async () => {
    const { port } = adapter({ body: image(Buffer.concat([PNG, Buffer.alloc(100)])) }, { maxBytes: 50 });
    await expect(port.generate(credential, { prompt: 'x' })).rejects.toThrow('too large');
  });
});
