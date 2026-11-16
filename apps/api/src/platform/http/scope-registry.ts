import { SetMetadata } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { ModulesContainer } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';

/** Authorization scopes of the operation table (ARCHITECTURE 3.3): public, token-only, user, user + recent auth, admin, metrics. */
export const SCOPES = ['Pub', 'T', 'U', 'U+RA', 'A', 'M'] as const;
export type RouteScope = (typeof SCOPES)[number];

export const SCOPE_KEY = 'http:scope';
const METRICS_GUARD_KEY = 'http:metrics-token-guard';

/** Declares the scope of a route (or of every route of a controller). A route without one fails startup. */
export const Scope = (scope: RouteScope): ClassDecorator & MethodDecorator => SetMetadata(SCOPE_KEY, scope);

/** Marks the guard class that checks the metrics token (`platform/metrics`, TASK-061). Scope M needs it. */
export const MetricsTokenGuardMarker = (): ClassDecorator => SetMetadata(METRICS_GUARD_KEY, true);

/** The session guard treats M (and Pub) as no session: only these scopes read a Bearer session token. */
export function needsSession(scope: RouteScope): boolean {
  return scope !== 'M' && scope !== 'Pub';
}

export interface RouteScopeEntry {
  route: string;
  scope: RouteScope | undefined;
  hasMetricsGuard: boolean;
}

type Handler = (...args: unknown[]) => unknown;

function guardClasses(...targets: object[]): object[] {
  return targets.flatMap((target) =>
    ((Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? []).map((guard) =>
      typeof guard === 'function' ? guard : (guard as object).constructor,
    ),
  );
}

export function collectRouteScopes(app: INestApplicationContext): RouteScopeEntry[] {
  const entries: RouteScopeEntry[] = [];
  for (const module of app.get(ModulesContainer, { strict: false }).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype;
      if (controller === null || controller === undefined) continue;
      const prototype = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[name];
        if (typeof handler !== 'function' || Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
        const scope = (Reflect.getMetadata(SCOPE_KEY, handler) ??
          Reflect.getMetadata(SCOPE_KEY, controller)) as RouteScope | undefined;
        const hasMetricsGuard = guardClasses(handler as Handler, controller).some(
          (guard) => Reflect.getMetadata(METRICS_GUARD_KEY, guard) === true,
        );
        entries.push({ route: `${controller.name}.${name}`, scope, hasMetricsGuard });
      }
    }
  }
  return entries;
}

export function scopeProblems(entries: readonly RouteScopeEntry[]): string[] {
  const problems: string[] = [];
  for (const { route, scope, hasMetricsGuard } of entries) {
    if (scope === undefined) problems.push(`${route}: no scope declared (default deny)`);
    else if (!SCOPES.includes(scope)) problems.push(`${route}: unknown scope ${String(scope)}`);
    else if (scope === 'M' && !hasMetricsGuard) problems.push(`${route}: scope M without the metrics-token guard`);
  }
  return problems;
}

/** Startup check: every route declares a scope, and scope M only on a route that carries the metrics-token guard. */
export function assertScopesDeclared(app: INestApplicationContext): void {
  const problems = scopeProblems(collectRouteScopes(app));
  if (problems.length > 0) throw new Error(`route scope check failed:\n${problems.join('\n')}`);
}
