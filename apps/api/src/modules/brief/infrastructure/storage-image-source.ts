import type { StoragePort } from '../../media/index.js';
import type { ImageSource } from '../application/worker/ports.js';

/** An upload is at most 10 MB (MEDIA_MAX_UPLOAD_BYTES); anything longer is not the sanitized image. */
const MAX_IMAGE_BYTES = 10_485_760 + 1;

/** Reads the sanitized product image from object storage with the worker's own token. */
export class StorageImageSource implements ImageSource {
  /** `storage` is resolved when the first image is read: the worker root builds it after this module. */
  constructor(private readonly storage: () => StoragePort) {}

  async read(storageKey: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = await this.storage().get(storageKey);
    for await (const chunk of stream) {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += piece.length;
      if (total > MAX_IMAGE_BYTES) {
        stream.destroy();
        throw new RangeError('image is larger than an upload can be');
      }
      chunks.push(piece);
    }
    return Buffer.concat(chunks);
  }
}
