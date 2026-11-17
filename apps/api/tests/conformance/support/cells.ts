import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ERROR_STATUS } from '../../../src/platform/http/domain-error.js';
import { ORIGIN } from '../../security/support/stack.js';
import { validRequest } from './requests.js';
import type { Account, World } from './world.js';
import type { Operation, Params } from './spec.js';
import { isAdmin, isGuarded } from './spec.js';

// A cell is one (operation, documented status) pair of the generated matrix. Its probe drives the running app until the
// operation answers that status and reports what the app said (one or more replies). The test holds every reply to the
// contract: the status, a registry code the operation may return with that status, and the envelope.

export interface Observed {
  status: number;
  code: string | undefined;
  headers: Record<string, unknown>;
  text: string;
  body: { success?: boolean; error?: { code: string; message?: string; details?: unknown[] }; metaData?: { requestId?: string; timestamp?: string }; data?: unknown };
}

export type Probe = (w: World, op: Operation) => Promise<Observed | Observed[]>;

/** Every reply the suite sees is written here; the gate (scripts/ci/api-matrix.mjs) checks that each registry code was seen. */
export const LEDGER = join(import.meta.dirname, '..', '..', '..', 'reports', 'conformance', 'observed.jsonl');

export function record(entry: { op: string; method: string; status: number; code: string | undefined; note?: string }): void {
  mkdirSync(dirname(LEDGER), { recursive: true });
  appendFileSync(LEDGER, `${JSON.stringify(entry)}\n`);
}

/** What an operation may answer with a status: its own `x-error-codes` and the common codes, of that registry status. */
const COMMON = ['unauthenticated', 'not_linked', 'account_suspended', 'account_removed', 'mfa_required', 'rate_limited', 'internal_error', 'service_unavailable', 'validation_failed', 'method_not_allowed', 'forbidden_role', 'recent_auth_required', 'not_found'];
export const allowedCodes = (op: Operation, status: number): string[] =>
  [...new Set([...op.codes, ...COMMON])].filter((code) => (ERROR_STATUS as Record<string, number>)[code] === status);

export interface SendOptions {
  params?: Params;
  mutate?: (r: ReturnType<typeof validRequest>) => void;
  extra?: Record<string, string>;
}

export async function send(w: World, op: Operation, token: string | undefined, o: SendOptions = {}): Promise<Observed> {
  const request = validRequest(op, o.params);
  o.mutate?.(request);
  const headers: Record<string, string> = { ...request.headers, ...o.extra };
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
  if (request.payload !== undefined && request.raw === undefined && headers['content-type'] === undefined) headers['content-type'] = 'application/json';
  const res = await w.raw(request.method, request.url, headers, request.raw ?? request.payload);
  const seen: Observed = { status: res.status, code: res.body.error?.code, headers: res.headers, text: res.text, body: res.body };
  record({ op: op.id, method: op.method, status: seen.status, code: seen.code });
  return seen;
}

/** The account that suits the operation's scope: an administrator for the admin routes, a user otherwise. */
export const actorFor = (w: World, op: Operation, label = 'cell'): Promise<Account> => (isAdmin(op) ? w.admin(label) : w.account(label));

export const withActor = (make: (w: World, op: Operation, who: Account) => Promise<Observed | Observed[]>): Probe => async (w, op) => make(w, op, await actorFor(w, op));

export const anonymous: Probe = async (w, op) => [
  await send(w, op, undefined),
  await send(w, op, 'not.a.token'),
  await send(w, op, undefined, { extra: { authorization: 'Basic dXNlcjpwYXNz' } }),
];

/** Administrator routes that refuse a stale sign-in today (alerts and the usage report); the others are SEC116-F2. */
export const RECENT_AUTH_ROUTES: ReadonlySet<string> = new Set(['API-125', 'API-126', 'API-130', 'API-131']);

/** An identity the provider verifies and the application does not know (no invitation, no approved request). */
export function unlinkedToken(w: World): string {
  const sub = `user_conf_unlinked_${randomUUID().slice(0, 8)}`;
  w.local.addUser(sub, `${sub}@example.test`, true);
  return w.local.issueToken({ sub, azp: ORIGIN, fva: [1, 1] });
}

/**
 * 403: every refusal that applies to the scope of the operation, each as the registry code it must carry: an unlinked identity,
 * a suspended and a removed account, a missing second factor, a stale sign-in, and (admin routes) a user token.
 */
export const forbidden: Probe = async (w, op) => {
  const seen: Observed[] = [];
  const scoped = op.scopes.includes('T') ? 'T' : 'U';
  const state = async (status: 'suspended' | 'removed'): Promise<Observed> => {
    const victim = await w.account(status);
    await w.pool.query(`update users set status = $2 where id = $1`, [victim.id, status]);
    return send(w, op, victim.token);
  };
  seen.push(await state('suspended'), await state('removed'));
  if (scoped !== 'T') {
    seen.push(await send(w, op, unlinkedToken(w)));
    const who = await actorFor(w, op, 'nofactor');
    seen.push(await send(w, op, who.noFactor));
  }
  if (isAdmin(op)) seen.push(await send(w, op, (await w.account('plain')).token));
  // Scope A also promises a recent sign-in; only the routes that enforce it are asked here (SEC116-F2 covers the rest).
  if (op.scopes.includes('U+RA') || RECENT_AUTH_ROUTES.has(op.id)) {
    const who = await actorFor(w, op, 'stale');
    seen.push(await send(w, op, w.local.issueToken({ sub: who.sub, azp: ORIGIN, fva: [600, 600] })));
  }
  return seen;
};

/** The part of the request an operation reads, if it reads any. */
export const readsInput = (op: Operation): boolean => op.pathParams.length > 0 || op.hasBody || op.paged || op.id === 'API-130' || op.id === 'API-131';

/** 400: the part of the request the operation reads, made malformed. */
export const malformed: Probe = withActor((w, op, who) => {
  const first = op.pathParams[0];
  if (first !== undefined) return send(w, op, who.token, { params: { [first]: first === 'position' ? '0' : first === 'provider' ? 'not-a-provider' : 'not-a-uuid' } });
  if (op.id === 'API-030') return send(w, op, who.token, { mutate: (r) => { const form = { name: 'other' }; void form; r.raw = Buffer.from('--x\r\nContent-Disposition: form-data; name="other"\r\n\r\nv\r\n--x--\r\n'); r.headers['content-type'] = 'multipart/form-data; boundary=x'; } });
  if (op.hasBody) return send(w, op, who.token, { mutate: (r) => { r.payload = { conformanceUnknownField: true }; } });
  if (op.id === 'API-130' || op.id === 'API-131') return send(w, op, who.token, { mutate: (r) => { r.url += '?from=not-a-date'; } });
  return send(w, op, who.token, { mutate: (r) => { r.url += '?limit=0'; } });
});

/** Input an operation that reads none still receives (a stray query, header or body): ignored, never a 400. */
export const unreadInput: Probe = withActor((w, op, who) => send(w, op, who.token, { mutate: (r) => { r.url += '?limit=0&cursor=zzz&x=%'; }, extra: { 'idempotency-key': '!', 'if-match': 'garbage' } }));

/** 404: a record that does not exist (the same answer a record of another owner gets, see the authorization matrix). */
export const missing: Probe = withActor((w, op, who) => send(w, op, who.token));

/** 429: the account's general limit is used up in the current window. */
export const limited: Probe = withActor(async (w, op, who) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const start = Math.floor(Date.now() / 60_000) * 60_000;
    await w.pool.query(
      `insert into rate_limit_buckets (scope, subject, window_start, count) values ('general-user', $1, to_timestamp($2 / 1000.0), 100000) on conflict (scope, subject, window_start) do update set count = 100000`,
      [who.id, start],
    );
    const seen = await send(w, op, who.token);
    if (seen.status === 429 || Math.floor(Date.now() / 60_000) * 60_000 === start) return seen;
  }
  throw new Error('the rate-limit window moved three times in a row');
});

/** 500: an internal failure behind the guard of the account lookup (a column the lookup reads is gone for the call). */
export const internal: Probe = withActor(async (w, op, who) => {
  await w.pool.query('alter table users rename column updated_at to updated_at_zz');
  try {
    return await send(w, op, who.token);
  } finally {
    await w.pool.query('alter table users rename column updated_at_zz to updated_at');
  }
});

/** 503: the rate-limit store is unreachable; the request is refused rather than let through. */
export const unavailable: Probe = withActor(async (w, op, who) => {
  await w.pool.query('alter table rate_limit_buckets rename to rate_limit_buckets_zz');
  try {
    return await send(w, op, who.token);
  } finally {
    await w.pool.query('alter table rate_limit_buckets_zz rename to rate_limit_buckets');
  }
});

/** The probe for a documented status that every guarded operation shares. */
export function genericProbe(op: Operation, status: number): Probe | undefined {
  if (!isGuarded(op)) return undefined;
  switch (status) {
    case 400: return readsInput(op) ? malformed : unreadInput;
    case 401: return anonymous;
    case 403: return forbidden;
    case 404: return op.pathParams.length > 0 ? missing : undefined;
    case 429: return limited;
    case 500: return internal;
    case 503: return unavailable;
    default: return undefined;
  }
}
