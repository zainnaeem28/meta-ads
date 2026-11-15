import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/render');

/** A recorded Render API response; `__DIGEST__` stands for the digest the request named. */
export function fixture(name: string, digest = ''): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, name), 'utf8').replaceAll('__DIGEST__', digest));
}

export interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown>;
  auth: string;
}

export interface Options {
  /** Deploy status sequence per new deploy (the last one repeats). */
  deployStatuses?: string[];
  /** Services whose new deploys end as update_failed. */
  failServices?: string[];
  /** Services whose live deploy reports another image digest than the one requested. */
  wrongShaServices?: string[];
  /** Digests each service already ran (its deploy history). */
  history?: Record<string, string[]>;
  jobStatuses?: string[];
  exports?: unknown;
  /** `METHOD /path` mapped to an HTTP status to force. */
  errors?: Record<string, number>;
  noDeployId?: boolean;
  noJobId?: boolean;
  noExportId?: boolean;
  /** Statuses for /health/ready, consumed one per request (the last repeats). */
  health?: number[];
  metrics?: Record<string, unknown>;
  metricsStatus?: number;
  webStatus?: number;
}

/** A local stand-in for the Render API, the app's health and metrics endpoints and an alert webhook. */
export class FakeRender {
  seen: Seen[] = [];
  server!: Server;
  url = '';
  private deploys = new Map<string, { service: string; sha: string; polls: number }>();
  private jobPolls = 0;
  private healthCalls = 0;
  constructor(private o: Options = {}) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        const url = new URL(req.url ?? '/', 'http://x');
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        const auth = String(req.headers.authorization ?? '');
        this.seen.push({ method: req.method ?? '', path: url.pathname, body, auth });
        const [status, payload] = this.route(req.method ?? '', url.pathname, body);
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      });
    });
    await new Promise<void>((ok) => this.server.listen(0, '127.0.0.1', ok));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((ok) => this.server.close(() => ok()));
  }

  calls(method: string, pathPattern: RegExp): Seen[] {
    return this.seen.filter((s) => s.method === method && pathPattern.test(s.path));
  }

  private route(method: string, path: string, body: Record<string, unknown>): [number, unknown] {
    const forced = this.o.errors?.[`${method} ${path}`];
    if (forced) return [forced, { message: 'forced' }];
    if (path === '/health/ready') {
      const list = this.o.health ?? [200];
      const code = list[Math.min(this.healthCalls, list.length - 1)]!;
      this.healthCalls += 1;
      return [code, { ok: code === 200 }];
    }
    if (path === '/internal/metrics/window')
      return [this.o.metricsStatus ?? 200, this.o.metrics ?? {}];
    if (path === '/web') return [this.o.webStatus ?? 200, {}];
    if (path === '/hook') return [200, {}];
    let m = /^\/v1\/services\/([\w-]+)\/deploys$/.exec(path);
    if (m && method === 'POST') {
      const service = m[1]!;
      const image = String(body.imageUrl ?? '');
      const sha = image.slice(image.indexOf('@') + 1);
      if (this.o.noDeployId) return [201, {}];
      const id = `dep-${this.deploys.size + 1}`;
      this.deploys.set(id, { service, sha, polls: 0 });
      return [201, { ...(fixture('deploy-created.json', sha) as object), id }];
    }
    if (m && method === 'GET') {
      const rows = (this.o.history?.[m[1]!] ?? []).map((sha) =>
        fixture('deploys-history.json', sha),
      );
      return [200, rows.flat()];
    }
    m = /^\/v1\/services\/([\w-]+)\/deploys\/([\w-]+)$/.exec(path);
    if (m) {
      const deploy = this.deploys.get(m[2]!);
      if (!deploy) return [404, {}];
      const list = this.o.deployStatuses ?? ['created', 'update_in_progress', 'live'];
      let status = list[Math.min(deploy.polls, list.length - 1)]!;
      deploy.polls += 1;
      if (this.o.failServices?.includes(deploy.service)) status = 'update_failed';
      const sha = this.o.wrongShaServices?.includes(deploy.service)
        ? `sha256:${'f'.repeat(64)}`
        : deploy.sha;
      const name =
        status === 'live'
          ? 'deploy-live.json'
          : status === 'update_failed'
            ? 'deploy-update-failed.json'
            : 'deploy-created.json';
      return [200, { ...(fixture(name, sha) as object), id: m[2], status }];
    }
    m = /^\/v1\/services\/([\w-]+)\/jobs$/.exec(path);
    if (m && method === 'POST')
      return [
        201,
        this.o.noJobId
          ? {}
          : { ...(fixture('job-created.json') as object), startCommand: body.startCommand },
      ];
    if (/^\/v1\/services\/[\w-]+\/jobs\/[\w-]+$/.test(path)) {
      const list = this.o.jobStatuses ?? ['pending', 'running', 'succeeded'];
      const status = list[Math.min(this.jobPolls, list.length - 1)]!;
      this.jobPolls += 1;
      return [
        200,
        {
          ...(fixture(status === 'failed' ? 'job-failed.json' : 'job-succeeded.json') as object),
          status,
        },
      ];
    }
    if (/^\/v1\/services\/[\w-]+$/.test(path))
      return method === 'PATCH' ? [200, {}] : [200, fixture('service.json')];
    if (path === '/v1/postgres/pg-1/export') {
      if (method === 'POST') return [202, this.o.noExportId ? {} : fixture('export-created.json')];
      return [200, this.o.exports ?? fixture('exports.json')];
    }
    return [404, { message: `unrouted ${method} ${path}` }];
  }
}
