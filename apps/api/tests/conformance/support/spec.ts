import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { contractsDir } from '../../security/support/stack.js';

// The API test matrix is generated, never listed by hand (TASK-065): every operation of packages/contracts/openapi.yaml by its
// `x-api-id`, with the statuses it documents, the error codes it names, its scope and its inputs.

export interface Operation {
  readonly id: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly scopes: readonly string[];
  readonly statuses: readonly number[];
  readonly codes: readonly string[];
  readonly pathParams: readonly string[];
  readonly jobCreating: boolean;
  readonly hasBody: boolean;
  readonly ifMatch: boolean;
  /** Takes `limit` and `cursor` (a list). */
  readonly paged: boolean;
  /** Served at the root (`/health`, `/internal/metrics`), outside `/api/v1`. */
  readonly root: boolean;
}

interface RawOperation {
  'x-api-id'?: string;
  'x-scope'?: string;
  'x-error-codes'?: string[];
  'x-job-creating'?: boolean;
  requestBody?: unknown;
  parameters?: { $ref?: string; name?: string }[];
  responses: Record<string, unknown>;
}

interface RawSpec {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: { ErrorCode: { enum: string[] } } };
}

/** The parsed file (paths and components). */
export const openApiSpec = (): RawSpec => load().spec;

let cached: { spec: RawSpec; operations: Operation[] } | undefined;

function load(): { spec: RawSpec; operations: Operation[] } {
  if (cached !== undefined) return cached;
  const requireFromContracts = createRequire(join(contractsDir, 'package.json'));
  const yaml = requireFromContracts('js-yaml') as { load(text: string): RawSpec };
  const spec = yaml.load(readFileSync(join(contractsDir, 'openapi.yaml'), 'utf8'));
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const raw = item[method] as RawOperation | undefined;
      if (raw === undefined) continue;
      const refs = (raw.parameters ?? []).map((p) => p.$ref ?? '');
      operations.push({
        id: String(raw['x-api-id']),
        method: method.toUpperCase() as Operation['method'],
        path,
        scopes: String(raw['x-scope'] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== ''),
        statuses: Object.keys(raw.responses).map(Number).sort((a, b) => a - b),
        codes: raw['x-error-codes'] ?? [],
        pathParams: [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string),
        jobCreating: raw['x-job-creating'] === true,
        hasBody: raw.requestBody !== undefined,
        ifMatch: refs.some((ref) => ref.endsWith('/IfMatch')),
        paged: refs.some((ref) => ref.endsWith('/Limit')),
        root: path.startsWith('/health') || path.startsWith('/internal'),
      });
    }
  }
  cached = { spec, operations: operations.sort((a, b) => a.id.localeCompare(b.id)) };
  return cached;
}

export const operations = (): readonly Operation[] => load().operations;

/** The 36 registry codes of the contract (`components.schemas.ErrorCode`). */
export const errorCodes = (): readonly string[] => load().spec.components.schemas.ErrorCode.enum;

export const cellName = (op: Pick<Operation, 'id'>, status: number): string => `${op.id} ${String(status)}`;

export const isGuarded = (op: Operation): boolean => !op.scopes.includes('Pub') && !op.scopes.includes('M');
export const isAdmin = (op: Operation): boolean => op.scopes.includes('A');

/** A request for an operation: the URL under the API prefix (or the root), with ids filled in. */
export interface RequestSpec {
  method: Operation['method'];
  url: string;
  payload?: unknown;
  headers: Record<string, string>;
}

export interface Params {
  readonly [name: string]: string;
}

const DEFAULT_PARAM: Record<string, () => string> = { position: () => '1', provider: () => 'openai' };

export function urlFor(op: Operation, params: Params = {}): string {
  const filled = op.path.replace(/\{([^}]+)\}/g, (_m, name: string) => params[name] ?? DEFAULT_PARAM[name]?.() ?? randomUUID());
  return op.root ? filled : `/api/v1${filled}`;
}
