/* global __ENV, __VU, __ITER, open, console */
// k6 script of the scaled-down NFR-01 target (QUALITY-RELEASE-PLAN section 6, TC-NFR-01). Every number comes from the
// environment that scripts/ci/load.sh fills from config/quality-policy.json (baselines.load); nothing is fixed here.
//
// Model: VUS virtual users act as the seeded accounts in turn (each account owns STUB_JOBS running stub jobs), think
// THINK seconds between actions, and poll a running campaign's job status every POLL seconds. About READ_SHARE of the
// actions read (history, detail, brief, key list, drafts, job-status poll), the rest write (create, save and delete a
// draft). The last virtual user is the administrator reading the admin routes.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';

const num = (name) => {
  const value = Number(__ENV[name]);
  if (!Number.isFinite(value)) throw new Error(`${name} is required`);
  return value;
};

const VUS = num('VUS');
const RAMP = num('RAMP_SEC');
const STEADY = num('STEADY_SEC');
const THINK = num('THINK_SEC');
const POLL = num('POLL_SEC');
const READ_SHARE = num('READ_SHARE');
const API = __ENV.API_URL;
const state = new SharedArray('state', () => [JSON.parse(open(__ENV.STATE_FILE))]);

const interactive = new Trend('interactive_duration', true);
const writes = new Counter('write_actions');
const reads = new Counter('read_actions');
const unauthorized = new Counter('status_401');
const capacity = new Counter('status_capacity'); // 429, 502, 503, 504: the service refusing or failing for lack of capacity
const serverError = new Counter('status_5xx');
const unexpected = new Counter('status_unexpected'); // any non-2xx answer the model does not expect
const requests = new Counter('model_requests');

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }));

export const options = {
  scenarios: {
    mixed: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: `${RAMP}s`, target: VUS },
        { duration: `${STEADY}s`, target: VUS },
      ],
      gracefulRampDown: '5s',
      gracefulStop: '15s',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const own = {}; // per-VU cache: account index -> { campaigns: [ids] }

function call(method, path, token, body, headers, expected) {
  const params = {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(headers || {}),
    },
  };
  const response = http.request(
    method,
    `${API}/api/v1${path}`,
    body === undefined ? null : JSON.stringify(body),
    params,
  );
  requests.add(1);
  interactive.add(response.timings.duration);
  if (response.status === 401) unauthorized.add(1);
  if ([429, 502, 503, 504].includes(response.status)) capacity.add(1);
  if (response.status >= 500 || response.status === 0) serverError.add(1);
  const ok = expected
    ? response.status === expected
    : response.status >= 200 && response.status < 300;
  if (!ok) {
    unexpected.add(1);
    if (__ENV.LOG_UNEXPECTED)
      console.warn(
        `unexpected ${response.status} ${method} ${path} ${String(response.body).slice(0, 160)}`,
      );
  }
  check(response, { [`${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')} ok`]: () => ok });
  return response;
}

function jsonOr(response, selector, fallback) {
  try {
    return response.json(selector);
  } catch {
    return fallback;
  }
}

function campaignsOf(account) {
  const key = account.sub;
  if (!own[key]) {
    const list = call('GET', '/campaigns?limit=20', account.token);
    own[key] = { campaigns: jsonOr(list, 'data', []).map((c) => c.id) };
  }
  return own[key].campaigns;
}

export default function () {
  const { users, admin } = state[0];
  const isAdmin = __VU === VUS;
  const account = isAdmin ? admin : users[(__VU - 1 + __ITER * VUS) % users.length];
  const token = account.token;

  if (isAdmin) {
    const paths = [
      '/admin/users',
      '/admin/usage-report',
      '/admin/settings',
      '/admin/alerts',
      '/admin/invitations',
    ];
    call('GET', paths[__ITER % paths.length], token);
    reads.add(1);
    sleep(THINK);
    return;
  }

  const ids = campaignsOf(account);
  if (Math.random() < READ_SHARE) {
    reads.add(1);
    const pick = ids[Math.floor(Math.random() * ids.length)];
    const roll = Math.random();
    if (roll < 0.35) {
      // the status poll of the clips screen: every POLL seconds while the stub jobs run
      call('GET', `/campaigns/${pick}/video-jobs`, token);
      sleep(POLL);
      call('GET', `/campaigns/${pick}/video-jobs`, token);
    } else if (roll < 0.55) {
      call('GET', '/campaigns?limit=20', token);
    } else if (roll < 0.7) {
      call('GET', `/campaigns/${pick}`, token);
    } else if (roll < 0.85) {
      call('GET', `/campaigns/${pick}/brief`, token);
    } else if (roll < 0.93) {
      call('GET', '/me/provider-keys', token);
    } else {
      call('GET', '/drafts', token);
    }
  } else {
    writes.add(1);
    const created = call('POST', '/drafts', token, {}, {}, 201);
    const id = jsonOr(created, 'data.id', null);
    if (id) {
      sleep(THINK);
      call(
        'PATCH',
        `/drafts/${id}`,
        token,
        { productName: 'Baseline draft' },
        { 'If-Match': '"1"' },
      );
      sleep(THINK);
      call('DELETE', `/drafts/${id}`, token, undefined, {}, 204);
    }
  }
  sleep(THINK);
}

export function handleSummary(data) {
  return { [__ENV.SUMMARY_FILE]: JSON.stringify(data, null, 2) };
}
