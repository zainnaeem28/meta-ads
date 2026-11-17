import { Controller, Headers, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentActor } from '../../../platform/http/auth.guard.js';
import type { ActorContext } from '../../../platform/http/index.js';
import { parseWith } from '../../../platform/http/index.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { parseIdempotencyKey, requestHash } from '../../../platform/idempotency/index.js';
import { JOB_CREATE_ROUTE, RateLimit } from '../../../platform/rate-limit/index.js';
import { owner } from './brief.controller.js';
import { SubmitService } from './submit.service.js';
import { outcomeSummary } from './submit-view.js';

const Params = z.object({ draftId: z.uuid() });

/** API-024: submit a complete draft of mine; the campaign, its brief and the brief-generation job are created together. */
@Controller('drafts')
@Scope('U')
export class SubmitController {
  constructor(@Inject(SubmitService) private readonly submits: SubmitService) {}

  @Post(':draftId/submit')
  @HttpCode(202)
  @RateLimit(JOB_CREATE_ROUTE)
  async submit(
    @CurrentActor() actor: ActorContext | undefined,
    @Param() rawParams: unknown,
    @Headers('idempotency-key') header: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const ownerId = owner(actor);
    const { draftId } = parseWith(Params, rawParams);
    const key = parseIdempotencyKey(header);
    const result = await this.submits.submit(
      ownerId,
      draftId,
      key,
      requestHash('POST', request.url, null),
    );
    void reply.header('Location', `/api/v1/campaigns/${result.campaignId}`);
    return { campaignId: result.campaignId, briefJob: outcomeSummary(result) };
  }
}
