import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SeedStep } from '../../../database/index.js';
import { parsePriceTable } from '../domain/price-table.js';
import type { PriceRow } from '../domain/types.js';
import { DrizzleUsageRepository } from './usage.repository.js';

/** `config/price-table.json` at the repository root (SB-D10); `PRICE_TABLE_FILE` points the seed at another file. */
export const DEFAULT_PRICE_TABLE_FILE = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'config',
  'price-table.json',
);

/** Reads and validates the file; throws `PriceTableInvalidError` naming the faulty rows, never a partial table. */
export function loadPriceTableFile(path: string = DEFAULT_PRICE_TABLE_FILE): PriceRow[] {
  return parsePriceTable(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

/**
 * The release seed's step (ARCHITECTURE §2.2 seed table): upserts the file's rows by natural key, so a rerun changes
 * nothing. Rows removed from the file stay in the table: history of past prices.
 */
export function priceTableSeedStep(path?: string): SeedStep {
  const repository = new DrizzleUsageRepository();
  return {
    name: 'price_table',
    datasets: ['reference', 'development', 'staging'],
    run: (tx) =>
      repository.upsertPrices(
        tx,
        loadPriceTableFile(path ?? process.env['PRICE_TABLE_FILE'] ?? DEFAULT_PRICE_TABLE_FILE),
      ),
  };
}
