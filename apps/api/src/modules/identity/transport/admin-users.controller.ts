import { Body, Controller, Get, Headers, Inject, Param, Put, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentActor } from '../../../platform/http/auth.guard.js';
import type { ActorContext } from '../../../platform/http/auth.guard.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import type { PageResult } from '../../../platform/http/response.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { parseWith } from '../../../platform/http/validation.pipe.js';
import { AdminUsersService } from '../application/admin-users.service.js';
import type { AdminUserView } from '../application/admin-users.service.js';

const userIdSchema = z.uuid();
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(512).optional(),
  status: z.enum(['active', 'suspended', 'removed']).optional(),
});
const setRoleBody = z.strictObject({ role: z.enum(['user', 'admin']) });

/** `If-Match: "<version>"`, the ETag of the last read (ADR-010: a mismatch is 409, not 412). */
export function versionOf(header: string | undefined): number {
  const match = header === undefined ? null : /^"([0-9]{1,9})"$/.exec(header.trim());
  if (match?.[1] === undefined || Number(match[1]) < 1) {
    throw new DomainError('validation_failed', 'The request is not valid.', [
      { field: 'If-Match', code: header === undefined ? 'required' : 'invalid_format', message: 'Send the ETag of the last read, e.g. "3".' },
    ]);
  }
  return Number(match[1]);
}

/** API-100 and API-104 (scope A: the guard refuses a non-admin with 403 and writes the `auth.denied` event). */
@Controller('admin/users')
@Scope('A')
export class AdminUsersController {
  constructor(@Inject(AdminUsersService) private readonly admin: AdminUsersService) {}

  @Get()
  list(@CurrentActor() actor: ActorContext, @Query() query: unknown): Promise<PageResult<AdminUserView>> {
    return this.admin.listUsers(actor, parseWith(listQuery, query ?? {}));
  }

  @Put(':userId/role')
  async setRole(
    @CurrentActor() actor: ActorContext,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdminUserView> {
    const id = parseWith(userIdSchema, userId);
    const { role } = parseWith(setRoleBody, body);
    const expected = versionOf(ifMatch);
    const { user } = await this.admin.setRole(actor, id, role, expected, request.id);
    void reply.header('ETag', `"${String(user.version)}"`);
    return user;
  }
}
