import type { Readable } from 'node:stream';

// StoragePort (ARCHITECTURE §1.3): object storage behind one port. Keys are built only by `media` (keys.ts).

export const STORAGE_PORT = Symbol('STORAGE_PORT');

/** The store cannot be reached or refused the call (maps to 503 on the request path). */
export class StorageUnavailable extends Error {
  constructor(operation: string, options?: { cause?: unknown }) {
    super(`storage ${operation} failed`, options);
    this.name = 'StorageUnavailable';
  }
}

export class StorageNotFound extends Error {
  constructor() {
    super('storage object not found');
    this.name = 'StorageNotFound';
  }
}

/** `put` found the key taken (`If-None-Match: *`): objects are never overwritten. */
export class StorageKeyExists extends Error {
  constructor() {
    super('storage key already exists');
    this.name = 'StorageKeyExists';
  }
}

/** The body is longer than `maxBytes`; nothing was stored. */
export class StorageTooLarge extends Error {
  constructor(readonly maxBytes: number) {
    super(`storage body exceeds ${String(maxBytes)} bytes`);
    this.name = 'StorageTooLarge';
  }
}

export interface ContentDisposition {
  readonly type: 'inline' | 'attachment';
  readonly filename?: string;
}

export interface StoredObjectInfo {
  readonly key: string;
  readonly bytes: number;
  readonly lastModified: Date;
}

export interface ListPage {
  readonly objects: readonly StoredObjectInfo[];
  /** Opaque; absent on the last page. */
  readonly nextCursor?: string;
}

export interface StoragePort {
  /** Conditional on a missing key. Reads at most `maxBytes + 1` bytes of `body`; returns the stored size. */
  put(
    key: string,
    body: Readable | Buffer,
    contentType: string,
    maxBytes: number,
  ): Promise<{ readonly bytes: number }>;
  get(key: string): Promise<Readable>;
  /** Idempotent: a missing key is not an error. */
  delete(key: string): Promise<void>;
  /** Deletes every key under `prefix` in batches of at most `batch`; returns how many were deleted. */
  deletePrefix(prefix: string, batch: number): Promise<number>;
  list(prefix: string, cursor?: string): Promise<ListPage>;
  /** A read-only URL for exactly this key, valid `ttlSec` seconds. */
  presignGet(key: string, ttlSec: number, disposition: ContentDisposition): Promise<string>;
}
