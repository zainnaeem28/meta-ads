import { describe, expect, it } from 'vitest';
import { CSV_HEADER, csvCell, csvRow } from './csv.js';
import { isFault, resolveWindow } from './window.js';

const now = new Date('2026-06-30T12:00:00Z');
const settings = { defaultDays: 30, maxDays: 366 };

describe('resolveWindow', () => {
  it('defaults to the last 30 days ending now', () => {
    expect(resolveWindow({}, now, settings)).toEqual({ from: new Date('2026-05-31T12:00:00Z'), to: now });
  });
  it('accepts exactly 366 days and refuses one millisecond more, naming the limit', () => {
    const to = new Date('2026-06-30T00:00:00Z');
    const ok = resolveWindow({ from: new Date(to.getTime() - 366 * 86_400_000), to }, now, settings);
    expect(isFault(ok)).toBe(false);
    const big = resolveWindow({ from: new Date(to.getTime() - 366 * 86_400_000 - 1), to }, now, settings);
    expect(big).toEqual({ kind: 'too_large', maxDays: 366 });
  });
  it('refuses a window that is empty or backwards', () => {
    expect(resolveWindow({ from: now, to: now }, now, settings)).toMatchObject({ kind: 'invalid' });
    expect(resolveWindow({ from: new Date('2026-07-01T00:00:00Z') }, now, settings)).toMatchObject({ kind: 'invalid' });
  });
});

describe('csv', () => {
  it('prefixes formula starters with a quote and quotes separators', () => {
    for (const lead of ['=', '+', '-', '@']) expect(csvCell(`${lead}1+1`)).toBe(`'${lead}1+1`);
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "x"')).toBe('"say ""x"""');
    expect(csvCell(null)).toBe('');
    expect(csvCell(12)).toBe('12');
  });
  it('writes the contract header', () => {
    expect(CSV_HEADER.split(',')).toHaveLength(10);
    expect(csvRow(['u', 'openai', 1, 1, 0, 0, 0, '0.0100', null, 5])).toBe('u,openai,1,1,0,0,0,0.0100,,5');
  });
});
