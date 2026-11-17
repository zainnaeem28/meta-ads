import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentActor } from '../../../platform/http/auth.guard.js';
import type { ActorContext } from '../../../platform/http/index.js';
import { DomainError, parseWith } from '../../../platform/http/index.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { parseIdempotencyKey, requestHash } from '../../../platform/idempotency/index.js';
import { JOB_CREATE_ROUTE, RateLimit } from '../../../platform/rate-limit/index.js';
import { ThumbService } from '../application/thumb.service.js';
import { thumbView } from './thumb-view.js';

const CampaignParams = z.object({ campaignId: z.uuid() });
const Create = z.object({ calloutText: z.string().min(1).max(80) }).strict();

function owner(actor: ActorContext | undefined): string {
  if (actor === undefined) throw new DomainError('unauthenticated', 'Sign in to continue.');
  return actor.userId;
}

/** API-075 and API-076: the thumbstopper call-out image of a campaign (REQ-022). */
@Controller()
@Scope('U')
export class ThumbController {
  constructor(@Inject(ThumbService) private readonly thumbs: ThumbService) {}

  @Post('campaigns/:campaignId/thumbstopper')
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
    const { campaignId } = parseWith(CampaignParams, rawParams);
    const key = parseIdempotencyKey(header);
    const body = parseWith(Create, rawBody);
    const result = await this.thumbs.generate(
      ownerId,
      campaignId,
      body.calloutText,
      key,
      requestHash('POST', request.url, rawBody),
    );
    return thumbView(result.job, result.reused);
  }

  @Get('campaigns/:campaignId/thumbstopper')
  async latest(@CurrentActor() actor: ActorContext | undefined, @Param() rawParams: unknown) {
    const { campaignId } = parseWith(CampaignParams, rawParams);
    const job = await this.thumbs.latest(owner(actor), campaignId);
    return job === null ? null : thumbView(job, false);
  }
}
