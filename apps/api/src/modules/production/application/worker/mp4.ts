import { Readable } from 'node:stream';

/** Bytes needed to see an MP4's first box header: 4 size bytes, then the type. */
const HEADER_BYTES = 12;

export type Mp4Peek = { readonly ok: true; readonly stream: Readable } | { readonly ok: false };

/**
 * Type-checks a download before anything is stored (ARCHITECTURE §5.5): an MP4 starts with an `ftyp` box. Reads just
 * enough of `source` to see the box type, then returns a stream that yields those bytes first and the rest after, so
 * nothing is lost. A body that is not an MP4 is destroyed and refused.
 */
export async function peekMp4(source: Readable): Promise<Mp4Peek> {
  const iterator = source[Symbol.asyncIterator]();
  const head: Buffer[] = [];
  let length = 0;
  while (length < HEADER_BYTES) {
    const next = await iterator.next();
    if (next.done === true) break;
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
    head.push(chunk);
    length += chunk.length;
  }
  const first = Buffer.concat(head);
  if (first.length < HEADER_BYTES || first.toString('latin1', 4, 8) !== 'ftyp') {
    source.destroy();
    return { ok: false };
  }
  async function* whole(): AsyncGenerator<Buffer> {
    yield first;
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) return;
      yield Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
    }
  }
  return { ok: true, stream: Readable.from(whole(), { objectMode: false }) };
}
