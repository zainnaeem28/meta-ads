import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ICON_NAMES, Icon, type IconSize } from './index';

const dir = fileURLToPath(new URL('../../../../design/mockups/assets/icons/', import.meta.url));
const designNames = readdirSync(dir)
  .filter((f) => f.endsWith('.svg'))
  .map((f) => f.replace(/\.svg$/, ''))
  .sort();

describe('CMP-002 icon set', () => {
  it('covers exactly the icons of the design list', () => {
    expect([...ICON_NAMES].sort()).toEqual(designNames);
  });

  it.each(designNames)('%s renders the design geometry at 16, 20 and 24 px', (name) => {
    const source = readFileSync(`${dir}${name}.svg`, 'utf8');
    const shapes = [
      ...source.matchAll(/<(path|circle|rect|line|polyline|polygon|ellipse)\b[^>]*>/g),
    ];
    for (const size of [16, 20, 24] as IconSize[]) {
      const html = renderToStaticMarkup(<Icon name={name as never} size={size} />);
      expect(html).toContain(`width="${size}"`);
      expect(html).toContain(`height="${size}"`);
      expect(html).toContain('viewBox="0 0 24 24"');
      expect(html).toContain('stroke="currentColor"');
      expect(html).toContain('stroke-width="2"');
      for (const [shape] of shapes) {
        const d = /\b(?:d|points)="([^"]+)"/.exec(shape)?.[1];
        const attr = d ?? /\b(?:cx|x1|x)="([^"]+)"/.exec(shape)?.[1];
        expect(html).toContain(attr);
      }
    }
  });

  it('is decorative by default and named when labelled', () => {
    expect(renderToStaticMarkup(<Icon name="check" />)).toContain('aria-hidden="true"');
    const named = renderToStaticMarkup(<Icon name="check" label="Done" />);
    expect(named).toContain('aria-label="Done"');
    expect(named).toContain('role="img"');
    expect(named).not.toContain('aria-hidden');
  });
});
