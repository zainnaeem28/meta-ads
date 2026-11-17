export const CSV_HEADER =
  'user_id,provider,calls,succeeded,failed,rejected,unconfirmed,estimated_cost_usd,latency_p50_ms,latency_p95_ms';

/** A cell that would start a formula in a spreadsheet gets a single quote in front (formula injection), then CSV quoting. */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const csvRow = (cells: readonly (string | number | null)[]): string =>
  cells.map(csvCell).join(',');
