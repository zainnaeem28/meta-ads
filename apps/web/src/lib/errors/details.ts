import {
  mapDetails,
  type DetailTarget,
  type ErrorDetail,
  type MappedDetails,
} from '@shroomap/ui/cmp-010';

export type { DetailTarget, ErrorDetail, MappedDetails };

/** A form's controls by DTO path or path pattern; `segments.*.dialogue` matches any index. */
export type ControlMap = Record<string, DetailTarget | ((numbers: number[]) => DetailTarget)>;

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

const matcher = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split('*').map(escape).join('(\\d+)')}$`);

/**
 * UI-UX §9.1 `details[]` rules: maps each entry to the control its `field` names (rule a), numbering from the
 * path index plus one (rule c), listing entries without a control in the summary only (rule d), and showing the
 * server message, never the detail `code` (rule e). A 5xx never shows `details[]` content (rule h): pass `show: false`.
 */
export function mapErrorDetails(
  details: readonly ErrorDetail[],
  controls: ControlMap,
  show = true,
): MappedDetails {
  if (!show) return { entries: [], fieldErrors: {} };
  const compiled = Object.entries(controls).map(([pattern, target]) => ({
    re: matcher(pattern),
    target,
  }));
  return mapDetails(details, (field) => {
    for (const { re, target } of compiled) {
      const match = re.exec(field);
      if (!match) continue;
      const numbers = match.slice(1).map((n) => Number(n) + 1);
      return typeof target === 'function' ? target(numbers) : target;
    }
    return undefined;
  });
}
