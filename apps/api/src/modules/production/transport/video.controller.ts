import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentActor } from '../../../platform/http/auth.guard.js';
import type { ActorContext } from '../../../platform/http/index.js';
import { DomainError, parseWith } from '../../../platform/http/index.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { parseIdempotencyKey, requestHash } from '../../../platform/idempotency/index.js';
import { JOB_CREATE_ROUTE, RateLimit } from '../../../platform/rate-limit/index.js';
import { VideoJobsService } from '../application/video-jobs.service.js';
import { videoJobView } from './video-view.js';

const SegmentParams = z.object({
  campaignId: z.uuid(),
  position: z.coerce.number().int().min(1).max(4),
});
const CampaignParams = z.object({ campaignId: z.uuid() });
const JobParams = z.object({ videoJobId: z.uuid() });
const GenerateSegment = z.object({ useProductImage: z.boolean().default(true) }).strict();

function owner(actor: ActorContext | undefined): string {
  if (actor === undefined) throw new DomainError('unauthenticated', 'Sign in to continue.');
  return actor.userId;
}

/** API-060 to API-063: the clip of each segment, its QC and its retry. */
@Controller()
@Scope('U')
export class VideoController {
  constructor(@Inject(VideoJobsService) private readonly jobs: VideoJobsService) {}

  @Post('campaigns/:campaignId/segments/:position/jobs')
  @HttpCode(202)
  @RateLimit(JOB_CREATE_ROUTE)
  async generate(
    @CurrentActor() actor: ActorContext | undefined,
    @Param() rawParams: unknown,
    @Body() rawBody: unknown,
    @Headers('idempotency-key') header: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const ownerId = owner(actor);
    const { campaignId, position } = parseWith(SegmentParams, rawParams);
    const key = parseIdempotencyKey(header);
    const body = parseWith(GenerateSegment, rawBody ?? {});
    const result = await this.jobs.generateSegment(
      ownerId,
      campaignId,
      position,
      body.useProductImage,
      key,
      requestHash('POST', request.url, rawBody ?? null),
    );
    return videoJobView(result.job, result.reused);
  }

  @Get('campaigns/:campaignId/video-jobs')
  async list(@CurrentActor() actor: ActorContext | undefined, @Param() rawParams: unknown) {
    const { campaignId } = parseWith(CampaignParams, rawParams);
    const entries = await this.jobs.listForCampaign(owner(actor), campaignId);
    return entries.map((entry) => ({
      position: entry.position,
      segmentState: entry.segmentState,
      segmentRevision: entry.segmentRevision,
      latestJob: entry.latestJob === null ? null : videoJobView(entry.latestJob, false),
    }));
  }

  @Get('video-jobs/:videoJobId')
  async get(@CurrentActor() actor: ActorContext | undefined, @Param() rawParams: unknown) {
    const { videoJobId } = parseWith(JobParams, rawParams);
    return videoJobView(await this.jobs.get(owner(actor), videoJobId), false);
  }

  @Post('video-jobs/:videoJobId/retry')
  @HttpCode(202)
  @RateLimit(JOB_CREATE_ROUTE)
  async retry(
    @CurrentActor() actor: ActorContext | undefined,
    @Param() rawParams: unknown,
    @Headers('idempotency-key') header: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const ownerId = owner(actor);
    const { videoJobId } = parseWith(JobParams, rawParams);
    const key = parseIdempotencyKey(header);
    const result = await this.jobs.retry(
      ownerId,
      videoJobId,
      key,
      requestHash('POST', request.url, null),
    );
    return videoJobView(result.job, result.reused);
  }
}
