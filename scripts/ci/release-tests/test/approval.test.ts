import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { digest, fixture, run, verifyScript, withArg, without } from './harness.ts';

const verify = (f: ReturnType<typeof fixture>, args = f.args, env: Record<string, string> = {}) =>
  run(verifyScript, args, { ...f.env, ...env });

describe('verify-release-approval.sh', () => {
  it('accepts a complete G3 record for the exact digests, configuration, plan and environment', async () => {
    const r = await verify(fixture());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('approval: ACCEPTED for staging');
    expect(r.stdout).toContain('UNPROVABLE identity');
  });

  it('accepts the hash-recorded fallback record and rejects a record altered after hashing', async () => {
    const f = fixture();
    const hash = (await import('node:crypto'))
      .createHash('sha256')
      .update((await import('node:fs')).readFileSync(f.files.g3))
      .digest('hex');
    expect((await verify(f, [...f.args, '--g3-sha256', hash])).code).toBe(0);
    const r = await verify(f, [...f.args, '--g3-sha256', 'f'.repeat(64)]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('g3-hash');
  });

  const rejected: [string, () => ReturnType<typeof fixture>, string][] = [
    [
      'a wrong digest in the G3 record',
      () =>
        fixture({
          g3: { digests: { api: digest('other'), worker: digest('worker'), web: digest('web') } },
        }),
      'digests-registry',
    ],
    [
      'a registry digest that differs from G3',
      () => fixture({ actual: { web: digest('swapped') } }),
      'digests-registry',
    ],
    [
      'a quality.json digest that differs from G3',
      () =>
        fixture({
          quality: {
            digests: { api: digest('api'), worker: digest('worker'), web: digest('other') },
          },
        }),
      'digests-quality',
    ],
    [
      'a malformed digest',
      () =>
        fixture({
          g3: { digests: { api: 'latest', worker: digest('worker'), web: digest('web') } },
        }),
      'g3-digests-shape',
    ],
    [
      'a G3 for the other environment',
      () => fixture({ g3: { environment: 'production' } }),
      'g3-environment',
    ],
    [
      'a G3 decision that is not PASS',
      () => fixture({ g3: { decision: 'CHANGES' } }),
      'g3-decision',
    ],
    [
      'a G3 for another source commit',
      () => fixture({ g3: { sourceSha: 'b'.repeat(40) } }),
      'g3-source',
    ],
    [
      'a G3 that approved another quality.json',
      () => fixture({ g3: { qualitySha256: '0'.repeat(64) } }),
      'quality-hash',
    ],
    [
      'quality.json for another commit',
      () => fixture({ quality: { sourceSha: 'c'.repeat(40) } }),
      'quality-source',
    ],
    [
      'quality.json that is not PASS',
      () => fixture({ quality: { result: 'FAIL' } }),
      'quality-result',
    ],
    ['a G3 without a plan revision', () => fixture({ g3: { planRevision: '' } }), 'plan-revision'],
    [
      'targets that differ from the expected values',
      () =>
        fixture({ g3: { targets: { hosts: ['evil.example.test'], database: 'x', bucket: 'y' } } }),
      'targets',
    ],
    [
      'a stale G3 record',
      () => fixture({ g3: { approvedAt: '2026-02-01T00:00:00Z' } }),
      'g3-fresh',
    ],
    [
      'a G3 approval dated in the future',
      () => fixture({ g3: { approvedAt: '2027-01-01T00:00:00Z' } }),
      'g3-fresh',
    ],
    ['a G3 with no approval time', () => fixture({ g3: { approvedAt: '' } }), 'g3-fresh'],
    [
      'a G3 that was already used for a release',
      () => fixture({ releases: [{ environment: 'staging', runId: '50', g3Ref: 'g3-100' }] }),
      'not-stale',
    ],
    [
      'a G3 with no ref',
      () => fixture({ g3: { ref: '' }, releases: [{ environment: 'staging', runId: '50', g3Ref: '' }] }),
      'g3-ref',
    ],
    [
      'a run older than the last release',
      () => fixture({ releases: [{ environment: 'staging', runId: '500', g3Ref: 'g3-1' }] }),
      'not-stale',
    ],
  ];
  it.each(rejected)('rejects %s', async (_name, build, check) => {
    const r = await verify(build());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`FAIL ${check}`);
    expect(r.stderr).toContain('REJECTED');
  });

  it('rejects a missing G3 record (fails closed)', async () => {
    const r = await verify(fixture({ skipG3: true }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('evidence file missing or unreadable');
  });

  it('rejects a dispatch from any ref other than main', async () => {
    const f = fixture();
    const r = await verify(f, withArg(f.args, '--ref', 'refs/heads/dev'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('FAIL dispatch-ref');
  });

  it('applies the restricted-identity rule when it is enabled', async () => {
    const f = fixture({ g3: { writtenBy: 'devops' } });
    const same = await verify(f, [...f.args, '--identity-mode', 'restricted']);
    expect(same.code).toBe(1);
    expect(same.stderr).toContain('FAIL identity');
    const other = fixture({ g3: { writtenBy: 'owner' } });
    expect((await verify(other, [...other.args, '--identity-mode', 'restricted'])).code).toBe(0);
  });

  it('honours G3_MAX_AGE_HOURS', async () => {
    const f = fixture();
    expect((await verify(f, f.args, { G3_MAX_AGE_HOURS: '1' })).code).toBe(1);
  });

  it('uses the real clock when no test clock is given', async () => {
    const f = fixture();
    const r = await run(verifyScript, f.args, { RELEASE_LOCK_DIR: f.env.RELEASE_LOCK_DIR! });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('FAIL g3-fresh');
  });

  it('rejects an evidence file that is not JSON', async () => {
    const f = fixture();
    writeFileSync(f.files.quality, 'not json');
    const r = await verify(f);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not valid JSON');
  });

  it.each([
    ['unknown argument', (a: string[]) => [...a, '--approved', 'true'], 'unknown argument'],
    ['a flag without a value', (a: string[]) => [...a, '--ref'], 'missing value'],
    [
      'an unknown environment',
      (a: string[]) => withArg(a, '--environment', 'dev'),
      'environment must be',
    ],
    ['a short source sha', (a: string[]) => withArg(a, '--source-sha', 'abc'), 'source-sha'],
    ['a non-numeric run id', (a: string[]) => withArg(a, '--run-id', 'x'), 'run-id'],
    ['no dispatcher', (a: string[]) => without(a, '--dispatcher'), 'dispatcher is required'],
    ['no release record', (a: string[]) => without(a, '--release-record'), 'evidence file missing'],
  ])('rejects %s', async (_name, change, message) => {
    const f = fixture();
    const r = await verify(f, change(f.args));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(message);
  });

  it('does not treat an APPROVED variable as evidence', async () => {
    const f = fixture({ skipG3: true });
    const r = await verify(f, f.args, { APPROVED: 'true' });
    expect(r.code).toBe(1);
  });
});
