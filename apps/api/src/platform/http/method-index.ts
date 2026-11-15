import type { FastifyInstance } from 'fastify';
import { ERROR_STATUS } from './domain-error.js';
import { errorEnvelope } from './response.js';

/** `Allow` order fixed by TD-D37. `OPTIONS` is never listed. */
const ALLOW_ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export type RouteMatch =
  | { kind: 'found' }
  | { kind: 'method_not_allowed'; allow: string }
  | { kind: 'not_found' };

interface Template {
  segments: readonly string[];
  methods: Set<string>;
}

const segmentsOf = (path: string): string[] => path.split('/').filter((s, i) => i === 0 || s !== '');

/**
 * Every route's method and path template, collected as routes are registered. A request that matched no route is
 * answered 405 (with `Allow`) or 404 from the template alone, so neither depends on authentication or on a record.
 */
export class MethodIndex {
  private readonly templates = new Map<string, Template>();

  add(method: string, url: string): void {
    const verb = method.toUpperCase();
    if (verb === 'OPTIONS') return;
    const segments = segmentsOf(url);
    const key = segments.join('/');
    const entry = this.templates.get(key) ?? { segments, methods: new Set<string>() };
    entry.methods.add(verb);
    if (verb === 'GET') entry.methods.add('HEAD');
    this.templates.set(key, entry);
  }

  /** `METHOD /template` pairs, for the contract test against the OpenAPI paths. */
  entries(): string[] {
    return [...this.templates.values()].flatMap((t) =>
      [...t.methods].map((m) => `${m} ${t.segments.join('/')}`),
    );
  }

  match(method: string, rawUrl: string): RouteMatch {
    const path = rawUrl.split('?', 1)[0] ?? '';
    const parts = segmentsOf(path);
    const verb = method.toUpperCase();
    const methods = new Set<string>();
    for (const template of this.templates.values()) {
      if (template.segments.length !== parts.length) continue;
      const fits = template.segments.every(
        (segment, i) => (segment.startsWith(':') && (parts[i] ?? '') !== '') || segment === parts[i],
      );
      if (fits) template.methods.forEach((m) => methods.add(m));
    }
    if (methods.size === 0) return { kind: 'not_found' };
    if (methods.has(verb)) return { kind: 'found' };
    return { kind: 'method_not_allowed', allow: ALLOW_ORDER.filter((m) => methods.has(m)).join(', ') };
  }
}

/**
 * Collects routes with an `onRoute` hook (call before the routes are registered) and answers route misses from an
 * `onRequest` hook: router first, before any guard, so a miss is never 401 (TD-D34, TD-D37).
 */
export function installMethodIndex(fastify: FastifyInstance): MethodIndex {
  const index = new MethodIndex();
  fastify.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) index.add(method, route.url);
  });
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.is404) return;
    const hit = index.match(request.method, request.url);
    if (hit.kind === 'method_not_allowed') {
      return reply
        .status(ERROR_STATUS.method_not_allowed)
        .header('Allow', hit.allow)
        .header('content-type', 'application/json; charset=utf-8')
        .send(errorEnvelope('method_not_allowed', 'This method is not allowed here.', request.id));
    }
    return reply
      .status(ERROR_STATUS.not_found)
      .header('content-type', 'application/json; charset=utf-8')
      .send(errorEnvelope('not_found', 'Not found.', request.id));
  });
  return index;
}
