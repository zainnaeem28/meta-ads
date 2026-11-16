import { Readable } from 'node:stream';

/** Bytes needed to tell the four allowed formats apart (the WebP signature ends at offset 12). */
export const SNIFF_BYTES = 12;

const startsWith = (head: Buffer, bytes: readonly number[], offset = 0): boolean =>
  head.length >= offset + bytes.length && bytes.every((byte, index) => head[offset + index] === byte);

/** The type found from the first bytes, never from the client's claim; null for everything else (SVG, PDF, executables). */
export function sniffImageType(head: Buffer): string | null {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(head, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return 'image/gif';
  }
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  return null;
}

export class UploadTooLarge extends Error {
  constructor() {
    super('upload exceeds the size cap');
    this.name = 'UploadTooLarge';
  }
}

/**
 * Reads only the first `SNIFF_BYTES` of the stream and returns them with a stream that replays them and then the rest,
 * counting bytes and failing with `UploadTooLarge` the moment the count passes `maxBytes`. Nothing else is buffered:
 * the pull is driven by the consumer, so memory stays at one chunk plus the sniffed head.
 */
export async function peek(
  source: Readable,
  maxBytes: number,
): Promise<{ head: Buffer; body: Readable; counted(): number }> {
  const iterator = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let first = Buffer.alloc(0);
  let ended = false;
  while (first.length < SNIFF_BYTES && !ended) {
    const next = await iterator.next();
    if (next.done === true) ended = true;
    else first = Buffer.concat([first, next.value]);
  }
  let seen = 0;
  async function* replay(): AsyncGenerator<Buffer> {
    if (first.length > 0) {
      seen += first.length;
      if (seen > maxBytes) throw new UploadTooLarge();
      yield first;
    }
    while (!ended) {
      const next = await iterator.next();
      if (next.done === true) return;
      seen += next.value.length;
      if (seen > maxBytes) throw new UploadTooLarge();
      yield next.value;
    }
  }
  return { head: first.subarray(0, SNIFF_BYTES), body: Readable.from(replay(), { objectMode: false }), counted: () => seen };
}
