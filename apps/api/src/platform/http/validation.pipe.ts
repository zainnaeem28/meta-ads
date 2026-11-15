import { Injectable } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { DomainError, MAX_DETAILS, MAX_MESSAGE } from './domain-error.js';
import type { ErrorDetail } from '../shared-kernel/index.js';

type Issue = z.core.$ZodIssue;

const camel = (segment: string): string =>
  segment.replace(/[_-]+([a-zA-Z0-9])/g, (_match, char: string) => char.toUpperCase());

/** Public DTO path: dot-joined, string segments in camelCase, array indexes as numbers. */
export function fieldPath(path: readonly PropertyKey[]): string {
  return path.map((segment) => (typeof segment === 'string' ? camel(segment) : String(segment))).join('.');
}

/** Zod leaves `issue.input` out by default, so a missing value is found by walking the original input. */
function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let current = input;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

/** Detail code and fixed message per issue. Messages never echo the rejected value. */
function describe(issue: Issue, input: unknown): { code: string; message: string } {
  switch (issue.code) {
    case 'invalid_type':
      return valueAt(input, issue.path) === undefined
        ? { code: 'required', message: 'This field is required.' }
        : { code: 'invalid_type', message: `Expected ${String(issue.expected)}.` };
    case 'too_big':
      return issue.origin === 'string' || issue.origin === 'array'
        ? { code: 'too_long', message: `Must be at most ${String(issue.maximum)} ${issue.origin === 'string' ? 'characters' : 'items'}.` }
        : { code: 'out_of_range', message: `Must be at most ${String(issue.maximum)}.` };
    case 'too_small':
      return issue.origin === 'string' || issue.origin === 'array'
        ? { code: 'too_short', message: `Must be at least ${String(issue.minimum)} ${issue.origin === 'string' ? 'characters' : 'items'}.` }
        : { code: 'out_of_range', message: `Must be at least ${String(issue.minimum)}.` };
    case 'invalid_format':
      return { code: 'invalid_format', message: 'The value has the wrong format.' };
    case 'invalid_value':
      return { code: 'invalid_value', message: 'The value is not one of the allowed values.' };
    case 'unrecognized_keys':
      return { code: 'unknown_field', message: 'This field is not allowed.' };
    default:
      return { code: 'invalid', message: 'The value is not valid.' };
  }
}

export function issueDetails(issues: readonly Issue[], input?: unknown): ErrorDetail[] {
  const details: ErrorDetail[] = [];
  for (const issue of issues) {
    const { code, message } = describe(issue, input);
    const base = fieldPath(issue.path);
    const fields =
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => fieldPath([...issue.path, key]))
        : [base];
    for (const field of fields) {
      if (details.length >= MAX_DETAILS) return details;
      details.push({ field, code, message: message.slice(0, MAX_MESSAGE) });
    }
  }
  return details;
}

/** Parse `value` with a generated schema; a failure is a 400 `validation_failed` with `details[]`. */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new DomainError('validation_failed', 'The request is not valid.', issueDetails(result.error.issues, value));
}

/** `@Body(new ZodValidationPipe(schemas.createCampaignBody))` and the same for query and params. */
@Injectable()
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    return parseWith(this.schema, value);
  }
}
