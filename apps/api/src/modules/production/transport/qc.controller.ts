import { Controller, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentActor } from '../../../platform/http/auth.guard.js';
import type { ActorContext } from '../../../platform/http/index.js';
import { DomainError, parseWith } from '../../../platform/http/index.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { parseIdempotencyKey, requestHash } from '../../../platform/idempotency/index.js';
import { JOB_CREATE_ROUTE, RateLimit } from '../../../platform/rate-limit/index.js';
import { QcRunsService } from '../application/qc-runs.service.js';
import { qcView } from './video-view.js';

const JobParams = z.object({ videoJobId: z.uuid() });

function owner(actor: ActorContext | undefined): string {
  if (actor === undefined) throw new DomainError('unauthenticated', 'Sign in to continue.');
  return actor.userId;
}

/** API-064: re-run the audio check of a completed clip (REQ-010). */
@Controller()
@Scope('U')
export class QcController {
  constructor(@Inject(QcRunsService) private readonly runs: QcRunsService) {}

  @Post('video-jobs/:videoJobId/qc')
  @HttpCode(202)
  @RateLimit(JOB_CREATE_ROUTE)
  async rerun(
    @CurrentActor() actor: ActorContext | undefined,
    @Param() rawParams: unknown,
    @Headers('idempotency-key') header: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const ownerId = owner(actor);
    const { videoJobId } = parseWith(JobParams, rawParams);
    const key = parseIdempotencyKey(header);
    const result = await this.runs.rerun(
      ownerId,
      videoJobId,
      key,
      requestHash('POST', request.url, null),
    );
    return { ...qcView(result.run), reused: result.reused };
  }
}
