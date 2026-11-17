import { Controller, Delete, HttpCode, Inject, Param, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentActor } from '../../../platform/http/auth.guard.js';
import type { ActorContext } from '../../../platform/http/index.js';
import { DomainError, parseWith } from '../../../platform/http/index.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { CampaignDeletionService } from '../application/campaign-deletion.service.js';

const Params = z.object({ campaignId: z.uuid() });

/** API-042: delete my campaign. It is hidden at once; the media removal is the worker's retried run. */
@Controller('campaigns')
@Scope('U')
export class CampaignDeletionController {
  constructor(
    @Inject(CampaignDeletionService) private readonly deletion: CampaignDeletionService,
  ) {}

  @Delete(':campaignId')
  @HttpCode(202)
  async remove(
    @CurrentActor() actor: ActorContext | undefined,
    @Param() rawParams: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{ deletionRunId: string; state: 'running' }> {
    if (actor === undefined) throw new DomainError('unauthenticated', 'Sign in to continue.');
    const { campaignId } = parseWith(Params, rawParams);
    return this.deletion.request(actor.userId, campaignId, request.id);
  }
}
