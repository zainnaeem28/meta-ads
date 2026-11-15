import type { ErrorDetail } from '@shroomap/contracts';

export type ApiErrorKind = 'http' | 'network' | 'abort' | 'malformed';

export interface ApiClientErrorInit {
  status: number;
  code: string;
  message?: string;
  details?: ErrorDetail[];
  requestId?: string | null;
  cause?: unknown;
}

/** Every failed API call surfaces as this class. `kind` tells an HTTP error from a transport failure. */
export class ApiClientError extends Error {
  readonly kind: ApiErrorKind = 'http';
  readonly status: number;
  readonly code: string;
  readonly details: ErrorDetail[];
  readonly requestId: string | null;

  constructor(init: ApiClientErrorInit) {
    super(init.message ?? init.code, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.details = init.details ?? [];
    this.requestId = init.requestId ?? null;
  }
}

/** The request never produced a response (offline, DNS, connection reset). */
export class ApiNetworkError extends ApiClientError {
  override readonly kind: ApiErrorKind = 'network';
  constructor(cause: unknown, requestId?: string | null) {
    super({
      status: 0,
      code: 'network_error',
      message: 'Network request failed',
      cause,
      requestId,
    });
  }
}

/** The caller aborted the request; not a failure to show the user. */
export class ApiAbortError extends ApiClientError {
  override readonly kind: ApiErrorKind = 'abort';
  constructor(cause: unknown) {
    super({ status: 0, code: 'request_aborted', message: 'Request aborted', cause });
  }
}

/** A response arrived but its body is not the JSON the contract promises. */
export class ApiMalformedResponseError extends ApiClientError {
  override readonly kind: ApiErrorKind = 'malformed';
  constructor(status: number, requestId: string | null, cause?: unknown) {
    super({ status, code: 'malformed_response', message: 'Malformed response', requestId, cause });
  }
}

export const isApiClientError = (value: unknown): value is ApiClientError =>
  value instanceof ApiClientError;

/** True for a 4xx HTTP answer: the same request cannot succeed on retry. */
export const isClientHttpError = (value: unknown): boolean =>
  isApiClientError(value) && value.kind === 'http' && value.status >= 400 && value.status < 500;
