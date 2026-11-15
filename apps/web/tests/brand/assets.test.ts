import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pub = (name: string) => fileURLToPath(new URL(`../../public/${name}`, import.meta.url));
const png = (name: string) => {
  const buf = readFileSync(pub(name));
  expect(buf.subarray(0, 8).toString('hex'), `${name} PNG signature`).toBe('89504e470d0a1a0a');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
const manifest = JSON.parse(readFileSync(pub('site.webmanifest'), 'utf8')) as {
  name: string;
  short_name: string;
  theme_color: string;
  background_color: string;
  display: string;
  start_url: string;
  icons: Icon[];
};

describe('favicon and app icons', () => {
  it.each([
    ['favicon-16.png', 16],
    ['favicon-32.png', 32],
    ['favicon-48.png', 48],
    ['apple-touch-icon.png', 180],
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['icon-maskable-512.png', 512],
  ])('%s is a square PNG of %i px', (name, size) => {
    expect(png(name)).toEqual({ width: size, height: size });
  });

  it('favicon.ico holds 16, 32 and 48 px images', () => {
    const ico = readFileSync(pub('favicon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, i) => {
      const entry = 6 + i * 16;
      const w = ico.readUInt8(entry) || 256;
      const h = ico.readUInt8(entry + 1) || 256;
      const bytes = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      expect(offset + bytes, `entry ${i} lies inside the file`).toBeLessThanOrEqual(ico.length);
      return `${w}x${h}`;
    });
    expect(sizes.sort()).toEqual(['16x16', '32x32', '48x48']);
  });

  it('favicon.svg is an SVG with a square viewBox', () => {
    const svg = readFileSync(pub('favicon.svg'), 'utf8');
    expect(svg).toMatch(/^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    const box = /viewBox="(\S+) (\S+) (\S+) (\S+)"/.exec(svg);
    expect(box?.[3]).toBe(box?.[4]);
  });

  it('social-preview.png is 1200 x 630', () => {
    expect(png('social-preview.png')).toEqual({ width: 1200, height: 630 });
  });
});

describe('site.webmanifest', () => {
  it('names the product and sets the brand colours', () => {
    expect(manifest.name).toBe('ShrooMap AI UGC Ad Director');
    expect(manifest.short_name).toBe('ShrooMap');
    expect(manifest.theme_color).toBe('#4A6F47');
    expect(manifest.background_color).toBe('#FBF9F4');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
  });

  it('declares 192, 512 and the maskable 512, each existing at its declared size and type', () => {
    expect(manifest.icons.map((i) => `${i.sizes}:${i.purpose}`).sort()).toEqual([
      '192x192:any',
      '512x512:any',
      '512x512:maskable',
    ]);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      expect(existsSync(pub(icon.src.replace(/^\//, ''))), icon.src).toBe(true);
      const size = Number(icon.sizes.split('x')[0]);
      expect(png(icon.src.replace(/^\//, ''))).toEqual({ width: size, height: size });
    }
  });
});
