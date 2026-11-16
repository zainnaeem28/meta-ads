/** One `ErrorDetail` of the API error envelope (`field` is a public DTO path such as `segments.0.dialogue`). */
export interface ErrorDetail {
  field: string;
  code: string;
  message: string;
}

/** A visible control a `field` path maps to; `label` is what the summary link reads. */
export interface DetailTarget {
  id: string;
  label: string;
}

export interface SummaryEntry {
  key: string;
  message: string;
  /** Absent when the path has no visible control: the entry is listed without a link (rule d). */
  target?: DetailTarget;
}

export interface MappedDetails {
  /** Summary entries in server order. */
  entries: SummaryEntry[];
  /** Error text per control id; the first entry for a control wins. */
  fieldErrors: Record<string, string>;
}

/** Numbers in a DTO path as the user counts them (index plus one); the path itself is never shown. */
export function pathNumbers(path: string): number[] {
  return path
    .split('.')
    .filter((part) => /^\d+$/.test(part))
    .map((part) => Number(part) + 1);
}

/**
 * UI-UX §9.1 rules (a), (c), (d), (e): maps `details[]` to control errors and summary entries.
 * `resolve` returns the control for a path, or undefined for an unknown path. The message is the
 * server message, never the code.
 */
export function mapDetails(
  details: readonly ErrorDetail[],
  resolve: (field: string) => DetailTarget | undefined,
): MappedDetails {
  const fieldErrors: Record<string, string> = {};
  const entries = details.map((detail, index): SummaryEntry => {
    const target = resolve(detail.field);
    if (target && !(target.id in fieldErrors)) fieldErrors[target.id] = detail.message;
    return { key: `${index}:${detail.field}`, message: detail.message, target };
  });
  return { entries, fieldErrors };
}

/** Entries shown before "and {n} more" (rule f). */
export const SUMMARY_LIMIT = 5;
