// Builds the ShrooMap brand SVGs and icon files from geometry.json (traced and refit from the owner PNGs in source/).
// Run from design/brand: NODE_PATH=<tools>/node_modules node build-brand-assets.mjs
// Needs: sharp, png-to-ico. The social preview is rendered by design/mockups/render-frames.mjs (it needs the Inter font).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const pngToIcoMod = require('png-to-ico');
const pngToIco = pngToIcoMod.default ?? pngToIcoMod;
const g = JSON.parse(readFileSync('geometry.json', 'utf8'));

export const colours = {
  light: { ring: '#B9C5B7', cap: '#5C8658', stemLine: '#B29C83', stemFill: '#D5BFA8', a: '#232D38', b: '#6A503C' },
  dark: { ring: '#5E7956', cap: '#5A8357', stemLine: '#B89B7C', stemFill: '#D3B698', a: '#F5F1E6', b: '#9E6240' },
  monoInk: { ring: '#232D38', cap: '#232D38', stemLine: '#232D38', stemFill: '#232D38', a: '#232D38', b: '#232D38' },
  monoCream: { ring: '#F5F1E6', cap: '#F5F1E6', stemLine: '#F5F1E6', stemFill: '#F5F1E6', a: '#F5F1E6', b: '#F5F1E6' },
};
const disc = '#EFF3EB'; // sampled from shroomap-icon.png

const ring = (c) => `<circle cx="${g.ring.cx}" cy="${g.ring.cy}" r="${g.ring.r}" fill="none" stroke="${c.ring}" stroke-width="${g.ring.stroke}"/>`;
const mushroom = (c) =>
  `<path fill="${c.cap}" fill-rule="evenodd" d="${g.cap}"/><path fill="${c.stemLine}" d="${g.stemOuter}"/><path fill="${c.stemFill}" d="${g.stemInner}"/>`;
const word = (c) => `<g transform="translate(${g.wordmarkShift.join(' ')})"><path fill="${c.a}" fill-rule="evenodd" d="${g.wordmarkA}"/><path fill="${c.b}" fill-rule="evenodd" d="${g.wordmarkB}"/></g>`;
const svg = (vb, body, title, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" role="img" aria-label="${title}"${extra}><title>${title}</title>${body}</svg>\n`;

const MARK_VB = '55 47.375 188 188';
const LOCKUP_VB = '55 47.375 895 188';
const WORD_VB = '304 90 646 100'; // wordmark in mark frame: x 305.4..950, y 101..181.5

const out = {};
out['shroomap-mark.svg'] = svg(MARK_VB, ring(colours.light) + mushroom(colours.light), 'ShrooMap');
out['shroomap-mark-on-dark.svg'] = svg(MARK_VB, ring(colours.dark) + mushroom(colours.dark), 'ShrooMap');
out['shroomap-mark-mono-ink.svg'] = svg(MARK_VB, ring(colours.monoInk) + mushroom(colours.monoInk), 'ShrooMap');
out['shroomap-mark-mono-cream.svg'] = svg(MARK_VB, ring(colours.monoCream) + mushroom(colours.monoCream), 'ShrooMap');
out['shroomap-logo-light.svg'] = svg(LOCKUP_VB, ring(colours.light) + mushroom(colours.light) + word(colours.light), 'ShrooMap');
out['shroomap-logo-dark.svg'] = svg(LOCKUP_VB, ring(colours.dark) + mushroom(colours.dark) + word(colours.dark), 'ShrooMap');
out['shroomap-logo-mono-ink.svg'] = svg(LOCKUP_VB, ring(colours.monoInk) + mushroom(colours.monoInk) + word(colours.monoInk), 'ShrooMap');
out['shroomap-logo-mono-cream.svg'] = svg(LOCKUP_VB, ring(colours.monoCream) + mushroom(colours.monoCream) + word(colours.monoCream), 'ShrooMap');
out['shroomap-wordmark-light.svg'] = svg(WORD_VB, word(colours.light), 'ShrooMap');
out['shroomap-wordmark-dark.svg'] = svg(WORD_VB, word(colours.dark), 'ShrooMap');
mkdirSync('svg', { recursive: true });
for (const [name, body] of Object.entries(out)) writeFileSync(`svg/${name}`, body);

// Small-size cut: no ring, mushroom enlarged on the light disc. The mushroom bbox centre is (149.4, 158.4) in mark units.
const MC = { x: 149.4, y: 158.4 };
const cut = (size, k, bg) => {
  const s = size;
  const inner = `<g transform="translate(${s / 2} ${s / 2}) scale(${k}) translate(${-MC.x} ${-MC.y})">${mushroom(colours.light)}</g>`;
  return { s, inner, bg };
};
// favicon (any size 16..48): disc on transparent. viewBox 64.
const fav = `<circle cx="32" cy="32" r="32" fill="${disc}"/><g transform="translate(32 33.5) scale(0.43) translate(${-MC.x} ${-MC.y})">${mushroom(colours.light)}</g>`;
writeFileSync('icons/favicon.svg', svg('0 0 64 64', fav, 'ShrooMap', ''));
// full-mark app icon on transparent (manifest "any" icons): ring + disc fill, from the owner icon.
const anyIcon = `<circle cx="${g.ring.cx}" cy="${g.ring.cy}" r="${g.ring.r + g.ring.stroke / 2}" fill="${disc}"/>` + ring(colours.light) + mushroom(colours.light);
writeFileSync('svg/shroomap-icon.svg', svg(MARK_VB, anyIcon, 'ShrooMap'));
// maskable: full-bleed square, mushroom inside the 80% safe circle (radius 0.4 of the side).
const mask = (side, k) => `<rect width="${side}" height="${side}" fill="${disc}"/><g transform="translate(${side / 2} ${side / 2 + side * 0.012}) scale(${k}) translate(${-MC.x} ${-MC.y})">${mushroom(colours.light)}</g>`;
writeFileSync('svg/shroomap-icon-maskable.svg', svg('0 0 512 512', mask(512, 2.45), 'ShrooMap'));
writeFileSync('svg/shroomap-apple-touch.svg', svg('0 0 180 180', mask(180, 0.9), 'ShrooMap'));

mkdirSync('icons', { recursive: true });
const png = async (file, size, svgFile) => sharp(readFileSync(svgFile), { density: 288 }).resize(size, size).png({ compressionLevel: 9 }).toFile(file);
for (const s of [16, 32, 48]) await png(`icons/favicon-${s}.png`, s, 'icons/favicon.svg');
await png('icons/apple-touch-icon.png', 180, 'svg/shroomap-apple-touch.svg');
await png('icons/icon-192.png', 192, 'svg/shroomap-icon.svg');
await png('icons/icon-512.png', 512, 'svg/shroomap-icon.svg');
await png('icons/icon-maskable-512.png', 512, 'svg/shroomap-icon-maskable.svg');
writeFileSync('icons/favicon.ico', await pngToIco(['icons/favicon-16.png', 'icons/favicon-32.png', 'icons/favicon-48.png']));
writeFileSync(
  'icons/site.webmanifest',
  JSON.stringify(
    {
      name: 'ShrooMap AI UGC Ad Director',
      short_name: 'ShrooMap',
      start_url: '/',
      display: 'standalone',
      background_color: '#FBF9F4',
      theme_color: '#4A6F47',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    null,
    2,
  ) + '\n',
);
console.log('brand assets written');
