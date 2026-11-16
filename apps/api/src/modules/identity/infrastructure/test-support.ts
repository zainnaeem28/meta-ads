import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  IdentityNotFound,
  IdentityTokenInvalid,
  IdentityUnavailable,
} from '../domain/identity-port.js';
import type { IdentityPort } from '../domain/identity-port.js';
import type { LocalIdentity } from './local-identity.js';

export interface ClerkStub {
  readonly url: string;
  /** Milliseconds every answer is held back, to prove the 3 s bound. */
  delayMs: number;
  /** When set, every request is answered with this status. */
  failWith: number | undefined;
  readonly requests: string[];
  close(): Promise<void>;
}

const NOW = 1_700_000_000_000;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}

const notFound = { errors: [{ code: 'resource_not_found', message: 'not found' }] };

/** A Clerk Backend API double backed by a `LocalIdentity` directory: the real `@clerk/backend` client talks to it over HTTP. */
export async function startClerkStub(backing: LocalIdentity): Promise<ClerkStub> {
  const sessions = new Map<string, { id: string; sub: string; revoked: boolean }>();
  const stub: ClerkStub = {
    url: '',
    delayMs: 0,
    failWith: undefined,
    requests: [],
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const path = url.pathname;
      stub.requests.push(`${req.method ?? ''} ${path}`);
      if (stub.delayMs > 0) await new Promise((r) => setTimeout(r, stub.delayMs));
      if (stub.failWith !== undefined)
        return send(res, stub.failWith, { errors: [{ code: 'boom', message: 'x' }] });
      const body = await readBody(req);
      let match: RegExpExecArray | null;
      if (req.method === 'GET' && path === '/v1/jwks') return send(res, 200, backing.jwks());
      if (req.method === 'GET' && (match = /^\/v1\/users\/([^/]+)$/.exec(path)) !== null) {
        const user = backing.users.get(decodeURIComponent(match[1] as string));
        if (user === undefined) return send(res, 404, notFound);
        return send(res, 200, {
          object: 'user',
          id: user.sub,
          primary_email_address_id: 'idn_1',
          email_addresses:
            user.email === null
              ? []
              : [
                  {
                    object: 'email_address',
                    id: 'idn_1',
                    email_address: user.email,
                    verification: {
                      status: user.emailVerified ? 'verified' : 'unverified',
                      strategy: 'email_code',
                    },
                    linked_to: [],
                  },
                ],
          phone_numbers: [],
          web3_wallets: [],
          external_accounts: [],
          saml_accounts: [],
          passkeys: [],
          created_at: NOW,
          updated_at: NOW,
        });
      }
      if (req.method === 'DELETE' && (match = /^\/v1\/users\/([^/]+)$/.exec(path)) !== null) {
        const sub = decodeURIComponent(match[1] as string);
        if (!backing.users.delete(sub)) return send(res, 404, notFound);
        return send(res, 200, { object: 'deleted_object', id: sub, deleted: true });
      }
      if (req.method === 'POST' && path === '/v1/invitations') {
        const id = await backing.createInvitation(
          String(body['email_address']),
          Number(body['expires_in_days']),
        );
        return send(res, 200, {
          object: 'invitation',
          id,
          email_address: body['email_address'],
          status: 'pending',
          created_at: NOW,
          updated_at: NOW,
        });
      }
      if (
        req.method === 'POST' &&
        (match = /^\/v1\/invitations\/([^/]+)\/revoke$/.exec(path)) !== null
      ) {
        const id = decodeURIComponent(match[1] as string);
        try {
          await backing.revokeInvitation(id);
        } catch {
          return send(res, 404, notFound);
        }
        return send(res, 200, {
          object: 'invitation',
          id,
          email_address: 'x@example.test',
          status: 'revoked',
          created_at: NOW,
          updated_at: NOW,
        });
      }
      if (req.method === 'GET' && path === '/v1/sessions') {
        const sub = url.searchParams.get('user_id') ?? '';
        const mine = [...sessions.values()].filter((s) => s.sub === sub && !s.revoked);
        if (mine.length === 0 && backing.users.has(sub)) {
          const created = { id: `sess_${sub}`, sub, revoked: false };
          sessions.set(created.id, created);
          mine.push(created);
        }
        return send(res, 200, {
          data: mine.map((s) => ({
            object: 'session',
            id: s.id,
            user_id: s.sub,
            client_id: 'client_1',
            status: 'active',
            last_active_at: NOW,
            expire_at: NOW,
            abandon_at: NOW,
            created_at: NOW,
            updated_at: NOW,
          })),
          total_count: mine.length,
        });
      }
      if (
        req.method === 'POST' &&
        (match = /^\/v1\/sessions\/([^/]+)\/revoke$/.exec(path)) !== null
      ) {
        const session = sessions.get(decodeURIComponent(match[1] as string));
        if (session === undefined) return send(res, 404, notFound);
        session.revoked = true;
        backing.sessionRevocations.push(session.sub);
        return send(res, 200, {
          object: 'session',
          id: session.id,
          user_id: session.sub,
          client_id: 'client_1',
          status: 'revoked',
          last_active_at: NOW,
          expire_at: NOW,
          abandon_at: NOW,
          created_at: NOW,
          updated_at: NOW,
        });
      }
      return send(res, 404, notFound);
    })().catch(() => send(res, 500, { errors: [{ code: 'stub', message: 'stub failure' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  (stub as { url: string }).url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stub;
}

/** What every `IdentityPort` adapter must do (ARCHITECTURE §1.3). `seed` makes the provider hold a user. */
export function identityContract(
  name: string,
  setup: () => Promise<{
    port: IdentityPort;
    local: LocalIdentity;
    outage(on: boolean): void;
    stop(): Promise<void>;
  }>,
): void {
  describe(`IdentityPort contract: ${name}`, () => {
    it('verifies a token and returns its claims', async () => {
      const { port, local, stop } = await setup();
      try {
        const claims = await port.verifyToken(
          local.issueToken({
            sub: 'user_a',
            sid: 'sess_a',
            fva: [3, 1],
            azp: 'http://localhost:3000',
          }),
        );
        expect(claims).toMatchObject({
          sub: 'user_a',
          sid: 'sess_a',
          fva: [3, 1],
          azp: 'http://localhost:3000',
        });
        expect(claims.exp).toBeGreaterThan(claims.iat);
        const bare = await port.verifyToken(local.issueToken({ sub: 'user_b' }));
        expect(bare).toMatchObject({ sub: 'user_b', fva: null, azp: null });
      } finally {
        await stop();
      }
    });

    it('refuses bad tokens as IdentityTokenInvalid', async () => {
      const { port, local, stop } = await setup();
      try {
        const good = local.issueToken({ sub: 'user_a' });
        const [h, p, s] = good.split('.') as [string, string, string];
        const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'admin', sid: 's', iss: local.issuer, iat: 1, exp: 9_999_999_999 })).toString('base64url')}.${s}`;
        const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'k' })).toString('base64url')}.${p}.`;
        const cases = [
          'not-a-token',
          'a.b.c',
          forged,
          none,
          local.issueToken({
            sub: 'u',
            ttlSeconds: -3600,
            iat: Math.floor(Date.now() / 1000) - 7200,
          }),
          local.issueToken({ sub: 'u', issuer: 'https://other.example.test' }),
          local.issueToken({ sub: 'u', kid: 'unknown-key' }),
          local.issueToken({ sub: 'u', iat: Math.floor(Date.now() / 1000) + 3600 }),
          local.issueToken({ sub: 'u', azp: 'https://evil.example.test' }),
        ];
        for (const token of cases)
          await expect(port.verifyToken(token)).rejects.toBeInstanceOf(IdentityTokenInvalid);
      } finally {
        await stop();
      }
    });

    it('reads a user, and says IdentityNotFound for an unknown one', async () => {
      const { port, local, stop } = await setup();
      try {
        local.addUser('user_a', 'ada@example.test', true);
        local.addUser('user_b', 'bob@example.test', false);
        expect(await port.getUser('user_a')).toEqual({
          primaryEmail: 'ada@example.test',
          emailVerified: true,
        });
        expect(await port.getUser('user_b')).toEqual({
          primaryEmail: 'bob@example.test',
          emailVerified: false,
        });
        await expect(port.getUser('user_missing')).rejects.toBeInstanceOf(IdentityNotFound);
      } finally {
        await stop();
      }
    });

    it('creates and revokes an invitation', async () => {
      const { port, local, stop } = await setup();
      try {
        const id = await port.createInvitation(
          'new@example.test',
          7,
          'http://localhost:3000/welcome',
        );
        expect(id).toMatch(/^inv_/);
        expect(local.invitations.get(id)).toMatchObject({
          email: 'new@example.test',
          expiresInDays: 7,
          revoked: false,
        });
        await port.revokeInvitation(id);
        expect(local.invitations.get(id)?.revoked).toBe(true);
        await expect(port.revokeInvitation('inv_missing')).rejects.toBeInstanceOf(IdentityNotFound);
      } finally {
        await stop();
      }
    });

    it('ends sessions, and deletes a user once', async () => {
      const { port, local, stop } = await setup();
      try {
        local.addUser('user_a', 'ada@example.test');
        await port.revokeSessions('user_a');
        expect(local.sessionRevocations).toContain('user_a');
        await port.revokeSessions('user_nobody');
        await port.deleteUser('user_a');
        expect(local.users.has('user_a')).toBe(false);
        await expect(port.deleteUser('user_a')).rejects.toBeInstanceOf(IdentityNotFound);
      } finally {
        await stop();
      }
    });

    it('reports an outage as IdentityUnavailable and recovers', async () => {
      const { port, local, outage, stop } = await setup();
      try {
        local.addUser('user_a', 'ada@example.test');
        outage(true);
        await expect(port.getUser('user_a')).rejects.toBeInstanceOf(IdentityUnavailable);
        await expect(
          port.createInvitation('a@example.test', 1, 'http://x.test'),
        ).rejects.toBeInstanceOf(IdentityUnavailable);
        await expect(port.revokeInvitation('inv_1')).rejects.toBeInstanceOf(IdentityUnavailable);
        await expect(port.revokeSessions('user_a')).rejects.toBeInstanceOf(IdentityUnavailable);
        await expect(port.deleteUser('user_a')).rejects.toBeInstanceOf(IdentityUnavailable);
        outage(false);
        expect((await port.getUser('user_a')).primaryEmail).toBe('ada@example.test');
      } finally {
        await stop();
      }
    });
  });
}
