import type { ProviderUsage, UsageReport } from '@shroomap/contracts';

/** SCREEN-015 copy (UI-UX §7 frame text, §8, §9.1). Accounts are shown by user ID only: no content, key material or email. */
export const SCREEN_015_COPY = {
  title: 'Usage report',
  description:
    'Operational spend, failures and brand-check use. Figures are estimates from the configured price table, not provider bills. No campaign content, keys or email addresses.',
  windowLabel: 'Time window',
  customFrom: 'From',
  customTo: 'To',
  apply: 'Apply',
  asOf: 'As of',
  windowTooLarge: 'The longest window is 366 days. Choose a shorter one.',
  windowFieldError: 'Choose a window of 366 days or fewer.',
  windowOrder: 'The end date must not be before the start date.',
  windowMissing: 'Choose both dates.',
  loading: 'Loading the usage report',
  emptyTitle: 'No usage in this window',
  errorTitle: 'The report could not be built',
  errorBody:
    'A data source did not answer, so no figures are shown rather than showing zeros. Try again.',
  retry: 'Try again',
  metrics: {
    calls: 'Provider calls',
    failed: 'Failed calls',
    cost: 'Estimated cost',
    flags: 'Claim flags raised',
  },
  accountsTitle: 'By account and provider',
  accountsNote: 'Estimated cost from the price table',
  exportCsv: 'Export CSV',
  exportError: 'The CSV could not be downloaded. Try again.',
  claimsTitle: 'Brand checks',
  claimsNote: 'Counts by class',
  notAllowed: '(not allowed)',
  none: '–',
} as const;

export const MAX_WINDOW_DAYS = 366;
export const PRESETS = [7, 30, 90, MAX_WINDOW_DAYS] as const;
export type WindowChoice = `${(typeof PRESETS)[number]}` | 'custom';

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const dayStart = (date: string): number => {
  const at = DATE.test(date) ? Date.parse(`${date}T00:00:00.000Z`) : Number.NaN;
  return at;
};

export const isoDate = (at: number): string => new Date(at).toISOString().slice(0, 10);

export interface ReportWindow {
  from: string;
  to: string;
}

/** The window of whole UTC days `from` to `to` (both inclusive) as the api's `[from, to)` instants; `null` when a date is malformed or reversed. */
export function windowParams(window: ReportWindow): { from: string; to: string } | null {
  const from = dayStart(window.from);
  const to = dayStart(window.to);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  return { from: new Date(from).toISOString(), to: new Date(to + DAY_MS).toISOString() };
}

/** Whole days covered by the inclusive dates; 0 when malformed. */
export function windowDays(window: ReportWindow): number {
  const from = dayStart(window.from);
  const to = dayStart(window.to);
  return Number.isNaN(from) || Number.isNaN(to) || to < from
    ? 0
    : Math.round((to - from) / DAY_MS) + 1;
}

/** `null` when the dates are a valid window; else the message to show on the end date. */
export function checkWindow(window: ReportWindow): string | null {
  if (!window.from || !window.to) return SCREEN_015_COPY.windowMissing;
  const days = windowDays(window);
  if (days === 0) return SCREEN_015_COPY.windowOrder;
  return days > MAX_WINDOW_DAYS ? SCREEN_015_COPY.windowFieldError : null;
}

/** The last `days` whole UTC days up to and including today. */
export function presetWindow(days: number, now: Date = new Date()): ReportWindow {
  const today = dayStart(isoDate(now.getTime()));
  return { from: isoDate(today - (days - 1) * DAY_MS), to: isoDate(today) };
}

/** Which selector choice a window is: a preset when it ends today and has a preset's length, else custom. */
export function choiceOf(window: ReportWindow | null, now: Date = new Date()): WindowChoice {
  if (!window) return '30';
  const match = PRESETS.find(
    (n) => window.to === isoDate(now.getTime()) && windowDays(window) === n,
  );
  return match ? (String(match) as WindowChoice) : 'custom';
}

export const PROVIDER_NAME: Record<string, string> = {
  openai: 'OpenAI',
  wavespeed: 'WaveSpeed',
  assembly_vendor: 'Assembly vendor',
};
export const providerName = (id: string): string => PROVIDER_NAME[id] ?? id;

export const CLAIM_CLASS: Record<string, string> = {
  high_risk: 'High risk (treatment, cure, dosing)',
  other: 'Other (word count, style)',
};

const COUNT = new Intl.NumberFormat('en-US');
export const formatCount = (n: number): string => COUNT.format(n);

/** Micro-dollars (four fraction digits) of a `MoneyUsd` string; exact, no floating point. */
export function microUsd(value: string): bigint {
  const match = /^(-?)(\d+)\.(\d{4})$/.exec(value);
  if (!match) return 0n;
  const units = BigInt(`${match[2]!}${match[3]!}`);
  return match[1] ? -units : units;
}

/** `US$412.60`, rounded half up to cents. */
export function formatUsd(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const cents = (abs + 50n) / 100n;
  const whole = COUNT.format(cents / 100n);
  return `${negative ? '-' : ''}US$${whole}.${String(cents % 100n).padStart(2, '0')}`;
}

/** `94 s`, `6.1 s`, `850 ms`; `–` when the api has no figure. */
export function formatLatency(ms: number | null): string {
  if (ms === null) return SCREEN_015_COPY.none;
  if (ms < 1000) return `${String(Math.round(ms))} ms`;
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))} s`;
}

/** `14 Nov 2026, 22:40` in UTC, the report's time basis. */
export function formatAsOf(instant: string): string {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return '';
  const date = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(at);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(at);
  return `${date}, ${time} UTC`;
}

/** `u_8f3a…c21d`: a user ID shortened to its first and last four characters. */
export function shortUserId(id: string): string {
  const bare = id.replace(/-/g, '');
  return bare.length > 10 ? `u_${bare.slice(0, 4)}…${bare.slice(-4)}` : `u_${bare}`;
}

export interface Totals {
  calls: number;
  failed: number;
  cost: bigint;
  flags: number;
}

export function totalsOf(report: UsageReport): Totals {
  return {
    calls: report.providers.reduce((n, p) => n + p.calls, 0),
    failed: report.providers.reduce((n, p) => n + p.failed, 0),
    cost: report.providers.reduce((n, p) => n + microUsd(p.estimatedCostUsd), 0n),
    flags: report.claimChecks.reduce((n, c) => n + c.raised, 0),
  };
}

export interface AccountRow {
  key: string;
  userId: string;
  usage: ProviderUsage;
}

export const accountRows = (report: UsageReport): AccountRow[] =>
  report.accounts.flatMap((a) =>
    a.providers.map((usage) => ({ key: `${a.userId}:${usage.provider}`, userId: a.userId, usage })),
  );

/** Whole percent of `part` in `whole`, 0 when `whole` is 0. */
export function share(part: bigint, whole: bigint): number {
  return whole > 0n ? Number((part * 100n + whole / 2n) / whole) : 0;
}
