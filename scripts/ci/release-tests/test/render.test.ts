import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeRender, type Options } from './fake-render.ts';
import { digest, fixture, readJson, releaseScript, run } from './harness.ts';
import { repoRoot } from './trace.ts';

const renderScript = join(repoRoot, 'scripts/ci/hosts/render.sh');
const NOW = Date.parse('2026-03-10T12:00:00Z') / 1000;
const PREFIX = 'ghcr.io/o/shroomap';
const SERVICES = { api: 'srv-api', worker: 'srv-worker', web: 'srv-web', migrate: 'srv-migrate' };

let fake: FakeRender | undefined;
afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

async function start(options: Options = {}) {
  fake = await new FakeRender(options).start();
  return fake;
}

/** Environment for the adapter: everything the owner adds, pointed at the local stand-in. */
function adapterEnv(f: FakeRender, g3Record: string, extra: Record<string, string> = {}) {
  return {
    RENDER_API_KEY: 'key-for-tests',
    RENDER_API_URL: `${f.url}/v1`,
    RENDER_SERVICE_API: SERVICES.api,
    RENDER_SERVICE_WORKER: SERVICES.worker,
    RENDER_SERVICE_WEB: SERVICES.web,
    RENDER_SERVICE_MIGRATE: SERVICES.migrate,
    RENDER_POSTGRES_ID: 'pg-1',
    RELEASE_IMAGE_PREFIX: PREFIX,
    RELEASE_G3_RECORD: g3Record,
    RENDER_SMOKE_API_URL: f.url,
    RENDER_SMOKE_WEB_URL: `${f.url}/web`,
    RENDER_POLL_SECONDS: '0',
    RELEASE_NOW: String(NOW),
    METRICS_TOKEN: 'metrics-token',
    ...extra,
  };
}

async function adapter(options: Options, args: string[], extra: Record<string, string> = {}) {
  const f = await start(options);
  const evidence = fixture();
  const result = await run(renderScript, args, adapterEnv(f, evidence.files.g3, extra));
  return { f, evidence, result };
}

const api = digest('api');

describe('render.sh: configuration', () => {
  it('stops as deployment-ready, not deployed, and lists the missing names', async () => {
    const r = await run(renderScript, ['smoke'], {});
    expect(r.code).toBe(78);
    expect(r.stderr).toContain('deployment-ready, not deployed');
    expect(r.stderr).toContain('RENDER_API_KEY');
    expect(r.stderr).toContain('RENDER_SERVICE_MIGRATE');
  });

  it('rejects a missing and an unknown operation', async () => {
    expect((await run(renderScript, [], {})).code).toBe(64);
    const f = await start();
    const unknown = await run(renderScript, ['explode'], adapterEnv(f, '/dev/null'));
    expect(unknown.code).toBe(64);
    expect(unknown.stderr).toContain('unknown operation');
  });
});

describe('render.sh: deploy by digest', () => {
  it('deploys the digest, sends the key as a bearer token and waits until live', async () => {
    const { f, result } = await adapter({}, ['deploy-api', api]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`api live on ${api}`);
    const [post] = f.calls('POST', /\/deploys$/);
    expect(post?.path).toBe('/v1/services/srv-api/deploys');
    expect(post?.body).toEqual({ imageUrl: `${PREFIX}/api@${api}` });
    expect(post?.auth).toBe('Bearer key-for-tests');
    expect(f.calls('GET', /\/deploys\/dep-1$/).length).toBe(3);
  });

  it('never puts the key in output', async () => {
    const { result } = await adapter({}, ['deploy-web', digest('web')]);
    expect(result.stdout + result.stderr).not.toContain('key-for-tests');
  });

  it('detects a failed deploy', async () => {
    const { result } = await adapter({ failServices: ['srv-api'] }, ['deploy-api', api]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ended as update_failed');
  });

  it('refuses a live deploy that runs another image', async () => {
    const { result } = await adapter({ wrongShaServices: ['srv-web'] }, [
      'deploy-web',
      digest('web'),
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is live but not on');
  });

  it('fails a deploy that is not live in time', async () => {
    const { result } = await adapter(
      { deployStatuses: ['update_in_progress'] },
      ['deploy-api', api],
      {
        RENDER_DEPLOY_TIMEOUT_SECONDS: '0',
      },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not live in time');
  });

  it('refuses anything that is not a full digest', async () => {
    const bad = await adapter({}, ['deploy-api', 'latest']);
    expect(bad.result.code).toBe(1);
    expect(bad.result.stderr).toContain('not an image digest');
    expect(bad.f.calls('POST', /deploys/)).toHaveLength(0);
    const none = await adapter({}, ['deploy-api']);
    expect(none.result.stderr).toContain('not an image digest');
  });

  it('fails when Render answers without a deploy id, with an error, or not at all', async () => {
    const noId = await adapter({ noDeployId: true }, ['deploy-api', api]);
    expect(noId.result.stderr).toContain('without an id');
    const down = await adapter({ errors: { 'POST /v1/services/srv-api/deploys': 500 } }, [
      'deploy-api',
      api,
    ]);
    expect(down.result.stderr).toContain('HTTP 500');
    const gone = await run(renderScript, ['deploy-api', api], {
      ...adapterEnv(await start(), '/dev/null'),
      RENDER_API_URL: 'http://127.0.0.1:1/v1',
    });
    expect(gone.code).toBe(1);
    expect(gone.stderr).toContain('no response');
  });

  it('sets the worker shutdown delay before it deploys', async () => {
    const { f, result } = await adapter({}, ['deploy-worker', digest('worker')], {
      RENDER_WORKER_SHUTDOWN_DELAY: '90',
    });
    expect(result.code).toBe(0);
    const patch = f.seen.findIndex((s) => s.method === 'PATCH');
    const post = f.seen.findIndex((s) => s.method === 'POST');
    expect(f.seen[patch]?.body).toEqual({ serviceDetails: { maxShutdownDelaySeconds: 90 } });
    expect(patch).toBeLessThan(post);
  });

  it('uses the default worker shutdown delay', async () => {
    const { f } = await adapter({}, ['deploy-worker', digest('worker')]);
    expect(f.calls('PATCH', /srv-worker/)[0]?.body).toEqual({
      serviceDetails: { maxShutdownDelaySeconds: 120 },
    });
  });
});

describe('render.sh: rollback to the previous digest', () => {
  const previous = digest('old-api');

  it('redeploys a digest the service has run before', async () => {
    const { f, result } = await adapter({ history: { 'srv-api': [previous] } }, [
      'rollback-api',
      previous,
    ]);
    expect(result.code).toBe(0);
    expect(f.calls('POST', /deploys$/)[0]?.body).toEqual({ imageUrl: `${PREFIX}/api@${previous}` });
  });

  it('refuses a target that is not in the host history, without deploying', async () => {
    const { f, result } = await adapter({ history: { 'srv-api': [digest('other')] } }, [
      'rollback-api',
      previous,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not in the deploy history of api');
    expect(f.calls('POST', /deploys$/)).toHaveLength(0);
  });

  it('refuses a rollback target that is not a digest', async () => {
    const { result } = await adapter({}, ['rollback-web', 'previous']);
    expect(result.stderr).toContain('not an image digest');
  });
});

describe('render.sh: migration jobs', () => {
  it('points the migrate service at the approved api digest, then runs db:migrate', async () => {
    const { f, evidence, result } = await adapter({}, ['migrate-db', 'exp-2']);
    expect(result.code).toBe(0);
    const approved = (evidence.g3.digests as Record<string, string>).api;
    expect(f.calls('POST', /srv-migrate\/deploys$/)[0]?.body).toEqual({
      imageUrl: `${PREFIX}/api@${approved}`,
    });
    expect(f.calls('POST', /srv-migrate\/jobs$/).map((s) => s.body.startCommand)).toEqual([
      'pnpm db:migrate',
    ]);
  });

  it('runs jobs:migrate and then the reference seed', async () => {
    const { f, result } = await adapter({}, ['migrate-jobs', 'exp-2']);
    expect(result.code).toBe(0);
    expect(f.calls('POST', /jobs$/).map((s) => s.body.startCommand)).toEqual([
      'pnpm jobs:migrate',
      'pnpm db:seed --dataset=reference',
    ]);
  });

  it('takes the commands from the environment', async () => {
    const { f } = await adapter({}, ['migrate-jobs', 'exp-2'], {
      RENDER_CMD_JOBS: 'ops jobs',
      RENDER_CMD_SEED: 'ops seed',
    });
    expect(f.calls('POST', /jobs$/).map((s) => s.body.startCommand)).toEqual([
      'ops jobs',
      'ops seed',
    ]);
  });

  it('needs the backup id', async () => {
    expect((await adapter({}, ['migrate-db'])).result.stderr).toContain('needs the backup id');
    expect((await adapter({}, ['migrate-jobs'])).result.stderr).toContain('needs the backup id');
  });

  it('stops on a failed job and does not run the seed', async () => {
    const { f, result } = await adapter({ jobStatuses: ['running', 'failed'] }, [
      'migrate-jobs',
      'exp-2',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ended as failed');
    expect(f.calls('POST', /jobs$/)).toHaveLength(1);
  });

  it('fails a job that does not finish in time', async () => {
    const { result } = await adapter({ jobStatuses: ['running'] }, ['migrate-jobs', 'exp-2'], {
      RENDER_JOB_TIMEOUT_SECONDS: '0',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('still running after the timeout');
  });

  it('fails when Render starts a job without an id', async () => {
    const { result } = await adapter({ noJobId: true }, ['migrate-jobs', 'exp-2']);
    expect(result.stderr).toContain('without an id');
  });
});

describe('render.sh: backup, schema read and smoke', () => {
  it('takes an on-demand backup and prints its id', async () => {
    const { result } = await adapter({}, ['backup']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('exp-2');
    expect((await adapter({ noExportId: true }, ['backup'])).result.stderr).toContain(
      'without an id',
    );
  });

  it('passes the backup gate for a backup younger than 24 hours', async () => {
    const { result } = await adapter({}, ['backup-gate']);
    expect(result.code).toBe(0);
  });

  it('fails the backup gate for an old backup, an empty list and a custom limit', async () => {
    const old = [{ id: 'e', createdAt: '2026-03-01T00:00:00Z' }];
    expect((await adapter({ exports: old }, ['backup-gate'])).result.stderr).toContain(
      'no backup of the database younger than 24 hours',
    );
    expect((await adapter({ exports: [] }, ['backup-gate'])).result.code).toBe(1);
    const tight = await adapter({}, ['backup-gate'], { RENDER_BACKUP_MAX_AGE_HOURS: '1' });
    expect(tight.result.stderr).toContain('younger than 1 hours');
  });

  it('reads the live state of all four services', async () => {
    const { f, result } = await adapter({}, ['schema-version']);
    expect(result.code).toBe(0);
    expect(f.calls('GET', /^\/v1\/services\/srv-[a-z]+$/)).toHaveLength(4);
    const missing = await adapter({ errors: { 'GET /v1/services/srv-worker': 404 } }, [
      'schema-version',
    ]);
    expect(missing.result.code).toBe(1);
  });

  it('passes the smoke check, retrying until the api is ready', async () => {
    const { result } = await adapter({ health: [503, 200] }, ['smoke'], {
      SMOKE_INTERVAL_SECONDS: '0',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('smoke passed on attempt 2');
  });

  it('fails the smoke check when the api or the web stays unhealthy', async () => {
    const api503 = await adapter({ health: [503] }, ['smoke'], {
      SMOKE_ATTEMPTS: '2',
      SMOKE_INTERVAL_SECONDS: '0',
    });
    expect(api503.result.code).toBe(1);
    expect(api503.result.stderr).toContain('smoke failed after 2 attempts');
    const web = await adapter({ webStatus: 502 }, ['smoke'], { SMOKE_ATTEMPTS: '1' });
    expect(web.result.code).toBe(1);
  });
});

describe('render.sh: alert, observe and record', () => {
  it('alerts to stderr without a webhook and posts to one when set', async () => {
    const plain = await adapter({}, ['alert', 'something broke']);
    expect(plain.result.code).toBe(0);
    expect(plain.result.stderr).toContain('ALERT: something broke');
    const hooked = await adapter({}, ['alert', 'hooked'], {
      ALERT_WEBHOOK_URL: 'http://127.0.0.1:1/hook',
    });
    expect(hooked.result.code).not.toBe(0);
    const f = await start();
    const posted = await run(renderScript, ['alert'], {
      ...adapterEnv(f, '/dev/null'),
      ALERT_WEBHOOK_URL: `${f.url}/hook`,
    });
    expect(posted.code).toBe(0);
    expect(f.calls('POST', /^\/hook$/)[0]?.body).toEqual({ text: '' });
  });

  it('runs the observation window through observe.sh', async () => {
    const { result } = await adapter({}, ['observe'], { OBSERVE_WINDOW_SECONDS: '0' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('window of 0s passed');
  });

  it('writes the release record entry from the result and the G3 record', async () => {
    const f = await start();
    const evidence = fixture();
    const resultFile = join(evidence.dir, 'deployment-result-staging.json');
    writeFileSync(
      resultFile,
      JSON.stringify({
        status: 'released',
        environment: 'staging',
        sourceSha: 'a'.repeat(40),
        runId: '100',
      }),
    );
    const r = await run(renderScript, ['record', resultFile], adapterEnv(f, evidence.files.g3));
    expect(r.code).toBe(0);
    const entry = readJson(join(evidence.dir, 'release-record-entry-staging.json'));
    expect(entry).toMatchObject({
      environment: 'staging',
      runId: '100',
      g3Ref: 'g3-100',
      result: 'released',
      recordedAt: '2026-03-10T12:00:00Z',
      digests: evidence.g3.digests,
    });
    const missing = await run(
      renderScript,
      ['record', join(evidence.dir, 'nope.json')],
      adapterEnv(f, evidence.files.g3),
    );
    expect(missing.code).toBe(1);
  });
});

describe('release-with-recovery.sh with the render adapter (real entry point)', () => {
  async function release(
    options: Options,
    extra: Record<string, string> = {},
    edit?: (t: ReturnType<typeof fixture>) => void,
  ) {
    const f = await start({ history: previousHistory(), ...options });
    const evidence = fixture();
    edit?.(evidence);
    const env = {
      ...evidence.env,
      ...adapterEnv(f, evidence.files.g3, {
        OBSERVE_WINDOW_SECONDS: '0',
        SMOKE_INTERVAL_SECONDS: '0',
        ...extra,
      }),
      HOST_ADAPTER: 'render',
    };
    const result = await run(releaseScript, ['--out-dir', evidence.out, ...evidence.args], env);
    const outcome = () => readJson(join(evidence.out, 'deployment-result-staging.json'));
    return { f, evidence, result, outcome };
  }
  function previousHistory() {
    return {
      'srv-api': [digest('old-api')],
      'srv-worker': [digest('old-worker')],
      'srv-web': [digest('old-web')],
    };
  }
  const metricsOk = { requests: 10, errors5xx: 0, p95Ms: 100, stuckSubmitting: 0 };

  it('migrates, deploys api, worker and web by digest, smokes, observes and records', async () => {
    const { f, evidence, result, outcome } = await release({ metrics: metricsOk });
    expect(result.code).toBe(0);
    expect(outcome()).toMatchObject({ status: 'released', adapter: 'render' });
    const posts = f
      .calls('POST', /./)
      .map((s) => `${s.path} ${String(s.body.imageUrl ?? s.body.startCommand ?? '')}`);
    const d = evidence.g3.digests as Record<string, string>;
    expect(posts).toEqual([
      '/v1/postgres/pg-1/export ',
      `/v1/services/srv-migrate/deploys ${PREFIX}/api@${d.api}`,
      '/v1/services/srv-migrate/jobs pnpm db:migrate',
      '/v1/services/srv-migrate/jobs pnpm jobs:migrate',
      '/v1/services/srv-migrate/jobs pnpm db:seed --dataset=reference',
      `/v1/services/srv-api/deploys ${PREFIX}/api@${d.api}`,
      `/v1/services/srv-worker/deploys ${PREFIX}/worker@${d.worker}`,
      `/v1/services/srv-web/deploys ${PREFIX}/web@${d.web}`,
    ]);
    const entry = readJson(join(evidence.out, 'release-record-entry-staging.json'));
    expect(entry).toMatchObject({ g3Ref: 'g3-100', result: 'released', digests: d });
  });

  it('recovers to the previous digests when the smoke check fails, newest layer first', async () => {
    const { f, result, outcome } = await release({ health: [503] }, { SMOKE_ATTEMPTS: '1' });
    expect(result.code).toBe(1);
    expect(outcome()).toMatchObject({ status: 'rolled-back' });
    const deploys = f.calls('POST', /deploys$/).map((s) => String(s.body.imageUrl));
    expect(deploys.slice(-3)).toEqual([
      `${PREFIX}/web@${digest('old-web')}`,
      `${PREFIX}/worker@${digest('old-worker')}`,
      `${PREFIX}/api@${digest('old-api')}`,
    ]);
  });

  it('keeps the old application when the migration job fails', async () => {
    const { f, result, outcome } = await release({ jobStatuses: ['failed'] });
    expect(result.code).toBe(1);
    expect(outcome()).toMatchObject({ status: 'migration-halted' });
    expect(f.calls('POST', /srv-(api|worker|web)\/deploys$/)).toHaveLength(0);
  });

  it('aborts the observation window and rolls back on a 5xx spike', async () => {
    const { result, outcome } = await release({ metrics: { requests: 500, errors5xx: 100 } });
    expect(result.code).toBe(1);
    expect(outcome()).toMatchObject({ status: 'rolled-back' });
  });

  it('fails when the backup gate finds no recent backup, before anything changes', async () => {
    const { f, result, outcome } = await release({ exports: [] });
    expect(result.code).toBe(1);
    expect(outcome()).toMatchObject({ status: 'preflight-failed' });
    expect(f.calls('POST', /./)).toHaveLength(0);
  });

  it('refuses to reach Render without the approval record', async () => {
    const { f, result } = await release({}, {}, (t) => writeFileSync(t.files.g3, '{}'));
    expect(result.code).toBe(1);
    expect(f.seen).toHaveLength(0);
  });

  it('stops as deployment-ready, not deployed, when the host adapter is not configured', async () => {
    const evidence = fixture();
    const r = await run(releaseScript, ['--out-dir', evidence.out, ...evidence.args], evidence.env);
    expect(r.code).toBe(0);
    const outcome = readJson(join(evidence.out, 'deployment-result-staging.json'));
    expect(outcome.status).toBe('deployment-ready-not-deployed');
    expect(readFileSync(join(evidence.out, 'deployment-result-staging.json'), 'utf8')).toContain(
      'RENDER_API_KEY',
    );
  });
});
