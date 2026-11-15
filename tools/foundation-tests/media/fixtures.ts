import { Buffer } from 'node:buffer';
import { createDeflate } from 'node:zlib';

// CRC-32 for PNG chunks
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// A valid 8-bit grayscale PNG of width x height whose pixel data is all zero: tiny on disk,
// width*height bytes when decoded (the decompression-bomb shape). Streams the deflate so the
// raw pixels never sit in memory at once.
export async function bombPng(width: number, height: number): Promise<Buffer> {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const deflate = createDeflate({ level: 9 });
  const parts: Buffer[] = [];
  deflate.on('data', (d: Buffer) => parts.push(d));
  const done = new Promise<void>((resolve, reject) => {
    deflate.on('end', resolve);
    deflate.on('error', reject);
  });
  const row = Buffer.alloc(width + 1); // filter byte 0 + zero pixels
  for (let y = 0; y < height; y++) {
    if (!deflate.write(row)) await new Promise((r) => deflate.once('drain', r));
  }
  deflate.end();
  await done;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.concat(parts)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
