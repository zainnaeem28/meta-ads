import { http, HttpResponse, type RequestHandler } from 'msw';
import {
  openAiChatCompletion,
  openAiError,
  openAiImage,
  openAiModels,
  openAiTranscription,
  waveSpeedBalance,
  waveSpeedError,
  waveSpeedTask,
} from './shapes.ts';

export interface MswOptions {
  openAiBase?: string;
  waveSpeedBase?: string;
  validOpenAiKey?: string;
  validWaveSpeedKey?: string;
  waveSpeedTaskId?: string;
  outputUrl?: string;
}

// MSW handlers for unit tests (no sockets of their own): same bodies as the stub server.
export function providerHandlers(options: MswOptions = {}): RequestHandler[] {
  const openAi = options.openAiBase ?? 'https://api.openai.com';
  const wave = options.waveSpeedBase ?? 'https://api.wavespeed.ai';
  const openAiKey = options.validOpenAiKey ?? 'sk-stub-valid-key-000000000000';
  const waveKey = options.validWaveSpeedKey ?? 'ws-stub-valid-key-000000000000';
  const taskId = options.waveSpeedTaskId ?? 'task-msw-0001';
  const output = options.outputUrl ?? `${wave}/outputs/${taskId}.mp4`;
  let polls = 0;

  const openAiAuth = (request: Request) =>
    request.headers.get('authorization') === `Bearer ${openAiKey}`;
  const waveAuth = (request: Request) =>
    request.headers.get('authorization') === `Bearer ${waveKey}`;
  const openAi401 = () =>
    HttpResponse.json(openAiError('invalid_api_key', 'Incorrect API key provided.'), {
      status: 401,
    });
  const wave401 = () => HttpResponse.json(waveSpeedError(401, 'Invalid API key'), { status: 401 });

  return [
    http.get(`${openAi}/v1/models`, ({ request }) =>
      openAiAuth(request) ? HttpResponse.json(openAiModels()) : openAi401(),
    ),
    http.post(`${openAi}/v1/chat/completions`, async ({ request }) => {
      if (!openAiAuth(request)) return openAi401();
      const body = (await request.json()) as { model?: string };
      return HttpResponse.json(
        openAiChatCompletion('{"productDescription":"stub"}', body.model ?? 'gpt-stub-mini'),
      );
    }),
    http.post(`${openAi}/v1/audio/transcriptions`, ({ request }) =>
      openAiAuth(request) ? HttpResponse.json(openAiTranscription('stub transcript')) : openAi401(),
    ),
    http.post(`${openAi}/v1/images/generations`, ({ request }) =>
      openAiAuth(request) ? HttpResponse.json(openAiImage()) : openAi401(),
    ),
    http.get(`${wave}/api/v3/balance`, ({ request }) =>
      waveAuth(request) ? HttpResponse.json(waveSpeedBalance(12.5)) : wave401(),
    ),
    http.post(`${wave}/api/v3/predictions/delete`, ({ request }) =>
      waveAuth(request)
        ? HttpResponse.json({ code: 200, message: 'success', data: null })
        : wave401(),
    ),
    http.get(`${wave}/api/v3/predictions/:id/result`, ({ request, params }) => {
      if (!waveAuth(request)) return wave401();
      polls += 1;
      const id = String(params['id']);
      return polls < 2
        ? HttpResponse.json(waveSpeedTask(id, 'bytedance/seedance', 'processing', wave))
        : HttpResponse.json(waveSpeedTask(id, 'bytedance/seedance', 'completed', wave, [output]));
    }),
    http.post(`${wave}/api/v3/:vendor/:model`, ({ request, params }) =>
      waveAuth(request)
        ? HttpResponse.json(
            waveSpeedTask(
              taskId,
              `${String(params['vendor'])}/${String(params['model'])}`,
              'created',
              wave,
            ),
          )
        : wave401(),
    ),
  ];
}
