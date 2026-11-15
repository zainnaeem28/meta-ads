import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  mp4Bytes,
  openAiChatCompletion,
  openAiError,
  openAiImage,
  openAiModels,
  openAiTranscription,
  waveSpeedBalance,
  waveSpeedError,
  waveSpeedTask,
} from './shapes.ts';

// Where a video submit fails. `drop-after-accept` is the restart point of ARCHITECTURE §5.5:
// the provider has accepted (and billed) the task, then the connection dies before the caller
// can write the task ID.
export type SubmitFault =
  'none' | 'drop-after-accept' | 'http-500-after-accept' | 'reject-400' | 'rate-limit-429';

export interface StubOptions {
  openAiKey?: string;
  waveSpeedKey?: string;
  // polls that answer `processing` before the task completes
  processingPolls?: number;
}

export interface SubmitRecord {
  id: string;
  model: string;
  body: unknown;
}

export interface StubServer {
  url: string;
  port: number;
  openAiKey: string;
  waveSpeedKey: string;
  submits: SubmitRecord[];
  polls: Record<string, number>;
  deleted: string[];
  requests: { method: string; path: string }[];
  setSubmitFault(fault: SubmitFault): void;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

export async function startStubServer(options: StubOptions = {}): Promise<StubServer> {
  const openAiKey = options.openAiKey ?? 'sk-stub-valid-key-000000000000';
  const waveSpeedKey = options.waveSpeedKey ?? 'ws-stub-valid-key-000000000000';
  const processingPolls = options.processingPolls ?? 1;
  let fault: SubmitFault = 'none';
  let counter = 0;
  const state = { url: '' };
  const server: StubServer = {
    url: '',
    port: 0,
    openAiKey,
    waveSpeedKey,
    submits: [],
    polls: {},
    deleted: [],
    requests: [],
    setSubmitFault: (next) => {
      fault = next;
    },
    close: () => Promise.resolve(),
  };

  const http: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      send(response, 500, { error: { message: String(error) } });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const path = new URL(request.url ?? '/', 'http://stub').pathname;
    server.requests.push({ method, path });
    const raw = method === 'POST' ? await readBody(request) : Buffer.alloc(0);
    const auth = request.headers.authorization;

    if (path.startsWith('/outputs/')) {
      response.writeHead(200, { 'content-type': 'video/mp4' });
      response.end(mp4Bytes());
      return;
    }

    if (path.startsWith('/v1/')) {
      if (auth !== `Bearer ${openAiKey}`) {
        send(response, 401, openAiError('invalid_api_key', 'Incorrect API key provided.'));
        return;
      }
      if (method === 'GET' && path === '/v1/models') return send(response, 200, openAiModels());
      if (method === 'POST' && path === '/v1/chat/completions') {
        const body = JSON.parse(raw.toString('utf8') || '{}') as { model?: string };
        return send(
          response,
          200,
          openAiChatCompletion('{"productDescription":"stub"}', body.model ?? 'gpt-stub-mini'),
        );
      }
      if (method === 'POST' && path === '/v1/audio/transcriptions')
        return send(response, 200, openAiTranscription('stub transcript'));
      if (method === 'POST' && path === '/v1/images/generations')
        return send(response, 200, openAiImage());
      return send(
        response,
        404,
        openAiError('not_found', 'Unknown route', 'invalid_request_error'),
      );
    }

    if (path.startsWith('/api/v3/')) {
      if (auth !== `Bearer ${waveSpeedKey}`)
        return send(response, 401, waveSpeedError(401, 'Invalid API key'));
      if (method === 'GET' && path === '/api/v3/balance')
        return send(response, 200, waveSpeedBalance(12.5));
      if (method === 'POST' && path === '/api/v3/predictions/delete') {
        const body = JSON.parse(raw.toString('utf8') || '{}') as { ids?: string[] };
        server.deleted.push(...(body.ids ?? []));
        return send(response, 200, { code: 200, message: 'success', data: null });
      }
      const result = /^\/api\/v3\/predictions\/([^/]+)\/result$/.exec(path);
      if (method === 'GET' && result) {
        const id = decodeURIComponent(result[1] ?? '');
        const known = server.submits.find((submit) => submit.id === id);
        if (!known) return send(response, 404, waveSpeedError(404, 'task not found'));
        const count = (server.polls[id] = (server.polls[id] ?? 0) + 1);
        return count <= processingPolls
          ? send(response, 200, waveSpeedTask(id, known.model, 'processing', state.url))
          : send(
              response,
              200,
              waveSpeedTask(id, known.model, 'completed', state.url, [
                `${state.url}/outputs/${id}.mp4`,
              ]),
            );
      }
      const submit = /^\/api\/v3\/([^/]+)\/([^/]+)$/.exec(path);
      if (method === 'POST' && submit) {
        if (fault === 'reject-400')
          return send(response, 400, waveSpeedError(400, 'invalid parameter'));
        if (fault === 'rate-limit-429')
          return send(response, 429, waveSpeedError(429, 'rate limited'));
        counter += 1;
        const id = `task-stub-${String(counter).padStart(4, '0')}`;
        const model = `${submit[1]}/${submit[2]}`;
        server.submits.push({ id, model, body: JSON.parse(raw.toString('utf8') || '{}') });
        if (fault === 'drop-after-accept') {
          request.socket.destroy();
          return;
        }
        if (fault === 'http-500-after-accept')
          return send(response, 500, waveSpeedError(500, 'internal error'));
        return send(response, 200, waveSpeedTask(id, model, 'created', state.url));
      }
      return send(response, 404, waveSpeedError(404, 'unknown route'));
    }
    send(response, 404, { error: 'not found' });
  }

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  server.port = (http.address() as AddressInfo).port;
  server.url = `http://127.0.0.1:${server.port}`;
  state.url = server.url;
  server.close = () =>
    new Promise<void>((resolve, reject) => {
      http.closeAllConnections();
      http.close((error) => (error ? reject(error) : resolve()));
    });
  return server;
}
