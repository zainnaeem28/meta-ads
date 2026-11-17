import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ERROR_STATUS } from '../../../src/platform/http/domain-error.js';
import { contractsDir } from '../../security/support/stack.js';
import type { Observed } from './cells.js';
import { errorCodes, openApiSpec } from './spec.js';
import type { Operation } from './spec.js';

// TC-ENV-01, TC-ENV-02: the envelope of every reply the suite sees, held to the file the contract is written in.

type Validator = ((data: unknown) => boolean) & {
  errors?: { instancePath: string; message?: string }[] | null;
};

let ajv:
  | { compile(schema: unknown): Validator; addSchema(schema: unknown, key: string): void }
  | undefined;
const compiled = new Map<string, Validator | null>();
const ROOT = 'https://shroomap.invalid/openapi';

function engine(): NonNullable<typeof ajv> {
  if (ajv !== undefined) return ajv;
  const requireFromContracts = createRequire(join(contractsDir, 'package.json'));
  const Ajv2020 = (
    requireFromContracts('ajv/dist/2020') as { default: new (o: object) => NonNullable<typeof ajv> }
  ).default;
  const addFormats = (requireFromContracts('ajv-formats') as { default: (a: unknown) => void })
    .default;
  const instance = new Ajv2020({ strict: false, allErrors: false });
  addFormats(instance);
  instance.addSchema({ $id: ROOT, components: openApiSpec().components }, ROOT);
  ajv = instance;
  return instance;
}

interface ResponseSpec {
  $ref?: string;
  content?: Record<string, { schema?: unknown }>;
}

/** The JSON schema the file declares for a status of an operation; null when the response has no JSON body. */
function schemaFor(op: Operation, status: number): Validator | null {
  const key = `${op.id} ${String(status)}`;
  if (compiled.has(key)) return compiled.get(key) ?? null;
  const spec = openApiSpec();
  const raw = (
    (spec.paths[op.path] ?? {})[op.method.toLowerCase()] as {
      responses: Record<string, ResponseSpec>;
    }
  ).responses[String(status)];
  let response: ResponseSpec | undefined = raw;
  if (raw?.$ref !== undefined)
    response = (spec.components as unknown as { responses: Record<string, ResponseSpec> })
      .responses[raw.$ref.split('/').pop() as string];
  const schema = response?.content?.['application/json']?.schema;
  const validator = schema === undefined ? null : engine().compile(wrap(schema));
  compiled.set(key, validator);
  return validator;
}

/** The schema with its `#/components/...` references pointed at the one root the engine knows. */
function wrap(schema: unknown): object {
  const text = JSON.stringify(schema).replace(/"\$ref":"#\//g, `"$ref":"${ROOT}#/`);
  return JSON.parse(text) as object;
}

const LEAKS = [
  /\bat [\w$.]+ \(.*:\d+:\d+\)/,
  /\bselect\b[\s\S]*\bfrom\b/i,
  /\binsert into\b/i,
  /\/(home|usr|app|node_modules)\//,
  /eyJ[\w-]{10,}\./,
  /\bsk-[\w-]{12,}/,
  /postgres(ql)?:\/\//i,
];
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DETAIL_CODES = new Set([
  'required',
  'too_long',
  'out_of_range',
  'invalid_format',
  'cursor_invalid',
  'invalid_value',
  'unknown_field',
  'too_short',
  'too_many',
  'mismatch',
  'missing',
  'disabled',
  'wrong_provider',
  'wrong_type',
]);

/** Everything about a reply the contract fixes, as a list of problems (empty when the reply conforms). */
export function conformance(op: Operation, status: number, seen: Observed): string[] {
  const problems: string[] = [];
  const type = String(seen.headers['content-type'] ?? '');
  if (!type.includes('application/json')) return problems;
  const body = seen.body as Record<string, unknown>;
  const meta = (body['metaData'] ?? {}) as Record<string, unknown>;
  const requestId = seen.headers['x-request-id'];
  if (typeof requestId !== 'string' || meta['requestId'] !== requestId)
    problems.push('metaData.requestId is not the X-Request-ID header');
  if (typeof meta['timestamp'] !== 'string' || !TIMESTAMP.test(meta['timestamp']))
    problems.push('metaData.timestamp is not an RFC 3339 UTC instant');
  const extra = Object.keys(meta).filter(
    (k) => !['requestId', 'timestamp', 'pagination'].includes(k),
  );
  if (extra.length > 0) problems.push(`metaData has extra keys ${extra.join(',')}`);
  if (status >= 400) {
    const error = (body['error'] ?? {}) as {
      code?: string;
      message?: string;
      details?: { field?: string; code?: string; message?: string }[];
    };
    if (Object.keys(body).sort().join() !== 'error,metaData,success' || body['success'] !== false)
      problems.push(`error envelope keys are ${Object.keys(body).join(',')}`);
    if (Object.keys(error).filter((k) => !['code', 'message', 'details'].includes(k)).length > 0)
      problems.push('error has extra keys');
    if (typeof error.code !== 'string' || !errorCodes().includes(error.code))
      problems.push(`code ${String(error.code)} is not in the registry`);
    else if ((ERROR_STATUS as Record<string, number>)[error.code] !== status)
      problems.push(`code ${error.code} is not a ${String(status)} code`);
    if (
      typeof error.message !== 'string' ||
      error.message.length === 0 ||
      error.message.length > 500
    )
      problems.push('message is empty or over 500 characters');
    const shown = JSON.stringify(body);
    for (const leak of LEAKS)
      if (leak.test(shown)) problems.push(`the body matches ${String(leak)}`);
    for (const detail of error.details ?? []) {
      if (Object.keys(detail).sort().join() !== 'code,field,message')
        problems.push('a detail is not {field, code, message}');
      if (
        /(^|\.)[a-z]+_[a-z_]+$/.test(detail.field ?? '') &&
        !/^(If-Match|Idempotency-Key)$/i.test(detail.field ?? '')
      )
        problems.push(`detail field ${String(detail.field)} looks like a column name`);
      if (!DETAIL_CODES.has(detail.code ?? '') && !/^[a-z0-9_]+$/.test(detail.code ?? ''))
        problems.push(`detail code ${String(detail.code)}`);
    }
    if ((error.details ?? []).length > 50) problems.push('more than 50 details');
  } else if (
    Object.keys(body).sort().join() !== 'data,metaData,success' ||
    body['success'] !== true
  ) {
    problems.push(`success envelope keys are ${Object.keys(body).join(',')}`);
  }
  const validate = schemaFor(op, status);
  if (validate !== null && !validate(seen.body))
    problems.push(
      `schema: ${validate.errors?.[0]?.instancePath ?? ''} ${validate.errors?.[0]?.message ?? ''}`,
    );
  return problems;
}
