import { Body, Controller, Get, HttpCode, Inject, Put, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentActor } from '../../../platform/http/auth.guard.js';
import type { ActorContext } from '../../../platform/http/auth.guard.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { parseWith } from '../../../platform/http/validation.pipe.js';
import { SettingsService } from '../application/settings.service.js';
import type { SettingsView } from '../application/settings.service.js';
import { SIGNUP_MODES } from '../domain/records.js';

const setModeBody = z.strictObject({ mode: z.enum(SIGNUP_MODES) });

/** Settings: API-120 and API-121 (scope A). */
@Controller('admin/settings')
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Get()
  @Scope('A')
  get(): Promise<SettingsView> {
    return this.settings.get();
  }

  @Put('signup-mode')
  @Scope('A')
  @HttpCode(200)
  setSignupMode(
    @CurrentActor() actor: ActorContext | undefined,
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<SettingsView> {
    if (actor === undefined) throw new DomainError('not_linked', 'This account is not linked to ShrooMap yet.');
    return this.settings.setSignupMode(
      { userId: actor.userId, requestId: request.id },
      parseWith(setModeBody, body).mode,
    );
  }
}
