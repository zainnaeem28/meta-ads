/**
 * Amounts are US dollars with at most four decimals (`numeric(12,4)`), so every amount is exactly an integer count of
 * 1/10000 dollar. Sums and comparisons run on those integers, never on floating-point dollars.
 */

const SCALE = 10_000;

export type Units = number;

/** `"12.3400"` or `12.34` to integer ten-thousandths. Rounds half up at the fourth decimal. */
export function toUnits(amount: string | number): Units {
  const value = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(value)) throw new RangeError('amount is not a finite number');
  return Math.round(value * SCALE);
}

/** Integer ten-thousandths to the `numeric(12,4)` text the database takes. */
export function toDecimal(units: Units): string {
  const sign = units < 0 ? '-' : '';
  const abs = Math.abs(units);
  const whole = Math.floor(abs / SCALE);
  const fraction = String(abs % SCALE).padStart(4, '0');
  return `${sign}${String(whole)}.${fraction}`;
}

/** `US$50.00` for messages (two decimals, a third and fourth only when they matter). */
export function formatUsd(units: Units): string {
  const text = toDecimal(units);
  return `US$${text.replace(/(\.\d\d)00$/, '$1').replace(/(\.\d\d\d)0$/, '$1')}`;
}
