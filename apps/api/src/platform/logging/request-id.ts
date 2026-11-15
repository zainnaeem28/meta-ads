import { v7 as uuidv7 } from 'uuid';

export const REQUEST_ID_HEADER = 'x-request-id';
const TRUSTED_SHAPE = /^[A-Za-z0-9-]{8,64}$/;

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && TRUSTED_SHAPE.test(value);
}

/** A trusted upstream value is kept only when it matches the shape; anything else gets a fresh UUIDv7. */
export function resolveRequestId(upstream: unknown, trusted = true): string {
  const value = Array.isArray(upstream) ? upstream[0] : upstream;
  return trusted && isValidRequestId(value) ? value : uuidv7();
}

/** The `metaData` shape the http layer puts in every envelope (ARCHITECTURE 3.1). */
export function responseMeta(
  requestId: string,
  now: () => Date = () => new Date(),
): { requestId: string; timestamp: string } {
  return { requestId, timestamp: now().toISOString() };
}

export interface JobPayloadBase {
  correlationId?: string;
}

/** Stamp a job payload with the request that caused it. */
export function withCorrelation<T extends object>(
  payload: T,
  requestId: string,
): T & { correlationId: string } {
  return { ...payload, correlationId: requestId };
}

/** The correlation ID a worker logs for a job: the payload's when valid, else a fresh one. */
export function correlationOf(payload: JobPayloadBase | null | undefined): string {
  return resolveRequestId(payload?.correlationId);
}
