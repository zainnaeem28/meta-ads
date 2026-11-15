import { randomUUID } from 'node:crypto';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { bigint, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import pg from 'pg';

// Foundation stand-in for the API's auth, owner-scoped CRUD and error-envelope behaviour
// (ARCHITECTURE §1.8, §3.5). It is not product code: the product API is a later ticket. It uses the
// real Fastify 5, the real @clerk/backend verifyToken/Backend client (against the local fake),
// Drizzle and a real PostgreSQL connection as the `app_api` role.
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkUserId: text('clerk_user_id').notNull().unique(),
  email: text('email').notNull(),
  role: text('role').notNull(),
});

export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const RECENT_AUTH_MAX_AGE_MIN = 10;

export interface AppOptions {
  databaseUrl: string;
  clerkApiUrl: string;
  clerkSecretKey: string;
  webOrigin: string;
  ownerEmail: string;
}

export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Actor {
  userId: string;
  clerkUserId: string;
  role: 'admin' | 'user';
  sessionId: string;
  fva: [number, number];
  mfaSatisfied: boolean;
  recentAuth: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
}

/** `fva` semantics of ARCHITECTURE §1.8: [minutes since first factor, minutes since second factor], -1 = none. */
export function evaluateFva(fva: [number, number], mfaRequiredForActor: boolean) {
  const mfaSatisfied = fva[1] >= 0;
  const recentAuth =
    fva[0] >= 0 &&
    fva[0] <= RECENT_AUTH_MAX_AGE_MIN &&
    (mfaRequiredForActor ? mfaSatisfied && fva[1] <= RECENT_AUTH_MAX_AGE_MIN : true);
  return { mfaSatisfied, recentAuth };
}

export async function buildApp(options: AppOptions): Promise<{
  app: FastifyInstance;
  pool: pg.Pool;
  close: () => Promise<void>;
}> {
  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 5 });
  const db = drizzle(pool);
  const clerk = createClerkClient({
    secretKey: options.clerkSecretKey,
    apiUrl: options.clerkApiUrl,
  });
  const app = Fastify({ logger: false, genReqId: () => randomUUID() });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof DomainError) {
      return reply
        .status(error.status)
        .send({ error: { code: error.code, message: error.message, requestId: request.id } });
    }
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    return reply.status(status).send({
      error: {
        code: status === 500 ? 'internal_error' : 'bad_request',
        message: status === 500 ? 'Internal error' : error.message,
        requestId: request.id,
      },
    });
  });
  app.setNotFoundHandler((request, reply) =>
    reply
      .status(404)
      .send({ error: { code: 'not_found', message: 'Not found', requestId: request.id } }),
  );
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  async function resolveActor(request: FastifyRequest): Promise<Actor> {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new DomainError(401, 'unauthenticated', 'Sign in required');
    let payload: { sub: string; sid?: string; fva?: unknown };
    try {
      payload = (await verifyToken(token, {
        secretKey: options.clerkSecretKey,
        apiUrl: options.clerkApiUrl,
        authorizedParties: [options.webOrigin],
        clockSkewInMs: 5000,
      })) as { sub: string; sid?: string; fva?: unknown };
    } catch {
      throw new DomainError(401, 'unauthenticated', 'Sign in required');
    }
    const sid = payload.sid;
    const fvaRaw = payload.fva;
    if (
      !sid ||
      !Array.isArray(fvaRaw) ||
      fvaRaw.length !== 2 ||
      !fvaRaw.every((n) => typeof n === 'number')
    )
      throw new DomainError(401, 'unauthenticated', 'Sign in required');
    // A revoked session or a deleted user must stop working at once, not at token expiry.
    try {
      const session = await clerk.sessions.getSession(sid);
      if (session.status !== 'active') throw new Error('inactive');
    } catch {
      throw new DomainError(401, 'unauthenticated', 'Sign in required');
    }
    let row = (await db.select().from(users).where(eq(users.clerkUserId, payload.sub)))[0];
    if (!row) row = await linkFirstAdmin(payload.sub);
    const role = row.role as 'admin' | 'user';
    const fva = fvaRaw as [number, number];
    const { mfaSatisfied, recentAuth } = evaluateFva(fva, role === 'admin');
    return {
      userId: row.id,
      clerkUserId: row.clerkUserId,
      role,
      sessionId: sid,
      fva,
      mfaSatisfied,
      recentAuth,
    };
  }

  /** Link the first admin: the verified Clerk email equals OWNER_EMAIL and no admin exists yet. */
  async function linkFirstAdmin(clerkUserId: string) {
    const clerkUser = await clerk.users.getUser(clerkUserId);
    const primary = clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId);
    const verified = primary?.verification?.status === 'verified';
    if (
      !primary ||
      !verified ||
      primary.emailAddress.toLowerCase() !== options.ownerEmail.toLowerCase()
    )
      throw new DomainError(403, 'account_not_active', 'This account cannot use the service');
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(7603)`);
      const admins = await tx.select().from(users).where(eq(users.role, 'admin'));
      if (admins.length > 0)
        throw new DomainError(403, 'account_not_active', 'This account cannot use the service');
      const [created] = await tx
        .insert(users)
        .values({ clerkUserId, email: primary.emailAddress, role: 'admin' })
        .returning();
      if (!created) throw new Error('insert failed');
      return created;
    });
  }

  const actorOf = (request: FastifyRequest): Actor => {
    if (!request.actor) throw new DomainError(401, 'unauthenticated', 'Sign in required');
    return request.actor;
  };
  const requireAdmin = (a: Actor) => {
    if (a.role !== 'admin') throw new DomainError(403, 'forbidden', 'Not allowed');
    if (!a.mfaSatisfied) throw new DomainError(403, 'mfa_required', 'Second factor required');
  };
  const requireRecent = (a: Actor) => {
    if (!a.recentAuth)
      throw new DomainError(403, 'recent_auth_required', 'Please confirm it is you');
  };

  app.addHook('preHandler', async (request) => {
    if (request.routeOptions.url?.startsWith('/health')) return;
    if (request.method === 'OPTIONS' || !request.routeOptions.url) return;
    request.actor = await resolveActor(request);
  });

  app.get('/health/live', async () => ({ data: { status: 'ok' } }));
  app.get('/v1/me', async (request) => {
    const a = actorOf(request);
    return {
      data: {
        id: a.userId,
        role: a.role,
        mfaSatisfied: a.mfaSatisfied,
        recentAuth: a.recentAuth,
      },
    };
  });

  // Admin: invitations (expiresInDays 7) and user deletion, each behind recent authentication.
  app.post('/v1/admin/invitations', async (request, reply) => {
    const a = actorOf(request);
    requireAdmin(a);
    requireRecent(a);
    const { email } = (request.body ?? {}) as { email?: unknown };
    if (typeof email !== 'string' || !email.includes('@'))
      throw new DomainError(400, 'validation_failed', 'email is required');
    const invitation = await clerk.invitations.createInvitation({
      emailAddress: email,
      expiresInDays: 7,
      notify: false,
    });
    return reply.status(201).send({ data: { id: invitation.id, status: invitation.status } });
  });
  app.delete('/v1/admin/invitations/:id', async (request, reply) => {
    const a = actorOf(request);
    requireAdmin(a);
    requireRecent(a);
    const { id } = request.params as { id: string };
    try {
      await clerk.invitations.revokeInvitation(id);
    } catch {
      throw new DomainError(404, 'not_found', 'Not found');
    }
    return reply.status(204).send();
  });
  app.delete('/v1/admin/users/:id', async (request, reply) => {
    const a = actorOf(request);
    requireAdmin(a);
    requireRecent(a);
    const { id } = request.params as { id: string };
    const row = (await db.select().from(users).where(eq(users.id, id)))[0];
    if (!row) throw new DomainError(404, 'not_found', 'Not found');
    if (row.id === a.userId) throw new DomainError(409, 'conflict', 'Cannot remove yourself');
    await clerk.users.deleteUser(row.clerkUserId);
    await db.delete(users).where(eq(users.id, id));
    return reply.status(204).send();
  });

  // Owner-scoped CRUD (API-021/022/023 shape): envelope, 404 concealment, If-Match, cursor paging.
  const toDto = (c: typeof campaigns.$inferSelect) => ({
    id: c.id,
    name: c.name,
    version: c.version,
    createdAt: c.createdAt.toISOString(),
  });
  const etag = (c: { id: string; version: number }) => `"${c.id}-v${c.version}"`;
  const sendOne = (reply: FastifyReply, c: typeof campaigns.$inferSelect, status = 200) =>
    reply
      .status(status)
      .header('etag', etag(c))
      .send({ data: toDto(c) });
  const idParam = (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DomainError(404, 'not_found', 'Not found');
    return id;
  };
  const named = (body: unknown) => {
    const name = (body as { name?: unknown } | null)?.name;
    if (typeof name !== 'string' || name.trim() === '' || name.length > 120)
      throw new DomainError(400, 'validation_failed', 'name must be 1 to 120 characters');
    return name.trim();
  };

  app.post('/v1/campaigns', async (request, reply) => {
    const a = actorOf(request);
    const [row] = await db
      .insert(campaigns)
      .values({ ownerId: a.userId, name: named(request.body) })
      .returning();
    if (!row) throw new Error('insert failed');
    return sendOne(reply.header('location', `/v1/campaigns/${row.id}`), row, 201);
  });
  app.get('/v1/campaigns', async (request) => {
    const a = actorOf(request);
    const q = request.query as { limit?: string; cursor?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 20) || 20, 1), 100);
    let after = 0;
    if (q.cursor !== undefined) {
      const text = Buffer.from(q.cursor, 'base64url').toString('utf8');
      const decoded = Number(text);
      if (!/^\d{1,15}$/.test(text) || !Number.isSafeInteger(decoded))
        throw new DomainError(400, 'invalid_cursor', 'Invalid cursor');
      after = decoded;
    }
    const rows = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.ownerId, a.userId), gt(campaigns.seq, after)))
      .orderBy(asc(campaigns.seq))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: page.map(toDto),
      meta: {
        nextCursor:
          rows.length > limit && last ? Buffer.from(String(last.seq)).toString('base64url') : null,
      },
    };
  });
  async function owned(a: Actor, id: string) {
    // A record of someone else answers exactly like one that does not exist.
    const row = (
      await db
        .select()
        .from(campaigns)
        .where(and(eq(campaigns.id, id), eq(campaigns.ownerId, a.userId)))
    )[0];
    if (!row) throw new DomainError(404, 'not_found', 'Not found');
    return row;
  }
  app.get('/v1/campaigns/:id', async (request, reply) =>
    sendOne(reply, await owned(actorOf(request), idParam(request))),
  );
  app.patch('/v1/campaigns/:id', async (request, reply) => {
    const a = actorOf(request);
    const id = idParam(request);
    const current = await owned(a, id);
    const match = request.headers['if-match'];
    if (!match) throw new DomainError(428, 'precondition_required', 'If-Match is required');
    if (match !== etag(current))
      throw new DomainError(412, 'precondition_failed', 'The record changed; reload it');
    const [row] = await db
      .update(campaigns)
      .set({ name: named(request.body), version: sql`${campaigns.version} + 1` })
      .where(
        and(
          eq(campaigns.id, id),
          eq(campaigns.ownerId, a.userId),
          eq(campaigns.version, current.version),
        ),
      )
      .returning();
    // A concurrent writer between the read and the update lost the version check.
    if (!row) throw new DomainError(412, 'precondition_failed', 'The record changed; reload it');
    return sendOne(reply, row);
  });
  app.delete('/v1/campaigns/:id', async (request, reply) => {
    const a = actorOf(request);
    const id = idParam(request);
    await owned(a, id);
    await db.delete(campaigns).where(and(eq(campaigns.id, id), eq(campaigns.ownerId, a.userId)));
    return reply.status(204).send();
  });

  await app.ready();
  return {
    app,
    pool,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}
