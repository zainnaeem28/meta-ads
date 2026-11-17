import type { Readable } from 'node:stream';
import type SharpFactory from 'sharp';
import { IMAGE_FORMATS, ImageRejected } from '../worker/image-sanitize.port.js';
import type { ImageFormat, ImageInfo, ImageSanitizePort } from '../worker/image-sanitize.port.js';

export interface SharpSanitizerConfig {
  /** `MEDIA_MAX_PIXEL_DIMENSION`. */
  readonly maxDimension: number;
  /** `MEDIA_MAX_PIXELS`; also the decoder's own limit (the second guard). */
  readonly maxPixels: number;
  readonly timeoutSec?: number;
  /** The most a quarantine object may hold; the upload cap is 10 MiB. */
  readonly maxInputBytes?: number;
}

const DEFAULT_TIMEOUT_SEC = 30;
const DEFAULT_MAX_INPUT = 12 * 1024 * 1024;

type Sharp = typeof SharpFactory;
let loaded: Promise<Sharp> | undefined;

/** `sharp` (libvips) is loaded on first use, so a process that never sanitizes (the api) never loads it. */
async function sharpLib(): Promise<Sharp> {
  loaded ??= import('sharp').then((m) => m.default);
  return loaded;
}

async function collect(input: Readable | Buffer, max: number): Promise<Buffer> {
  if (Buffer.isBuffer(input)) {
    if (input.length > max) throw new ImageRejected('decode_failed');
    return input;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += piece.length;
    if (size > max) {
      input.destroy();
      throw new ImageRejected('decode_failed');
    }
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

function formatOf(name: string | undefined): ImageFormat {
  if (name === undefined || !(IMAGE_FORMATS as readonly string[]).includes(name)) {
    throw new ImageRejected('type_not_allowed');
  }
  return name as ImageFormat;
}

/** A timeout or an out-of-memory is the machine's fault, not the file's: it stays a plain error and the job retries. */
function isTransient(error: unknown): boolean {
  return error instanceof Error && /timeout|time out|cancel|memory/i.test(error.message);
}

/** ImageSanitizePort on `sharp` (ARCHITECTURE §1.3, §5.4). */
export class SharpImageSanitizer implements ImageSanitizePort {
  constructor(private readonly config: SharpSanitizerConfig) {}

  async inspect(input: Readable | Buffer): Promise<ImageInfo> {
    const sharp = await sharpLib();
    const data = await collect(input, this.config.maxInputBytes ?? DEFAULT_MAX_INPUT);
    let meta: Awaited<ReturnType<ReturnType<Sharp>['metadata']>>;
    try {
      // The header read must not apply the decoder's default pixel limit: a bomb's claim is answered below.
      meta = await sharp(data, { failOn: 'error', limitInputPixels: false }).metadata();
    } catch (error) {
      if (isTransient(error)) throw error;
      throw new ImageRejected('decode_failed');
    }
    const format = formatOf(meta.format);
    const width = meta.width;
    const height = meta.pageHeight ?? meta.height;
    if (width === undefined || height === undefined || width < 1 || height < 1)
      throw new ImageRejected('decode_failed');
    if (
      width > this.config.maxDimension ||
      height > this.config.maxDimension ||
      width * height > this.config.maxPixels
    ) {
      throw new ImageRejected('pixel_cap_exceeded');
    }
    return { format, width, height };
  }

  async reencode(input: Readable | Buffer, format: ImageFormat): Promise<Buffer> {
    const sharp = await sharpLib();
    const data = await collect(input, this.config.maxInputBytes ?? DEFAULT_MAX_INPUT);
    try {
      // No `withMetadata`/`keepMetadata`: EXIF, XMP, IPTC and the ICC profile are dropped. `rotate()` applies the EXIF
      // orientation first, so the picture still stands upright. `pages` defaults to 1: a GIF keeps its first frame.
      const pipeline = sharp(data, { limitInputPixels: this.config.maxPixels, failOn: 'error' })
        .rotate()
        .timeout({ seconds: this.config.timeoutSec ?? DEFAULT_TIMEOUT_SEC });
      const encoded =
        format === 'jpeg'
          ? pipeline.jpeg({ quality: 88 })
          : format === 'png'
            ? pipeline.png()
            : format === 'webp'
              ? pipeline.webp({ quality: 88 })
              : pipeline.gif();
      return await encoded.toBuffer();
    } catch (error) {
      if (error instanceof ImageRejected || isTransient(error)) throw error;
      const message = error instanceof Error ? error.message : '';
      throw new ImageRejected(
        /pixel limit/i.test(message) ? 'decompression_bomb' : 'decode_failed',
      );
    }
  }
}
