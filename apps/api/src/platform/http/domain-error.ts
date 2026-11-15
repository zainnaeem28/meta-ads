import { DomainErrorBase } from '../shared-kernel/index.js';
import type { ErrorDetail } from '../shared-kernel/index.js';

/**
 * The registry codes of shared-boundaries section 6, generated into packages/contracts as ERROR_CODES. The api
 * does not import the contracts package at run time (it ships TypeScript source for the web client); the unit test
 * compares this table with the generated list and with the status comments in openapi.yaml.
 */
export type ErrorCodeValue = keyof typeof ERROR_STATUS;

/** One HTTP status per registry code (shared-boundaries section 6). */
export const ERROR_STATUS = {
  validation_failed: 400,
  unauthenticated: 401,
  not_linked: 403,
  forbidden_role: 403,
  mfa_required: 403,
  recent_auth_required: 403,
  account_suspended: 403,
  account_removed: 403,
  not_found: 404,
  method_not_allowed: 405,
  version_conflict: 409,
  state_conflict: 409,
  idempotency_key_reused: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  key_missing: 422,
  key_disabled: 422,
  key_invalid: 422,
  storage_quota_reached: 422,
  media_not_ready: 422,
  open_claim_issues: 422,
  claim_not_clearable: 422,
  brief_not_accepted: 422,
  spend_cap_reached: 422,
  assembly_daily_limit: 422,
  clip_not_completed: 422,
  qc_confirmation_required: 422,
  last_admin: 422,
  self_action: 422,
  confirmation_mismatch: 422,
  invite_domain_not_allowed: 422,
  signup_open_prerequisites: 422,
  report_window_too_large: 422,
  rate_limited: 429,
  internal_error: 500,
  service_unavailable: 503,
} as const satisfies Record<string, number>;

export const MAX_DETAILS = 50;
export const MAX_MESSAGE = 300;
export const MAX_ERROR_MESSAGE = 500;
const MAX_FIELD = 200;
const MAX_DETAIL_CODE = 64;

const REGISTERED = new Set<string>(Object.keys(ERROR_STATUS));
export const ERROR_CODES = Object.keys(ERROR_STATUS) as ErrorCodeValue[];

export function isErrorCode(value: unknown): value is ErrorCodeValue {
  return typeof value === 'string' && REGISTERED.has(value);
}

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

/** A business refusal with a registry code and a message that is safe to show the caller. */
export class DomainError extends DomainErrorBase<ErrorCodeValue> {
  readonly status: number;

  constructor(code: ErrorCodeValue, safeMessage: string, details?: readonly ErrorDetail[]) {
    if (!isErrorCode(code)) throw new TypeError(`unregistered error code: ${String(code)}`);
    super(
      code,
      clip(safeMessage, MAX_ERROR_MESSAGE),
      details?.slice(0, MAX_DETAILS).map((detail) => ({
        field: clip(detail.field, MAX_FIELD),
        code: clip(detail.code, MAX_DETAIL_CODE),
        message: clip(detail.message, MAX_MESSAGE),
      })),
    );
    this.status = ERROR_STATUS[code];
  }
}
