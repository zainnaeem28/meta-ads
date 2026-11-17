import { describe, expect, it } from 'vitest';
import { EgressError } from '../../../../platform/egress/index.js';
import type { Egress } from '../../../../platform/egress/index.js';
import { ProviderCallFailed, ProviderInvalidResponse } from '../../application/worker/ports.js';
import { OpenAiTranscribe, TRANSCRIBE_TIMEOUT_MS, multipart } from './openai-transcribe.js';

const credential = { apiKey: Buffer.from('sk-openai-secret') };
const wav = Buffer.from('RIFFxxxxWAVEfmt ');

type Fetch = Pick<Egress, 'fetch'>['fetch'];
interface Sent { provider: string; url: string; method?: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number }

function adapter(answer: { status?: number; body?: unknown; raw?: string; fail?: unknown }, model = 'gpt-transcribe') {
  const sent: Sent[] = [];
  const fetch: Fetch = async (provider, req) => {
    sent.push({ provider, url: req.url, ...(req.method === undefined ? {} : { method: req.method }), ...(req.headers === undefined ? {} : { headers: req.headers }), ...(req.body === undefined ? {} : { body: req.body }), ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }) });
    if (answer.fail !== undefined) throw answer.fail;
    return { status: answer.status ?? 200, headers: {}, body: Buffer.from(answer.raw ?? JSON.stringify(answer.body ?? {})) };
  };
  return { port: new OpenAiTranscribe({ fetch }, { transcribeModel: model }), sent };
}

async function failure(promise: Promise<unknown>): Promise<ProviderCallFailed> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ProviderCallFailed);
  return error as ProviderCallFailed;
}

describe('OpenAiTranscribe', () => {
  it('posts the audio once, English, 60 s, with the key, and returns the text', async () => {
    const { port, sent } = adapter({ body: { text: 'hello there' } });
    expect(await port.transcribe(credential, wav, 'en')).toEqual({ text: 'hello there' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ provider: 'openai', url: 'https://api.openai.com/v1/audio/transcriptions', method: 'POST', timeoutMs: TRANSCRIBE_TIMEOUT_MS });
    expect(sent[0]?.headers?.['authorization']).toBe('Bearer sk-openai-secret');
    expect(sent[0]?.headers?.['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const body = (sent[0]?.body as Buffer).toString('latin1');
    expect(body).toContain('name="model"\r\n\r\ngpt-transcribe');
    expect(body).toContain('name="language"\r\n\r\nen');
    expect(body).toContain('name="file"; filename="clip.wav"\r\nContent-Type: audio/wav');
    expect(body).toContain('RIFFxxxxWAVEfmt ');
  });

  it('refuses a model name that is not a plain identifier, before any call', async () => {
    const { port, sent } = adapter({}, 'gpt transcribe"\r\n');
    await expect(port.transcribe(credential, wav, 'en')).rejects.toThrow(RangeError);
    expect(sent).toHaveLength(0);
  });

  it.each([
    [401, {}, 'configuration', true],
    [429, { error: { code: 'insufficient_quota' } }, 'credit', false],
    [429, {}, 'temporary', false],
    [400, {}, 'temporary', false],
    [500, {}, 'outcome_unknown', false],
  ])('classifies a %i answer (%j) as %s', async (status, body, causeClass, auth) => {
    const { port } = adapter({ status, body });
    const error = await failure(port.transcribe(credential, wav, 'en'));
    expect(error.classification.causeClass).toBe(causeClass);
    expect(error.classification.countsAsAuthFailure).toBe(auth);
    expect(error.message).not.toContain('sk-openai-secret');
  });

  it('classifies an egress refusal before the request left as unsent, and one after as unknown', async () => {
    const before = await failure(adapter({ fail: new EgressError('blocked_address', 'before_send') }).port.transcribe(credential, wav, 'en'));
    expect(before.classification.usageEvent).toBe('none');
    const after = await failure(adapter({ fail: new EgressError('timeout', 'after_send') }).port.transcribe(credential, wav, 'en'));
    expect(after.classification.causeClass).toBe('outcome_unknown');
    const plain = await failure(adapter({ fail: new Error('boom') }).port.transcribe(credential, wav, 'en'));
    expect(plain.classification.causeClass).toBe('outcome_unknown');
  });

  it('treats an answer that is not a transcript as an invalid response', async () => {
    await expect(adapter({ raw: '<html>' }).port.transcribe(credential, wav, 'en')).rejects.toBeInstanceOf(ProviderInvalidResponse);
    await expect(adapter({ body: { other: 1 } }).port.transcribe(credential, wav, 'en')).rejects.toBeInstanceOf(ProviderInvalidResponse);
  });
});

describe('multipart', () => {
  it('writes the fields, then the file, then the closing boundary', () => {
    const text = multipart('B', { a: '1' }, { name: 'f.wav', type: 'audio/wav', bytes: Buffer.from('xyz') }).toString();
    expect(text).toBe('--B\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--B\r\nContent-Disposition: form-data; name="file"; filename="f.wav"\r\nContent-Type: audio/wav\r\n\r\nxyz\r\n--B--\r\n');
  });
});
