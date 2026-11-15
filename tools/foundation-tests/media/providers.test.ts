import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobStore, startStubServer, submitOnce, type StubServer } from 'provider-stubs';

// Step 9 through the real socket path: the shared stub server from tools/provider-stubs answers
// the recorded OpenAI / WaveSpeed shapes, and the at-most-once rule of ARCHITECTURE §5.5 holds at
// the restart point between "provider accepted" and "task ID written".

let stub: StubServer;
beforeAll(async () => {
  stub = await startStubServer();
});
afterAll(async () => {
  await stub.close();
});

describe('provider contract stubs (integration)', () => {
  it('OpenAI probe: 200 valid, 401 invalid, with the recorded bodies', async () => {
    const ok = await fetch(`${stub.url}/v1/models`, {
      headers: { authorization: `Bearer ${stub.openAiKey}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ object: 'list' });
    const bad = await fetch(`${stub.url}/v1/models`, {
      headers: { authorization: 'Bearer sk-nope' },
    });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ error: { code: 'invalid_api_key' } });
  });

  it('WaveSpeed: submit, poll to completion, copy the output, delete the task', async () => {
    const headers = {
      authorization: `Bearer ${stub.waveSpeedKey}`,
      'content-type': 'application/json',
    };
    const submit = await fetch(`${stub.url}/api/v3/bytedance/seedance`, {
      method: 'POST',
      headers,
      body: '{"prompt":"x"}',
    });
    const task = (
      (await submit.json()) as { data: { id: string; urls: { get: string }; status: string } }
    ).data;
    expect(task.status).toBe('created');
    let status = 'created';
    let output = '';
    for (let i = 0; i < 5 && status !== 'completed'; i++) {
      const poll = (
        (await (await fetch(task.urls.get, { headers })).json()) as {
          data: { status: string; outputs: string[] };
        }
      ).data;
      status = poll.status;
      output = poll.outputs[0] ?? '';
    }
    expect(status).toBe('completed');
    const bytes = Buffer.from(await (await fetch(output)).arrayBuffer());
    expect(bytes.subarray(4, 8).toString('ascii')).toBe('ftyp');
    await fetch(`${stub.url}/api/v3/predictions/delete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids: [task.id] }),
    });
    expect(stub.deleted).toContain(task.id);
  });

  it('restart point: the provider accepted, the task ID was never written, the retry path does not resubmit', async () => {
    const before = stub.submits.length;
    const store = new JobStore();
    store.create('video-job-1');
    stub.setSubmitFault('drop-after-accept');
    const row = await submitOnce('video-job-1', {
      store,
      baseUrl: stub.url,
      apiKey: stub.waveSpeedKey,
      model: 'bytedance/seedance',
    });
    stub.setSubmitFault('none');
    expect(row).toMatchObject({
      state: 'failed',
      failure: 'outcome_unknown',
      providerTaskId: null,
      callCount: 1,
    });
    // a redelivered job and a recovery sweep after a restart both leave the provider call count at one
    await submitOnce('video-job-1', {
      store,
      baseUrl: stub.url,
      apiKey: stub.waveSpeedKey,
      model: 'bytedance/seedance',
    });
    store.sweepOrphans();
    expect(stub.submits.length - before).toBe(1);
  });
});
