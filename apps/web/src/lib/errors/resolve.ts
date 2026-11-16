import { isApiClientError } from '../api/errors';
import {
  ERROR_TABLE,
  FALLBACK_ROW,
  type CopyContext,
  type ErrorAction,
  type ErrorRow,
  type Presentation,
  type Tone,
} from './copy';
import { DEFAULT_WAIT_SECONDS } from './countdown';
import type { ErrorDetail } from './details';

/** `page`: a data load that failed. `context`: an action inside a form, dialog or page that keeps its content. */
export type Surface = 'page' | 'context';

/** Server messages longer than this are never shown (UI-UX §9.1 e: up to 300 characters, wrapped, never cut). */
export const MAX_SERVER_MESSAGE = 300;

// What a message must never carry: a status, a stack, a table name or a provider name.
const UNSAFE = [
  /\bhttp\b/i,
  /\b(?:status(?: code)?|error)\s*:?\s*[1-5]\d\d\b/i,
  /\b[45]\d\d\s+(?:error|status|internal|bad|not found|forbidden|unauthori[sz]ed)/i,
  /\bat\s+\S+\s*\(.*:\d+(:\d+)?\)/,
  /\bstack\b|\btraceback\b|\bexception\b/i,
  /\bsql\b|\bselect\b.+\bfrom\b|\brelation\s+"|\bconstraint\b|\bpostgres/i,
  /\b(clerk|stripe|sentry|cloudflare|neon|supabase|elevenlabs|openai|anthropic|fal\.ai|google|r2)\b/i,
];

/** The server `message` when it is safe to show, else null. Rows that show it fall back to their own copy. */
export const safeServerMessage = (message: unknown): string | null => {
  if (typeof message !== 'string') return null;
  const text = message.trim();
  if (text.length === 0 || text.length > MAX_SERVER_MESSAGE) return null;
  return UNSAFE.some((pattern) => pattern.test(text)) ? null : text;
};

export interface ErrorView {
  /** The code from the answer; for an unknown code the row is `internal_error` and this stays the raw value. */
  code: string;
  known: boolean;
  row: ErrorRow;
  presentation: Presentation;
  tone: Tone;
  /** Dialog heading, where the row has one. */
  title: string | null;
  message: string;
  action: ErrorAction;
  /** Request ID for the "Reference" line; only the 500/503 rows (and the fallback) carry one. */
  reference: string | null;
  /** Retry presentation applies: the Try again button, its wait, and the failure hint. */
  retry: boolean;
  /** Seconds Try again stays disabled: `Retry-After`, 5 without it for 503/429, 0 for a 500. */
  waitSeconds: number;
  defect: boolean;
  requestId: string | null;
  /** `details[]`; always empty for a 5xx (rule h). */
  details: ErrorDetail[];
}

export interface ResolveOptions {
  surface?: Surface;
}

const rowFor = (code: string | null): ErrorRow | undefined =>
  code !== null && Object.hasOwn(ERROR_TABLE, code)
    ? ERROR_TABLE[code as keyof typeof ERROR_TABLE]
    : undefined;

/** True for an error the user should be told about; a caller-aborted request is not one. */
export const isReportable = (error: unknown): boolean =>
  !(isApiClientError(error) && error.kind === 'abort');

/**
 * Chooses the copy, action and presentation of one failure. Branches on `error.code` only: never on the HTTP
 * status, and never on the server message except where the row shows it. Unknown codes and transport failures use
 * the `internal_error` row.
 */
export function resolveError(error: unknown, options: ResolveOptions = {}): ErrorView {
  const surface = options.surface ?? 'page';
  const api = isApiClientError(error) ? error : null;
  const code = api?.code ?? 'unknown_error';
  const known = rowFor(code) !== undefined;
  const row = rowFor(code) ?? FALLBACK_ROW;

  const wait = api?.retryAfterSeconds ?? null;
  const ctx: CopyContext = {
    server: safeServerMessage(api?.message === api?.code ? null : api?.message),
    wait,
  };
  // Rows that do not show the server message must never leak it, so only rows that read ctx.server receive it.
  const text = row.pageMessage && surface === 'page' ? row.pageMessage : row.message(ctx);

  const presentation: Presentation =
    surface === 'context' && row.inContext ? row.inContext : row.presentation;

  const isServerFault =
    row === ERROR_TABLE.internal_error || row === ERROR_TABLE.service_unavailable;
  const waitSeconds = !row.retry
    ? 0
    : row === ERROR_TABLE.internal_error
      ? 0
      : (wait ?? DEFAULT_WAIT_SECONDS);

  return {
    code,
    known,
    row,
    presentation,
    tone: row.tone,
    title: row.title ?? null,
    message: text,
    action: row.action,
    reference: row.reference ? (api?.requestId ?? null) : null,
    retry: row.retry === true,
    waitSeconds,
    defect: row.defect === true,
    requestId: api?.requestId ?? null,
    details: isServerFault || !api ? [] : api.details,
  };
}
