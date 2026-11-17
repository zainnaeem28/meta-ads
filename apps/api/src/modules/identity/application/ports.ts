import type { DbTx } from '../../../platform/db/index.js';

/** A transaction handle, or the pool-backed database for a single statement. */
export type Db = Pick<DbTx, 'select' | 'insert' | 'update' | 'execute'>;

export interface UserRecord {
  readonly id: string;
  readonly idpSubject: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
}

export interface InvitationRecord {
  readonly id: string;
  readonly expiresAt: Date;
}

export interface SettingsRecord {
  readonly signupMode: string;
  readonly firstAdminSeededAt: Date | null;
}

// The module-private repositories (infrastructure) satisfy these structurally; the application never imports them.
export interface UserStore {
  findBySubject(db: Db, idpSubject: string): Promise<UserRecord | undefined>;
  insertIfAbsent(
    db: Db,
    user: {
      id: string;
      idpSubject: string;
      email: string;
      role?: 'user' | 'admin';
      linkedVia: string;
    },
  ): Promise<UserRecord | undefined>;
  countActiveAdmins(db: Db): Promise<number>;
}

export interface InvitationStore {
  findInvitedByEmail(db: Db, email: string): Promise<InvitationRecord | undefined>;
  transition(db: Db, id: string, to: 'accepted', acceptedUserId: string | null): Promise<boolean>;
}

export interface SettingsStore {
  get(db: Db): Promise<SettingsRecord>;
  markFirstAdminSeeded(db: Db): Promise<boolean>;
}

export type AccessRequestView = 'none' | 'pending' | 'declined';

export interface AccessRequestLookup {
  /** State of the subject's latest access request. */
  stateOfSubject(db: Db, idpSubject: string): Promise<AccessRequestView>;
}

export interface KeyNotice {
  readonly provider: 'openai' | 'wavespeed';
  readonly status: 'disabled' | 'missing';
}

/** The provider-keys module (a higher layer) binds this to its key notices; until then there are none. */
export interface KeyNoticePort {
  noticesFor(userId: string): Promise<readonly KeyNotice[]>;
}

export const USER_STORE = Symbol('USER_STORE');
export const INVITATION_STORE = Symbol('INVITATION_STORE');
export const SETTINGS_STORE = Symbol('SETTINGS_STORE');
export const ACCESS_REQUEST_LOOKUP = Symbol('ACCESS_REQUEST_LOOKUP');
export const KEY_NOTICE_PORT = Symbol('KEY_NOTICE_PORT');
export const AUTH_OPTIONS = Symbol('AUTH_OPTIONS');

/** Configuration the guard and linking read (registry: OWNER_EMAIL, MFA_REQUIRED_FOR, RECENT_AUTH_MAX_AGE_MIN, ...). */
export interface AuthOptions {
  readonly ownerEmail: string | undefined;
  readonly mfaRequiredFor: 'all' | 'admins';
  readonly recentAuthMaxAgeMin: number;
  readonly inviteEmailDomains: readonly string[];
  readonly accessRequestFormEnabled: boolean;
  /** `WEB_ORIGIN`: the only `azp` a token may carry. */
  readonly webOrigin: string | undefined;
}

export function authOptionsFrom(
  env: Readonly<Record<string, string | undefined>>,
  webOrigin: string | undefined,
): AuthOptions {
  const mfa = env['MFA_REQUIRED_FOR'];
  const minutes = Number(env['RECENT_AUTH_MAX_AGE_MIN'] ?? '10');
  if (mfa !== undefined && mfa !== '' && mfa !== 'all' && mfa !== 'admins') {
    throw new Error('MFA_REQUIRED_FOR must be all or admins');
  }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
    throw new Error('RECENT_AUTH_MAX_AGE_MIN must be an integer from 1 to 60');
  }
  const owner = env['OWNER_EMAIL']?.trim().toLowerCase();
  return {
    ownerEmail: owner === undefined || owner === '' ? undefined : owner,
    mfaRequiredFor: mfa === 'admins' ? 'admins' : 'all',
    recentAuthMaxAgeMin: minutes,
    inviteEmailDomains: (env['INVITE_EMAIL_DOMAINS'] ?? '')
      .split(',')
      .map((domain) => domain.trim().toLowerCase())
      .filter((domain) => domain !== ''),
    accessRequestFormEnabled: env['ACCESS_REQUEST_FORM_ENABLED'] === 'true',
    webOrigin,
  };
}
