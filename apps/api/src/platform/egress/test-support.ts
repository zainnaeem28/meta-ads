import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const HOSTS = ['api.openai.com', 'evil.example.com', 'cdn.example.net'];

/** A throwaway CA-less self-signed certificate valid for the test host names (used as the trusted `ca`). */
export function makeCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'egress-cert-'));
  try {
    const san = HOSTS.map((host) => `DNS:${host}`).join(',');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=api.openai.com',
      '-addext', `subjectAltName=${san}`, '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export async function startServer(handler: Handler): Promise<{ port: number; ca: string; close: () => Promise<void> }> {
  const { key, cert } = makeCert();
  const server = createServer({ key, cert }, handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    ca: cert,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
