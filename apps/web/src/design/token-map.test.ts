import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { colourMappings, declarations } from './token-map.js';

const ui = (path: string) =>
  fileURLToPath(new URL(`../../../../packages/ui/${path}`, import.meta.url));
const tokensCss = readFileSync(ui('src/tokens.css'), 'utf8');
const themeCss = readFileSync(ui('src/theme.css'), 'utf8');
const tokens = declarations(tokensCss);

describe('design tokens (TASK-066)', () => {
  it('tokens.css is a verbatim copy of the design package tokens', () => {
    const design = fileURLToPath(new URL('../../../../design/mockups/tokens.css', import.meta.url));
    expect(readFileSync(design, 'utf8')).toBe(tokensCss);
  });

  it('maps every colour to an existing token and every semantic colour token is mapped', () => {
    const mapped = colourMappings(themeCss);
    expect(mapped.length).toBeGreaterThan(40);
    for (const [, source] of mapped) expect(tokens.has(source), source).toBe(true);
    const mappedSources = new Set(mapped.map(([, source]) => source));
    const colourTokens = [...tokens].filter(
      ([name, value]) => !name.startsWith('--brand-') && /^(#|rgb\()/.test(value),
    );
    for (const [name] of colourTokens) expect(mappedSources.has(name), name).toBe(true);
  });

  it('keeps raw colour values out of the theme mapping', () => {
    expect(themeCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(themeCss).not.toMatch(/\b(rgb|hsl|oklch)a?\(/);
  });

  it('reads declarations and tolerates an empty stylesheet', () => {
    expect(declarations('  ').size).toBe(0);
    expect(declarations(':root { --a: 1; }').get('--a')).toBe('1');
  });

  it('carries the portal override for administration', () => {
    expect(tokensCss).toContain('[data-portal="admin"]');
  });

  it('self-hosts Inter latin and latin-ext with optional (no late swap) and a licence file', () => {
    expect(themeCss.match(/font-display:\s*optional/g)).toHaveLength(2);
    expect(themeCss).not.toMatch(/url\(\s*["']?https?:/);
    for (const file of ['inter-latin-wght-normal.woff2', 'inter-latin-ext-wght-normal.woff2']) {
      expect(statSync(ui(`src/fonts/${file}`)).size).toBeGreaterThan(10_000);
      expect(themeCss).toContain(file);
    }
    expect(existsSync(ui('src/fonts/INTER-LICENSE-OFL-1.1.txt'))).toBe(true);
  });
});
