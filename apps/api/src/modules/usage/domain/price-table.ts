import { z } from 'zod';
import { PROVIDERS } from './types.js';
import type { BillableCall, PriceRow } from './types.js';

/** `config/price-table.json` (SB-D10): versioned, changed by a reviewed PR, loaded into `price_table` by the release seed. */

const decimal = (digits: number, scale: number): z.ZodType<string> =>
  z
    .string()
    .regex(new RegExp(`^\\d{1,${String(digits - scale)}}(\\.\\d{1,${String(scale)}})?$`), 'must be a non-negative decimal');

const rowSchema = z
  .object({
    provider: z.enum(PROVIDERS),
    operation: z.string().min(1).max(64),
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    unit: z.string().min(1).max(32),
    unitPriceUsd: decimal(12, 6),
    unitsPerCall: decimal(10, 3),
  })
  .strict();

const fileSchema = z
  .object({
    version: z.literal(1),
    /** Where the figures come from; a reviewer replaces placeholders before a paid call is enabled. */
    note: z.string().optional(),
    rows: z.array(rowSchema).min(1),
  })
  .strict();

export class PriceTableInvalidError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`price table is invalid: ${issues.join('; ')}`);
    this.name = 'PriceTableInvalidError';
  }
}

const isRealDate = (text: string): boolean => {
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(text);
};

/** Parses and checks the file's content: shape, real dates, and no duplicate `(provider, operation, effectiveFrom)`. */
export function parsePriceTable(content: unknown): PriceRow[] {
  const parsed = fileSchema.safeParse(content);
  if (!parsed.success) {
    throw new PriceTableInvalidError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const row of parsed.data.rows) {
    if (!isRealDate(row.effectiveFrom)) issues.push(`${row.provider} ${row.operation}: effectiveFrom is not a date`);
    const key = `${row.provider}|${row.operation}|${row.effectiveFrom}`;
    if (seen.has(key)) issues.push(`${row.provider} ${row.operation} ${row.effectiveFrom}: duplicate row`);
    seen.add(key);
  }
  if (issues.length > 0) throw new PriceTableInvalidError(issues);
  return parsed.data.rows;
}

/** The row in force on `day` (`YYYY-MM-DD`, UTC) for a call: the latest `effectiveFrom` not after it. */
export function priceInForce(rows: readonly PriceRow[], call: BillableCall, day: string): PriceRow | undefined {
  let best: PriceRow | undefined;
  for (const row of rows) {
    if (row.provider !== call.provider || row.operation !== call.operation || row.effectiveFrom > day) continue;
    if (best === undefined || row.effectiveFrom > best.effectiveFrom) best = row;
  }
  return best;
}

/**
 * The validator: every billable call has a row effective on `day`. Returns the calls without one; empty means the
 * table prices them all. Used by the seed's pre-check and by the CI test over the file and the default configuration.
 */
export function missingPrices(
  rows: readonly PriceRow[],
  calls: readonly BillableCall[],
  day: string,
): BillableCall[] {
  return calls.filter((call) => priceInForce(rows, call, day) === undefined);
}
