import { Controller, Get, Inject } from '@nestjs/common';
import { CurrentSession } from '../../../platform/http/auth.guard.js';
import type { AuthResult } from '../../../platform/http/auth.guard.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { MeService } from '../application/me.service.js';
import type { MeView } from '../application/me.service.js';

@Controller('me')
export class MeController {
  constructor(@Inject(MeService) private readonly me: MeService) {}

  /** API-001: scope T, so a verified token without an account still reads its link state. */
  @Get()
  @Scope('T')
  get(@CurrentSession() auth: AuthResult): Promise<MeView> {
    return this.me.me(auth);
  }
}
