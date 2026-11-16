import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { AuditService } from '../../audit/index.js';
import type { SignupMode } from '../domain/records.js';
import { AUTH_OPTIONS } from './ports.js';
import type { AuthOptions } from './ports.js';
import { SETTINGS_ADMIN_STORE } from './settings.store.js';
import type { SettingsAdminStorePort } from './settings.store.js';

export const SETTINGS_OPTIONS = Symbol('SETTINGS_OPTIONS');

/** The PM-D6 prerequisites of open signup that live in configuration (the fourth, the G-4 record, is in the database). */
export interface SettingsOptions {
  readonly emailVerificationRequired: boolean;
  readonly signupRateLimitEnabled: boolean;
  readonly abuseLimitsEnabled: boolean;
}

export function settingsOptionsFrom(env: Readonly<Record<string, string | undefined>>): SettingsOptions {
  return {
    emailVerificationRequired: env['SIGNUP_OPEN_EMAIL_VERIFICATION'] === 'true',
    signupRateLimitEnabled: env['SIGNUP_OPEN_RATE_LIMIT'] === 'true',
    abuseLimitsEnabled: env['SIGNUP_OPEN_ABUSE_LIMITS'] === 'true',
  };
}

export interface SettingsView {
  readonly signupMode: SignupMode;
  readonly accessRequestFormEnabled: boolean;
  readonly mfaRequiredFor: 'all' | 'admins';
  readonly inviteEmailDomains: readonly string[];
  readonly openModePrerequisites: SettingsOptions & { readonly verificationRecordId: string | null };
}

/** Settings (API-120, API-121): the signup mode is editable, everything else is configuration shown read-only. */
@Injectable()
export class SettingsService {
  constructor(
    @Inject(SETTINGS_ADMIN_STORE) private readonly store: SettingsAdminStorePort,
    @Inject(DATABASE) private readonly database: Pick<Database, 'db' | 'uow'>,
    @Inject(AuditService) private readonly audit: Pick<AuditService, 'record'>,
    @Inject(AUTH_OPTIONS) private readonly auth: AuthOptions,
    @Inject(SETTINGS_OPTIONS) private readonly options: SettingsOptions,
  ) {}

  async get(): Promise<SettingsView> {
    return this.view(await this.store.read(this.database.db));
  }

  /**
   * API-121. Flipping to `open` is refused with the missing prerequisites named; setting the current mode answers
   * unchanged and records no event. Existing accounts are never touched.
   */
  async setSignupMode(actor: { userId: string; requestId: string }, mode: SignupMode): Promise<SettingsView> {
    return this.database.uow.run(async (tx) => {
      const current = await this.store.read(tx, true);
      if (current.signupMode === mode) return this.view(current);
      if (mode === 'open') {
        const missing = this.missing(current.openModeVerificationId);
        if (missing.length > 0) {
          throw new DomainError(
            'signup_open_prerequisites',
            'Open signup needs its prerequisites first.',
            missing.map((field) => ({ field, code: 'missing', message: 'This prerequisite is not in place.' })),
          );
        }
      }
      await this.store.setSignupMode(tx, mode, actor.userId);
      await this.audit.record(tx, {
        actorId: actor.userId,
        actorType: 'admin',
        action: 'signup_mode.changed',
        objectType: 'platform_settings',
        objectId: null,
        outcome: 'allowed',
        requestId: actor.requestId,
      });
      return this.view({ ...current, signupMode: mode });
    });
  }

  private missing(verificationId: string | null): string[] {
    const missing: string[] = [];
    if (!this.options.emailVerificationRequired) missing.push('emailVerificationRequired');
    if (!this.options.signupRateLimitEnabled) missing.push('signupRateLimitEnabled');
    if (!this.options.abuseLimitsEnabled) missing.push('abuseLimitsEnabled');
    if (verificationId === null || verificationId === '') missing.push('verificationRecordId');
    return missing;
  }

  private view(row: { signupMode: SignupMode; openModeVerificationId: string | null }): SettingsView {
    return {
      signupMode: row.signupMode,
      accessRequestFormEnabled: this.auth.accessRequestFormEnabled,
      mfaRequiredFor: this.auth.mfaRequiredFor,
      inviteEmailDomains: this.auth.inviteEmailDomains,
      openModePrerequisites: { ...this.options, verificationRecordId: row.openModeVerificationId },
    };
  }
}
