import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { LoggerModule } from 'nestjs-pino';
import type { Logger } from 'pino';
import type { IncomingMessage } from 'node:http';
import { buildLogger } from './logger.js';
import type { LoggerOptions } from './logger.js';
import type { Scrubber } from './redact.js';
import { REQUEST_ID_HEADER, resolveRequestId } from './request-id.js';

/** The request ID Fastify assigned to the raw request (also echoed in `X-Request-ID`). */
export function requestIdOf(req: IncomingMessage): string {
  return (req as IncomingMessage & { id?: string }).id ?? resolveRequestId(undefined);
}

export interface HttpLogging {
  readonly logger: Logger;
  readonly scrub: Scrubber;
  /** Fastify adapter that owns request IDs (UUIDv7 or a trusted upstream value, echoed as `X-Request-ID`). */
  adapter(): FastifyAdapter;
  /** nestjs-pino as the application logger, over the same pino instance. */
  module(): DynamicModule;
}

/** Credentials on a request are secrets for the life of the process, whatever their shape. */
function learnCredentials(req: IncomingMessage, scrub: Scrubber): void {
  const authorization = req.headers.authorization;
  if (authorization !== undefined) {
    scrub.learn(authorization);
    scrub.learn(authorization.replace(/^\S+\s+/, ''));
  }
  for (const pair of (req.headers.cookie ?? '').split(';')) {
    if (pair.includes('=')) scrub.learn(pair.slice(pair.indexOf('=') + 1).trim());
  }
}

@Module({})
export class LoggingModule {}

export function createHttpLogging(
  options: LoggerOptions & { trustUpstreamRequestId?: boolean } = {},
): HttpLogging {
  const { logger, scrub } = buildLogger(options);
  const trust = options.trustUpstreamRequestId ?? true;
  return {
    logger,
    scrub,
    adapter: () => {
      const adapter = new FastifyAdapter({
        requestIdHeader: false,
        genReqId: (req: IncomingMessage) => {
          learnCredentials(req, scrub);
          return resolveRequestId(req.headers[REQUEST_ID_HEADER], trust);
        },
      });
      const fastify = adapter.getInstance();
      fastify.addHook('onRequest', (request, reply, done) => {
        void reply.header('X-Request-ID', request.id);
        done();
      });
      // One line per request: the route template, never the raw URL, query, headers or body.
      fastify.addHook('onResponse', (request, reply, done) => {
        const failed = reply.statusCode >= 500;
        logger[failed ? 'error' : 'info'](
          {
            requestId: request.id,
            method: request.method,
            route: request.routeOptions?.url ?? 'unmatched',
            status: reply.statusCode,
            durationMs: Math.round(reply.elapsedTime),
          },
          failed ? 'request failed' : 'request completed',
        );
        done();
      });
      return adapter;
    },
    module: () => ({
      module: LoggingModule,
      global: true,
      imports: [LoggerModule.forRoot({ pinoHttp: { logger, autoLogging: false } })],
      exports: [LoggerModule],
    }),
  };
}
