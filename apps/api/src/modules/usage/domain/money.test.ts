import { describe, expect, it } from 'vitest';
import { formatUsd, toDecimal, toUnits } from './money.js';

describe('money', () => {
  it('converts to exact ten-thousandths and back', () => {
    expect(toUnits('12.3400')).toBe(123_400);
    expect(toUnits(0.1 + 0.2)).toBe(3000);
    expect(toUnits('0.00005')).toBe(1);
    expect(toDecimal(123_400)).toBe('12.3400');
    expect(toDecimal(5)).toBe('0.0005');
    expect(toDecimal(-15_000)).toBe('-1.5000');
  });

  it('rejects a value that is not a number', () => {
    expect(() => toUnits('abc')).toThrow(RangeError);
  });

  it('formats dollars with two decimals unless more matter', () => {
    expect(formatUsd(500_000)).toBe('US$50.00');
    expect(formatUsd(10_000)).toBe('US$1.00');
    expect(formatUsd(2_500)).toBe('US$0.25');
    expect(formatUsd(125)).toBe('US$0.0125');
    expect(formatUsd(1_250)).toBe('US$0.125');
  });
});
