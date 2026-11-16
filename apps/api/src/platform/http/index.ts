export { buildPage, decodeCursor, encodeCursor, filterHash, invalidCursor } from './cursor.js';
export type { CursorScope } from './cursor.js';
export { DomainError, ERROR_CODES, ERROR_STATUS, isErrorCode } from './domain-error.js';
export type { ErrorCodeValue } from './domain-error.js';
export { ErrorFilter, classify } from './error.filter.js';
export type { FilterLogger } from './error.filter.js';
export {
  CsvResult,
  EnvelopeInterceptor,
  PageResult,
  RawResponse,
  errorEnvelope,
  successEnvelope,
} from './response.js';
export type { CursorPagination, ErrorEnvelope, MetaData, SuccessEnvelope } from './response.js';
export { ZodValidationPipe, issueDetails, parseWith } from './validation.pipe.js';
export {
  AuthGuard,
  CurrentActor,
  CurrentSession,
  SESSION_AUTHENTICATOR,
  authorizeScope,
  bearerToken,
  requireMfa,
  requireRecentAuth,
  requireRole,
} from './auth.guard.js';
export type {
  ActorContext,
  ActorRole,
  AuthResult,
  AuthenticatedRequest,
  SessionAuthenticator,
  UnlinkedSession,
} from './auth.guard.js';
export { Scope } from './scope-registry.js';
