import { Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { map } from 'rxjs';
import type { Observable } from 'rxjs';
import type { ErrorDetail } from '../shared-kernel/index.js';

export interface CursorPagination {
  type: 'cursor';
  limit: number;
  returnedCount: number;
  hasNextPage: boolean;
  nextCursor: string | null;
}

export interface MetaData {
  requestId: string;
  timestamp: string;
  pagination?: CursorPagination;
}

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  metaData: MetaData;
}

export interface ErrorEnvelope {
  success: false;
  error: { code: string; message: string; details?: ErrorDetail[] };
  metaData: { requestId: string; timestamp: string };
}

/** A list handler returns this; the interceptor puts `pagination` into `metaData`. */
export class PageResult<T> {
  constructor(
    readonly items: readonly T[],
    readonly pagination: CursorPagination,
  ) {}
}

/** A CSV export handler returns this; it is sent as `text/csv` with no envelope. */
export class CsvResult {
  constructor(
    readonly body: string,
    readonly filename?: string,
  ) {}
}

const stamp = (requestId: string, now: () => Date): { requestId: string; timestamp: string } => ({
  requestId,
  timestamp: now().toISOString(),
});

export function successEnvelope<T>(
  data: T,
  requestId: string,
  pagination?: CursorPagination,
  now: () => Date = () => new Date(),
): SuccessEnvelope<T> {
  return {
    success: true,
    data,
    metaData: { ...stamp(requestId, now), ...(pagination === undefined ? {} : { pagination }) },
  };
}

export function errorEnvelope(
  code: string,
  message: string,
  requestId: string,
  details?: readonly ErrorDetail[],
  now: () => Date = () => new Date(),
): ErrorEnvelope {
  return {
    success: false,
    error: {
      code,
      message,
      ...(details === undefined || details.length === 0 ? {} : { details: [...details] }),
    },
    metaData: stamp(requestId, now),
  };
}

const RAW_RESPONSE = 'shroomap:raw-response';

/** Marks a handler whose body is sent as is (liveness and readiness probes). */
export const RawResponse = (): MethodDecorator => (_target, _key, descriptor) => {
  Reflect.defineMetadata(RAW_RESPONSE, true, descriptor.value as object);
};

/** Wraps every handler result in the success envelope; 204 and CSV leave without one. */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    if (Reflect.getMetadata(RAW_RESPONSE, context.getHandler()) === true) return next.handle();
    return next.handle().pipe(
      map((result: unknown) => {
        if (reply.statusCode === 204) return undefined;
        if (result instanceof CsvResult) {
          void reply.header('content-type', 'text/csv; charset=utf-8');
          if (result.filename !== undefined) {
            void reply.header('content-disposition', `attachment; filename="${result.filename}"`);
          }
          return result.body;
        }
        if (result instanceof PageResult) {
          return successEnvelope([...result.items], request.id, result.pagination);
        }
        return successEnvelope(result ?? null, request.id);
      }),
    );
  }
}
