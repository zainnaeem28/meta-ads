import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  callsOf,
  digest,
  fixture,
  readJson,
  releaseScript,
  run,
  stubScript,
  wait,
  withArg,
  without,
} from './harness.ts';
import { repoRoot } from './trace.ts';

const OPS = [
  'schema-version',
  'backup-gate',
  'backup',
  'migrate-db stub-backup-1',
  'migrate-jobs stub-backup-1',
];
const DEPLOYS = [
  `deploy-api ${digest('api')}`,
  `deploy-worker ${digest('worker')}`,
  `deploy-web ${digest('web')}`,
];
const FULL = [...OPS, ...DEPLOYS, 'smoke', 'observe'];

function setup(overrides: Parameters<typeof fixture>[0] = {}, env: Record<string, string> = {}) {
  const f = fixture(overrides);
  const calls = join(f.dir, 'calls.log');
  const all = { ...f.env, HOST_ADAPTER: 'stub', STUB_CALLS_FILE: calls, ...env };
  const release = (args = f.args, extra: Record<string, string> = {}) =>
    run(releaseScript, ['--out-dir', f.out, ...args], { ...all, ...extra });
  const result = () => readJson(join(f.out, 'deployment-result-staging.json'));
  return { f, calls, release, result, env: all };
}

describe('release-with-recovery.sh', () => {
  it('releases api, worker and web by digest in order and records the result', async () => {
    const t = setup();
    const r = await t.release();
    expect(r.code).toBe(0);
    expect(callsOf(t.calls).slice(0, -1)).toEqual(FULL);
    expect(callsOf(t.calls).at(-1)).toMatch(/^record .*deployment-result-staging\.json$/);
    expect(t.result()).toMatchObject({
      status: 'released',
      environment: 'staging',
      adapter: 'stub',
    });
  });

  it('defaults the calls file into the output folder', async () => {
    const t = setup();
    const r = await run(releaseScript, ['--out-dir', t.f.out, ...t.f.args], {
      ...t.f.env,
      HOST_ADAPTER: 'stub',
    });
    expect(r.code).toBe(0);
    expect(callsOf(join(t.f.out, 'host-calls-staging.log'))).toHaveLength(FULL.length + 1);
  });

  it('finishes "deployment-ready, not deployed" with no host adapter and no credential', async () => {
    const t = setup();
    const r = await t.release(t.f.args, { HOST_ADAPTER: '' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('deployment-ready-not-deployed');
    expect(t.result().status).toBe('deployment-ready-not-deployed');
    expect(callsOf(t.calls)).toEqual([]);
  });

  it('still verifies a supplied G3 record when no host adapter is configured', async () => {
    const t = setup({ g3: { environment: 'production' } });
    const r = await t.release(t.f.args, { HOST_ADAPTER: '' });
    expect(r.code).toBe(1);
    expect(t.result().status).toBe('approval-rejected');
  });

  it('reports ready when no adapter and no G3 record are supplied', async () => {
    const t = setup();
    const r = await t.release(without(without(t.f.args, '--g3-record'), '--dispatcher'), {
      HOST_ADAPTER: '',
    });
    expect(r.code).toBe(0);
  });

  it.each([
    ['an adapter name with a path', '../stub', 64],
    ['an unknown adapter', 'nothing', 64],
  ])('rejects %s', async (_n, adapter, code) => {
    const t = setup();
    expect((await t.release(t.f.args, { HOST_ADAPTER: adapter })).code).toBe(code);
  });

  it.each([
    ['no output folder', (a: string[]) => a, ['--environment', 'staging'], 'out-dir'],
    [
      'an unknown environment',
      (a: string[]) => withArg(a, '--environment', 'dev'),
      null,
      'environment must be',
    ],
    ['a flag without a value', (a: string[]) => [...a, '--ref'], null, 'missing value'],
  ])('rejects %s', async (_n, change, only, message) => {
    const t = setup();
    const r = only
      ? await run(releaseScript, only as string[], t.env)
      : await run(releaseScript, ['--out-dir', t.f.out, ...change(t.f.args)], t.env);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain(message);
  });

  describe('failures and recovery', () => {
    it('halts on a failed migration: no retry, no deploy, no rollback, alert', async () => {
      const t = setup({}, { STUB_FAIL_OPS: 'migrate-jobs' });
      const r = await t.release();
      expect(r.code).toBe(1);
      expect(callsOf(t.calls).filter((c) => c.startsWith('migrate-jobs'))).toHaveLength(1);
      expect(callsOf(t.calls).some((c) => c.startsWith('deploy') || c.startsWith('rollback'))).toBe(
        false,
      );
      expect(t.result().status).toBe('migration-halted');
      expect(readFileSync(join(t.f.out, 'alerts-staging.log'), 'utf8')).toContain(
        'Old application remains active',
      );
    });

    it('aborts a migration checkpoint that exceeds its threshold', async () => {
      const t = setup({}, { STUB_SLEEP_OPS: 'migrate-db=5', MIGRATE_TIMEOUT_SECONDS: '1' });
      const r = await t.release();
      expect(r.code).toBe(1);
      expect(t.result().detail).toContain('exceeded 1s');
    });

    it('stops with nothing changed when the backup fails', async () => {
      const t = setup({}, { STUB_FAIL_OPS: 'backup' });
      expect((await t.release()).code).toBe(1);
      expect(callsOf(t.calls).some((c) => c.startsWith('migrate'))).toBe(false);
      expect(t.result().status).toBe('backup-failed');
    });

    it('stops with nothing changed when preflight fails', async () => {
      const t = setup({}, { STUB_FAIL_OPS: 'backup-gate' });
      expect((await t.release()).code).toBe(1);
      expect(callsOf(t.calls)).toEqual(['schema-version', 'backup-gate']);
      expect(t.result().status).toBe('preflight-failed');
    });

    it('keeps everything when the first deploy fails', async () => {
      const t = setup({}, { STUB_FAIL_OPS: 'deploy-api' });
      expect((await t.release()).code).toBe(1);
      expect(t.result().status).toBe('deploy-halted');
      expect(callsOf(t.calls).some((c) => c.startsWith('rollback'))).toBe(false);
    });

    it('rolls back only what was deployed when a later deploy fails, never the database', async () => {
      const t = setup({}, { STUB_FAIL_OPS: 'deploy-worker' });
      expect((await t.release()).code).toBe(1);
      const calls = callsOf(t.calls);
      expect(calls.filter((c) => c.startsWith('rollback'))).toEqual([
        `rollback-api ${digest('old-api')}`,
      ]);
      expect(calls.some((c) => /^(restore|migrate-down)/.test(c))).toBe(false);
      expect(t.result().status).toBe('rolled-back');
    });

    it.each(['smoke', 'observe'])(
      'rolls back web, worker, api to the previous digests when %s fails',
      async (phase) => {
        const t = setup({}, { STUB_FAIL_OPS: phase });
        const r = await t.release();
        expect(r.code).toBe(1);
        const calls = callsOf(t.calls);
        expect(calls.slice(-4, -1)).toEqual([
          `rollback-web ${digest('old-web')}`,
          `rollback-worker ${digest('old-worker')}`,
          `rollback-api ${digest('old-api')}`,
        ]);
        expect(calls.at(-1)).toMatch(/^alert /);
        expect(calls.filter((c) => c.startsWith('deploy'))).toHaveLength(3); // no automatic redeploy
        expect(t.result().status).toBe('rolled-back');
      },
    );

    it('cannot recover without a previous release record: stays red and alerts', async () => {
      const t = setup({ releases: [] }, { STUB_FAIL_OPS: 'smoke' });
      const r = await t.release();
      expect(r.code).toBe(2);
      expect(t.result().status).toBe('recovery-failed');
      expect(readFileSync(join(t.f.out, 'alerts-staging.log'), 'utf8')).toContain(
        'no approved recovery exists',
      );
    });

    it('fails with an alert before any rollback call when the previous record lacks a digest', async () => {
      const t = setup(
        {
          releases: [
            {
              environment: 'staging',
              runId: '50',
              g3Ref: 'g3-50',
              digests: { api: digest('old-api') },
            },
          ],
        },
        { STUB_FAIL_OPS: 'smoke' },
      );
      const r = await t.release();
      expect(r.code).toBe(2);
      expect(t.result().status).toBe('recovery-failed');
      expect(callsOf(t.calls).some((c) => c.startsWith('rollback'))).toBe(false);
      expect(readFileSync(join(t.f.out, 'alerts-staging.log'), 'utf8')).toContain(
        'no digest for web',
      );
    });

    it('reports a failed record step', async () => {
      const t = setup({}, { STUB_FAIL_OPS: 'record' });
      const r = await t.release();
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('release record step failed');
    });

    it('still fails and writes the alert file when the alert call itself fails', async () => {
      const t = setup({}, { STUB_FAIL_OPS: 'migrate-db,alert' });
      const r = await t.release();
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('the alert call itself failed');
      expect(readFileSync(join(t.f.out, 'alerts-staging.log'), 'utf8')).toContain(
        'migrate-db failed',
      );
    });
  });

  describe('lock', () => {
    it('gives up when the environment lock is held too long', async () => {
      const t = setup({}, { STUB_SLEEP_OPS: 'deploy-api=3' });
      const first = t.release();
      await wait(1000);
      const second = await t.release(withArg(t.f.args, '--run-id', '101'), {
        RELEASE_LOCK_WAIT_SECONDS: '1',
      });
      expect(second.code).toBe(1);
      expect(second.stdout).toContain('waiting');
      expect(second.stdout).toContain('lock-timeout');
      expect((await first).code).toBe(0);
    });
  });

  it('never reads or needs a deployment credential', async () => {
    const t = setup();
    const canary = 'canary-do-not-leak-7f3a';
    const r = await t.release(t.f.args, {
      RENDER_API_KEY: canary,
      PAPERCLIP_G3_READER_TOKEN: canary,
      DATABASE_URL: canary,
    });
    expect(r.code).toBe(0);
    expect(
      r.stdout +
        r.stderr +
        readFileSync(t.calls, 'utf8') +
        readFileSync(join(t.f.out, 'deployment-result-staging.json'), 'utf8'),
    ).not.toContain(canary);
    for (const file of [
      'scripts/ci/verify-release-approval.sh',
      'scripts/ci/release-with-recovery.sh',
      'scripts/ci/hosts/stub.sh',
    ]) {
      const code = readFileSync(join(repoRoot, file), 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('#') && !l.includes('write_result deployment-ready'));
      expect(code.join('\n')).not.toMatch(/\$\{?[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/);
    }
  });
});

describe('stub.sh', () => {
  it('records the call and mutates nothing', async () => {
    const dir = fixture().dir;
    const calls = join(dir, 'c.log');
    const r = await run(stubScript, ['deploy-api', 'sha256:x', 'y'], { STUB_CALLS_FILE: calls });
    expect(r.code).toBe(0);
    expect(callsOf(calls)).toEqual(['deploy-api sha256:x y']);
    expect(
      (await run(stubScript, ['schema-version'], { STUB_CALLS_FILE: calls })).stdout,
    ).toContain('stub-schema-1');
  });

  it('fails closed without an operation or a calls file', async () => {
    expect((await run(stubScript, [], { STUB_CALLS_FILE: '/dev/null' })).code).toBe(64);
    expect((await run(stubScript, ['deploy-api'], {})).code).toBe(64);
  });

  it('injects failures and delays on named operations only', async () => {
    const calls = join(fixture().dir, 'c.log');
    const env = { STUB_CALLS_FILE: calls, STUB_FAIL_OPS: 'smoke', STUB_SLEEP_OPS: 'observe=0' };
    expect((await run(stubScript, ['smoke'], env)).code).toBe(1);
    expect((await run(stubScript, ['observe'], env)).code).toBe(0);
    expect(callsOf(calls)).toEqual(['smoke', 'observe']);
  });
});

describe('probes 7, 9 and 10 (stub adapter, fixture G3 records, no credentials)', () => {
  const transcript: string[] = [];
  const note = (title: string, lines: string[]) =>
    transcript.push(`## ${title}\n${lines.join('\n')}\n`);
  const clean = (text: string, dir: string) => text.split(dir).join('<tmp>').trim();

  it('probe 7: dispatch without a recorded G3 or with a G3 for another target reaches no host call', async () => {
    const lines: string[] = [];
    for (const [label, build] of [
      ['no G3 record', () => fixture({ skipG3: true })],
      [
        'G3 recorded for production, dispatch for staging',
        () => fixture({ g3: { environment: 'production' } }),
      ],
      [
        'G3 for other digests',
        () =>
          fixture({
            g3: { digests: { api: digest('x'), worker: digest('worker'), web: digest('web') } },
          }),
      ],
    ] as const) {
      const f = build();
      const calls = join(f.dir, 'calls.log');
      writeFileSync(calls, '');
      const r = await run(releaseScript, ['--out-dir', f.out, ...f.args], {
        ...f.env,
        HOST_ADAPTER: 'stub',
        STUB_CALLS_FILE: calls,
      });
      expect(r.code).toBe(1);
      expect(readFileSync(calls, 'utf8')).toBe('');
      expect(readJson(join(f.out, 'deployment-result-staging.json')).status).toBe(
        'approval-rejected',
      );
      lines.push(
        `${label}: exit ${r.code}, recorded-call file bytes: ${readFileSync(calls).length}`,
        clean(r.stderr, f.dir)
          .split('\n')
          .filter((l) => l.startsWith('FAIL') || l.startsWith('approval'))
          .join('\n'),
      );
    }
    note('Probe 7: no mutation without a recorded G3', lines);
  });

  it('probe 9: the second dispatch to one environment waits for the first', async () => {
    const f = fixture();
    const calls = join(f.dir, 'calls.log');
    const env = {
      ...f.env,
      HOST_ADAPTER: 'stub',
      STUB_CALLS_FILE: calls,
      STUB_SLEEP_OPS: 'deploy-api=2',
    };
    const first = run(releaseScript, ['--out-dir', join(f.dir, 'a'), ...f.args], env);
    await wait(800);
    const second = run(
      releaseScript,
      ['--out-dir', join(f.dir, 'b'), ...withArg(f.args, '--run-id', '101')],
      env,
    );
    const [a, b] = await Promise.all([first, second]);
    expect([a.code, b.code]).toEqual([0, 0]);
    expect(b.stdout).toContain('waiting');
    const recorded = callsOf(calls);
    const one = FULL.length + 1;
    expect(recorded).toHaveLength(one * 2);
    expect(recorded.slice(0, one).map((c) => c.split(' ')[0])).toEqual(
      recorded.slice(one).map((c) => c.split(' ')[0]),
    );
    note('Probe 9: two dispatches to staging, second waits', [
      `first exit ${a.code}, second exit ${b.code}`,
      `second run said: ${b.stdout.split('\n').find((l) => l.includes('waiting'))}`,
      `recorded ops in order (${recorded.length}): ${recorded.map((c) => c.split(' ')[0]).join(' ')}`,
      'the first run recorded all of its operations before the second run recorded any',
    ]);
  });

  it('probe 10: a failing recovery step leaves the job red and alerts the owner', async () => {
    const f = fixture();
    const calls = join(f.dir, 'calls.log');
    const r = await run(releaseScript, ['--out-dir', f.out, ...f.args], {
      ...f.env,
      HOST_ADAPTER: 'stub',
      STUB_CALLS_FILE: calls,
      STUB_FAIL_OPS: 'smoke,rollback-worker',
    });
    expect(r.code).toBe(2);
    const recorded = callsOf(calls);
    expect(recorded.at(-1)).toMatch(/^alert /);
    expect(recorded.some((c) => c.startsWith('rollback-api'))).toBe(false);
    expect(recorded.filter((c) => c.startsWith('record'))).toHaveLength(0);
    const alerts = readFileSync(join(f.out, 'alerts-staging.log'), 'utf8');
    expect(alerts).toContain('rollback-worker failed');
    expect(readJson(join(f.out, 'deployment-result-staging.json')).status).toBe('recovery-failed');
    note('Probe 10: smoke fails, then recovery step rollback-worker fails', [
      `job exit code: ${r.code} (red)`,
      `recorded ops: ${recorded.map((c) => c.split(' ')[0]).join(' ')}`,
      `alert recorded: ${alerts.replace(/^\S+ /, '').trim()}`,
      `annotation: ${r.stderr.split('\n').find((l) => l.startsWith('::error::'))}`,
      'nothing after the failed recovery step ran (no rollback-api, no record)',
    ]);
  });

  it('writes the probe evidence', () => {
    mkdirSync(join(repoRoot, 'docs/evidence/TASK-013'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'docs/evidence/TASK-013/probes.txt'),
      `# TASK-013 probes 7, 9, 10 (real scripts, HOST_ADAPTER=stub, fixture G3 records, no credentials)\n\n${transcript.join('\n')}`,
    );
    expect(transcript).toHaveLength(3);
  });
});
