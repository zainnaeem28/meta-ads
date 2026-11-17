import type { Readable } from 'node:stream';

// ImageSanitizePort (ARCHITECTURE §1.3): the one place an uploaded image is decoded. The `sharp` adapter lives in
// `infrastructure/` and is loaded by the worker only; nothing on the request path touches it.

export const IMAGE_SANITIZE_PORT = Symbol('IMAGE_SANITIZE_PORT');

export const IMAGE_FORMATS = ['jpeg', 'png', 'webp', 'gif'] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

export const IMAGE_CONTENT_TYPES: Readonly<Record<ImageFormat, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** The reasons `media_objects.reject_reason` allows. */
export type RejectReason =
  'type_not_allowed' | 'pixel_cap_exceeded' | 'decompression_bomb' | 'decode_failed';

/** The file itself is unacceptable: the row becomes `rejected` and the job is never retried. */
export class ImageRejected extends Error {
  constructor(readonly reason: RejectReason) {
    super(`image rejected: ${reason}`);
    this.name = 'ImageRejected';
  }
}

export interface ImageInfo {
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
}

export interface ImageSanitizePort {
  /** Reads the header only. Throws `ImageRejected` before any decode when the type or the size is not allowed. */
  inspect(input: Readable | Buffer): Promise<ImageInfo>;
  /** Decodes and encodes again: every piece of metadata is dropped, a GIF keeps its first frame only. */
  reencode(input: Readable | Buffer, format: ImageFormat): Promise<Buffer>;
}
