import { ERROR_STATUS } from '../../../src/platform/http/domain-error.js';
import { validRequest } from './requests.js';
import type { Account, World } from './world.js';
import type { Operation, Params } from './spec.js';
import { isAdmin, isGuarded } from './spec.js';

// A cell is one (operation, documented status) pair of the generated matrix. Its probe drives the running app until the
// operation answers that status, and reports what the app said. The test then holds the reply to the contract: the status, a
// registry code that the operation may return with that status, and the envelope.

export interface Observed {
  status: number;
  code: string | undefined;
  headers: Record<string, unknown>;
  text: string;
  body: { success?: boolean; error?: { code: string }; metaData?: { requestId?: string } };
}

export type Probe = (w: World, op: Operation) => Promise<Observed>;

/** What an operation may answer with a status: its own `x-error-codes` and the common codes, of that registry status. */
const COMMON = ['unauthenticated', 'not_linked', 'account_suspended', 'account_removed', 'mfa_required', 'rate_limited', 'internal_error', 'service_unavailable', 'validation_failed', 'method_not_allowed'];
export const allowedCodes = (op: Operation, status: number): string[] =>
  [...new Set([...op.codes, ...COMMON])].filter((code) => (ERROR_STATUS as Record<string, number>)[code] === status);

export async function send(w: World, op: Operation, token: string | undefined, overrides: { params?: Params; mutate?: (r: ReturnType<typeof validRequest>) => void; extra?: Record<string, string> } = {}): Promise<Observed> {
  const request = validRequest(op, overrides.params);
  overrides.mutate?.(request);
  const headers: Record<string, string> = { ...request.headers, ...overrides.extra };
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
  const payload = request.raw ?? request.payload;
  if (request.payload !== undefined && request.raw === undefined && headers['content-type'] === undefined) headers['content-type'] = 'application/json';
  const res = await w.raw(request.method, request.url, headers, payload);
  return { status: res.status, code: res.body.error?.code, headers: res.headers, text: res.text, body: res.body };
}

/** The account that suits the operation's scope: an administrator for the admin routes, a user otherwise. */
export const actorFor = (w: World, op: Operation): Promise<Account> => (isAdmin(op) ? w.admin('cell') : w.account('cell'));

const withActor = (make: (w: World, op: Operation, who: Account) => Promise<Observed>): Probe => async (w, op) => make(w, op, await actorFor(w, op));

export const anonymous: Probe = (w, op) => send(w, op, undefined);

/** 403: an administrator route called by a user; any other route by a suspended account. */
export const forbidden: Probe = async (w, op) => {
  if (isAdmin(op)) return send(w, op, (await w.account('plain')).token);
  const victim = await w.account('suspended');
  await w.pool.query(`update users set status = 'suspended' where id = $1`, [victim.id]);
  return send(w, op, victim.token);
};

/** 400: the part of the request the operation reads, made malformed. */
export const malformed: Probe = withActor((w, op, who) => {
  const first = op.pathParams[0];
  if (first !== undefined) return send(w, op, who.token, { params: { [first]: first === 'position' ? '0' : first === 'provider' ? 'not-a-provider' : 'not-a-uuid' } });
  if (op.id === 'API-030') return send(w, op, who.token, { mutate: (r) => { r.raw = Buffer.from('--x\r\nContent-Disposition: form-data; name="other"\r\n\r\nv\r\n--x--\r\n'); r.headers['content-type'] = 'multipart/form-data; boundary=x'; } });
  if (op.hasBody || !op.paged) return send(w, op, who.token, { mutate: (r) => { r.raw = Buffer.from('{"broken'); r.headers['content-type'] = 'application/json'; } });
  return send(w, op, who.token, { mutate: (r) => { r.url += '?limit=0'; } });
});

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
    case 400: return malformed;
    case 401: return anonymous;
    case 403: return forbidden;
    case 404: return op.pathParams.length > 0 ? missing : undefined;
    case 429: return limited;
    case 500: return internal;
    case 503: return unavailable;
    default: return undefined;
  }
}
