import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configuredOperations } from './operations.js';
import { PriceTableInvalidError, missingPrices, parsePriceTable, priceInForce } from './price-table.js';

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  provider: 'openai',
  operation: 'm1',
  effectiveFrom: '2026-01-01',
  unit: 'call',
  unitPriceUsd: '0.010000',
  unitsPerCall: '1',
  ...over,
});
const file = (rows: unknown[]): unknown => ({ version: 1, rows });

describe('parsePriceTable', () => {
  it('accepts a valid file', () => {
    expect(parsePriceTable(file([row()]))).toHaveLength(1);
  });

  it.each([
    ['an unknown provider', file([row({ provider: 'acme' })])],
    ['a negative price', file([row({ unitPriceUsd: '-1' })])],
    ['too many decimals', file([row({ unitPriceUsd: '0.0000001' })])],
    ['an unknown field', file([row({ extra: 1 })])],
    ['an impossible date', file([row({ effectiveFrom: '2026-02-30' })])],
    ['a duplicate row', file([row(), row()])],
    ['no rows', file([])],
    ['another version', { version: 2, rows: [row()] }],
    ['a non-object', 'x'],
  ])('refuses %s', (_name, content) => {
    expect(() => parsePriceTable(content)).toThrow(PriceTableInvalidError);
  });
});

describe('price lookup and validator', () => {
  const rows = parsePriceTable(
    file([row(), row({ effectiveFrom: '2026-06-01', unitPriceUsd: '0.020000' }), row({ operation: 'later', effectiveFrom: '2027-01-01' })]),
  );

  it('uses the latest row not after the day', () => {
    const call = { provider: 'openai', operation: 'm1' } as const;
    expect(priceInForce(rows, call, '2026-05-31')?.unitPriceUsd).toBe('0.010000');
    expect(priceInForce(rows, call, '2026-06-01')?.unitPriceUsd).toBe('0.020000');
    expect(priceInForce(rows, call, '2025-12-31')).toBeUndefined();
  });

  it('reports every call without a row in force', () => {
    const calls = [
      { provider: 'openai', operation: 'm1' },
      { provider: 'openai', operation: 'later' },
      { provider: 'wavespeed', operation: 'm1' },
    ] as const;
    expect(missingPrices(rows, calls, '2026-07-01')).toEqual([calls[1], calls[2]]);
  });
});

describe('config/price-table.json', () => {
  const path = join(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'config', 'price-table.json');
  const rows = parsePriceTable(JSON.parse(readFileSync(path, 'utf8')));
  const today = new Date().toISOString().slice(0, 10);

  it('prices every billable call of the default and the local stub configuration, thumbstopper image included', () => {
    const calls = configuredOperations(
      {
        OPENAI_TEXT_MODEL: 'local-stub-text',
        OPENAI_VISION_MODEL: 'local-stub-vision',
        OPENAI_IMAGE_MODEL: 'local-stub-image',
        ASSEMBLY_ADAPTER: 'shotstack',
      },
      true,
    );
    expect(calls.map((c) => c.operation)).toContain('local-stub-image');
    expect(missingPrices(rows, calls, today)).toEqual([]);
  });

  it('fails the validator when a row is removed', () => {
    const without = rows.filter((r) => r.operation !== 'local-stub-image');
    const calls = configuredOperations({ OPENAI_IMAGE_MODEL: 'local-stub-image' });
    expect(missingPrices(without, calls, today)).toEqual(calls);
  });
});
