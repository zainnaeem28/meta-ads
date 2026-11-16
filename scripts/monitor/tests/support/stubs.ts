import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

// A stub of API-903 plus a Sentry ingest and a heartbeat endpoint, all on one loopback server.

export interface Stubs {
  url: string;
  token: string;
  /** The next API-903 answer; a function may delay or break the socket. */
  answer: (handler: (req: IncomingMessage, res: ServerResponse) => void) => void;
  envelopes: string[];
  heartbeats: number;
  headers: Record<string, string | string[] | undefined>[];
  close: () => Promise<void>;
}

export const TOKEN = 'mT'.repeat(22);

const instant = (offset: number): string =>
  new Date(Date.UTC(2026, 10, 16, 12, 0, 0) + offset).toISOString();

export interface Sample {
  requests: number;
  errors5xx: number;
  p95Ms: number | null;
}

export function body(opts: {
  w10: Sample;
  w15: Sample;
  pool?: { acquisitions: number; waited: number; p95WaitMs: number | null };
  dropped10m?: number;
  droppedTotal?: number;
}): unknown {
  const sample = (minutes: number, s: Sample): object => ({
    minutes,
    from: instant(-minutes * 60_000),
    to: instant(0),
    ...s,
  });
  return {
    success: true,
    data: {
      processStartedAt: instant(-3_600_000),
      windows: [sample(10, opts.w10), sample(15, opts.w15)],
      poolWait: { minutes: 10, ...(opts.pool ?? { acquisitions: 0, waited: 0, p95WaitMs: null }) },
      telemetryDropped10m: opts.dropped10m ?? 0,
      telemetryDroppedTotal: opts.droppedTotal ?? 0,
    },
    metaData: { requestId: 'req-1', timestamp: instant(0) },
  };
}

export const quiet: Sample = { requests: 500, errors5xx: 0, p95Ms: 120 };

export function json(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
}

export async function startStubs(): Promise<Stubs> {
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) =>
    json(res, 200, body({ w10: quiet, w15: quiet }));
  const stubs: Stubs = {
    url: '',
    token: TOKEN,
    answer: (h) => void (handler = h),
    envelopes: [],
    heartbeats: 0,
    headers: [],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const server: Server = createServer((req, res) => {
    if (req.url === '/internal/metrics/window') {
      stubs.headers.push(req.headers);
      if (req.headers.authorization !== `Bearer ${TOKEN}`)
        return json(res, 404, { success: false, error: { code: 'not_found' } });
      return handler(req, res);
    }
    if (req.url === '/api/1/envelope/') {
      let text = '';
      req.on('data', (chunk: Buffer) => (text += chunk.toString()));
      req.on('end', () => {
        stubs.envelopes.push(text);
        res.end('{}');
      });
      return;
    }
    if (req.url === '/heartbeat') {
      stubs.heartbeats += 1;
      return void res.end('ok');
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stubs.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return stubs;
}
