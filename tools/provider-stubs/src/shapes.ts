// Response shapes of the two providers, shared by the MSW handlers (unit tests) and the local
// stub server (integration tests) so both answer with exactly the same bodies.
// Sources: ARCHITECTURE §1.3 (ports), §5.5 (state machine), §12 (integration records).

export type WaveSpeedStatus = 'created' | 'processing' | 'completed' | 'failed';

export interface WaveSpeedTask {
  id: string;
  model: string;
  outputs: string[];
  urls: { get: string };
  has_nsfw_contents: boolean[];
  status: WaveSpeedStatus;
  created_at: string;
  error: string;
  executionTime: number;
  timings: { inference: number };
}

export interface WaveSpeedEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

export function waveSpeedTask(
  id: string,
  model: string,
  status: WaveSpeedStatus,
  baseUrl: string,
  outputs: string[] = [],
  error = '',
): WaveSpeedEnvelope<WaveSpeedTask> {
  return {
    code: 200,
    message: 'success',
    data: {
      id,
      model,
      outputs,
      urls: { get: `${baseUrl}/api/v3/predictions/${id}/result` },
      has_nsfw_contents: outputs.map(() => false),
      status,
      created_at: '2026-11-15T00:00:00.000Z',
      error,
      executionTime: status === 'completed' ? 41230 : 0,
      timings: { inference: status === 'completed' ? 41230 : 0 },
    },
  };
}

export function waveSpeedBalance(balance: number): WaveSpeedEnvelope<{ balance: number }> {
  return { code: 200, message: 'success', data: { balance } };
}

export function waveSpeedError(code: number, message: string): WaveSpeedEnvelope<null> {
  return { code, message, data: null };
}

export function openAiModels() {
  return {
    object: 'list',
    data: [
      { id: 'gpt-stub-mini', object: 'model', created: 1_700_000_000, owned_by: 'openai' },
      { id: 'gpt-stub-vision', object: 'model', created: 1_700_000_001, owned_by: 'openai' },
    ],
  };
}

export function openAiChatCompletion(content: string, model: string) {
  return {
    id: 'chatcmpl-stub0001',
    object: 'chat.completion',
    created: 1_700_000_000,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, refusal: null },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 48, total_tokens: 168 },
  };
}

export function openAiTranscription(text: string) {
  return { text };
}

// 1x1 transparent PNG, the "generated" callout image.
export const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export function openAiImage() {
  return { created: 1_700_000_000, data: [{ b64_json: PNG_1X1_B64 }] };
}

export function openAiError(code: string, message: string, type = 'invalid_request_error') {
  return { error: { message, type, param: null, code } };
}

// Smallest bytes that pass the MP4 `ftyp` check of ARCHITECTURE §5.5 (output copy).
export function mp4Bytes(): Buffer {
  const brand = Buffer.from('isom');
  const size = Buffer.alloc(4);
  size.writeUInt32BE(24);
  return Buffer.concat([
    size,
    Buffer.from('ftyp'),
    brand,
    Buffer.alloc(4),
    brand,
    Buffer.from('mp41'),
  ]);
}
