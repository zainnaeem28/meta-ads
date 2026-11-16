import type { ErrorCodeValue } from '@shroomap/contracts';
import { ROUTES } from './routes';

/** How a row is shown (UI-UX §9.1 "Presentation"). `surface` at the call site picks between page and alert. */
export type Presentation =
  | 'page' // CMP-019 load error, role="alert"
  | 'alert' // CMP-011 above the actions
  | 'toast' // CMP-012
  | 'dialog' // CMP-013 (qc-confirm, step-up)
  | 'redirect' // navigation to an auth screen
  | 'message-page' // full message page in the auth shell
  | 'field' // CMP-010 error under a control, with the summary
  | 'file-row'; // CMP-021 rejected row, with a CMP-011 alert under the zone

export type Tone = 'destructive' | 'warning';

export type ActionKind =
  | 'retry' // Try again (read: now; write: same idempotency key)
  | 'reload'
  | 'refresh'
  | 'link'
  | 'close'
  | 'sign-in'
  | 'confirm'
  | 'fix' // correct the input and resubmit
  | 'none';

export interface ErrorAction {
  kind: ActionKind;
  label: string;
  /** Destination of a `link`, `sign-in` or `redirect`. */
  href?: string;
}

/** What the copy functions may read from the answer. */
export interface CopyContext {
  /** The server `message`, already screened (see `safeServerMessage`); null when absent or unsafe. */
  server: string | null;
  /** Whole seconds of `Retry-After`, or null. */
  wait: number | null;
}

export interface ErrorRow {
  code: ErrorCodeValue;
  status: number;
  /** Heading of a dialog, where the row has one. */
  title?: string;
  /** Wording when the failing call is a page load and differs from `message`. */
  pageMessage?: string;
  message: (ctx: CopyContext) => string;
  action: ErrorAction;
  presentation: Presentation;
  /** Presentation when the failing call is an action inside a form or dialog and the row differs from `presentation`. */
  inContext?: Presentation;
  /** Action when the failing call is an action inside a form, dialog or page and the row differs from `action`. */
  inContextAction?: ErrorAction;
  tone: Tone;
  /** The 500/503 "Reference" line with the request ID and a Copy button. */
  reference?: boolean;
  /** The 5xx retry presentation (live countdown, three-failure hint, same idempotency key). */
  retry?: boolean;
  /** Not reachable from a correct UI: log the route and request ID. */
  defect?: boolean;
  /** Screen state the row maps to (UI-UX §9.1), for the table test and review. */
  state: string;
}

/** Joins a fixed lead-in and the server message that names the limit, clip or missing prerequisite. */
const lead = (fixed: string, ctx: CopyContext): string =>
  ctx.server ? `${fixed} ${ctx.server}` : fixed;

/** The seconds wording of `rate_limited` and `service_unavailable`. */
export const waitPhrase = (seconds: number): string =>
  seconds > 120
    ? `${Math.ceil(seconds / 60)} minutes`
    : `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;

const SAME_ACTION: ErrorAction = { kind: 'none', label: '' };

const rows: ErrorRow[] = [
  {
    code: 'internal_error',
    status: 500,
    message: () =>
      'Something went wrong on our side. Your work was not changed by this request. Try again, and if it keeps happening quote the reference below.',
    action: { kind: 'retry', label: 'Try again' },
    presentation: 'page',
    inContext: 'alert',
    tone: 'destructive',
    reference: true,
    retry: true,
    state: 'error',
  },
  {
    code: 'service_unavailable',
    status: 503,
    message: ({ wait }) =>
      wait
        ? `ShrooMap is temporarily unavailable. You can try again in ${waitPhrase(wait)}.`
        : 'ShrooMap is temporarily unavailable. Try again in a moment.',
    action: { kind: 'retry', label: 'Try again' },
    presentation: 'page',
    inContext: 'alert',
    tone: 'warning',
    reference: true,
    retry: true,
    state: 'error',
  },
  {
    code: 'method_not_allowed',
    status: 405,
    message: () => 'This action is not available. Reload the page and try again.',
    action: { kind: 'reload', label: 'Reload' },
    presentation: 'alert',
    tone: 'destructive',
    defect: true,
    state: 'defect',
  },
  {
    code: 'qc_confirmation_required',
    status: 422,
    title: 'Confirm clips that did not pass the check',
    message: ({ server }) =>
      server
        ? `${server} The final ad will include these clips as they are. Your confirmation is recorded.`
        : 'The final ad will include these clips as they are. Your confirmation is recorded.',
    action: { kind: 'confirm', label: 'Include these clips and assemble' },
    presentation: 'dialog',
    tone: 'warning',
    state: 'qc-confirm',
  },
  {
    code: 'validation_failed',
    status: 400,
    message: () => 'Check the highlighted fields and try again.',
    action: { kind: 'fix', label: 'Correct and resubmit' },
    presentation: 'field',
    tone: 'destructive',
    state: 'validation-error',
  },
  {
    code: 'unauthenticated',
    status: 401,
    message: () => 'Your session ended. Sign in to continue.',
    action: { kind: 'sign-in', label: 'Sign in', href: ROUTES.signIn },
    presentation: 'redirect',
    tone: 'warning',
    state: 'session-expired',
  },
  {
    code: 'not_linked',
    status: 403,
    message: () =>
      'Your account is not set up for this workspace yet. Ask for access below, or ask an administrator for an invitation.',
    action: { kind: 'link', label: 'Request access', href: ROUTES.access },
    presentation: 'message-page',
    tone: 'warning',
    state: 'not-linked',
  },
  {
    code: 'forbidden_role',
    status: 403,
    pageMessage: 'This page is not available.',
    message: () => 'You do not have permission to do this.',
    action: { kind: 'link', label: 'Go Home', href: ROUTES.home },
    inContextAction: { kind: 'close', label: 'Close' },
    presentation: 'page',
    inContext: 'alert',
    tone: 'warning',
    state: 'unavailable',
  },
  {
    code: 'mfa_required',
    status: 403,
    message: () => 'Two-step verification is required. Set it up to continue.',
    action: { kind: 'link', label: 'Set up', href: ROUTES.mfa },
    presentation: 'redirect',
    tone: 'warning',
    state: 'mfa',
  },
  {
    code: 'recent_auth_required',
    status: 403,
    title: 'Confirm it is you',
    message: () => 'For your security, confirm it is you again to continue.',
    action: { kind: 'confirm', label: 'Confirm sign-in' },
    presentation: 'dialog',
    tone: 'warning',
    state: 'step-up',
  },
  {
    code: 'not_found',
    status: 404,
    message: () => 'This page or item is not available.',
    action: { kind: 'link', label: 'Go Home', href: ROUTES.home },
    presentation: 'page',
    inContext: 'toast',
    tone: 'warning',
    state: 'unavailable',
  },
  {
    code: 'version_conflict',
    status: 409,
    message: () =>
      'This was changed somewhere else. Reload to see the latest version before you edit again.',
    action: { kind: 'refresh', label: 'Show the latest version' },
    presentation: 'alert',
    tone: 'warning',
    state: 'conflict',
  },
  {
    code: 'state_conflict',
    status: 409,
    message: () => 'This cannot be done in its current state. Refresh to see what changed.',
    action: { kind: 'refresh', label: 'Refresh' },
    presentation: 'alert',
    tone: 'warning',
    state: 'out-of-date',
  },
  {
    code: 'idempotency_key_reused',
    status: 409,
    message: () =>
      'This request was already sent with different details. Reload the page and try again.',
    action: { kind: 'reload', label: 'Reload' },
    presentation: 'alert',
    tone: 'destructive',
    defect: true,
    state: 'defect',
  },
  {
    code: 'key_missing',
    status: 422,
    message: () => 'Add your provider key to continue. Your work is saved.',
    action: { kind: 'link', label: 'Add provider key', href: ROUTES.providerKeys },
    presentation: 'alert',
    tone: 'warning',
    state: 'key-missing',
  },
  {
    code: 'key_disabled',
    status: 422,
    message: () =>
      'Your provider key was disabled after repeated failures. Replace it to continue.',
    action: { kind: 'link', label: 'Replace key', href: ROUTES.providerKeys },
    presentation: 'alert',
    tone: 'destructive',
    state: 'key-disabled',
  },
  {
    code: 'key_invalid',
    status: 422,
    message: () =>
      'The provider did not accept this key. Check it and try again. Nothing was saved.',
    action: { kind: 'fix', label: 'Try again' },
    presentation: 'field',
    tone: 'destructive',
    state: 'validation-error',
  },
  {
    code: 'spend_cap_reached',
    status: 422,
    message: (ctx) => lead('A usage limit has been reached, so this cannot start.', ctx),
    action: { ...SAME_ACTION, label: 'Contact your administrator' },
    presentation: 'alert',
    tone: 'warning',
    state: 'cap-reached',
  },
  {
    code: 'assembly_daily_limit',
    status: 422,
    message: () => 'You have used all final-ad assemblies for today. Try again after midnight UTC.',
    action: SAME_ACTION,
    presentation: 'alert',
    tone: 'warning',
    state: 'cap-reached',
  },
  {
    code: 'storage_quota_reached',
    status: 422,
    message: () =>
      'Your storage limit is full. Delete a draft or campaign to free space, then upload again.',
    action: { kind: 'link', label: 'Go to campaigns', href: ROUTES.campaigns },
    presentation: 'file-row',
    tone: 'warning',
    state: 'upload-rejected',
  },
  {
    code: 'payload_too_large',
    status: 413,
    message: ({ server }) => server ?? 'This file is too large. Choose a smaller file.',
    action: { kind: 'fix', label: 'Choose another file' },
    presentation: 'file-row',
    tone: 'destructive',
    state: 'upload-rejected',
  },
  {
    code: 'unsupported_media_type',
    status: 415,
    message: ({ server }) =>
      server ?? 'This file type is not supported. Use JPEG, PNG, WebP or GIF.',
    action: { kind: 'fix', label: 'Choose another file' },
    presentation: 'file-row',
    tone: 'destructive',
    state: 'upload-rejected',
  },
  {
    code: 'media_not_ready',
    status: 422,
    message: () => 'The image is still being processed. Wait a moment and try again.',
    action: { kind: 'retry', label: 'Try again' },
    presentation: 'alert',
    tone: 'warning',
    state: 'uploading',
  },
  {
    code: 'clip_not_completed',
    status: 422,
    message: ({ server }) =>
      server ?? 'A clip is not finished. Remove it from the selection or wait for it to complete.',
    action: { kind: 'refresh', label: 'Update selection' },
    presentation: 'alert',
    tone: 'warning',
    state: 'selecting',
  },
  {
    code: 'brief_not_accepted',
    status: 422,
    message: ({ server }) =>
      server && /segment/i.test(server) && /(not active|inactive)/i.test(server)
        ? server
        : 'Accept the brief before you generate clips.',
    action: { kind: 'link', label: 'Open the brief', href: ROUTES.brief },
    presentation: 'alert',
    tone: 'warning',
    state: 'blocked',
  },
  {
    code: 'claim_not_clearable',
    status: 422,
    message: () => 'This issue cannot be cleared. Edit the segment until the check passes.',
    action: { kind: 'fix', label: 'Edit the segment' },
    presentation: 'alert',
    tone: 'warning',
    state: 'accept-blocked',
  },
  {
    code: 'open_claim_issues',
    status: 422,
    message: () => 'Fix the flagged claim issues before you continue.',
    action: { kind: 'fix', label: 'Fix the flagged text' },
    presentation: 'field',
    tone: 'warning',
    state: 'accept-blocked',
  },
  {
    code: 'confirmation_mismatch',
    status: 422,
    message: () => "That does not match. Type the account's email address exactly to confirm.",
    action: { kind: 'fix', label: 'Retype' },
    presentation: 'field',
    tone: 'destructive',
    state: 'remove-confirm',
  },
  {
    code: 'report_window_too_large',
    status: 422,
    message: () => 'Choose a window of 366 days or fewer.',
    action: { kind: 'fix', label: 'Change the dates' },
    presentation: 'field',
    tone: 'warning',
    state: 'window-too-large',
  },
  {
    code: 'last_admin',
    status: 422,
    message: () => 'This is the last administrator. Make another account an administrator first.',
    action: { kind: 'close', label: 'Close' },
    presentation: 'alert',
    tone: 'warning',
    state: 'last-admin',
  },
  {
    code: 'self_action',
    status: 422,
    message: () => 'You cannot do this to your own account.',
    action: { kind: 'close', label: 'Close' },
    presentation: 'alert',
    tone: 'warning',
    state: 'only-you',
  },
  {
    code: 'account_suspended',
    status: 403,
    message: () => 'Your account is suspended. Contact your administrator.',
    action: SAME_ACTION,
    presentation: 'message-page',
    tone: 'warning',
    state: 'suspended',
  },
  {
    code: 'account_removed',
    status: 403,
    message: () => 'This account has been removed.',
    action: SAME_ACTION,
    presentation: 'message-page',
    tone: 'destructive',
    state: 'removed',
  },
  {
    code: 'invite_domain_not_allowed',
    status: 422,
    message: () => 'Invitations are limited to approved email domains. Use an approved address.',
    action: { kind: 'fix', label: 'Change the address' },
    presentation: 'field',
    tone: 'destructive',
    state: 'invite-error',
  },
  {
    code: 'signup_open_prerequisites',
    status: 422,
    message: (ctx) => lead('Open sign-up cannot be turned on yet.', ctx),
    action: { kind: 'close', label: 'Close' },
    presentation: 'alert',
    tone: 'warning',
    state: 'open-refused',
  },
  {
    code: 'rate_limited',
    status: 429,
    message: ({ wait }) =>
      wait
        ? `Too many attempts. Try again in ${waitPhrase(wait)}.`
        : 'Too many attempts. Try again in a moment.',
    action: { kind: 'retry', label: 'Try again' },
    presentation: 'alert',
    tone: 'warning',
    retry: true,
    state: 'rate-limited',
  },
];

/** The copy table: one row for each of the 36 registry codes, keyed by `error.code`. */
export const ERROR_TABLE = Object.fromEntries(rows.map((row) => [row.code, row])) as Record<
  ErrorCodeValue,
  ErrorRow
>;

/** Unknown codes (and transport failures) use the `internal_error` row. */
export const FALLBACK_ROW: ErrorRow = ERROR_TABLE.internal_error;
