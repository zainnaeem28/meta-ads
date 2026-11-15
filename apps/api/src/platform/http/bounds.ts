import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/** Request bounds (ARCHITECTURE 3.7). The 10 MiB upload of API-030 sets its own limit on its route. */
export const JSON_BODY_LIMIT_BYTES = 64 * 1024;
export const REQUEST_TIMEOUT_MS = 60_000;
export const CONNECTION_TIMEOUT_MS = 30_000;

/**
 * JSON body cap, plus the Node server timeouts: a request not fully received in 60 s gets the server's own 408
 * (not enveloped); an idle socket is closed after 30 s with no response.
 */
export function applyBounds(app: NestFastifyApplication): void {
  app.useBodyParser('application/json', { bodyLimit: JSON_BODY_LIMIT_BYTES });
  const server = app.getHttpAdapter().getHttpServer() as {
    requestTimeout: number;
    connectionsCheckingInterval?: number;
    setTimeout(ms: number): unknown;
  };
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.setTimeout(CONNECTION_TIMEOUT_MS);
}
