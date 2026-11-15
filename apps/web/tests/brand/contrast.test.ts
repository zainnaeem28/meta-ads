import { describe, expect, it } from 'vitest';
import { PALETTE } from '../../../../packages/ui/src/components/cmp-001/artwork';

const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

// Surfaces from packages/ui/src/tokens.css; figures are those measured in BRAND-BRIEF §3 and §4.
const BACKGROUND = '#FBF9F4';
const CARD = '#FFFFFF';
const MUTED = '#F5F1E6';
const INVERSE = '#161C23';

describe('wordmark contrast (the logo is exempt from WCAG 1.4.3; the name is also text)', () => {
  const [, , , lightWord, lightAccent] = PALETTE.light.fills;
  const [, , , darkWord, darkAccent] = PALETTE.dark.fills;

  it('light wordmark SHROO is above 4.5:1 on background, card and muted', () => {
    expect(ratio(lightWord, BACKGROUND)).toBeCloseTo(13.27, 1);
    for (const surface of [BACKGROUND, CARD, MUTED]) {
      expect(ratio(lightWord, surface)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(lightAccent, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('dark wordmark SHROO is above 4.5:1 on the inverse surface; MAP rust is the accepted 3.49:1', () => {
    expect(ratio(darkWord, INVERSE)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(darkAccent, INVERSE)).toBeCloseTo(3.49, 1);
  });

  it('dark rust MAP on navy #232D38 would be 2.84:1, the placement the brief forbids', () => {
    expect(ratio(darkAccent, '#232D38')).toBeCloseTo(2.84, 1);
  });
});
