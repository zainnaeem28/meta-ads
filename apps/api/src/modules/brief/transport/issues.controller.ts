import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentActor } from '../../../platform/http/auth.guard.js';
import type { ActorContext } from '../../../platform/http/index.js';
import { parseWith } from '../../../platform/http/index.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { IssuesService } from '../application/issues.service.js';
import { issueView, owner } from './brief.controller.js';

const Params = z.object({ issueId: z.uuid() });
const ClearClaimIssue = z.strictObject({ reason: z.string().trim().min(3).max(500) });

/** API-054: clear a claim issue of mine with a reason. */
@Controller('claim-issues')
@Scope('U')
export class IssuesController {
  constructor(@Inject(IssuesService) private readonly issues: IssuesService) {}

  @Post(':issueId/clear')
  @HttpCode(200)
  async clear(
    @CurrentActor() actor: ActorContext | undefined,
    @Param() rawParams: unknown,
    @Body() rawBody: unknown,
  ) {
    const userId = owner(actor);
    const { issueId } = parseWith(Params, rawParams);
    const { reason } = parseWith(ClearClaimIssue, rawBody);
    return issueView(await this.issues.clear(userId, issueId, reason));
  }
}
