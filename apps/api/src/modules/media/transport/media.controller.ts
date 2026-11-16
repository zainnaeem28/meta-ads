import { Controller, Get, Header, Inject, Injectable, Param, Post, Req, Res } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import multipart from '@fastify/multipart';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { DomainError, parseWith } from '../../../platform/http/index.js';
import type { ActorContext } from '../../../platform/http/index.js';
import { CurrentActor } from '../../../platform/http/auth.guard.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { RateLimiter } from '../../../platform/rate-limit/index.js';
import { MediaService } from '../application/media.service.js';
import { MEDIA_CONFIG, MEDIA_REPOSITORY } from '../application/ports.js';
import type { MediaConfig, MediaRecord, MediaRepository } from '../application/ports.js';
import { MediaUploadService } from './media-upload.service.js';
import { UploadTooLarge } from './sniff.js';

/** API-030: 30 uploads per account per 10 minutes. */
export const UPLOAD_LIMIT = { limit: 30, windowSeconds: 600 } as const;
const UPLOAD_SCOPE = 'media-upload';

/** Room for the multipart framing around the one file part when the announced length is checked up front. */
const FRAMING_ALLOWANCE_BYTES = 16 * 1024;

const MediaParams = z.object({ mediaId: z.uuid() });

export interface MediaView {
  id: string;
  kind: string;
  state: string;
  contentType: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  rejectReason: string | null;
  attached: boolean;
  campaignId: string | null;
  createdAt: string;
}

export const mediaView = (m: MediaRecord): MediaView => ({
  id: m.id,
  kind: m.kind,
  state: m.state,
  contentType: m.contentType,
  bytes: m.bytes,
  width: m.width,
  height: m.height,
  rejectReason: m.rejectReason,
  attached: m.attachedAt !== null,
  campaignId: m.campaignId,
  createdAt: m.createdAt.toISOString(),
});

/** Adds the multipart parser to the api's fastify instance; the file part is read as a stream and never buffered. */
@Injectable()
export class MultipartSupport implements OnModuleInit {
  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    @Inject(MEDIA_CONFIG) private readonly config: MediaConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    const fastify = this.host.httpAdapter.getInstance() as { register: (plugin: unknown, options: unknown) => Promise<unknown> };
    await fastify.register(multipart, {
      throwFileSizeLimit: true,
      // One byte over the cap so the route's own counter (the 413) decides first.
      limits: { fileSize: this.config.maxUploadBytes + 1, files: 1, fields: 4, parts: 8, fieldSize: 1024, headerPairs: 32 },
    });
  }
}

const notFound = (): DomainError => new DomainError('not_found', 'Not found.');

function planned(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof UploadTooLarge || code === 'FST_REQ_FILE_TOO_LARGE') {
    return new DomainError('payload_too_large', 'The file is too large.');
  }
  if (typeof code === 'string' && code.startsWith('FST_') && code !== 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return new DomainError('validation_failed', 'The request is not valid.');
  }
  return error;
}

/** API-030 to API-032: upload into quarantine, the record's state, and a fresh signed URL after the ownership check. */
@Controller('media')
export class MediaController {
  constructor(
    @Inject(MediaUploadService) private readonly uploads: MediaUploadService,
    @Inject(MediaService) private readonly media: MediaService,
    @Inject(MEDIA_REPOSITORY) private readonly repository: MediaRepository,
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(MEDIA_CONFIG) private readonly config: MediaConfig,
  ) {}

  @Post()
  @Scope('U')
  async upload(
    @CurrentActor() actor: ActorContext | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MediaView> {
    const ownerId = owner(actor);
    const consumed = await this.limiter.consume(UPLOAD_SCOPE, ownerId, UPLOAD_LIMIT.limit, UPLOAD_LIMIT.windowSeconds);
    if (!consumed.allowed) {
      void reply.header('Retry-After', String(consumed.retryAfterSeconds));
      throw new DomainError('rate_limited', 'Too many requests. Try again shortly.');
    }
    if (!request.isMultipart()) {
      throw new DomainError('unsupported_media_type', 'Send the file as multipart/form-data.');
    }
    const announced = Number(request.headers['content-length']);
    const announcedBytes = Number.isSafeInteger(announced) && announced > 0 ? announced : undefined;
    // Size is checked before the body is read.
    if (announcedBytes !== undefined && announcedBytes > this.config.maxUploadBytes + FRAMING_ALLOWANCE_BYTES) {
      throw new DomainError('payload_too_large', 'The file is too large.');
    }
    let created;
    try {
      const part = await request.file();
      if (part === undefined || part.fieldname !== 'file') {
        throw new DomainError('validation_failed', 'The request is not valid.', [
          { field: 'file', code: 'required', message: 'A file part named "file" is required.' },
        ]);
      }
      // The client's file name is never read, used as a key or logged.
      created = await this.uploads.upload(ownerId, part.file, announcedBytes);
    } catch (error) {
      const failure = planned(error);
      // An oversized body is refused without reading the rest: the connection closes after the answer.
      if (failure instanceof DomainError && failure.code === 'payload_too_large') void reply.header('Connection', 'close');
      throw failure;
    }
    const record = await this.find(ownerId, created.id);
    void reply.header('Location', `/api/v1/media/${created.id}`);
    return mediaView(record);
  }

  @Get(':mediaId')
  @Scope('U')
  async get(@CurrentActor() actor: ActorContext | undefined, @Param() rawParams: unknown): Promise<MediaView> {
    const { mediaId } = parseWith(MediaParams, rawParams);
    return mediaView(await this.find(owner(actor), mediaId));
  }

  @Get(':mediaId/url')
  @Scope('U')
  @Header('Cache-Control', 'no-store')
  async url(
    @CurrentActor() actor: ActorContext | undefined,
    @Param() rawParams: unknown,
  ): Promise<{ url: string; expiresAt: string }> {
    const { mediaId } = parseWith(MediaParams, rawParams);
    const signed = await this.media.signedUrl('browser', { ownerId: owner(actor), mediaId });
    return { url: signed.url, expiresAt: new Date(Date.now() + signed.expiresInSec * 1000).toISOString() };
  }

  /** A foreign id and one that never existed give the same 404. */
  private async find(ownerId: string, mediaId: string): Promise<MediaRecord> {
    const record = await this.database.uow.run((tx) => this.repository.find(tx, mediaId));
    if (record === null || record.ownerId !== ownerId) throw notFound();
    return record;
  }
}

function owner(actor: ActorContext | undefined): string {
  if (actor === undefined) throw new DomainError('unauthenticated', 'Sign in to continue.');
  return actor.userId;
}
