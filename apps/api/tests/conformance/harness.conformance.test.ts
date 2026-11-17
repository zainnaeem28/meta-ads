import { describe, expect, it } from 'vitest';
import type { Observed } from './support/cells.js';
import { allowedCodes, genericProbe, readsInput } from './support/cells.js';
import { conformance } from './support/envelope.js';
import { cellName, errorCodes, isAdmin, isGuarded, operations, urlFor } from './support/spec.js';
import { validRequest } from './support/requests.js';

// The generator and the envelope check are the instruments of every other file in this folder; these cases show that they
// generate what the contract says and that they refuse what the contract forbids.

const op = (id: string) => operations().find((o) => o.id === id) as ReturnType<typeof operations>[number];
const reply = (status: number, body: unknown, headers: Record<string, unknown> = {}): Observed => ({
  status, code: (body as { error?: { code: string } }).error?.code, headers: { 'content-type': 'application/json', 'x-request-id': 'req-1', ...headers }, text: JSON.stringify(body), body: body as Observed['body'],
});
const meta = { requestId: 'req-1', timestamp: '2026-01-01T00:00:00.000Z' };

describe('the generated matrix', () => {
  it('lists every operation of the file with its statuses, scope and inputs', () => {
    const all = operations();
    expect(all.length).toBeGreaterThanOrEqual(57);
    expect(new Set(all.map((o) => o.id)).size).toBe(all.length);
    expect(all.filter(isAdmin).length).toBeGreaterThan(15);
    expect(all.filter((o) => !isGuarded(o)).map((o) => o.id)).toEqual(['API-900', 'API-901', 'API-902', 'API-903']);
    expect(op('API-104')).toMatchObject({ method: 'PUT', pathParams: ['userId'], ifMatch: true, hasBody: true });
    expect(op('API-024')).toMatchObject({ jobCreating: true, pathParams: ['draftId'] });
    expect(op('API-902').root).toBe(true);
    expect(cellName(op('API-001'), 200)).toBe('API-001 200');
    expect(errorCodes()).toHaveLength(36);
  });

  it('builds a well-formed request for each shape of input', () => {
    expect(urlFor(op('API-060'), { campaignId: 'c1' })).toBe('/api/v1/campaigns/c1/segments/1/jobs');
    expect(urlFor(op('API-011'))).toBe('/api/v1/me/provider-keys/openai');
    expect(urlFor(op('API-901'))).toBe('/health/ready');
    expect(validRequest(op('API-024')).headers['idempotency-key']).toMatch(/^conf-/);
    expect(validRequest(op('API-104'), {}, 3).headers['if-match']).toBe('"3"');
    expect(validRequest(op('API-030')).raw).toBeInstanceOf(Buffer);
    expect(validRequest(op('API-020')).payload).toBeUndefined();
  });

  it('knows which codes an operation may answer with a status and which operations read input', () => {
    expect(allowedCodes(op('API-021'), 409)).toEqual(expect.arrayContaining(['state_conflict']));
    expect(allowedCodes(op('API-021'), 409)).not.toContain('version_conflict');
    expect(allowedCodes(op('API-001'), 403)).toEqual(expect.arrayContaining(['not_linked', 'account_suspended', 'account_removed', 'mfa_required']));
    expect(readsInput(op('API-001'))).toBe(false);
    expect(readsInput(op('API-020'))).toBe(true);
    expect(readsInput(op('API-130'))).toBe(true);
    expect(genericProbe(op('API-001'), 404)).toBeUndefined();
    expect(genericProbe(op('API-900'), 401)).toBeUndefined();
    expect(genericProbe(op('API-022'), 404)).toBeTypeOf('function');
    expect(genericProbe(op('API-022'), 200)).toBeUndefined();
  });
});

describe('the envelope check', () => {
  const ok = reply(200, { success: true, data: { status: 'ok' }, metaData: meta });
  it('accepts the envelope of the contract', () => {
    expect(conformance(op('API-900'), 200, ok)).toEqual([]);
    expect(conformance(op('API-100'), 403, reply(403, { success: false, error: { code: 'forbidden_role', message: 'You do not have access to this.' }, metaData: meta }))).toEqual([]);
  });

  it('refuses a request id that differs from the header, a bad instant and extra keys', () => {
    const problems = conformance(op('API-900'), 200, reply(200, { success: true, data: { status: 'ok' }, extra: 1, metaData: { requestId: 'other', timestamp: 'yesterday', odd: true } }));
    expect(problems.join('|')).toMatch(/requestId/);
    expect(problems.join('|')).toMatch(/timestamp/);
    expect(problems.join('|')).toMatch(/extra keys/);
    expect(problems.join('|')).toMatch(/success envelope keys/);
  });

  it('refuses an error that is not in the registry, carries the wrong status, leaks, or is too long', () => {
    const bad = (code: string, message: string, status = 403, details?: unknown[]) => conformance(op('API-100'), status, reply(status, { success: false, error: { code, message, ...(details === undefined ? {} : { details }) }, metaData: meta })).join('|');
    expect(bad('made_up', 'x')).toMatch(/not in the registry/);
    expect(bad('not_found', 'x')).toMatch(/not a 403 code/);
    expect(bad('forbidden_role', 'x'.repeat(501))).toMatch(/over 500/);
    expect(bad('forbidden_role', 'at Object.run (/app/node_modules/x.js:10:5)')).toMatch(/matches/);
    expect(bad('forbidden_role', 'select * from users')).toMatch(/matches/);
    expect(bad('forbidden_role', 'fine', 403, [{ field: 'owner_id', code: 'required', message: 'm' }])).toMatch(/column name/);
    expect(bad('forbidden_role', 'fine', 403, [{ field: 'a', code: 'required' }])).toMatch(/\{field, code, message\}/);
    expect(bad('forbidden_role', 'fine', 403, Array.from({ length: 51 }, () => ({ field: 'a', code: 'required', message: 'm' })))).toMatch(/more than 50/);
  });

  it('validates the body against the schema of the file', () => {
    const problems = conformance(op('API-900'), 200, reply(200, { success: true, data: { status: 5 }, metaData: meta }));
    expect(problems.join('|')).toMatch(/schema/);
  });

  it('leaves a body that is not JSON to its own checks', () => {
    expect(conformance(op('API-131'), 200, { status: 200, code: undefined, headers: { 'content-type': 'text/csv' }, text: 'a,b', body: {} })).toEqual([]);
  });
});
