import sharp, { type Metadata } from 'sharp';

// Foundation form of ImageSanitizePort (ARCHITECTURE §1.3, §5.4): header-only inspect with the
// dimension and pixel caps checked before any decode, and a re-encode that strips metadata.

export const LIMITS = { maxPixelDimension: 8000, maxPixels: 40_000_000 } as const;

export class MediaRejected extends Error {
  constructor(readonly reason: 'unsupported_type' | 'pixel_cap' | 'decode_failed') {
    super(reason);
  }
}

export interface Inspected {
  format: 'jpeg' | 'png' | 'webp' | 'gif';
  width: number;
  height: number;
}

const FORMATS = new Set(['jpeg', 'png', 'webp', 'gif']);

export async function inspect(input: Buffer): Promise<Inspected> {
  let meta: Metadata;
  try {
    // metadata() reads the header only (no pixel decode), so the caps below run before any decode;
    // limitInputPixels stays on every decoding call (reencode) as the second guard
    meta = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    throw new MediaRejected('decode_failed');
  }
  if (!meta.format || !FORMATS.has(meta.format) || !meta.width || !meta.height) {
    throw new MediaRejected('unsupported_type');
  }
  if (
    meta.width > LIMITS.maxPixelDimension ||
    meta.height > LIMITS.maxPixelDimension ||
    meta.width * meta.height > LIMITS.maxPixels
  ) {
    throw new MediaRejected('pixel_cap');
  }
  return { format: meta.format as Inspected['format'], width: meta.width, height: meta.height };
}

export async function reencode(input: Buffer, format: Inspected['format']): Promise<Buffer> {
  // default sharp output drops EXIF, XMP, IPTC and ICC; `rotate()` bakes the orientation in;
  // pages: 1 keeps the first frame of an animated GIF/WebP
  const pipeline = sharp(input, { limitInputPixels: LIMITS.maxPixels, pages: 1 }).rotate();
  try {
    switch (format) {
      case 'jpeg':
        return await pipeline.jpeg({ quality: 90 }).toBuffer();
      case 'webp':
        return await pipeline.webp({ quality: 90 }).toBuffer();
      default:
        return await pipeline.png().toBuffer();
    }
  } catch {
    throw new MediaRejected('decode_failed');
  }
}
