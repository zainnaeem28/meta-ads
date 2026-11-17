import { Controller, Get, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentActor } from '../../../platform/http/auth.guard.js';
import type { ActorContext } from '../../../platform/http/index.js';
import { parseWith } from '../../../platform/http/index.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { parseIdempotencyKey, requestHash } from '../../../platform/idempotency/index.js';
import { JOB_CREATE_ROUTE, RateLimit } from '../../../platform/rate-limit/index.js';
import { AnalysisService } from './analysis.service.js';
import { owner } from './brief.controller.js';
import { jobSummary, outcomeSummary } from './submit-view.js';

const Params = z.object({ mediaId: z.uuid() });

/** API-035 and API-036: the product-only description of one of my images. */
@Controller('media/:mediaId/analysis')
@Scope('U')
export class AnalysisController {
  constructor(@Inject(AnalysisService) private readonly analyses: AnalysisService) {}

  @Post()
  @HttpCode(202)
  @RateLimit(JOB_CREATE_ROUTE)
  async request(
    @CurrentActor() actor: ActorContext | undefined,
    @Param() rawParams: unknown,
    @Headers('idempotency-key') header: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const ownerId = owner(actor);
    const { mediaId } = parseWith(Params, rawParams);
    const key = parseIdempotencyKey(header);
    const result = await this.analyses.request(ownerId, mediaId, key, requestHash('POST', request.url, null));
    const view = await this.analyses.latest(ownerId, mediaId);
    return { job: outcomeSummary(result), productDescription: view.productDescription };
  }

  @Get()
  async get(@CurrentActor() actor: ActorContext | undefined, @Param() rawParams: unknown) {
    const { mediaId } = parseWith(Params, rawParams);
    const view = await this.analyses.latest(owner(actor), mediaId);
    return { job: view.job === null ? null : jobSummary(view.job, false), productDescription: view.productDescription };
  }
}
