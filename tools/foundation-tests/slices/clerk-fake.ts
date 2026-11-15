import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { generateKeyPairSync, createSign, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

// Local stand-in for the Clerk JWKS endpoint and the parts of the Backend API the slice uses. No
// Clerk account, key or instance is involved: this is the "local JWKS fake" of the ticket. Whether the
// real Clerk behaves the same is the NOT_RUN deployment-time owner item DOP-OI-4.
export interface FakeUser {
  id: string;
  email: string;
  verified: boolean;
}
export interface FakeInvitation {
  id: string;
  email: string;
  status: 'pending' | 'revoked';
  expiresInDays: number;
}
export interface FakeSession {
  id: string;
  userId: string;
  status: 'active' | 'revoked';
}
export interface RecordedCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

export class ClerkFake {
  readonly kid = `ins_${randomBytes(6).toString('hex')}`;
  readonly secretKey = `sk_test_${randomBytes(12).toString('hex')}`;
  readonly users = new Map<string, FakeUser>();
  readonly sessions = new Map<string, FakeSession>();
  readonly invitations = new Map<string, FakeInvitation>();
  readonly calls: RecordedCall[] = [];
  /** Per-user "factors enrolled" so reverification can model a second factor. */
  private readonly privateKey: KeyObject;
  private readonly jwk: Record<string, unknown>;
  private server: Server | undefined;
  url = '';

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    this.jwk = { ...publicKey.export({ format: 'jwk' }), kid: this.kid, use: 'sig', alg: 'RS256' };
  }

  addUser(email: string, verified = true): FakeUser {
    const user = { id: `user_${randomBytes(8).toString('hex')}`, email, verified };
    this.users.set(user.id, user);
    return user;
  }

  addSession(userId: string): FakeSession {
    const session = {
      id: `sess_${randomBytes(8).toString('hex')}`,
      userId,
      status: 'active' as const,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** A session token as Clerk would issue it. `fva` is [minutes since first factor, minutes since second factor]. */
  mint(
    session: FakeSession,
    options: { fva?: [number, number]; ttlSeconds?: number; azp?: string; iatOffset?: number } = {},
  ): string {
    const now = Math.floor(Date.now() / 1000) + (options.iatOffset ?? 0);
    // `cat` marks a session token in @clerk/backend 3 (JWT_CATEGORY_SESSION_TOKEN); other categories are refused.
    const header = { alg: 'RS256', typ: 'JWT', kid: this.kid, cat: 'cl_B7d4PD111AAA' };
    const payload = {
      sub: session.userId,
      sid: session.id,
      fva: options.fva ?? [0, -1],
      azp: options.azp ?? 'http://web.test',
      iss: 'https://clerk.fake.test',
      iat: now,
      nbf: now - 1,
      exp: now + (options.ttlSeconds ?? 60),
    };
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const body = `${part(header)}.${part(payload)}`;
    const signature = createSign('RSA-SHA256')
      .update(body)
      .sign(this.privateKey)
      .toString('base64url');
    return `${body}.${signature}`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ({ status, json }) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(json));
        },
        (error: unknown) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ errors: [{ message: String(error) }] }));
        },
      );
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  private userJson(u: FakeUser) {
    const emailId = `idn_${u.id.slice(5)}`;
    return {
      object: 'user',
      id: u.id,
      primary_email_address_id: emailId,
      email_addresses: [
        {
          object: 'email_address',
          id: emailId,
          email_address: u.email,
          verification: { status: u.verified ? 'verified' : 'unverified', strategy: 'email_code' },
          linked_to: [],
        },
      ],
      phone_numbers: [],
      web3_wallets: [],
      external_accounts: [],
      created_at: 0,
      updated_at: 0,
    };
  }

  private sessionJson(s: FakeSession) {
    return {
      object: 'session',
      id: s.id,
      user_id: s.userId,
      client_id: 'client_1',
      status: s.status,
    };
  }

  private invitationJson(i: FakeInvitation) {
    return {
      object: 'invitation',
      id: i.id,
      email_address: i.email,
      status: i.status,
      created_at: 0,
      updated_at: 0,
    };
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; json: unknown }> {
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    const method = req.method ?? 'GET';
    this.calls.push({ method, path: url.pathname, body });
    const notFound = {
      status: 404,
      json: { errors: [{ code: 'resource_not_found', message: 'not found' }] },
    };
    const bad = (code: string) => ({ status: 422, json: { errors: [{ code, message: code }] } });

    if (url.pathname === '/v1/jwks') return { status: 200, json: { keys: [this.jwk] } };
    // Every other Backend API call needs the instance secret key.
    if (req.headers.authorization !== `Bearer ${this.secretKey}`)
      return {
        status: 401,
        json: { errors: [{ code: 'authentication_invalid', message: 'bad key' }] },
      };

    let m = /^\/v1\/users\/([^/]+)$/.exec(url.pathname);
    if (m?.[1]) {
      const user = this.users.get(m[1]);
      if (!user) return notFound;
      if (method === 'GET') return { status: 200, json: this.userJson(user) };
      if (method === 'DELETE') {
        this.users.delete(m[1]);
        // Clerk ends the deleted user's sessions with the user.
        for (const s of this.sessions.values()) if (s.userId === m[1]) s.status = 'revoked';
        return { status: 200, json: { object: 'deleted_object', id: m[1], deleted: true } };
      }
    }
    m = /^\/v1\/sessions\/([^/]+)(\/revoke)?$/.exec(url.pathname);
    if (m?.[1]) {
      const session = this.sessions.get(m[1]);
      if (!session) return notFound;
      if (m[2] && method === 'POST') {
        session.status = 'revoked';
        return { status: 200, json: this.sessionJson(session) };
      }
      if (!m[2] && method === 'GET') return { status: 200, json: this.sessionJson(session) };
    }
    if (url.pathname === '/v1/invitations' && method === 'POST') {
      const email = body?.['email_address'];
      const days = body?.['expires_in_days'];
      if (typeof email !== 'string') return bad('form_param_missing');
      if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365)
        return bad('form_param_value_invalid');
      const invitation: FakeInvitation = {
        id: `inv_${randomBytes(6).toString('hex')}`,
        email,
        status: 'pending',
        expiresInDays: days,
      };
      this.invitations.set(invitation.id, invitation);
      return { status: 200, json: this.invitationJson(invitation) };
    }
    m = /^\/v1\/invitations\/([^/]+)\/revoke$/.exec(url.pathname);
    if (m?.[1] && method === 'POST') {
      const invitation = this.invitations.get(m[1]);
      if (!invitation) return notFound;
      if (invitation.status !== 'pending') return bad('invitation_already_revoked');
      invitation.status = 'revoked';
      return { status: 200, json: this.invitationJson(invitation) };
    }
    return notFound;
  }
}
