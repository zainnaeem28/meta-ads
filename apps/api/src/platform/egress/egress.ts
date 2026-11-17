import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { Agent, buildConnector, request } from 'undici';
import type { Dispatcher } from 'undici';
import { isBlockedAddress } from './address.js';
import { EgressError } from './errors.js';

export type AllowedHosts = Readonly<Record<string, readonly string[]>>;
export type Resolver = (host: string) => Promise<readonly string[]>;

export interface EgressOptions {
  allowedHosts: AllowedHosts;
  /** Whole-call limit, redirects and body included (PROVIDER_HTTP_TIMEOUT_MS). */
  timeoutMs: number;
  /** Largest response body (PROVIDER_OUTPUT_MAX_BYTES unless a request asks for less). */
  maxBytes: number;
  /** Replaceable in tests; the default asks the system resolver for every address. */
  resolver?: Resolver;
  /** Test seams only. The composition root never sets them. */
  testing?: {
    isBlockedAddress?: (address: string) => boolean;
    tls?: { ca: string | Buffer };
    port?: number;
  };
}

export interface EgressRequest {
  /** An https URL on a host the provider's allow-list names. Built by the adapter, never taken from a caller's input. */
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Buffer;
  maxBytes?: number;
  timeoutMs?: number;
  /** Accepted `content-type` values (without parameters); anything else is refused as `wrong_type`. */
  contentTypes?: readonly string[];
}

export interface EgressResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface EgressStreamResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** Errors with an `EgressError` once the size or time bound is crossed. */
  body: Readable;
}

const MAX_REDIRECTS = 3;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const CONNECT_ERRORS = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export const defaultResolver: Resolver = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const name = host.toLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.toLowerCase();
    return pattern.startsWith('*.')
      ? name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1
      : name === pattern;
  });
}

/** Startup check of the allow-list: names only, no IP literals, no single-label or bare-suffix wildcards. */
export function validateAllowList(allowed: AllowedHosts): string[] {
  const problems: string[] = [];
  for (const [provider, hosts] of Object.entries(allowed)) {
    for (const host of hosts) {
      const bare = host.startsWith('*.') ? host.slice(2) : host;
      if (isIP(bare) !== 0 || /^\d+(\.\d+)*$/.test(bare))
        problems.push(`${provider}: ${host} is an IP address`);
      else if (bare.toLowerCase() === 'localhost' || bare.endsWith('.localhost'))
        problems.push(`${provider}: ${host} is local`);
      else if (host.startsWith('*.') && bare.split('.').length < 2)
        problems.push(`${provider}: ${host} is too broad`);
    }
  }
  return problems;
}

export class Egress {
  private readonly allowed: AllowedHosts;
  private readonly resolver: Resolver;
  private readonly blocked: (address: string) => boolean;

  constructor(private readonly options: EgressOptions) {
    this.allowed = options.allowedHosts;
    this.resolver = options.resolver ?? defaultResolver;
    this.blocked = options.testing?.isBlockedAddress ?? isBlockedAddress;
  }

  providers(): string[] {
    return Object.keys(this.allowed);
  }

  /** Fetch the whole body (bounded by `maxBytes`). */
  async fetch(provider: string, req: EgressRequest): Promise<EgressResponse> {
    const res = await this.fetchStream(provider, req);
    const chunks: Buffer[] = [];
    for await (const chunk of res.body) chunks.push(chunk as Buffer);
    return { status: res.status, headers: res.headers, body: Buffer.concat(chunks) };
  }

  /** Fetch with a body that is read as it arrives; the bounds stay enforced while it is consumed. */
  async fetchStream(provider: string, req: EgressRequest): Promise<EgressStreamResponse> {
    const hosts = this.allowed[provider];
    if (hosts === undefined)
      throw new EgressError(
        'provider_unknown',
        'before_send',
        `no egress allow-list for provider ${provider}`,
      );
    const maxBytes = Math.min(req.maxBytes ?? this.options.maxBytes, this.options.maxBytes);
    const timeoutMs = Math.min(req.timeoutMs ?? this.options.timeoutMs, this.options.timeoutMs);
    const deadline = AbortSignal.timeout(timeoutMs);
    let url = this.checkUrl(req.url, hosts);
    let method = req.method ?? 'GET';
    let body = req.body;

    for (let hop = 0; ; hop += 1) {
      const attempt = await this.attempt(url, method, req.headers, body, deadline);
      const { response, agent, state } = attempt;
      try {
        if (REDIRECT_STATUS.has(response.statusCode)) {
          const location = response.headers['location'];
          response.body.destroy();
          await agent.close();
          const next =
            typeof location === 'string' ? this.redirectTarget(url, location) : undefined;
          if (next === undefined || hop >= MAX_REDIRECTS) {
            throw new EgressError(
              'redirect_refused',
              'after_send',
              `redirect refused (host ${url.hostname})`,
              url.hostname,
            );
          }
          url = next;
          if (response.statusCode === 303) {
            method = 'GET';
            body = undefined;
          }
          continue;
        }
        return this.bounded(response, agent, state, {
          maxBytes,
          deadline,
          contentTypes: req.contentTypes,
          host: url.hostname,
        });
      } catch (error) {
        response.body.destroy();
        await agent.close().catch(() => undefined);
        throw error;
      }
    }
  }

  private checkUrl(raw: string, hosts: readonly string[]): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new EgressError('invalid_url', 'before_send', 'the request URL is not valid');
    }
    if (url.protocol !== 'https:')
      throw new EgressError('not_https', 'before_send', 'only https is fetched', url.hostname);
    if (url.username !== '' || url.password !== '') {
      throw new EgressError(
        'invalid_url',
        'before_send',
        'a URL with credentials is refused',
        url.hostname,
      );
    }
    if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0 || !hostAllowed(url.hostname, hosts)) {
      throw new EgressError(
        'host_not_allowed',
        'before_send',
        `host ${url.hostname} is not on the provider allow-list`,
        url.hostname,
      );
    }
    if (this.options.testing?.port === undefined && url.port !== '' && url.port !== '443') {
      throw new EgressError(
        'host_not_allowed',
        'before_send',
        `port ${url.port} is not allowed`,
        url.hostname,
      );
    }
    return url;
  }

  /** A redirect is followed only to the very same host over https; any other target is refused. */
  private redirectTarget(from: URL, location: string): URL | undefined {
    let next: URL;
    try {
      next = new URL(location, from);
    } catch {
      return undefined;
    }
    return next.protocol === 'https:' &&
      next.hostname.toLowerCase() === from.hostname.toLowerCase() &&
      next.port === from.port &&
      next.username === '' &&
      next.password === ''
      ? next
      : undefined;
  }

  /** Resolve once, refuse when any answer is blocked, then connect to that pinned answer only. */
  private async pin(host: string, signal: AbortSignal): Promise<string> {
    let addresses: readonly string[];
    try {
      addresses = await Promise.race([
        this.resolver(host),
        new Promise<never>((_, reject) =>
          signal.addEventListener(
            'abort',
            () =>
              reject(
                new EgressError(
                  'timeout',
                  'before_send',
                  'the time limit passed while resolving the host',
                  host,
                ),
              ),
            { once: true },
          ),
        ),
      ]);
    } catch (error) {
      if (error instanceof EgressError) throw error;
      throw new EgressError(
        'dns_failure',
        'before_send',
        `host ${host} could not be resolved`,
        host,
      );
    }
    const first = addresses[0];
    if (first === undefined)
      throw new EgressError(
        'dns_failure',
        'before_send',
        `host ${host} could not be resolved`,
        host,
      );
    if (addresses.some((address) => this.blocked(address))) {
      throw new EgressError(
        'blocked_address',
        'before_send',
        `host ${host} resolves to a private or reserved address`,
        host,
      );
    }
    return first;
  }

  private async attempt(
    url: URL,
    method: string,
    headers: Record<string, string> | undefined,
    body: string | Buffer | undefined,
    deadline: AbortSignal,
  ): Promise<{ response: Dispatcher.ResponseData; agent: Agent; state: { connected: boolean } }> {
    const host = url.hostname;
    const address = await this.pin(host, deadline);
    const state = { connected: false };
    const connector = buildConnector({
      lookup: (_hostname, opts, callback) => {
        const family = isIP(address);
        if (typeof opts === 'object' && opts.all === true)
          callback(null, [{ address, family }] as never, undefined as never);
        else callback(null, address, family);
      },
      ...(this.options.testing?.tls === undefined ? {} : { ca: this.options.testing.tls.ca }),
    });
    const agent = new Agent({
      connect: (opts, cb) =>
        connector(opts, (error, socket) => {
          if (error === null && socket !== null) state.connected = true;
          cb(error as never, socket as never);
        }),
      maxRedirections: 0,
      keepAliveTimeout: 1,
    } as ConstructorParameters<typeof Agent>[0]);
    try {
      const response = await request(url, {
        dispatcher: agent,
        method: method as 'GET',
        headers: { ...headers, 'accept-encoding': 'identity' },
        ...(body === undefined ? {} : { body }),
        signal: deadline,
      });
      response.body.on('error', () => undefined); // a destroyed body must not raise an unhandled error
      return { response, agent, state };
    } catch (error) {
      await agent.close().catch(() => undefined);
      throw this.translate(error, host, state.connected, deadline);
    }
  }

  private translate(
    error: unknown,
    host: string,
    connected: boolean,
    deadline: AbortSignal,
  ): EgressError {
    if (error instanceof EgressError) return error;
    if (deadline.aborted) {
      return new EgressError(
        'timeout',
        connected ? 'after_send' : 'before_send',
        `the time limit passed (host ${host})`,
        host,
      );
    }
    const code =
      (error as { code?: string; cause?: { code?: string } }).code ??
      (error as { cause?: { code?: string } }).cause?.code;
    if (!connected || (code !== undefined && CONNECT_ERRORS.has(code))) {
      return new EgressError(
        'connection_failed',
        'before_send',
        `could not connect to ${host}`,
        host,
      );
    }
    return new EgressError(
      'network_error',
      'after_send',
      `the connection to ${host} failed after sending`,
      host,
    );
  }

  private bounded(
    response: Dispatcher.ResponseData,
    agent: Agent,
    state: { connected: boolean },
    limits: {
      maxBytes: number;
      deadline: AbortSignal;
      contentTypes: readonly string[] | undefined;
      host: string;
    },
  ): EgressStreamResponse {
    const { maxBytes, deadline, contentTypes, host } = limits;
    const headers = response.headers as EgressStreamResponse['headers'];
    const refuse = (error: EgressError): never => {
      response.body.destroy();
      void agent.close().catch(() => undefined);
      throw error;
    };
    const length = Number(headers['content-length']);
    if (Number.isFinite(length) && length > maxBytes) {
      refuse(
        new EgressError(
          'too_large',
          'after_send',
          `the response is larger than ${maxBytes} bytes`,
          host,
        ),
      );
    }
    if (contentTypes !== undefined && response.statusCode < 300) {
      const type =
        String(headers['content-type'] ?? '')
          .split(';')[0]
          ?.trim()
          .toLowerCase() ?? '';
      if (!contentTypes.some((allowed) => allowed.toLowerCase() === type)) {
        refuse(
          new EgressError(
            'wrong_type',
            'after_send',
            `the response type ${type === '' ? '(none)' : type} is not accepted`,
            host,
          ),
        );
      }
    }
    let seen = 0;
    const out = new Readable({ read: () => undefined });
    const fail = (error: EgressError): void => {
      response.body.destroy();
      out.destroy(error);
      void agent.close().catch(() => undefined);
    };
    deadline.addEventListener(
      'abort',
      () =>
        fail(
          new EgressError('timeout', 'after_send', `the time limit passed (host ${host})`, host),
        ),
      { once: true },
    );
    response.body.on('data', (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > maxBytes)
        fail(
          new EgressError(
            'too_large',
            'after_send',
            `the response is larger than ${maxBytes} bytes`,
            host,
          ),
        );
      else out.push(chunk);
    });
    response.body.on('end', () => {
      out.push(null);
      void agent.close().catch(() => undefined);
    });
    response.body.on('error', (error) => {
      fail(
        deadline.aborted
          ? new EgressError('timeout', 'after_send', `the time limit passed (host ${host})`, host)
          : this.translate(error, host, state.connected, deadline),
      );
    });
    return { status: response.statusCode, headers, body: out };
  }
}
