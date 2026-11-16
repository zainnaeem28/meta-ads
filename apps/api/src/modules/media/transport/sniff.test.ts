import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { SNIFF_BYTES, UploadTooLarge, peek, sniffImageType } from './sniff.js';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]);

describe('sniffImageType', () => {
  it('names the four allowed formats by their first bytes', () => {
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from([...PNG, 0, 0, 0, 0]))).toBe('image/png');
    expect(sniffImageType(Buffer.from('GIF87a......'))).toBe('image/gif');
    expect(sniffImageType(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImageType(webp)).toBe('image/webp');
  });

  it('refuses SVG, PDF, executables, a bare RIFF, short and empty input', () => {
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(Buffer.from('<?xml version="1.0"?><svg/>'))).toBeNull();
    expect(sniffImageType(Buffer.from('%PDF-1.7 ......'))).toBeNull();
    expect(sniffImageType(Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00'))).toBeNull();
    expect(sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]))).toBeNull();
    expect(sniffImageType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('peek', () => {
  it('collects the head across small chunks and replays every byte once', async () => {
    const data = Buffer.concat([Buffer.from(PNG), Buffer.alloc(100, 1)]);
    const source = Readable.from([data.subarray(0, 3), data.subarray(3, 5), data.subarray(5, 40), data.subarray(40)]);
    const { head, body, counted } = await peek(source, 1000);
    expect(head).toHaveLength(SNIFF_BYTES);
    expect(sniffImageType(head)).toBe('image/png');
    expect(await drain(body)).toEqual(data);
    expect(counted()).toBe(data.length);
  });

  it('handles a body shorter than the head and an empty body', async () => {
    const short = await peek(Readable.from([Buffer.from('abc')]), 10);
    expect(short.head.toString()).toBe('abc');
    expect((await drain(short.body)).toString()).toBe('abc');
    const empty = await peek(Readable.from([]), 10);
    expect(empty.head).toHaveLength(0);
    expect(await drain(empty.body)).toHaveLength(0);
  });

  it('fails with UploadTooLarge when the head or the rest passes the cap, and never reads further', async () => {
    const tiny = await peek(Readable.from([Buffer.alloc(20)]), 10);
    await expect(drain(tiny.body)).rejects.toBeInstanceOf(UploadTooLarge);
    let produced = 0;
    async function* endless(): AsyncGenerator<Buffer> {
      for (;;) {
        produced += 1024;
        yield Buffer.alloc(1024);
      }
    }
    const big = await peek(Readable.from(endless()), 4096);
    await expect(drain(big.body)).rejects.toBeInstanceOf(UploadTooLarge);
    expect(produced).toBeLessThan(4096 + 64 * 1024);
  });
});
