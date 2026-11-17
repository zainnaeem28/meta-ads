import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { HealthService } from '../../../src/platform/health/health.service.js';
import { AppMetrics } from '../../../src/platform/metrics/app-metrics.js';
import { METRICS_TOKEN } from './world.js';
import type { Account, World } from './world.js';
import { FAKE_KEY, PNG_BYTES, multipart } from './requests.js';
import { actorFor, record, unlinkedToken, send, withActor } from './cells.js';
import { Writable } from 'node:stream';
import { createApiApp } from '../../../src/bootstrap/api.module.js';
import { createHttpLogging } from '../../../src/platform/logging/index.js';
import { ORIGIN } from '../../security/support/stack.js';
import type { Observed, Probe } from './cells.js';
import * as fx from './fixtures.js';
import { ERROR_STATUS } from '../../../src/platform/http/domain-error.js';

// The cells the generic probes cannot reach: successes and the business refusals of each operation. Each probe builds the
// state the cell needs (through the API where it is cheap, with SQL where the API cannot get there fast) and then asks the
// operation under test, through HTTP, for the status.

const key = (): string => `conf-${randomUUID().slice(0, 12)}`;
const COMPLETE = {
  productName: 'Conformance Cap',
  productDescription: 'A calm morning drink',
  audience: { ageMin: 25, ageMax: 40 },
  direction: { goal: 'awareness', segmentCount: 2 },
  concept: 'A calm morning at the kitchen window',
};

type Op = Parameters<Probe>[1];
const idem = (k: string) => ({ 'idempotency-key': k });
const body = (payload: unknown) => (r: { payload?: unknown }) => {
  r.payload = payload;
};

async function draft(
  w: World,
  who: Account,
  payload: Record<string, unknown> = {},
): Promise<{ id: string; version: number }> {
  const res = await w.call('POST', '/drafts', who.token, payload);
  if (res.status !== 201) throw new Error(`draft failed ${String(res.status)} ${res.raw}`);
  return { id: res.body.data.id as string, version: res.body.data.version as number };
}

/**
 * The api composition root with the metrics token configured and no database: the stack of the matrix is built from a config
 * that carries no token, so the metrics routes (scope M) are asked of the same root built the way production builds it.
 */
async function metricsApp<T>(
  body: (
    get: (path: string, token: string | undefined) => Promise<Observed>,
    app: Awaited<ReturnType<typeof createApiApp>>['app'],
  ) => Promise<T>,
): Promise<T> {
  const sink = new Writable({
    write(_c, _e, done) {
      done();
    },
  });
  const { app } = await createApiApp(
    { WEB_ORIGIN: ORIGIN, APP_ENV: 'development', METRICS_TOKEN } as Parameters<
      typeof createApiApp
    >[0],
    createHttpLogging({ level: 'silent', destination: sink }),
    [],
  );
  const get = async (path: string, token: string | undefined): Promise<Observed> => {
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: path,
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      });
    let parsed: Observed['body'] = { success: res.statusCode < 400 };
    try {
      parsed = JSON.parse(res.body) as Observed['body'];
    } catch {
      /* the exposition format is text */
    }
    const seen = {
      status: res.statusCode,
      code: parsed.error?.code,
      headers: res.headers as Record<string, unknown>,
      text: res.body,
      body: parsed,
    };
    record({
      op: path === '/internal/metrics' ? 'API-902' : 'API-903',
      method: 'GET',
      status: seen.status,
      code: seen.code,
    });
    return seen;
  };
  try {
    return await body(get, app);
  } finally {
    await app.close();
  }
}

/** Registers a probe for a documented cell. */
const cells: Record<string, Probe> = {};
const cell = (id: string, status: number, probe: Probe): void => {
  cells[`${id} ${String(status)}`] = probe;
};
const user = (
  id: string,
  status: number,
  make: (w: World, op: Op, who: Account) => Promise<Observed | Observed[]>,
): void => cell(id, status, withActor(make));

// ---------------------------------------------------------------- platform
for (const id of ['API-900', 'API-901'])
  cell(id, 200, async (w, op) =>
    w.raw('GET', op.path, {}).then((r) => ({
      status: r.status,
      code: r.body.error?.code,
      headers: r.headers,
      text: r.text,
      body: r.body,
    })),
  );
cell('API-901', 503, async (w) => {
  await w.pool.query('alter schema pgboss rename to pgboss_zz');
  try {
    const r = await w.raw('GET', '/health/ready');
    return {
      status: r.status,
      code: r.body.error?.code,
      headers: r.headers,
      text: r.text,
      body: r.body,
    };
  } finally {
    await w.pool.query('alter schema pgboss_zz rename to pgboss');
  }
});
for (const id of ['API-902', 'API-903']) {
  cell(id, 200, (w, op) => metricsApp((get) => get(op.path, METRICS_TOKEN)));
  cell(id, 404, async (w, op) => {
    const user = await w.account('m');
    return metricsApp(async (get) => [
      await get(op.path, undefined),
      await get(op.path, 'x'.repeat(48)),
      await get(op.path, user.token),
    ]);
  });
  cell(id, 500, (_w, op) =>
    metricsApp(async (get, app) => {
      const instance = app.get(AppMetrics, { strict: false });
      const spy =
        id === 'API-902'
          ? vi.spyOn(instance, 'exposition').mockRejectedValueOnce(new Error('registry failed'))
          : vi.spyOn(instance.window, 'snapshot').mockImplementationOnce(() => {
              throw new Error('window failed');
            });
      try {
        return await get(op.path, METRICS_TOKEN);
      } finally {
        spy.mockRestore();
      }
    }),
  );
}
void HealthService;

// ---------------------------------------------------------------- identity, keys
user('API-001', 200, (w, op, who) => send(w, op, who.token));
cell('API-002', 202, async (w, op) => send(w.form as World, op, unlinkedToken(w.form as World)));
cell('API-002', 400, async (w, op) =>
  send(w.form as World, op, unlinkedToken(w.form as World), { mutate: body({ junk: 1 }) }),
);
user('API-002', 404, (w, op, who) => send(w, op, who.token));
user('API-010', 200, (w, op, who) => send(w, op, who.token));
user('API-011', 200, async (w, op, who) => {
  w.probe.answer = 200;
  return send(w, op, who.token);
});
user('API-011', 422, async (w, op, who) => {
  w.probe.answer = 401;
  try {
    return await send(w, op, who.token);
  } finally {
    w.probe.answer = 200;
  }
});
user('API-012', 204, async (w, op, who) => {
  await fx.putKey(w, who);
  return send(w, op, who.token);
});
user('API-013', 200, async (w, op, who) => {
  await fx.putKey(w, who);
  return send(w, op, who.token);
});

// ---------------------------------------------------------------- drafts
user('API-020', 200, async (w, op, who) => {
  await draft(w, who);
  return send(w, op, who.token);
});
user('API-021', 201, (w, op, who) => send(w, op, who.token));
user('API-021', 409, async (w, op, who) => {
  const image = await fx.media(w, who);
  await draft(w, who, { productMediaId: image });
  return send(w, op, who.token, { mutate: body({ productMediaId: image }) });
});
user('API-021', 422, async (w, op, who) =>
  send(w, op, who.token, {
    mutate: body({ productMediaId: await fx.media(w, who, 'upload', 'processing') }),
  }),
);
user('API-022', 200, async (w, op, who) =>
  send(w, op, who.token, { params: { draftId: (await draft(w, who)).id } }),
);
user('API-023', 200, async (w, op, who) =>
  send(w, op, who.token, { params: { draftId: (await draft(w, who)).id } }),
);
user('API-023', 409, async (w, op, who) => {
  const stale = await draft(w, who);
  const submitted = { id: (await fx.campaign(w, who)).draftId };
  return [
    await send(w, op, who.token, { params: { draftId: stale.id }, extra: { 'if-match': '"9"' } }),
    await send(w, op, who.token, { params: { draftId: submitted.id } }),
  ];
});
user('API-023', 422, async (w, op, who) =>
  send(w, op, who.token, {
    params: { draftId: (await draft(w, who)).id },
    mutate: body({ productMediaId: await fx.media(w, who, 'upload', 'processing') }),
  }),
);
user('API-025', 204, async (w, op, who) =>
  send(w, op, who.token, { params: { draftId: (await draft(w, who)).id } }),
);
user('API-025', 409, async (w, op, who) => {
  return send(w, op, who.token, { params: { draftId: (await fx.campaign(w, who)).draftId } });
});
{
  const ready = async (w: World, who: Account, extra: Record<string, unknown> = {}) =>
    (await draft(w, who, { ...COMPLETE, ...extra })).id;
  user('API-024', 202, async (w, op, who) => {
    await fx.putKey(w, who);
    return send(w, op, who.token, { params: { draftId: await ready(w, who) } });
  });
  user('API-024', 409, async (w, op, who) => {
    await fx.putKey(w, who);
    const k = key();
    const first = await send(w, op, who.token, {
      params: { draftId: await ready(w, who) },
      extra: idem(k),
    });
    const second = await send(w, op, who.token, {
      params: { draftId: await ready(w, who) },
      extra: idem(k),
    });
    return first.status === 202 ? second : first;
  });
  user('API-024', 422, async (w, op, who) => {
    const missing = await send(w, op, who.token, { params: { draftId: await ready(w, who) } });
    await fx.putKey(w, who);
    await w.pool.query(`update provider_keys set status = 'disabled' where owner_id = $1`, [
      who.id,
    ]);
    const disabled = await send(w, op, who.token, { params: { draftId: await ready(w, who) } });
    await w.pool.query(`update provider_keys set status = 'active' where owner_id = $1`, [who.id]);
    await fx.fillSpend(w, who);
    const capped = await send(w, op, who.token, { params: { draftId: await ready(w, who) } });
    const image = await fx.media(w, who);
    const pending = await ready(w, who, { productMediaId: image });
    await w.pool.query(`update media_objects set state = 'processing' where id = $1`, [image]);
    const processing = await send(w, op, who.token, { params: { draftId: pending } });
    return [missing, disabled, capped, processing];
  });
}

// ---------------------------------------------------------------- media
const upload =
  (bytes: Buffer, name = 'file') =>
  (r: { raw?: Buffer; headers: Record<string, string> }) => {
    const form = multipart(bytes, name);
    r.raw = form.payload;
    r.headers['content-type'] = form.headers['content-type'] as string;
  };
user('API-030', 201, (w, op, who) => send(w, op, who.token));
user('API-030', 413, (w, op, who) =>
  send(w, op, who.token, {
    mutate: upload(Buffer.concat([PNG_BYTES, Buffer.alloc(10 * 1024 * 1024 + 1024)])),
  }),
);
user('API-030', 415, (w, op, who) =>
  send(w, op, who.token, { mutate: upload(Buffer.from('this is text, not an image at all, ok?')) }),
);
user('API-030', 422, async (w, op, who) => {
  await w.pool.query(
    `insert into storage_usage (owner_id, bytes_used) values ($1, 21474836480) on conflict (owner_id) do update set bytes_used = 21474836480`,
    [who.id],
  );
  return send(w, op, who.token);
});
user('API-031', 200, async (w, op, who) =>
  send(w, op, who.token, { params: { mediaId: await fx.media(w, who) } }),
);
user('API-032', 200, async (w, op, who) =>
  send(w, op, who.token, { params: { mediaId: await fx.media(w, who) } }),
);
user('API-032', 422, async (w, op, who) =>
  send(w, op, who.token, { params: { mediaId: await fx.media(w, who, 'upload', 'processing') } }),
);
user('API-036', 200, async (w, op, who) =>
  send(w, op, who.token, { params: { mediaId: await fx.media(w, who) } }),
);
user('API-035', 202, async (w, op, who) => {
  await fx.putKey(w, who);
  return send(w, op, who.token, { params: { mediaId: await fx.media(w, who) } });
});
user('API-035', 409, async (w, op, who) => {
  await fx.putKey(w, who);
  const k = key();
  const first = await send(w, op, who.token, {
    params: { mediaId: await fx.media(w, who) },
    extra: idem(k),
  });
  const second = await send(w, op, who.token, {
    params: { mediaId: await fx.media(w, who) },
    extra: idem(k),
  });
  return first.status === 202 ? second : first;
});
user('API-035', 422, async (w, op, who) => {
  const noKey = await send(w, op, who.token, { params: { mediaId: await fx.media(w, who) } });
  await fx.putKey(w, who);
  const notReady = await send(w, op, who.token, {
    params: { mediaId: await fx.media(w, who, 'upload', 'processing') },
  });
  await w.pool.query(`update provider_keys set status = 'disabled' where owner_id = $1`, [who.id]);
  const disabled = await send(w, op, who.token, { params: { mediaId: await fx.media(w, who) } });
  await w.pool.query(`update provider_keys set status = 'active' where owner_id = $1`, [who.id]);
  await fx.fillSpend(w, who);
  const capped = await send(w, op, who.token, { params: { mediaId: await fx.media(w, who) } });
  return [noKey, notReady, disabled, capped];
});

// ---------------------------------------------------------------- campaigns and brief
user('API-040', 200, async (w, op, who) => {
  await fx.campaign(w, who);
  return send(w, op, who.token);
});
user('API-041', 200, async (w, op, who) =>
  send(w, op, who.token, { params: { campaignId: (await fx.campaign(w, who)).id } }),
);
user('API-042', 202, async (w, op, who) =>
  send(w, op, who.token, { params: { campaignId: (await fx.campaign(w, who)).id } }),
);
user('API-050', 200, async (w, op, who) =>
  send(w, op, who.token, {
    params: { campaignId: (await fx.campaign(w, who, { briefState: 'draft' })).id },
  }),
);
user('API-051', 200, async (w, op, who) =>
  send(w, op, who.token, {
    params: { campaignId: (await fx.campaign(w, who, { briefState: 'draft' })).id },
  }),
);
user('API-051', 409, async (w, op, who) => {
  const draftBrief = await fx.campaign(w, who, { briefState: 'draft' });
  const generating = await fx.campaign(w, who, { briefState: 'generating' });
  return [
    await send(w, op, who.token, {
      params: { campaignId: draftBrief.id },
      extra: { 'if-match': '"9"' },
    }),
    await send(w, op, who.token, { params: { campaignId: generating.id } }),
  ];
});
user('API-052', 200, async (w, op, who) =>
  send(w, op, who.token, {
    params: { campaignId: (await fx.campaign(w, who, { briefState: 'draft' })).id },
  }),
);
user('API-052', 409, async (w, op, who) => {
  const stale = await fx.campaign(w, who, { briefState: 'draft' });
  const generating = await fx.campaign(w, who, { briefState: 'generating' });
  return [
    await send(w, op, who.token, {
      params: { campaignId: stale.id },
      extra: { 'if-match': '"9"' },
    }),
    await send(w, op, who.token, { params: { campaignId: generating.id } }),
  ];
});
user('API-052', 422, async (w, op, who) => {
  const c = await fx.campaign(w, who, { briefState: 'draft' });
  await fx.claimIssue(w, who, c, 'other');
  return send(w, op, who.token, { params: { campaignId: c.id } });
});
user('API-053', 202, async (w, op, who) => {
  await fx.putKey(w, who);
  return send(w, op, who.token, {
    params: { campaignId: (await fx.campaign(w, who, { briefState: 'draft' })).id },
  });
});
user('API-053', 409, async (w, op, who) => {
  await fx.putKey(w, who);
  const generating = await fx.campaign(w, who, { briefState: 'generating' });
  const target = await fx.campaign(w, who, { briefState: 'draft' });
  const other = await fx.campaign(w, who, { briefState: 'draft' });
  const k = key();
  await send(w, op, who.token, { params: { campaignId: target.id }, extra: idem(k) });
  return [
    await send(w, op, who.token, { params: { campaignId: generating.id } }),
    await send(w, op, who.token, { params: { campaignId: other.id }, extra: idem(k) }),
  ];
});
user('API-053', 422, async (w, op, who) => {
  const noKey = await send(w, op, who.token, {
    params: { campaignId: (await fx.campaign(w, who, { briefState: 'draft' })).id },
  });
  await fx.putKey(w, who);
  await w.pool.query(`update provider_keys set status = 'disabled' where owner_id = $1`, [who.id]);
  const disabled = await send(w, op, who.token, {
    params: { campaignId: (await fx.campaign(w, who, { briefState: 'draft' })).id },
  });
  await w.pool.query(`update provider_keys set status = 'active' where owner_id = $1`, [who.id]);
  await fx.fillSpend(w, who);
  const capped = await send(w, op, who.token, {
    params: { campaignId: (await fx.campaign(w, who, { briefState: 'draft' })).id },
  });
  return [noKey, disabled, capped];
});
user('API-054', 200, async (w, op, who) => {
  const c = await fx.campaign(w, who, { briefState: 'draft' });
  return send(w, op, who.token, { params: { issueId: await fx.claimIssue(w, who, c, 'other') } });
});
user('API-054', 409, async (w, op, who) => {
  const c = await fx.campaign(w, who, { briefState: 'draft' });
  const issue = await fx.claimIssue(w, who, c, 'other');
  await w.pool.query(
    `update claim_issues set resolution = 'closed_by_edit', resolved_at = now() where id = $1`,
    [issue],
  );
  return send(w, op, who.token, { params: { issueId: issue } });
});
user('API-054', 422, async (w, op, who) => {
  const c = await fx.campaign(w, who, { briefState: 'draft' });
  return send(w, op, who.token, {
    params: { issueId: await fx.claimIssue(w, who, c, 'high_risk') },
  });
});

// ---------------------------------------------------------------- production
const withWaveKey = async (w: World, who: Account): Promise<void> => {
  await fx.putKey(w, who, 'wavespeed');
};
user('API-060', 202, async (w, op, who) => {
  await withWaveKey(w, who);
  return send(w, op, who.token, { params: { campaignId: (await fx.campaign(w, who)).id } });
});
user('API-060', 409, async (w, op, who) => {
  await withWaveKey(w, who);
  const k = key();
  const c = await fx.campaign(w, who);
  await send(w, op, who.token, { params: { campaignId: c.id, position: '1' }, extra: idem(k) });
  return send(w, op, who.token, { params: { campaignId: c.id, position: '2' }, extra: idem(k) });
});
user('API-060', 422, async (w, op, who) => {
  const noKey = await send(w, op, who.token, {
    params: { campaignId: (await fx.campaign(w, who)).id },
  });
  const notAccepted = await send(w, op, who.token, {
    params: { campaignId: (await fx.campaign(w, who, { briefState: 'draft' })).id },
  });
  await withWaveKey(w, who);
  await w.pool.query(`update provider_keys set status = 'disabled' where owner_id = $1`, [who.id]);
  const disabled = await send(w, op, who.token, {
    params: { campaignId: (await fx.campaign(w, who)).id },
  });
  await w.pool.query(`update provider_keys set status = 'active' where owner_id = $1`, [who.id]);
  await fx.fillSpend(w, who);
  const capped = await send(w, op, who.token, {
    params: { campaignId: (await fx.campaign(w, who)).id },
  });
  return [noKey, notAccepted, disabled, capped];
});
user('API-061', 200, async (w, op, who) => {
  const c = await fx.campaign(w, who);
  await fx.videoJob(w, who, c);
  return send(w, op, who.token, { params: { campaignId: c.id } });
});
user('API-062', 200, async (w, op, who) => {
  const c = await fx.campaign(w, who);
  return send(w, op, who.token, { params: { videoJobId: await fx.videoJob(w, who, c) } });
});
user('API-063', 202, async (w, op, who) => {
  await withWaveKey(w, who);
  const c = await fx.campaign(w, who);
  return send(w, op, who.token, {
    params: { videoJobId: await fx.videoJob(w, who, c, 1, 'failed') },
  });
});
user('API-063', 409, async (w, op, who) => {
  await withWaveKey(w, who);
  const c = await fx.campaign(w, who);
  return send(w, op, who.token, {
    params: { videoJobId: await fx.videoJob(w, who, c, 1, 'completed') },
  });
});
user('API-063', 422, async (w, op, who) => {
  const failed = async (): Promise<string> =>
    fx.videoJob(w, who, await fx.campaign(w, who), 1, 'failed');
  const noKey = await send(w, op, who.token, { params: { videoJobId: await failed() } });
  const draftCampaign = await fx.campaign(w, who, { briefState: 'draft' });
  const notAccepted = await send(w, op, who.token, {
    params: { videoJobId: await fx.videoJob(w, who, draftCampaign, 1, 'failed') },
  });
  await withWaveKey(w, who);
  await w.pool.query(`update provider_keys set status = 'disabled' where owner_id = $1`, [who.id]);
  const disabled = await send(w, op, who.token, { params: { videoJobId: await failed() } });
  await w.pool.query(`update provider_keys set status = 'active' where owner_id = $1`, [who.id]);
  await fx.fillSpend(w, who);
  const capped = await send(w, op, who.token, { params: { videoJobId: await failed() } });
  return [noKey, notAccepted, disabled, capped];
});
user('API-064', 202, async (w, op, who) => {
  await fx.putKey(w, who);
  const c = await fx.campaign(w, who);
  return send(w, op, who.token, { params: { videoJobId: await fx.videoJob(w, who, c) } });
});
user('API-064', 409, async (w, op, who) => {
  await fx.putKey(w, who);
  const k = key();
  const c = await fx.campaign(w, who);
  await send(w, op, who.token, {
    params: { videoJobId: await fx.videoJob(w, who, c, 1) },
    extra: idem(k),
  });
  return send(w, op, who.token, {
    params: { videoJobId: await fx.videoJob(w, who, c, 2) },
    extra: idem(k),
  });
});
user('API-064', 422, async (w, op, who) => {
  const c = await fx.campaign(w, who);
  const notDone = await send(w, op, who.token, {
    params: { videoJobId: await fx.videoJob(w, who, c, 1, 'processing') },
  });
  const noKey = await send(w, op, who.token, {
    params: { videoJobId: await fx.videoJob(w, who, c, 1) },
  });
  await fx.putKey(w, who);
  await w.pool.query(`update provider_keys set status = 'disabled' where owner_id = $1`, [who.id]);
  const disabled = await send(w, op, who.token, {
    params: { videoJobId: await fx.videoJob(w, who, c, 2) },
  });
  await w.pool.query(`update provider_keys set status = 'active' where owner_id = $1`, [who.id]);
  await fx.fillSpend(w, who);
  const capped = await send(w, op, who.token, {
    params: { videoJobId: await fx.videoJob(w, who, c, 2) },
  });
  return [notDone, noKey, disabled, capped];
});
const assembly = async (
  w: World,
  who: Account,
  qc: 'passed' | 'failed' | 'none' = 'passed',
): Promise<{ c: fx.Campaign; job: string }> => {
  const c = await fx.campaign(w, who);
  const job = await fx.videoJob(w, who, c);
  if (qc !== 'none') await fx.qcRun(w, who, job, qc);
  return { c, job };
};
user('API-070', 202, async (w, op, who) => {
  const { c, job } = await assembly(w, who);
  return send(w, op, who.token, { params: { campaignId: c.id }, mutate: body({ clips: [job] }) });
});
user('API-070', 409, async (w, op, who) => {
  const k = key();
  const a = await assembly(w, who);
  const b = await assembly(w, who);
  await send(w, op, who.token, {
    params: { campaignId: a.c.id },
    mutate: body({ clips: [a.job] }),
    extra: idem(k),
  });
  return send(w, op, who.token, {
    params: { campaignId: b.c.id },
    mutate: body({ clips: [b.job] }),
    extra: idem(k),
  });
});
user('API-070', 422, async (w, op, who) => {
  const running = await fx.campaign(w, who);
  const notDone = await send(w, op, who.token, {
    params: { campaignId: running.id },
    mutate: body({ clips: [await fx.videoJob(w, who, running, 1, 'processing')] }),
  });
  const failedQc = await assembly(w, who, 'failed');
  const needsConfirmation = await send(w, op, who.token, {
    params: { campaignId: failedQc.c.id },
    mutate: body({ clips: [failedQc.job] }),
  });
  const full = await assembly(w, who);
  for (let i = 0; i < 25; i += 1)
    await w.pool.query(
      `insert into assembly_jobs (id, owner_id, campaign_id, state, reuse_hash, render_day) values ($1, $2, $3, 'done', $4, current_date)`,
      [randomUUID(), who.id, full.c.id, randomUUID().replace(/-/g, '').padEnd(64, '0')],
    );
  const limit = await send(w, op, who.token, {
    params: { campaignId: full.c.id },
    mutate: body({ clips: [full.job] }),
  });
  return [notDone, needsConfirmation, limit];
});
user('API-071', 200, async (w, op, who) => {
  const { c, job } = await assembly(w, who);
  return send(w, op, who.token, { params: { assemblyId: await fx.assemblyJob(w, who, c, job) } });
});
user('API-075', 202, async (w, op, who) => {
  await fx.putKey(w, who);
  return send(w, op, who.token, { params: { campaignId: (await fx.campaign(w, who)).id } });
});
user('API-075', 409, async (w, op, who) => {
  await fx.putKey(w, who);
  const k = key();
  const a = await fx.campaign(w, who);
  const b = await fx.campaign(w, who);
  await send(w, op, who.token, { params: { campaignId: a.id }, extra: idem(k) });
  return send(w, op, who.token, { params: { campaignId: b.id }, extra: idem(k) });
});
user('API-075', 422, async (w, op, who) => {
  const claim = await send(w, op, who.token, {
    params: { campaignId: (await fx.campaign(w, who)).id },
    mutate: body({ calloutText: 'Clinically proven to cure anxiety' }),
  });
  const noKey = await send(w, op, who.token, {
    params: { campaignId: (await fx.campaign(w, who)).id },
  });
  await fx.putKey(w, who);
  await w.pool.query(`update provider_keys set status = 'disabled' where owner_id = $1`, [who.id]);
  const disabled = await send(w, op, who.token, {
    params: { campaignId: (await fx.campaign(w, who)).id },
  });
  await w.pool.query(`update provider_keys set status = 'active' where owner_id = $1`, [who.id]);
  await fx.fillSpend(w, who);
  const capped = await send(w, op, who.token, {
    params: { campaignId: (await fx.campaign(w, who)).id },
  });
  return [claim, noKey, disabled, capped];
});
user('API-076', 200, async (w, op, who) => {
  const c = await fx.campaign(w, who);
  await fx.thumbstopper(w, who, c);
  return send(w, op, who.token, { params: { campaignId: c.id } });
});

// ---------------------------------------------------------------- administration
const target = async (w: World, label = 'target'): Promise<Account> => w.account(label);
user('API-100', 200, (w, op, who) => send(w, op, who.token));
user('API-101', 200, async (w, op, who) =>
  send(w, op, who.token, { params: { userId: (await target(w)).id } }),
);
user('API-101', 409, async (w, op, who) => {
  const t = await target(w);
  await w.pool.query(`update users set status = 'removed' where id = $1`, [t.id]);
  return send(w, op, who.token, { params: { userId: t.id } });
});
user('API-101', 422, async (w, op, who) => send(w, op, who.token, { params: { userId: who.id } }));
user('API-102', 200, async (w, op, who) => {
  const t = await target(w);
  await w.pool.query(`update users set status = 'suspended' where id = $1`, [t.id]);
  return send(w, op, who.token, { params: { userId: t.id } });
});
user('API-102', 409, async (w, op, who) => {
  const t = await target(w);
  await w.pool.query(`update users set status = 'removed' where id = $1`, [t.id]);
  return send(w, op, who.token, { params: { userId: t.id } });
});
user('API-103', 202, async (w, op, who) => {
  const t = await target(w);
  return send(w, op, who.token, {
    params: { userId: t.id },
    mutate: body({ confirmation: t.email }),
  });
});
user('API-103', 409, async (w, op, who) => {
  const t = await target(w);
  await w.pool.query(`update users set status = 'removed' where id = $1`, [t.id]);
  return send(w, op, who.token, {
    params: { userId: t.id },
    mutate: body({ confirmation: t.email }),
  });
});
user('API-103', 422, async (w, op, who) => {
  const t = await target(w);
  return [
    await send(w, op, who.token, {
      params: { userId: t.id },
      mutate: body({ confirmation: 'not-the-email@example.test' }),
    }),
    await send(w, op, who.token, {
      params: { userId: who.id },
      mutate: body({ confirmation: who.email }),
    }),
  ];
});
user('API-104', 200, async (w, op, who) =>
  send(w, op, who.token, { params: { userId: (await target(w)).id } }),
);
user('API-104', 409, async (w, op, who) => {
  const t = await target(w);
  const gone = await target(w);
  await w.pool.query(`update users set status = 'suspended' where id = $1`, [gone.id]);
  return [
    await send(w, op, who.token, { params: { userId: t.id }, extra: { 'if-match': '"9"' } }),
    await send(w, op, who.token, { params: { userId: gone.id } }),
  ];
});
user('API-104', 422, async (w, op, who) =>
  send(w, op, who.token, {
    params: { userId: who.id },
    mutate: body({ role: 'user' }),
    extra: { 'if-match': '"1"' },
  }),
);
user('API-105', 200, (w, op, who) => send(w, op, who.token));
user('API-110', 200, (w, op, who) => send(w, op, who.token));
user('API-111', 202, (w, op, who) => send(w, op, who.token));
user('API-111', 422, (w, op, who) =>
  send(w, op, who.token, { mutate: body({ email: 'someone@outside-domain.invalid' }) }),
);
user('API-112', 200, async (w, op, who) =>
  send(w, op, who.token, { params: { invitationId: await fx.invitation(w, who.id) } }),
);
user('API-112', 409, async (w, op, who) =>
  send(w, op, who.token, {
    params: { invitationId: await fx.invitation(w, who.id, undefined, 'expired') },
  }),
);
user('API-113', 200, async (w, op, who) =>
  send(w, op, who.token, { params: { invitationId: await fx.invitation(w, who.id) } }),
);
user('API-113', 409, async (w, op, who) =>
  send(w, op, who.token, {
    params: { invitationId: await fx.invitation(w, who.id, undefined, 'expired') },
  }),
);
user('API-115', 200, async (w, op, who) => {
  await fx.accessRequest(w);
  return send(w, op, who.token);
});
user('API-116', 200, async (w, op, who) =>
  send(w, op, who.token, { params: { accessRequestId: await fx.accessRequest(w) } }),
);
user('API-116', 409, async (w, op, who) =>
  send(w, op, who.token, { params: { accessRequestId: await fx.accessRequest(w, 'declined') } }),
);
user('API-116', 422, async (w, op, who) =>
  send(w, op, who.token, {
    params: {
      accessRequestId: await fx.accessRequest(w, 'pending', 'asker@outside-domain.invalid'),
    },
  }),
);
user('API-117', 200, async (w, op, who) =>
  send(w, op, who.token, { params: { accessRequestId: await fx.accessRequest(w) } }),
);
user('API-117', 409, async (w, op, who) =>
  send(w, op, who.token, { params: { accessRequestId: await fx.accessRequest(w, 'approved') } }),
);
user('API-120', 200, (w, op, who) => send(w, op, who.token));
user('API-121', 200, (w, op, who) => send(w, op, who.token));
user('API-121', 422, (w, op, who) => send(w, op, who.token, { mutate: body({ mode: 'open' }) }));
user('API-125', 200, (w, op, who) => send(w, op, who.token));
user('API-126', 200, async (w, op, who) => {
  const id = randomUUID();
  await w.pool.query(
    `insert into admin_alerts (id, kind, subject_user_id, counts) values ($1, 'job_burst', null, '{}'::jsonb)`,
    [id],
  );
  return send(w, op, who.token, { params: { alertId: id } });
});
user('API-130', 200, (w, op, who) => send(w, op, who.token));
user('API-130', 422, (w, op, who) =>
  send(w, op, who.token, {
    mutate: (r) => {
      r.url += '?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z';
    },
  }),
);
user('API-131', 200, (w, op, who) => send(w, op, who.token));
user('API-131', 422, (w, op, who) =>
  send(w, op, who.token, {
    mutate: (r) => {
      r.url += '?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z';
    },
  }),
);

/**
 * Documented cells the product cannot answer (a finding in docs/evidence/TASK-065/findings.md). The cell still has a test: it
 * asserts what the product does instead, so the day the product (or the contract) changes the test says so.
 */
export interface Waiver {
  readonly finding: string;
  readonly instead: number;
  readonly probe: Probe;
}
const waivers: Record<string, Waiver> = {};
// API-102: the account that asks is active, so asking for itself to become active is a no-op 200, never `self_action`.
waivers['API-102 422'] = {
  finding: 'CONF065-F3',
  instead: 200,
  probe: withActor((w, op, who) => send(w, op, who.token, { params: { userId: who.id } })),
};
export const WAIVED: Readonly<Record<string, Waiver>> = waivers;

export const SPECIFIC: Readonly<Record<string, Probe>> = cells;
void actorFor;
void FAKE_KEY;
void ERROR_STATUS;
