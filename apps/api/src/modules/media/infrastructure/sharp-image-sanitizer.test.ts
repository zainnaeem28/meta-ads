import { Readable } from 'node:stream';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ImageRejected } from '../worker/image-sanitize.port.js';
import { SharpImageSanitizer } from './sharp-image-sanitizer.js';

// TC-UPL-04 and the pixel and bomb cases of TC-UPL-11/12 on the real `sharp` (libvips); fixtures are built in memory.

const sanitizer = new SharpImageSanitizer({ maxDimension: 200, maxPixels: 10_000 });
const blank = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } });

async function gpsJpeg(): Promise<Buffer> {
  return blank(64, 48)
    .withExif({
      IFD0: { Copyright: 'secret-owner', Software: 'camera-app' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '0/1 7/1 0/1' },
    })
    .jpeg()
    .toBuffer();
}

const rejection = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof ImageRejected) return error.reason;
    throw error;
  }
  return 'accepted';
};

/** Rewrites the width and height in a PNG header (and its CRC) to forge a decompression bomb's claim. */
function forgePng(png: Buffer, width: number, height: number): Buffer {
  const copy = Buffer.from(png);
  copy.writeUInt32BE(width, 16);
  copy.writeUInt32BE(height, 20);
  let crc = 0xffffffff;
  for (const byte of copy.subarray(12, 29)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  copy.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
  return copy;
}

describe('ImageSanitizePort on sharp', () => {
  it('inspects the header of a stream: format and size', async () => {
    const png = await blank(30, 20).png().toBuffer();
    expect(await sanitizer.inspect(Readable.from([png]))).toEqual({ format: 'png', width: 30, height: 20 });
  });

  it('strips EXIF and GPS from a JPEG and keeps the picture', async () => {
    const source = await gpsJpeg();
    expect((await sharp(source).metadata()).exif).toBeDefined();
    expect(source.includes('GPS')).toBe(false); // binary tags: the marker below proves the block is there
    const out = await sanitizer.reencode(source, 'jpeg');
    const meta = await sharp(out).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(out.includes(Buffer.from('Exif'))).toBe(false);
    expect(out.includes(Buffer.from('secret-owner'))).toBe(false);
    expect([meta.width, meta.height, meta.format]).toEqual([64, 48, 'jpeg']);
  });

  it('applies the EXIF orientation before dropping it', async () => {
    const source = await blank(60, 20).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const meta = await sharp(await sanitizer.reencode(source, 'jpeg')).metadata();
    expect([meta.width, meta.height, meta.orientation]).toEqual([20, 60, undefined]);
  });

  it('keeps the first frame of an animated GIF only', async () => {
    const frames = await Promise.all([30, 90, 160].map((v) => sharp({ create: { width: 16, height: 16, channels: 3, background: { r: v, g: v, b: v } } }).png().toBuffer()));
    const animated = await sharp(frames, { join: { animated: true } }).gif({ delay: [100, 100, 100], loop: 0 }).toBuffer();
    expect((await sharp(animated, { pages: -1 }).metadata()).pages).toBe(3);
    const out = await sanitizer.reencode(animated, 'gif');
    const meta = await sharp(out, { pages: -1 }).metadata();
    expect([meta.format, meta.pages ?? 1, meta.width, meta.height]).toEqual(['gif', 1, 16, 16]);
  });

  it('re-encodes PNG and WebP too', async () => {
    for (const format of ['png', 'webp'] as const) {
      const source = await blank(20, 20)[format]().toBuffer();
      expect((await sharp(await sanitizer.reencode(source, format)).metadata()).format).toBe(format);
    }
  });

  it('rejects a header over the dimension cap and one over the pixel cap before any decode', async () => {
    const tall = await blank(10, 10).png().toBuffer();
    expect(await rejection(() => sanitizer.inspect(forgePng(tall, 201, 1)))).toBe('pixel_cap_exceeded');
    expect(await rejection(() => sanitizer.inspect(forgePng(tall, 150, 150)))).toBe('pixel_cap_exceeded');
    // A decompression bomb claims a huge picture in a few bytes: refused on the header alone.
    expect(await rejection(() => sanitizer.inspect(forgePng(tall, 60_000, 60_000)))).toBe('pixel_cap_exceeded');
    expect(await rejection(async () => sanitizer.inspect(await blank(100, 101).png().toBuffer()))).toBe('pixel_cap_exceeded');
    expect(await sanitizer.inspect(await blank(100, 100).png().toBuffer())).toMatchObject({ width: 100, height: 100 });
  });

  it('the decoder limit is a second guard: re-encoding a picture over the pixel limit is refused', async () => {
    const guard = new SharpImageSanitizer({ maxDimension: 200, maxPixels: 100 });
    expect(await rejection(async () => guard.reencode(await blank(20, 20).png().toBuffer(), 'png'))).toBe('decompression_bomb');
  });

  it('rejects a type that is not allowed and bytes that are not an image', async () => {
    expect(await rejection(async () => sanitizer.inspect(await blank(8, 8).tiff().toBuffer()))).toBe('type_not_allowed');
    expect(await rejection(() => sanitizer.inspect(Buffer.from('MZ not an image at all')))).toBe('decode_failed');
    expect(await rejection(() => sanitizer.reencode(Buffer.from('GIF89a garbage'), 'gif'))).toBe('decode_failed');
    const png = await blank(20, 20).png().toBuffer();
    expect(await rejection(() => sanitizer.reencode(png.subarray(0, 60), 'png'))).toBe('decode_failed');
  });

  it('refuses an input larger than the cap without reading the rest of the stream', async () => {
    const small = new SharpImageSanitizer({ maxDimension: 200, maxPixels: 10_000, maxInputBytes: 100 });
    const stream = Readable.from([Buffer.alloc(80), Buffer.alloc(80), Buffer.alloc(80)]);
    expect(await rejection(() => small.inspect(stream))).toBe('decode_failed');
    expect(await rejection(() => small.inspect(Buffer.alloc(101)))).toBe('decode_failed');
  });
});
