import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { providerHandlers, PNG_1X1_B64 } from '../src/index.ts';

const OPENAI = 'sk-stub-valid-key-000000000000';
const WAVE = 'ws-stub-valid-key-000000000000';
const server = setupServer(...providerHandlers());

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const get = (url: string, key: string) =>
  fetch(url, { headers: { authorization: `Bearer ${key}` } });
const post = (url: string, key: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('OpenAI contract (MSW)', () => {
  it('probe: 200 with a model list, 401 with the OpenAI error shape', async () => {
    const ok = await get('https://api.openai.com/v1/models', OPENAI);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { object: string }).object).toBe('list');
    const bad = await get('https://api.openai.com/v1/models', 'sk-wrong');
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({
      error: expect.objectContaining({ code: 'invalid_api_key', type: 'invalid_request_error' }),
    });
  });

  it('chat completion, transcription and image generation answer the recorded shapes', async () => {
    const chat = await post('https://api.openai.com/v1/chat/completions', OPENAI, { model: 'm1' });
    const chatBody = (await chat.json()) as {
      model: string;
      choices: { message: { content: string }; finish_reason: string }[];
      usage: { total_tokens: number };
    };
    expect(chatBody.model).toBe('m1');
    expect(chatBody.choices[0]?.finish_reason).toBe('stop');
    expect(JSON.parse(chatBody.choices[0]?.message.content ?? '{}')).toHaveProperty(
      'productDescription',
    );
    expect(chatBody.usage.total_tokens).toBe(168);

    const tr = await post('https://api.openai.com/v1/audio/transcriptions', OPENAI, {});
    expect(await tr.json()).toEqual({ text: 'stub transcript' });

    const img = await post('https://api.openai.com/v1/images/generations', OPENAI, {});
    const imgBody = (await img.json()) as { data: { b64_json: string }[] };
    expect(imgBody.data[0]?.b64_json).toBe(PNG_1X1_B64);
    for (const path of ['chat/completions', 'audio/transcriptions', 'images/generations']) {
      expect((await post(`https://api.openai.com/v1/${path}`, 'nope', {})).status).toBe(401);
    }
  });
});

describe('WaveSpeed contract (MSW)', () => {
  it('submit returns a created task, a poll runs then completes with an output URL', async () => {
    const submit = await post('https://api.wavespeed.ai/api/v3/bytedance/seedance', WAVE, {
      prompt: 'x',
    });
    const body = (await submit.json()) as {
      code: number;
      data: { id: string; status: string; urls: { get: string } };
    };
    expect(body.code).toBe(200);
    expect(body.data.status).toBe('created');
    expect(body.data.urls.get).toContain('/predictions/');
    const first = (await (await get(body.data.urls.get, WAVE)).json()) as {
      data: { status: string };
    };
    expect(first.data.status).toBe('processing');
    const second = (await (await get(body.data.urls.get, WAVE)).json()) as {
      data: { status: string; outputs: string[] };
    };
    expect(second.data.status).toBe('completed');
    expect(second.data.outputs[0]).toMatch(/\.mp4$/);
  });

  it('balance probe, delete and 401', async () => {
    const bal = (await (await get('https://api.wavespeed.ai/api/v3/balance', WAVE)).json()) as {
      data: { balance: number };
    };
    expect(bal.data.balance).toBe(12.5);
    expect(
      (await post('https://api.wavespeed.ai/api/v3/predictions/delete', WAVE, { ids: ['a'] }))
        .status,
    ).toBe(200);
    for (const [method, url] of [
      ['GET', 'https://api.wavespeed.ai/api/v3/balance'],
      ['POST', 'https://api.wavespeed.ai/api/v3/predictions/delete'],
      ['GET', 'https://api.wavespeed.ai/api/v3/predictions/t1/result'],
      ['POST', 'https://api.wavespeed.ai/api/v3/bytedance/seedance'],
    ] as const) {
      const res = await fetch(url, { method, headers: { authorization: 'Bearer wrong' } });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: 401, message: 'Invalid API key', data: null });
    }
  });

  it('honours custom bases, keys and task IDs', async () => {
    server.use(
      ...providerHandlers({
        waveSpeedBase: 'https://ws.example.test',
        validWaveSpeedKey: 'k',
        waveSpeedTaskId: 'T9',
      }),
    );
    const res = (await (await post('https://ws.example.test/api/v3/a/b', 'k', {})).json()) as {
      data: { id: string; model: string };
    };
    expect(res.data.id).toBe('T9');
    expect(res.data.model).toBe('a/b');
  });
});
