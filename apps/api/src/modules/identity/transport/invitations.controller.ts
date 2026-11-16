import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentActor } from '../../../platform/http/auth.guard.js';
import type { ActorContext } from '../../../platform/http/auth.guard.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import type { PageResult } from '../../../platform/http/response.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { parseWith } from '../../../platform/http/validation.pipe.js';
import { InvitationService } from '../application/invitations.service.js';
import type { InvitationActor, InvitationView } from '../application/invitations.service.js';
import { INVITATION_STATES } from '../domain/records.js';

// The request shapes of OpenAPI design.5: InvitationCreate (closed object, email up to 320), the list query
// (limit 1..50 default 20, cursor up to 512, state) and the `invitationId` path parameter.
const createBody = z.strictObject({ email: z.string().trim().max(320).pipe(z.email()) });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(512).optional(),
  state: z.enum(INVITATION_STATES).optional(),
});
const idParam = z.uuid();

/** Invitations: API-110..113 (scope A). The admin-only guard, MFA and the 403 audit are the session guard's. */
@Controller('admin/invitations')
export class InvitationsController {
  constructor(@Inject(InvitationService) private readonly invitations: InvitationService) {}

  private actorOf(actor: ActorContext | undefined, request: FastifyRequest): InvitationActor {
    if (actor === undefined) throw new DomainError('not_linked', 'This account is not linked to ShrooMap yet.');
    return { userId: actor.userId, requestId: request.id };
  }

  @Get()
  @Scope('A')
  list(
    @CurrentActor() actor: ActorContext | undefined,
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<PageResult<InvitationView>> {
    return this.invitations.list(this.actorOf(actor, request), parseWith(listQuery, query));
  }

  @Post()
  @Scope('A')
  @HttpCode(202)
  create(
    @CurrentActor() actor: ActorContext | undefined,
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<{ email: string; message: string }> {
    return this.invitations.create(this.actorOf(actor, request), parseWith(createBody, body).email);
  }

  @Post(':invitationId/resend')
  @Scope('A')
  @HttpCode(200)
  resend(
    @CurrentActor() actor: ActorContext | undefined,
    @Req() request: FastifyRequest,
    @Param('invitationId') id: string,
  ): Promise<InvitationView> {
    return this.invitations.resend(this.actorOf(actor, request), this.idOf(id));
  }

  @Post(':invitationId/revoke')
  @Scope('A')
  @HttpCode(200)
  revoke(
    @CurrentActor() actor: ActorContext | undefined,
    @Req() request: FastifyRequest,
    @Param('invitationId') id: string,
  ): Promise<InvitationView> {
    return this.invitations.revoke(this.actorOf(actor, request), this.idOf(id));
  }

  private idOf(raw: string): string {
    const result = idParam.safeParse(raw);
    if (!result.success) {
      throw new DomainError('validation_failed', 'The request is not valid.', [
        { field: 'invitationId', code: 'invalid_format', message: 'The value has the wrong format.' },
      ]);
    }
    return result.data;
  }
}
