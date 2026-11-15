export const REDACTED = '[REDACTED]';

/** Paths pino censors even if a field slipped past the allow-list (ARCHITECTURE 3.7). */
export const REDACTION_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.apiKey',
  '*.api_key',
  '*.ciphertext',
  '*.wrappedDek',
  '*.url',
  '*.email',
  '*.token',
  '*.transcript',
  '*.description',
] as const;

// Value shapes that never belong in a log line, wherever they appear.
const SHAPES: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style keys
  /\b(?:ws|wavespeed)[-_][A-Za-z0-9_-]{16,}/gi, // WaveSpeed keys (real format still VERIFY, TR-01)
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, // authorization header values
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, // JWTs
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, // email addresses
  /\b(?:https?:\/\/)[^\s"']*[?&](?:X-Amz-Signature|signature|token|sig)=[^\s"'&]+[^\s"']*/gi, // signed URLs
  /sk_(?:test|live)_[A-Za-z0-9]{8,}/g, // Clerk secret keys
];

const MIN_SECRET_LENGTH = 8;

export interface Scrubber {
  (value: string): string;
  /** Remember a runtime secret (a bearer token or cookie seen on a request) and remove it from later text. */
  learn(value: string): void;
}

const MAX_LEARNED = 1000;

/** Build a scrubber for strings: replaces secret shapes and every literal known secret value. */
export function createScrubber(secretValues: readonly string[] = []): Scrubber {
  const literals = new Set(secretValues.filter((value) => value.length >= MIN_SECRET_LENGTH));
  const scrub = ((value: string) => {
    let out = value;
    for (const literal of [...literals].sort((a, b) => b.length - a.length))
      out = out.split(literal).join(REDACTED);
    for (const shape of SHAPES) out = out.replace(shape, REDACTED);
    return out;
  }) as Scrubber;
  scrub.learn = (value) => {
    if (value.length < MIN_SECRET_LENGTH || literals.has(value)) return;
    if (literals.size >= MAX_LEARNED) literals.delete(literals.values().next().value as string);
    literals.add(value);
  };
  return scrub;
}

/** Deep-scrub any structure (error reporter events, trace attributes, job payloads) into a new value. */
export function scrubDeep(value: unknown, scrub: Scrubber, depth = 0): unknown {
  if (typeof value === 'string') return scrub(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, scrub, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[scrub(key)] = SENSITIVE_KEY.test(key) ? REDACTED : scrubDeep(inner, scrub, depth + 1);
  }
  return out;
}

const SENSITIVE_KEY =
  /^(authorization|cookie|set-cookie|apiKey|api_key|ciphertext|wrappedDek|email|password|secret|token|transcript|description)$/i;

/** Error reporter hook (Sentry `beforeSend`): the scrubbed event, never the original. */
export function scrubReportEvent<T extends object>(event: T, scrub: Scrubber): T {
  return scrubDeep(event, scrub) as T;
}

/** Tracing hook: scrubbed span attributes. */
export function scrubSpanAttributes(
  attributes: Record<string, unknown>,
  scrub: Scrubber,
): Record<string, unknown> {
  return scrubDeep(attributes, scrub) as Record<string, unknown>;
}
