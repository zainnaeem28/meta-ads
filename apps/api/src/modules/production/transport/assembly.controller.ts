import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentActor } from '../../../platform/http/auth.guard.js';
import type { ActorContext } from '../../../platform/http/index.js';
import { DomainError, parseWith } from '../../../platform/http/index.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { parseIdempotencyKey, requestHash } from '../../../platform/idempotency/index.js';
import { JOB_CREATE_ROUTE, RateLimit } from '../../../platform/rate-limit/index.js';
import { AssemblyService } from '../application/assembly.service.js';
import type { AssemblyOutcome } from '../application/assembly.service.js';
import { instant } from './video-view.js';

const CampaignParams = z.object({ campaignId: z.uuid() });
const AssemblyParams = z.object({ assemblyId: z.uuid() });
const AssemblyCreate = z
  .object({
    clips: z.array(z.uuid()).min(1).max(4),
    thumbstopperJobId: z.uuid().nullish(),
    confirmations: z
      .object({ qcOverride: z.array(z.uuid()).max(4).default([]) })
      .strict()
      .default({ qcOverride: [] }),
  })
  .strict();

const unique = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;

function owner(actor: ActorContext | undefined): string {
  if (actor === undefined) throw new DomainError('unauthenticated', 'Sign in to continue.');
  return actor.userId;
}

/** `Assembly`; `reused` is true when API-070 returned an existing assembly, false on reads. */
export const assemblyView = ({ assembly, reused }: AssemblyOutcome) => ({
  id: assembly.id,
  campaignId: assembly.campaignId,
  state: assembly.state,
  clips: assembly.clips,
  thumbstopperJobId: assembly.thumbstopperJobId,
  outOfDate: assembly.outOfDate,
  outputMediaId: assembly.outputMediaId,
  causeClass: assembly.causeClass,
  causeMessage: assembly.causeMessage,
  createdAt: instant(assembly.createdAt),
  updatedAt: instant(assembly.updatedAt),
  reused,
});

/** API-070 and API-071: the final video of a campaign, assembled from its completed clips (REQ-011). */
@Controller()
@Scope('U')
export class AssemblyController {
  constructor(@Inject(AssemblyService) private readonly assemblies: AssemblyService) {}

  @Post('campaigns/:campaignId/assemblies')
  @HttpCode(202)
  @RateLimit(JOB_CREATE_ROUTE)
  async create(
    @CurrentActor() actor: ActorContext | undefined,
    @Param() rawParams: unknown,
    @Body() rawBody: unknown,
    @Headers('idempotency-key') header: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const ownerId = owner(actor);
    const { campaignId } = parseWith(CampaignParams, rawParams);
    const key = parseIdempotencyKey(header);
    const body = parseWith(AssemblyCreate, rawBody);
    if (!unique(body.clips)) {
      throw new DomainError('validation_failed', 'The request is not valid.', [
        { field: 'clips', code: 'not_unique', message: 'Each clip can be chosen once.' },
      ]);
    }
    const qcOverride = body.confirmations.qcOverride;
    if (!unique(qcOverride)) {
      throw new DomainError('validation_failed', 'The request is not valid.', [
        {
          field: 'confirmations.qcOverride',
          code: 'not_unique',
          message: 'Each clip can be confirmed once.',
        },
      ]);
    }
    const foreign = qcOverride.flatMap((id, index) => (body.clips.includes(id) ? [] : [index]));
    if (foreign.length > 0) {
      throw new DomainError(
        'validation_failed',
        'The request is not valid.',
        foreign.map((index) => ({
          field: `confirmations.qcOverride[${String(index)}]`,
          code: 'not_in_clips',
          message: 'Only a clip that is being assembled can be confirmed.',
        })),
      );
    }
    const outcome = await this.assemblies.create(
      ownerId,
      campaignId,
      { clips: body.clips, thumbstopperJobId: body.thumbstopperJobId ?? null, qcOverride },
      key,
      requestHash('POST', request.url, rawBody),
    );
    return assemblyView(outcome);
  }

  @Get('assemblies/:assemblyId')
  async get(@CurrentActor() actor: ActorContext | undefined, @Param() rawParams: unknown) {
    const { assemblyId } = parseWith(AssemblyParams, rawParams);
    return assemblyView({
      assembly: await this.assemblies.get(owner(actor), assemblyId),
      reused: false,
    });
  }
}
