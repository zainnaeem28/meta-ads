import { Controller, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentActor } from '../../../platform/http/auth.guard.js';
import type { ActorContext } from '../../../platform/http/index.js';
import { parseWith } from '../../../platform/http/index.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { parseIdempotencyKey, requestHash } from '../../../platform/idempotency/index.js';
import { JOB_CREATE_ROUTE, RateLimit } from '../../../platform/rate-limit/index.js';
import { owner } from './brief.controller.js';
import { RegenerateService } from './regenerate.service.js';
import { outcomeSummary } from './submit-view.js';

const Params = z.object({ campaignId: z.uuid() });

/** API-053: generate the brief of one of my campaigns again; its edits are replaced when the new text is written. */
@Controller('campaigns/:campaignId/brief')
@Scope('U')
export class RegenerateController {
  constructor(@Inject(RegenerateService) private readonly regenerates: RegenerateService) {}

  @Post('regenerate')
  @HttpCode(202)
  @RateLimit(JOB_CREATE_ROUTE)
  async regenerate(
    @CurrentActor() actor: ActorContext | undefined,
    @Param() rawParams: unknown,
    @Headers('idempotency-key') header: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const ownerId = owner(actor);
    const { campaignId } = parseWith(Params, rawParams);
    const key = parseIdempotencyKey(header);
    const result = await this.regenerates.regenerate(ownerId, campaignId, key, requestHash('POST', request.url, null));
    return { briefState: 'generating', job: outcomeSummary(result) };
  }
}
