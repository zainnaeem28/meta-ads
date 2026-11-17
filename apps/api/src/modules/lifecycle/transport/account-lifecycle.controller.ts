import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentActor } from '../../../platform/http/auth.guard.js';
import type { ActorContext } from '../../../platform/http/index.js';
import { parseWith } from '../../../platform/http/index.js';
import type { PageResult } from '../../../platform/http/response.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { AccountLifecycleService } from '../application/account-lifecycle.service.js';
import type { ErasureRunView, RemovalAccepted } from '../application/account-lifecycle.service.js';
import type { AccountView } from '../application/account-lifecycle-ports.js';

const userIdSchema = z.uuid();
const removeBody = z.strictObject({ confirmation: z.string().min(3).max(320) });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(512).optional(),
  state: z.enum(['running', 'completed', 'stuck']).optional(),
});

/** API-101, 102, 103 and 105 (scope A: the guard refuses a non-admin with 403 and writes the `auth.denied` event). */
@Controller('admin')
@Scope('A')
export class AccountLifecycleController {
  constructor(
    @Inject(AccountLifecycleService) private readonly accounts: AccountLifecycleService,
  ) {}

  @Post('users/:userId/suspend')
  @HttpCode(200)
  async suspend(
    @CurrentActor() actor: ActorContext,
    @Param('userId') userId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AccountView> {
    const view = await this.accounts.suspend(
      actor.userId,
      parseWith(userIdSchema, userId),
      request.id,
    );
    void reply.header('ETag', `"${String(view.version)}"`);
    return view;
  }

  @Post('users/:userId/reinstate')
  @HttpCode(200)
  async reinstate(
    @CurrentActor() actor: ActorContext,
    @Param('userId') userId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AccountView> {
    const view = await this.accounts.reinstate(
      actor.userId,
      parseWith(userIdSchema, userId),
      request.id,
    );
    void reply.header('ETag', `"${String(view.version)}"`);
    return view;
  }

  @Post('users/:userId/remove')
  @HttpCode(202)
  remove(
    @CurrentActor() actor: ActorContext,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<RemovalAccepted> {
    const id = parseWith(userIdSchema, userId);
    const { confirmation } = parseWith(removeBody, body);
    return this.accounts.remove(actor.userId, id, confirmation, request.id);
  }

  @Get('erasures')
  erasures(
    @CurrentActor() actor: ActorContext,
    @Query() query: unknown,
  ): Promise<PageResult<ErasureRunView>> {
    return this.accounts.listErasures(actor.userId, parseWith(listQuery, query ?? {}));
  }
}
