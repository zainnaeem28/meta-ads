import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentActor, CurrentSession } from '../../../platform/http/auth.guard.js';
import type { ActorContext, AuthResult } from '../../../platform/http/auth.guard.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import type { PageResult } from '../../../platform/http/response.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { parseWith } from '../../../platform/http/validation.pipe.js';
import { clientIp } from '../../../platform/rate-limit/index.js';
import { AccessRequestService } from '../application/access-requests.service.js';
import type {
  AccessRequestActor,
  AccessRequestView,
} from '../application/access-requests.service.js';
import { ACCESS_REQUEST_STATES } from '../domain/records.js';

// The request shapes of OpenAPI design.5: AccessRequestCreate (closed object, note up to 500, body optional), the list
// query (limit 1..50 default 20, cursor up to 512, state default pending) and the `accessRequestId` path parameter.
const createBody = z.strictObject({ note: z.string().max(500).optional() });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(512).optional(),
  state: z.enum(ACCESS_REQUEST_STATES).default('pending'),
});
const idParam = z.uuid();

function trustProxyHops(): number {
  const hops = Number(process.env['TRUST_PROXY_HOPS'] ?? '1');
  return Number.isInteger(hops) && hops >= 0 ? hops : 1;
}

/** API-002 (scope T: a verified token without an account). */
@Controller('access-requests')
export class AccessRequestsController {
  constructor(@Inject(AccessRequestService) private readonly requests: AccessRequestService) {}

  @Post()
  @Scope('T')
  @HttpCode(202)
  create(
    @CurrentSession() auth: AuthResult,
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<{ state: 'received' }> {
    const parsed = parseWith(createBody, body ?? {});
    const subject = auth.linked ? auth.actor.userId : auth.session.subject;
    return this.requests.create(
      subject,
      auth.linked,
      clientIp(request, trustProxyHops()),
      parsed.note,
    );
  }
}

/** Access requests: API-115..117 (scope A). The admin-only guard, MFA and the 403 audit are the session guard's. */
@Controller('admin/access-requests')
export class AdminAccessRequestsController {
  constructor(@Inject(AccessRequestService) private readonly requests: AccessRequestService) {}

  private actorOf(actor: ActorContext | undefined, request: FastifyRequest): AccessRequestActor {
    if (actor === undefined)
      throw new DomainError('not_linked', 'This account is not linked to ShrooMap yet.');
    return { userId: actor.userId, requestId: request.id };
  }

  @Get()
  @Scope('A')
  list(
    @CurrentActor() actor: ActorContext | undefined,
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<PageResult<AccessRequestView>> {
    return this.requests.list(this.actorOf(actor, request), parseWith(listQuery, query));
  }

  @Post(':accessRequestId/approve')
  @Scope('A')
  @HttpCode(200)
  approve(
    @CurrentActor() actor: ActorContext | undefined,
    @Req() request: FastifyRequest,
    @Param('accessRequestId') id: string,
  ): Promise<AccessRequestView> {
    return this.requests.approve(this.actorOf(actor, request), this.idOf(id));
  }

  @Post(':accessRequestId/decline')
  @Scope('A')
  @HttpCode(200)
  decline(
    @CurrentActor() actor: ActorContext | undefined,
    @Req() request: FastifyRequest,
    @Param('accessRequestId') id: string,
  ): Promise<AccessRequestView> {
    return this.requests.decline(this.actorOf(actor, request), this.idOf(id));
  }

  private idOf(raw: string): string {
    const result = idParam.safeParse(raw);
    if (!result.success) {
      throw new DomainError('validation_failed', 'The request is not valid.', [
        {
          field: 'accessRequestId',
          code: 'invalid_format',
          message: 'The value has the wrong format.',
        },
      ]);
    }
    return result.data;
  }
}
