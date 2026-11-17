export interface ReportWindow {
  readonly from: Date;
  readonly to: Date;
}

export type WindowFault =
  | { readonly kind: 'invalid'; readonly field: 'from' | 'to'; readonly message: string }
  | { readonly kind: 'too_large'; readonly maxDays: number };

export interface WindowSettings {
  readonly defaultDays: number;
  readonly maxDays: number;
}

const DAY_MS = 86_400_000;

/**
 * Window [from, to) in UTC: `to` defaults to now and `from` to `to` minus the default days. `to` must be after `from`;
 * a span above `maxDays` is refused (API-130). Returns the fault instead of throwing so the domain stays framework free.
 */
export function resolveWindow(
  input: { readonly from?: Date | undefined; readonly to?: Date | undefined },
  now: Date,
  settings: WindowSettings,
): ReportWindow | WindowFault {
  const to = input.to ?? now;
  const from = input.from ?? new Date(to.getTime() - settings.defaultDays * DAY_MS);
  if (!(to.getTime() > from.getTime()))
    return { kind: 'invalid', field: 'to', message: 'to must be after from' };
  if (to.getTime() - from.getTime() > settings.maxDays * DAY_MS)
    return { kind: 'too_large', maxDays: settings.maxDays };
  return { from, to };
}

export const isFault = (value: ReportWindow | WindowFault): value is WindowFault => 'kind' in value;
