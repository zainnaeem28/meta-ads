import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  JobStore,
  SimulatedCrash,
  startStubServer,
  submitOnce,
  type StubServer,
} from '../src/index.ts';

let stub: StubServer;
beforeAll(async () => {
  stub = await startStubServer();
});
afterAll(async () => {
  await stub.close();
});
beforeEach(() => {
  stub.setSubmitFault('none');
  stub.submits.length = 0;
  stub.deleted.length = 0;
  for (const key of Object.keys(stub.polls)) delete stub.polls[key];
});

const auth = (key: string) => ({
  authorization: `Bearer ${key}`,
  'content-type': 'application/json',
});

describe('local stub server', () => {
  it('serves the OpenAI shapes over a real socket', async () => {
    const models = await fetch(`${stub.url}/v1/models`, { headers: auth(stub.openAiKey) });
    expect(((await models.json()) as { data: unknown[] }).data.length).toBe(2);
    expect((await fetch(`${stub.url}/v1/models`, { headers: auth('x') })).status).toBe(401);
    const chat = await fetch(`${stub.url}/v1/chat/completions`, {
      method: 'POST',
      headers: auth(stub.openAiKey),
      body: '{"model":"m"}',
    });
    expect(((await chat.json()) as { model: string }).model).toBe('m');
    const chatEmpty = await fetch(`${stub.url}/v1/chat/completions`, {
      method: 'POST',
      headers: auth(stub.openAiKey),
    });
    expect(((await chatEmpty.json()) as { model: string }).model).toBe('gpt-stub-mini');
    expect(
      (
        await fetch(`${stub.url}/v1/audio/transcriptions`, {
          method: 'POST',
          headers: auth(stub.openAiKey),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${stub.url}/v1/images/generations`, {
          method: 'POST',
          headers: auth(stub.openAiKey),
        })
      ).status,
    ).toBe(200);
    expect((await fetch(`${stub.url}/v1/unknown`, { headers: auth(stub.openAiKey) })).status).toBe(
      404,
    );
    expect((await fetch(`${stub.url}/elsewhere`)).status).toBe(404);
  });

  it('runs a WaveSpeed task: submit, processing, completed, output copy, delete', async () => {
    const submit = await fetch(`${stub.url}/api/v3/bytedance/seedance`, {
      method: 'POST',
      headers: auth(stub.waveSpeedKey),
      body: '{"prompt":"p"}',
    });
    const task = ((await submit.json()) as { data: { id: string; urls: { get: string } } }).data;
    expect(stub.submits).toHaveLength(1);
    const p1 = (await (
      await fetch(task.urls.get, { headers: auth(stub.waveSpeedKey) })
    ).json()) as { data: { status: string } };
    expect(p1.data.status).toBe('processing');
    const p2 = (await (
      await fetch(task.urls.get, { headers: auth(stub.waveSpeedKey) })
    ).json()) as { data: { status: string; outputs: string[] } };
    expect(p2.data.status).toBe('completed');
    const out = Buffer.from(await (await fetch(p2.data.outputs[0] ?? '')).arrayBuffer());
    expect(out.subarray(4, 8).toString()).toBe('ftyp');
    await fetch(`${stub.url}/api/v3/predictions/delete`, {
      method: 'POST',
      headers: auth(stub.waveSpeedKey),
      body: JSON.stringify({ ids: [task.id] }),
    });
    expect(stub.deleted).toEqual([task.id]);
    await fetch(`${stub.url}/api/v3/predictions/delete`, {
      method: 'POST',
      headers: auth(stub.waveSpeedKey),
    });
    expect(
      (
        await fetch(`${stub.url}/api/v3/predictions/nope/result`, {
          headers: auth(stub.waveSpeedKey),
        })
      ).status,
    ).toBe(404);
    expect(
      (await fetch(`${stub.url}/api/v3/balance`, { headers: auth(stub.waveSpeedKey) })).status,
    ).toBe(200);
    expect((await fetch(`${stub.url}/api/v3/balance`, { headers: auth('bad') })).status).toBe(401);
    expect(
      (await fetch(`${stub.url}/api/v3/a/b/c/d`, { headers: auth(stub.waveSpeedKey) })).status,
    ).toBe(404);
  });

  it('pre-acceptance rejections are not recorded as accepted tasks', async () => {
    stub.setSubmitFault('reject-400');
    expect(
      (
        await fetch(`${stub.url}/api/v3/a/b`, {
          method: 'POST',
          headers: auth(stub.waveSpeedKey),
          body: '{}',
        })
      ).status,
    ).toBe(400);
    stub.setSubmitFault('rate-limit-429');
    expect(
      (
        await fetch(`${stub.url}/api/v3/a/b`, {
          method: 'POST',
          headers: auth(stub.waveSpeedKey),
          body: '{}',
        })
      ).status,
    ).toBe(429);
    expect(stub.submits).toHaveLength(0);
  });
});

describe('at-most-once submit and the restart point (ARCHITECTURE §5.5)', () => {
  const deps = (store: JobStore, extra: { beforeWriteTaskId?: () => void } = {}) => ({
    store,
    baseUrl: stub.url,
    apiKey: stub.waveSpeedKey,
    model: 'bytedance/seedance',
    ...extra,
  });

  it('happy path writes the task ID and a second claim does not submit again', async () => {
    const store = new JobStore();
    store.create('job-1');
    const row = await submitOnce('job-1', deps(store));
    expect(row).toMatchObject({ state: 'submitted', callCount: 1 });
    expect(row.providerTaskId).toBe(stub.submits[0]?.id);
    await submitOnce('job-1', deps(store));
    expect(stub.submits).toHaveLength(1);
    await expect(submitOnce('missing', deps(store))).rejects.toThrow('unknown job');
  });

  it('connection dropped after accept: outcome_unknown, never resubmitted', async () => {
    const store = new JobStore();
    store.create('job-2');
    stub.setSubmitFault('drop-after-accept');
    const row = await submitOnce('job-2', deps(store));
    expect(row).toMatchObject({
      state: 'failed',
      failure: 'outcome_unknown',
      providerTaskId: null,
    });
    stub.setSubmitFault('none');
    await submitOnce('job-2', deps(store));
    await submitOnce('job-2', deps(store));
    expect(stub.submits).toHaveLength(1);
  });

  it('HTTP 500 after accept is outcome_unknown too; 400, 429 are definitive and unbilled', async () => {
    const store = new JobStore();
    for (const [id, fault, failure] of [
      ['j500', 'http-500-after-accept', 'outcome_unknown'],
      ['j400', 'reject-400', 'configuration'],
      ['j429', 'rate-limit-429', 'temporary'],
    ] as const) {
      store.create(id);
      stub.setSubmitFault(fault);
      expect((await submitOnce(id, deps(store))).failure).toBe(failure);
    }
    expect(stub.submits).toHaveLength(1);
    store.create('j401');
    stub.setSubmitFault('none');
    expect((await submitOnce('j401', { ...deps(store), apiKey: 'wrong' })).failure).toBe(
      'configuration',
    );
  });

  it('process death between provider accept and task-ID write: the sweep fails the orphan, no second submit', async () => {
    const store = new JobStore();
    store.create('job-3');
    await expect(
      submitOnce(
        'job-3',
        deps(store, {
          beforeWriteTaskId: () => {
            throw new SimulatedCrash('killed');
          },
        }),
      ),
    ).rejects.toBeInstanceOf(SimulatedCrash);
    expect(stub.submits).toHaveLength(1);
    expect(store.rows.get('job-3')).toMatchObject({ state: 'submitting', providerTaskId: null });
    // after restart: the claim is refused (not pending), the sweep marks outcome_unknown
    await submitOnce('job-3', deps(store));
    expect(stub.submits).toHaveLength(1);
    expect(store.sweepOrphans()).toBe(1);
    expect(store.rows.get('job-3')).toMatchObject({ state: 'failed', failure: 'outcome_unknown' });
    expect(store.sweepOrphans()).toBe(0);
  });
});
