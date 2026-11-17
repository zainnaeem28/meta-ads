import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { peekMp4 } from './mp4.js';

const mp4 = (extra: number): Buffer => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12 + extra, 9)]);
const read = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

describe('peekMp4', () => {
  it('accepts an ftyp box and returns every byte, however the body is chunked', async () => {
    const whole = mp4(5000);
    for (const size of [1, 3, 11, 12, 13, 4096, whole.length]) {
      const pieces: Buffer[] = [];
      for (let at = 0; at < whole.length; at += size) pieces.push(whole.subarray(at, at + size));
      const peek = await peekMp4(Readable.from(pieces));
      expect(peek.ok).toBe(true);
      if (peek.ok) expect((await read(peek.stream)).equals(whole)).toBe(true);
    }
  });

  it('refuses a body that is not an MP4 and a body shorter than a box header', async () => {
    expect((await peekMp4(Readable.from([Buffer.from('<html><body>not a video</body></html>')]))).ok).toBe(false);
    expect((await peekMp4(Readable.from([Buffer.from('short')]))).ok).toBe(false);
    expect((await peekMp4(Readable.from([]))).ok).toBe(false);
  });

  it('destroys the source it refuses', async () => {
    const source = Readable.from([Buffer.from('x'.repeat(100))]);
    await peekMp4(source);
    expect(source.destroyed).toBe(true);
  });
});
