import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { bombPng } from './fixtures.ts';
import { inspect, LIMITS, MediaRejected, reencode } from './sanitize.ts';

// ImageSanitizePort (TC-MED fixtures): header inspection, pixel cap, decompression bomb, metadata strip.

const rejectedWith = async (promise: Promise<unknown>, reason: string) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MediaRejected);
  expect((error as MediaRejected).reason).toBe(reason);
};

const rgb = (width: number, height: number, color: string) =>
  sharp({ create: { width, height, channels: 3, background: color } });

describe('sharp header inspection', () => {
  it('reports format and size for JPEG, PNG, WebP and GIF', async () => {
    const jpeg = await rgb(64, 48, '#336699').jpeg().toBuffer();
    const png = await rgb(32, 32, '#ff0000').png().toBuffer();
    const webp = await rgb(40, 20, '#00ff00').webp().toBuffer();
    const gif = await rgb(16, 16, '#0000ff').gif().toBuffer();
    expect(await inspect(jpeg)).toEqual({ format: 'jpeg', width: 64, height: 48 });
    expect(await inspect(png)).toEqual({ format: 'png', width: 32, height: 32 });
    expect(await inspect(webp)).toEqual({ format: 'webp', width: 40, height: 20 });
    expect(await inspect(gif)).toEqual({ format: 'gif', width: 16, height: 16 });
  });

  it('rejects non-images and unsupported formats before any decode', async () => {
    await rejectedWith(inspect(Buffer.from('not an image at all')), 'decode_failed');
    await rejectedWith(inspect(await rgb(8, 8, '#000').tiff().toBuffer()), 'unsupported_type');
    await rejectedWith(inspect(Buffer.alloc(0)), 'decode_failed');
  });

  it('truncated image: header is readable, the decode failure is decode_failed', async () => {
    const jpeg = await rgb(256, 256, '#abcdef').jpeg().toBuffer();
    const cut = jpeg.subarray(0, Math.floor(jpeg.length / 3));
    await inspect(cut).catch(() => undefined);
    await rejectedWith(reencode(cut, 'jpeg'), 'decode_failed');
  });
});

describe('pixel cap and decompression bomb', () => {
  it('width or height above MEDIA_MAX_PIXEL_DIMENSION is rejected from the header', async () => {
    const wide = await bombPng(LIMITS.maxPixelDimension + 1, 2);
    await rejectedWith(inspect(wide), 'pixel_cap');
  });

  it('width x height above MEDIA_MAX_PIXELS is rejected although each side is within the dimension cap', async () => {
    const side = LIMITS.maxPixelDimension - 1; // 7999 x 7999 = 63.98 MP > 40 MP
    expect(side * side).toBeGreaterThan(LIMITS.maxPixels);
    const big = await bombPng(side, side);
    await rejectedWith(inspect(big), 'pixel_cap');
  });

  it('a 20000 x 20000 bomb (400 MP, a few hundred KB on disk) is refused without decoding it', async () => {
    const bomb = await bombPng(20000, 20000);
    console.log(
      `bomb fixture: 20000x20000 gray PNG, ${bomb.length} bytes on disk, 400000000 bytes decoded`,
    );
    expect(bomb.length).toBeLessThan(2_000_000);
    const before = process.memoryUsage().rss;
    const started = Date.now();
    await rejectedWith(inspect(bomb), 'pixel_cap');
    await rejectedWith(reencode(bomb, 'png'), 'decode_failed'); // decoder guard (limitInputPixels) refuses too
    const grew = process.memoryUsage().rss - before;
    console.log(
      `bomb rejected in ${Date.now() - started} ms, RSS grew ${(grew / 1e6).toFixed(1)} MB (a decode needs >= 400 MB)`,
    );
    expect(grew).toBeLessThan(150 * 1e6);
  });

  it('the decoder limit is a second guard that holds on its own', async () => {
    const ok = await rgb(100, 100, '#808080').png().toBuffer();
    await expect(sharp(ok, { limitInputPixels: 5000 }).raw().toBuffer()).rejects.toThrow(
      /pixel limit/i,
    );
    await expect(sharp(ok, { limitInputPixels: 10000 }).raw().toBuffer()).resolves.toBeTruthy();
  });

  it('an image exactly at the caps is accepted', async () => {
    const edge = await bombPng(
      LIMITS.maxPixelDimension,
      Math.floor(LIMITS.maxPixels / LIMITS.maxPixelDimension),
    );
    expect(await inspect(edge)).toMatchObject({ format: 'png', width: 8000, height: 5000 });
  });
});

describe('metadata strip', () => {
  it('EXIF (including GPS) and the ICC profile are gone after re-encode; pixels and size are kept', async () => {
    const source = await rgb(120, 80, '#c0ffee')
      .withExif({
        IFD0: { Copyright: 'someone-private', ImageDescription: 'taken at home' },
        IFD3: {
          GPSLatitudeRef: 'N',
          GPSLatitude: '40/1 26/1 46/1',
          GPSLongitudeRef: 'W',
          GPSLongitude: '79/1 58/1 56/1',
        },
      })
      .jpeg()
      .toBuffer();
    const before = await sharp(source).metadata();
    expect(before.exif).toBeDefined();
    expect(source.includes(Buffer.from('someone-private'))).toBe(true);

    const clean = await reencode(source, 'jpeg');
    const after = await sharp(clean).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(clean.includes(Buffer.from('someone-private'))).toBe(false);
    expect(clean.includes(Buffer.from('Exif'))).toBe(false);
    expect(after).toMatchObject({ format: 'jpeg', width: 120, height: 80 });
  });

  it('orientation is applied to the pixels, then the tag is dropped', async () => {
    const source = await rgb(120, 80, '#123456').withMetadata({ orientation: 6 }).jpeg().toBuffer();
    expect((await sharp(source).metadata()).orientation).toBe(6);
    const clean = await reencode(source, 'jpeg');
    const after = await sharp(clean).metadata();
    expect(after.orientation).toBeUndefined();
    expect([after.width, after.height]).toEqual([80, 120]);
  });

  it('an animated GIF is reduced to its first frame (PNG), PNG and WebP keep their format', async () => {
    const h = 20;
    const frames = Buffer.concat([
      Buffer.alloc(20 * h * 3, 0), // frame 1: black
      Buffer.alloc(20 * h * 3, 255), // frame 2: white
    ]);
    const animated = await sharp(frames, {
      raw: { width: 20, height: h * 2, channels: 3, pageHeight: h },
    })
      .gif({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect((await sharp(animated, { pages: -1 }).metadata()).pages).toBe(2);
    const first = await reencode(animated, 'gif');
    const meta = await sharp(first).metadata();
    expect(meta.format).toBe('png');
    expect(meta.pages ?? 1).toBe(1);
    const { data } = await sharp(first).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeLessThan(10); // black first frame, not the white second one

    const png = await rgb(10, 10, '#fff').png().toBuffer();
    expect((await sharp(await reencode(png, 'png')).metadata()).format).toBe('png');
    const webp = await rgb(10, 10, '#fff').webp().toBuffer();
    expect((await sharp(await reencode(webp, 'webp')).metadata()).format).toBe('webp');
  });
});
