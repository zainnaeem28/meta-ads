import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { DomainError } from '../../../platform/http/domain-error.js';
import { MediaController, MultipartSupport, UPLOAD_LIMIT, mediaView } from './media.controller.js';
import { UploadTooLarge } from './sniff.js';

const actor = { userId: 'u1' } as never;
const ID = '0197a1b2-0000-7000-8000-000000000001';
const record = {
  id: ID,
  ownerId: 'u1',
  kind: 'upload',
  state: 'ready',
  storageKey: 'q/u1/x',
  bytes: 5,
  contentType: 'image/png',
  width: 2,
  height: 3,
  campaignId: null,
  attachedAt: null,
  rejectReason: null,
  createdAt: new Date('2026-11-15T10:00:00.000Z'),
};

function build(
  options: {
    allowed?: boolean;
    found?: unknown;
    file?: unknown;
    headers?: Record<string, string>;
    multipart?: boolean;
  } = {},
) {
  const uploads = { upload: vi.fn(() => Promise.resolve({ id: ID })) };
  const media = {
    signedUrl: vi.fn(() => Promise.resolve({ url: 'https://s/x', expiresInSec: 300 })),
  };
  const repository = {
    find: vi.fn(() => Promise.resolve('found' in options ? options.found : record)),
  };
  const database = {
    uow: { run: vi.fn((fn: (tx: unknown) => unknown) => Promise.resolve(fn({}))) },
  };
  const limiter = {
    consume: vi.fn(() =>
      Promise.resolve({ allowed: options.allowed ?? true, retryAfterSeconds: 42 }),
    ),
  };
  const controller = new MediaController(
    uploads as never,
    media as never,
    repository as never,
    database as never,
    limiter as never,
    { maxUploadBytes: 1000 } as never,
  );
  const header = vi.fn();
  const request = {
    isMultipart: () => options.multipart ?? true,
    headers: options.headers ?? { 'content-length': '500' },
    file: vi.fn(() =>
      Promise.resolve(
        'file' in options ? options.file : { fieldname: 'file', file: Readable.from([]) },
      ),
    ),
  };
  return {
    controller,
    uploads,
    media,
    repository,
    limiter,
    request,
    header,
    reply: { header } as never,
  };
}

const code = async (promise: Promise<unknown>): Promise<string | undefined> =>
  ((await promise.catch((e: unknown) => e)) as DomainError).code;

describe('MediaController upload', () => {
  it('limits the account, streams the file part and answers with the record and its Location', async () => {
    const t = build();
    const view = await t.controller.upload(actor, t.request as never, t.reply);
    expect(t.limiter.consume).toHaveBeenCalledWith(
      'media-upload',
      'u1',
      UPLOAD_LIMIT.limit,
      UPLOAD_LIMIT.windowSeconds,
    );
    expect(UPLOAD_LIMIT).toEqual({ limit: 30, windowSeconds: 600 });
    expect(t.uploads.upload).toHaveBeenCalledWith('u1', expect.anything(), 500);
    expect(t.header).toHaveBeenCalledWith('Location', `/api/v1/media/${ID}`);
    expect(view).toEqual(mediaView(record as never));
    expect(view).toMatchObject({
      attached: false,
      createdAt: '2026-11-15T10:00:00.000Z',
      rejectReason: null,
    });
  });

  it('needs an actor, answers 429 with Retry-After, and wants multipart', async () => {
    expect(
      await code(build().controller.upload(undefined, build().request as never, build().reply)),
    ).toBe('unauthenticated');
    const limited = build({ allowed: false });
    expect(
      await code(limited.controller.upload(actor, limited.request as never, limited.reply)),
    ).toBe('rate_limited');
    expect(limited.header).toHaveBeenCalledWith('Retry-After', '42');
    const plain = build({ multipart: false });
    expect(await code(plain.controller.upload(actor, plain.request as never, plain.reply))).toBe(
      'unsupported_media_type',
    );
  });

  it('refuses an announced length far over the cap before reading the body', async () => {
    const t = build({ headers: { 'content-length': String(1000 + 17 * 1024) } });
    expect(await code(t.controller.upload(actor, t.request as never, t.reply))).toBe(
      'payload_too_large',
    );
    expect(t.request.file).not.toHaveBeenCalled();
  });

  it('works without an announced length and ignores a bad one', async () => {
    for (const headers of [{}, { 'content-length': 'abc' }] as Record<string, string>[]) {
      const t = build({ headers });
      await t.controller.upload(actor, t.request as never, t.reply);
      expect(t.uploads.upload).toHaveBeenCalledWith('u1', expect.anything(), undefined);
    }
  });

  it('wants one part named file', async () => {
    for (const file of [undefined, { fieldname: 'other', file: Readable.from([]) }]) {
      const t = build({ file });
      expect(await code(t.controller.upload(actor, t.request as never, t.reply))).toBe(
        'validation_failed',
      );
    }
  });

  it('maps the parser and cap errors to the contract codes and leaves others alone', async () => {
    for (const [failure, expected] of [
      [new UploadTooLarge(), 'payload_too_large'],
      [Object.assign(new Error('x'), { code: 'FST_REQ_FILE_TOO_LARGE' }), 'payload_too_large'],
      [Object.assign(new Error('x'), { code: 'FST_FILES_LIMIT' }), 'validation_failed'],
    ] as const) {
      const t = build();
      t.uploads.upload.mockRejectedValueOnce(failure as never);
      expect(await code(t.controller.upload(actor, t.request as never, t.reply))).toBe(expected);
      expect(t.header.mock.calls.some((c) => c[0] === 'Connection')).toBe(
        expected === 'payload_too_large',
      );
    }
    const t = build();
    const plain = new Error('boom');
    t.uploads.upload.mockRejectedValueOnce(plain as never);
    await expect(t.controller.upload(actor, t.request as never, t.reply)).rejects.toBe(plain);
    const body = build();
    const bodyError = Object.assign(new Error('x'), { code: 'FST_ERR_CTP_BODY_TOO_LARGE' });
    body.uploads.upload.mockRejectedValueOnce(bodyError as never);
    await expect(body.controller.upload(actor, body.request as never, body.reply)).rejects.toBe(
      bodyError,
    );
  });
});

describe('MediaController reads', () => {
  it("returns the owner's record and the one 404 for a foreign or missing id", async () => {
    expect((await build().controller.get(actor, { mediaId: ID })).id).toBe(ID);
    const foreign = build({ found: { ...record, ownerId: 'u2' } });
    expect(await code(foreign.controller.get(actor, { mediaId: ID }))).toBe('not_found');
    const missing = build({ found: null });
    expect(await code(missing.controller.get(actor, { mediaId: ID }))).toBe('not_found');
    expect(await code(build().controller.get(actor, { mediaId: 'nope' }))).toBe(
      'validation_failed',
    );
  });

  it('signs for the owner only and reports the expiry instant', async () => {
    const t = build();
    vi.useFakeTimers({ now: new Date('2026-11-15T10:00:00.000Z') });
    try {
      expect(await t.controller.url(actor, { mediaId: ID })).toEqual({
        url: 'https://s/x',
        expiresAt: '2026-11-15T10:05:00.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
    expect(t.media.signedUrl).toHaveBeenCalledWith('browser', { ownerId: 'u1', mediaId: ID });
  });
});

describe('MultipartSupport', () => {
  it('registers the parser with one file of at most the cap plus one byte', async () => {
    const register = vi.fn(() => Promise.resolve());
    const host = { httpAdapter: { getInstance: () => ({ register }) } };
    await new MultipartSupport(host as never, { maxUploadBytes: 1000 } as never).onModuleInit();
    expect(register).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limits: expect.objectContaining({ fileSize: 1001, files: 1 }) }),
    );
  });
});
