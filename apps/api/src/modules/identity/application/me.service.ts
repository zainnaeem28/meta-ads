import { Inject, Injectable, Optional } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import type { AuthResult } from '../../../platform/http/auth.guard.js';
import { ACCESS_REQUEST_LOOKUP, AUTH_OPTIONS, KEY_NOTICE_PORT } from './ports.js';
import type { AccessRequestLookup, AuthOptions, KeyNotice, KeyNoticePort } from './ports.js';

export type MeView =
  | {
      linkState: 'linked';
      id: string;
      role: 'user' | 'admin';
      status: 'active';
      mfa: { required: boolean; satisfied: boolean };
      recentAuth: { satisfied: boolean; maxAgeSeconds: number };
      keyNotices: readonly KeyNotice[];
    }
  | {
      linkState: 'not_linked';
      accessRequest: { formEnabled: boolean; state: 'none' | 'pending' | 'declined' };
    };

/** API-001. The actor was loaded and linked by the guard, so a suspended or removed account never gets here. */
@Injectable()
export class MeService {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'db'>,
    @Inject(AUTH_OPTIONS) private readonly options: AuthOptions,
    @Inject(ACCESS_REQUEST_LOOKUP) private readonly requests: AccessRequestLookup,
    @Optional() @Inject(KEY_NOTICE_PORT) private readonly notices?: KeyNoticePort,
  ) {}

  async me(auth: AuthResult): Promise<MeView> {
    if (!auth.linked) {
      return {
        linkState: 'not_linked',
        accessRequest: {
          formEnabled: this.options.accessRequestFormEnabled,
          state: await this.requests.stateOfSubject(this.database.db, auth.session.subject),
        },
      };
    }
    const { actor } = auth;
    return {
      linkState: 'linked',
      id: actor.userId,
      role: actor.role,
      status: 'active',
      mfa: actor.mfa,
      recentAuth: actor.recentAuth,
      keyNotices: (await this.notices?.noticesFor(actor.userId)) ?? [],
    };
  }
}
