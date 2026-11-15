/** The only fields a log line may carry (ARCHITECTURE 3.7). Anything else is dropped before it is written. */
export const ALLOWED_FIELDS = [
  'time',
  'level',
  'msg',
  'requestId',
  'correlationId',
  'route',
  'method',
  'status',
  'durationMs',
  'code',
  'module',
  'userId',
  'jobId',
  'jobType',
  'provider',
  'outcome',
  'latencyMs',
  'releaseSha',
] as const;

export type AllowedField = (typeof ALLOWED_FIELDS)[number];

const ALLOWED = new Set<string>(ALLOWED_FIELDS);

export function isAllowedField(name: string): name is AllowedField {
  return ALLOWED.has(name);
}

/** Keep listed fields with primitive values; drop the rest (objects, arrays and unlisted names). */
export function filterFields(
  fields: Record<string, unknown>,
  scrub: (value: string) => string,
): Record<string, string | number | boolean | null> {
  const kept: Record<string, string | number | boolean | null> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!isAllowedField(name)) continue;
    if (typeof value === 'string') kept[name] = scrub(value);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null)
      kept[name] = value;
  }
  return kept;
}
