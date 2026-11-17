import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '../../../platform/http/domain-error.js';
import type { ActorContext } from '../../../platform/http/index.js';
import type { BriefView } from '../application/brief.service.js';
import { BriefController, owner, versionOf } from './brief.controller.js';
import { IssuesController } from './issues.controller.js';

const A = '0197a1b2-0000-7000-8000-000000000001';
const C = '0197a1b2-0000-7000-8000-0000000000c1';
const actor = { userId: A } as ActorContext;

const view = (over: Partial<BriefView['brief']> = {}, job: BriefView['generationJob'] = null): BriefView => ({
  brief: { id: 'b', campaignId: C, state: 'draft', version: 3, acceptedAt: null, updatedAt: '2026-11-16 10:05:00+00', ...over },
  generationJob: job,
  segments: [{ id: 's', position: 1, state: 'active', revision: 2, dialogue: 'd', prompt: 'p', wordCount: 1 }],
  issues: [
    { id: 'i1', briefId: 'b', segmentId: 's', segmentPosition: 1, field: 'dialogue', ruleId: 'r', class: 'other', resolution: 'open', message: 'm', spanStart: 1, spanEnd: 4, clearReason: null },
    { id: 'i2', briefId: 'b', segmentId: 's', segmentPosition: 1, field: 'prompt', ruleId: 'r2', class: 'other', resolution: 'open', message: 'm', spanStart: null, spanEnd: null, clearReason: null },
  ],
});

function setup() {
  const service = {
    get: vi.fn(async () => view({}, { id: 'j', state: 'submitting', causeClass: null, causeMessage: null, createdAt: '2026-11-16 10:00:00.123456+00', updatedAt: '2026-11-16 10:01:00+00', deadlineAt: '2026-11-16T11:00:00Z' })),
    edit: vi.fn(async () => view({ version: 4 })),
    accept: vi.fn(async () => view({ state: 'accepted', version: 4, acceptedAt: '2026-11-16 10:06:00+00' })),
  };
  const headers: Record<string, string> = {};
  const reply = { header: (name: string, value: string) => void (headers[name] = value) } as never;
  return { service, controller: new BriefController(service as never), headers, reply };
}

const fails = async (promise: Promise<unknown>): Promise<DomainError> => {
  const error: unknown = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
};

describe('If-Match and the actor', () => {
  it('reads a quoted positive integer and refuses the rest', () => {
    expect(versionOf('"3"')).toBe(3);
    for (const bad of [undefined, '3', '"0"', 'W/"3"', '"x"']) expect(() => versionOf(bad)).toThrow(DomainError);
    expect(() => owner(undefined)).toThrow(DomainError);
  });
});

describe('BriefController', () => {
  it('renders the brief with an ETag, instants, spans and the job label (API-050)', async () => {
    const { controller, headers, reply } = setup();
    const body = await controller.get(actor, { campaignId: C }, reply);
    expect(headers['ETag']).toBe('"3"');
    expect(body).toMatchObject({ state: 'draft', version: 3, acceptedAt: null, updatedAt: '2026-11-16T10:05:00Z' });
    expect(body.generationJob).toMatchObject({ label: 'queued', createdAt: '2026-11-16T10:00:00.123456Z', reused: false });
    expect(body.issues.map((i) => i.span)).toEqual([{ start: 1, end: 4 }, null]);
    expect(body.segments[0]).toEqual({ position: 1, state: 'active', revision: 2, dialogue: 'd', prompt: 'p', wordCount: 1 });
    await expect(controller.get(actor, { campaignId: 'nope' }, reply)).rejects.toBeInstanceOf(DomainError);
  });

  it('edits under If-Match and passes only the texts that were sent (API-051)', async () => {
    const { controller, service, headers, reply } = setup();
    const body = await controller.edit(actor, { campaignId: C }, { segments: [{ position: 1, dialogue: 'x' }, { position: 2, prompt: 'y' }] }, '"3"', reply);
    expect(service.edit).toHaveBeenCalledWith(A, C, 3, [{ position: 1, dialogue: 'x' }, { position: 2, prompt: 'y' }]);
    expect(headers['ETag']).toBe('"4"');
    expect(body.version).toBe(4);
  });

  it.each([
    [{ segments: [] }],
    [{ segments: [{ position: 1 }] }],
    [{ segments: [{ position: 5, dialogue: 'x' }] }],
    [{ segments: [{ position: 1, dialogue: '' }] }],
    [{ segments: [{ position: 1, dialogue: 'x' }], extra: true }],
    [{}],
  ])('refuses the body %j', async (payload) => {
    const { controller, service, reply } = setup();
    expect((await fails(controller.edit(actor, { campaignId: C }, payload, '"3"', reply))).code).toBe('validation_failed');
    expect(service.edit).not.toHaveBeenCalled();
  });

  it('needs a valid If-Match to edit or accept', async () => {
    const { controller, reply } = setup();
    expect((await fails(controller.edit(actor, { campaignId: C }, { segments: [{ position: 1, dialogue: 'x' }] }, undefined, reply))).code).toBe('validation_failed');
    expect((await fails(controller.accept(actor, { campaignId: C }, undefined, reply))).code).toBe('validation_failed');
  });

  it('accepts and answers the new ETag (API-052)', async () => {
    const { controller, service, headers, reply } = setup();
    const body = await controller.accept(actor, { campaignId: C }, '"3"', reply);
    expect(service.accept).toHaveBeenCalledWith(A, C, 3);
    expect(body).toMatchObject({ state: 'accepted', acceptedAt: '2026-11-16T10:06:00Z' });
    expect(headers['ETag']).toBe('"4"');
  });
});

describe('IssuesController', () => {
  const issue = view().issues[0]!;
  it('trims and requires the reason and answers the issue (API-054)', async () => {
    const service = { clear: vi.fn(async () => ({ ...issue, resolution: 'cleared_with_reason' as const, clearReason: 'ok then' })) };
    const controller = new IssuesController(service as never);
    const id = '0197a1b2-0000-7000-8000-0000000000f1';
    const body = await controller.clear(actor, { issueId: id }, { reason: '  ok then ' });
    expect(service.clear).toHaveBeenCalledWith(A, id, 'ok then');
    expect(body).toMatchObject({ id: 'i1', resolution: 'cleared_with_reason', clearReason: 'ok then', span: { start: 1, end: 4 } });
    for (const payload of [{}, { reason: 'ab' }, { reason: 'x'.repeat(501) }, { reason: 'fine', extra: 1 }]) {
      expect((await fails(controller.clear(actor, { issueId: id }, payload))).code).toBe('validation_failed');
    }
    expect((await fails(controller.clear(actor, { issueId: 'nope' }, { reason: 'fine' }))).code).toBe('validation_failed');
    expect(service.clear).toHaveBeenCalledTimes(1);
  });
});
