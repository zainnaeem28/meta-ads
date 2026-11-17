import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DomainError, ERROR_STATUS } from './domain-error.js';
import type { ErrorCodeValue } from './domain-error.js';
import { errorEnvelope } from './response.js';
import type { ErrorDetail } from '../shared-kernel/index.js';

export interface FilterLogger {
  error(fields: Record<string, unknown>, message: string): void;
}

/** Fixed caller-facing text per code for errors that do not come from a DomainError. */
const GENERIC_MESSAGE: Partial<Record<ErrorCodeValue, string>> = {
  validation_failed: 'The request is not valid.',
  unauthenticated: 'Sign in to continue.',
  forbidden_role: 'You do not have access to this.',
  not_found: 'Not found.',
  method_not_allowed: 'This method is not allowed here.',
  state_conflict: 'The request conflicts with the current state.',
  payload_too_large: 'The request is too large.',
  unsupported_media_type: 'This content type is not supported.',
  rate_limited: 'Too many requests. Try again shortly.',
  internal_error: 'Something went wrong. Try again.',
  service_unavailable: 'The service is temporarily unavailable. Try again shortly.',
};

const STATUS_CODE: Readonly<Record<number, ErrorCodeValue>> = {
  400: 'validation_failed',
  401: 'unauthenticated',
  403: 'forbidden_role',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'state_conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'validation_failed',
  429: 'rate_limited',
  503: 'service_unavailable',
};

const FASTIFY_CODE: Readonly<Record<string, ErrorCodeValue>> = {
  FST_ERR_CTP_BODY_TOO_LARGE: 'payload_too_large',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'unsupported_media_type',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'validation_failed',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'validation_failed',
  FST_ERR_CTP_INVALID_JSON_BODY: 'validation_failed',
};

/** PostgreSQL statement_timeout and lock_timeout (TD-D34..TD-D40 follow-up F3). */
const TIMEOUT_SQLSTATES = new Set(['57014', '55P03']);

function isDatabaseTimeout(error: unknown): boolean {
  for (
    let depth = 0, current: unknown = error;
    depth < 5 && typeof current === 'object' && current !== null;
    depth++
  ) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && TIMEOUT_SQLSTATES.has(code)) return true;
    current = cause;
  }
  return false;
}

interface Outcome {
  code: ErrorCodeValue;
  message: string;
  details?: readonly ErrorDetail[];
  /** The error to log: set for every 5xx. */
  log?: unknown;
}

function fromStatus(status: number, log: unknown): Outcome {
  const code: ErrorCodeValue =
    STATUS_CODE[status] ?? (status >= 500 ? 'internal_error' : 'validation_failed');
  return {
    code,
    message: GENERIC_MESSAGE[code] ?? GENERIC_MESSAGE['internal_error'] ?? '',
    ...(ERROR_STATUS[code] >= 500 ? { log } : {}),
  };
}

export function classify(exception: unknown): Outcome {
  if (exception instanceof DomainError) {
    return {
      code: exception.code,
      message: exception.safeMessage,
      ...(exception.status >= 500 ? { log: exception } : { details: exception.details ?? [] }),
    };
  }
  if (isDatabaseTimeout(exception)) {
    return {
      code: 'service_unavailable',
      message: GENERIC_MESSAGE['service_unavailable'] ?? '',
      log: exception,
    };
  }
  if (exception instanceof HttpException) return fromStatus(exception.getStatus(), exception);
  if (typeof exception === 'object' && exception !== null) {
    const { statusCode, code } = exception as { statusCode?: unknown; code?: unknown };
    if (typeof code === 'string' && FASTIFY_CODE[code] !== undefined) {
      return fromStatus(ERROR_STATUS[FASTIFY_CODE[code]], exception);
    }
    if (
      typeof statusCode === 'number' &&
      statusCode >= 400 &&
      statusCode <= 599 &&
      typeof code === 'string' &&
      code.startsWith('FST_')
    ) {
      return fromStatus(statusCode, exception);
    }
  }
  return {
    code: 'internal_error',
    message: GENERIC_MESSAGE['internal_error'] ?? '',
    log: exception,
  };
}

/** The one place an error becomes a response: registry status, error envelope, 5xx logged once. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: FilterLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const outcome = classify(exception);
    const status = ERROR_STATUS[outcome.code];
    if (outcome.log !== undefined) {
      const name = outcome.log instanceof Error ? outcome.log.name : typeof outcome.log;
      const message = outcome.log instanceof Error ? `: ${outcome.log.message.slice(0, 300)}` : '';
      this.logger.error(
        {
          requestId: request.id,
          route: request.routeOptions?.url ?? 'unmatched',
          status,
          code: outcome.code,
        },
        `unhandled error ${name}${message}`,
      );
    }
    if (reply.sent) return;
    void reply
      .status(status)
      .header('content-type', 'application/json; charset=utf-8')
      .send(errorEnvelope(outcome.code, outcome.message, request.id, outcome.details));
  }
}
