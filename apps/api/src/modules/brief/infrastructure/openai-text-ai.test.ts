import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Egress } from '../../../platform/egress/egress.js';
import { startServer } from '../../../platform/egress/test-support.js';
import type { Handler } from '../../../platform/egress/test-support.js';
import { ProviderCallFailed, ProviderInvalidResponse } from '../application/worker/text-ai.port.js';
import type { BriefInput } from '../application/worker/text-ai.port.js';
import { OpenAiTextAi } from './openai-text-ai.js';

// TextAIPort over OpenAI chat completions against a local TLS server standing in for api.openai.com (never the real one).
// TC-BRF-01, TC-BRF-05 (provider classes), TC-UPL analysis (inline bytes), TC-KEY-06 (the key stays out of errors).

const KEY = 'test-openai-secret-that-must-not-leak-0000';
let handler: Handler = (_req, res) => { res.end('{}'); };
let server: Awaited<ReturnType<typeof startServer>>;
let seen: { auth: string | undefined; body: Record<string, any> }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => {
  server = await startServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => {
      seen.push({ auth: req.headers['authorization'], body: JSON.parse(Buffer.concat(parts).toString() || '{}') as Record<string, any> }); // eslint-disable-line @typescript-eslint/no-explicit-any
      handler(req, res);
    });
  });
});
afterAll(async () => { await server.close(); });

function adapter(timeoutMs = 5000): OpenAiTextAi {
  const egress = new Egress({
    allowedHosts: { openai: ['api.openai.com'] },
    timeoutMs,
    maxBytes: 2_000_000,
    resolver: async () => ['127.0.0.1'],
    testing: { isBlockedAddress: () => false, tls: { ca: server.ca }, port: server.port },
  });
  return new OpenAiTextAi(egress, {
    textModel: 'local-stub-text',
    visionModel: 'local-stub-vision',
    chatUrl: `https://api.openai.com:${String(server.port)}/v1/chat/completions`,
  });
}

const reply = (content: unknown, status = 200): Handler => (_req, res) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(typeof content === 'string' ? content : JSON.stringify(content));
};
const completion = (content: unknown) => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content), refusal: null } }] });
const credential = { apiKey: Buffer.from(KEY) };
const input: BriefInput = {
  productName: 'Calm Cap',
  productDescription: 'A morning ritual drink',
  audience: { ageMin: 25, ageMax: 40, gender: 'all', interests: ['wellness'] },
  direction: { goal: 'awareness', tone: 'calm' },
  segmentCount: 2,
  mode: 'description',
  source: 'A slow morning',
  callToAction: 'Take the free 2-minute quiz',
};

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}

describe('generateBrief', () => {
  it('sends structured output against a JSON schema and returns the segments in order', async () => {
    seen = [];
    handler = reply(completion({ segments: [{ position: 2, dialogue: 'B', prompt: 'pb' }, { position: 1, dialogue: 'A', prompt: 'pa' }] }));
    const draft = await adapter().generateBrief(credential, input);
    expect(draft.segments.map((s) => s.position)).toEqual([1, 2]);
    const sent = seen[0];
    expect(sent?.auth).toBe(`Bearer ${KEY}`);
    expect(sent?.body['model']).toBe('local-stub-text');
    expect(sent?.body['store']).toBe(false);
    expect(sent?.body['response_format'].type).toBe('json_schema');
    expect(sent?.body['response_format'].json_schema.strict).toBe(true);
    expect(sent?.body['response_format'].json_schema.schema.properties.segments.minItems).toBe(2);
    expect(JSON.stringify(sent?.body['messages'])).toContain('Take the free 2-minute quiz');
  });

  it.each([
    ['text that is not JSON', reply('<html>nope</html>')],
    ['a message that is not JSON', (_q: unknown, res: { setHeader(name: string, value: string): void; end(body: string): void }) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'not json', refusal: null } }] })); }],
    ['a refusal with no content', reply({ choices: [{ message: { content: null, refusal: 'I cannot help with that' } }] })],
    ['no choices', reply({ choices: [] })],
    ['the wrong shape', reply(completion({ segments: [{ position: 1, dialogue: 'A' }] }))],
    ['too few segments', reply(completion({ segments: [{ position: 1, dialogue: 'A', prompt: 'p' }] }))],
    ['repeated positions', reply(completion({ segments: [{ position: 1, dialogue: 'A', prompt: 'p' }, { position: 1, dialogue: 'B', prompt: 'p' }] }))],
    ['positions out of range', reply(completion({ segments: [{ position: 1, dialogue: 'A', prompt: 'p' }, { position: 3, dialogue: 'B', prompt: 'p' }] }))],
    ['an empty dialogue', reply(completion({ segments: [{ position: 1, dialogue: ' ', prompt: 'p' }, { position: 2, dialogue: 'B', prompt: 'p' }] }))],
  ])('invalid JSON or schema is ProviderInvalidResponse: %s', async (_name, next) => {
    handler = next as Handler;
    const error = await failure(adapter().generateBrief(credential, input));
    expect(error).toBeInstanceOf(ProviderInvalidResponse);
    expect(String(error)).not.toContain(KEY);
  });
});

describe('classification of provider errors (ARCHITECTURE §5.10)', () => {
  it.each([
    [401, undefined, 'configuration', 'rejected_zero', true],
    [403, undefined, 'configuration', 'rejected_zero', false],
    [402, undefined, 'credit', 'rejected_zero', false],
    [429, 'insufficient_quota', 'credit', 'rejected_zero', false],
    [429, 'rate_limit_exceeded', 'temporary', 'rejected_zero', false],
    [400, 'invalid_request_error', 'temporary', 'rejected_zero', false],
    [500, undefined, 'outcome_unknown', 'unconfirmed', false],
    [503, undefined, 'outcome_unknown', 'unconfirmed', false],
  ])('HTTP %s (%s) is %s with usage %s', async (status, code, cause, usage, auth) => {
    handler = reply({ error: { code, message: `bad key ${KEY}` } }, status);
    const error = await failure(adapter().generateBrief(credential, input));
    expect(error).toBeInstanceOf(ProviderCallFailed);
    const classification = (error as ProviderCallFailed).classification;
    expect(classification.causeClass).toBe(cause);
    expect(classification.usageEvent).toBe(usage);
    expect(classification.countsAsAuthFailure).toBe(auth);
    expect(JSON.stringify(classification)).not.toContain(KEY);
    expect((error as Error).message).not.toContain(KEY);
  });

  it('an unreadable error body still classifies by status', async () => {
    handler = reply('gateway exploded', 502);
    const error = (await failure(adapter().generateBrief(credential, input))) as ProviderCallFailed;
    expect(error.classification.causeClass).toBe('outcome_unknown');
  });

  it('a timeout after the request was sent is outcome_unknown, unconfirmed', async () => {
    handler = () => { /* never answers */ };
    const error = (await failure(adapter(300).generateBrief(credential, input))) as ProviderCallFailed;
    expect(error).toBeInstanceOf(ProviderCallFailed);
    expect(error.classification.causeClass).toBe('outcome_unknown');
    expect(error.classification.usageEvent).toBe('unconfirmed');
  });

  it('a host that is not allow-listed never leaves: temporary, no usage event', async () => {
    const egress = new Egress({ allowedHosts: { openai: ['other.example.net'] }, timeoutMs: 1000, maxBytes: 1000, resolver: async () => ['127.0.0.1'] });
    const ai = new OpenAiTextAi(egress, { textModel: 'm', visionModel: 'v', chatUrl: `https://api.openai.com:${String(server.port)}/v1/chat/completions` });
    const error = (await failure(ai.generateBrief(credential, input))) as ProviderCallFailed;
    expect(error.classification.causeClass).toBe('temporary');
    expect(error.classification.usageEvent).toBe('none');
  });
});

describe('shortenSegments', () => {
  it('returns the shortened segments for the positions it was given', async () => {
    handler = reply(completion({ segments: [{ position: 3, dialogue: 'Shorter', prompt: 'p3' }] }));
    const out = await adapter().shortenSegments(credential, [{ position: 3, dialogue: 'Much longer', prompt: 'p3' }], 45);
    expect(out).toEqual([{ position: 3, dialogue: 'Shorter', prompt: 'p3' }]);
  });

  it('refuses an answer for other positions than the ones sent', async () => {
    handler = reply(completion({ segments: [{ position: 2, dialogue: 'x', prompt: 'p' }] }));
    const error = await failure(adapter().shortenSegments(credential, [{ position: 3, dialogue: 'long', prompt: 'p' }], 45));
    expect(error).toBeInstanceOf(ProviderInvalidResponse);
  });
});

describe('describeProduct (REQ-020, TD-D26)', () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

  it('sends the image bytes inline as a base64 data URL, never a URL, and returns the description', async () => {
    seen = [];
    handler = reply(completion({ productDescription: 'A small glass jar.' }));
    const text = await adapter().describeProduct(credential, bytes, 'image/png');
    expect(text).toBe('A small glass jar.');
    const body = seen[0]?.body;
    expect(body?.['model']).toBe('local-stub-vision');
    const part = body?.['messages'][1].content.find((p: { type: string }) => p.type === 'image_url');
    expect(part.image_url.url).toBe(`data:image/png;base64,${bytes.toString('base64')}`);
    expect(JSON.stringify(body?.['messages'])).not.toMatch(/https?:/u);
    expect(body?.['response_format'].json_schema.schema.required).toEqual(['productDescription']);
  });

  it('refuses a content type that is not an image the product accepts', async () => {
    await expect(adapter().describeProduct(credential, bytes, 'application/pdf')).rejects.toThrow(RangeError);
  });

  it.each([
    ['an empty description', completion({ productDescription: '  ' })],
    ['extra fields', completion({ productDescription: 'x', ethnicity: 'y' })],
  ])('%s is ProviderInvalidResponse', async (_name, content) => {
    handler = reply(content);
    expect(await failure(adapter().describeProduct(credential, bytes, 'image/png'))).toBeInstanceOf(ProviderInvalidResponse);
  });
});
