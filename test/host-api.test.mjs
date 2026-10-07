/**
 * Offline checks for the Host half: normalization of the four account payloads,
 * cache and credential behaviour, and both routes. No network, no real key.
 *
 *   node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { apply, inject, name } from '../index.js';

const KEY_REF = 'COMMAND_CODE_API_KEY';
const ENABLED_REF = 'COMMAND_CODE_USAGE_ENABLED';
const ELLIPSIS = '\u2026';

// ---------------------------------------------------------------------------
// Fixtures: the shapes the account API answers with, trimmed to what is read.
// ---------------------------------------------------------------------------

const GOAT = {
  whoami: { success: true, user: { id: 'u1', name: 'xjphhh', email: 'x@example.com' }, org: null },
  summary: {
    totalCount: 709,
    successRate: 100,
    completedCount: 709,
    failedCount: 0,
    totalTokensIn: 21235607,
    totalTokensOut: 235665,
    totalTokens: 21471272,
    totalCredits: 2.2986040503999994,
    totalFreeCredits: 0,
    totalMonthlyCredits: 2.2986040503999994,
    totalPurchasedCredits: 0,
    periodBasis: 'billing-period',
  },
  credits: {
    credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 67.6517552326, purchasedCredits: 0, freeCredits: 0 },
    windowLimits: {
      limited: true,
      exceeded: null,
      fiveHour: { used: 0.132790966, cap: 14, exceeded: false, resetAt: 1791351771195 },
      weekly: { used: 2.3482447674, cap: 35, exceeded: false, resetAt: 1791855428661 },
    },
    sandboxAccess: false,
    sandboxMinutes: null,
  },
  subscription: {
    success: true,
    data: {
      id: 'sub_1',
      status: 'active',
      currentPeriodStart: '2026-10-06T01:12:14.000Z',
      currentPeriodEnd: '2026-11-06T01:12:14.000Z',
      planId: 'individual-goat',
      cancelAtPeriodEnd: false,
    },
  },
};

/** The $15 Provider plan: metered, so there are no rolling windows to report. */
const PROVIDER = {
  ...GOAT,
  credits: { credits: { monthlyCredits: 12.5, purchasedCredits: 5, freeCredits: 0 }, windowLimits: null },
  subscription: { success: true, data: { ...GOAT.subscription.data, planId: 'individual-provider' } },
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeCredentials(initial) {
  const refs = new Map(Object.entries(initial ?? {}));
  return {
    refs,
    resolve: async (ref) => (refs.has(ref) ? { value: refs.get(ref), source: 'credentials' } : undefined),
    describe: async () => ({ writable: true }),
    set: async (ref, value) => {
      refs.set(ref, value);
    },
    unset: async (ref) => {
      refs.delete(ref);
    },
  };
}

function makeCtx(credentials, rejection) {
  const routes = new Map();
  const disposers = [];
  const ctx = {
    get: (service) => (service === 'credentials' ? credentials : undefined),
    // Cordis runs the effect body now and keeps the disposer it returns.
    effect: (run) => {
      disposers.push(run());
    },
    connection: { requestRejection: () => rejection },
    webServer: {
      register: (route) => {
        routes.set(route.path, route);
        return () => {};
      },
    },
  };
  return { ctx, routes, disposers };
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk);
    },
  };
}

/** One request through a registered route; returns the parsed body. */
async function call(route, { method = 'GET', url = route.path, body, raw } = {}) {
  const chunks = raw !== undefined ? [Buffer.from(raw)] : body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  const req = {
    method,
    url,
    on(event, handler) {
      if (event === 'data') {
        for (const chunk of chunks) handler(chunk);
        return this;
      }
      if (event === 'end') {
        handler();
        return this;
      }
      return this;
    },
    destroy() {},
  };
  const res = makeRes();
  await route.handler(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body.length > 0 ? JSON.parse(res.body) : null };
}

/** Replace global fetch with a table of endpoint answers; returns the call log. */
function stubFetch(answers) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const answer = answers[path] ?? { status: 404, body: {} };
    if (answer.networkError === true) throw new Error('socket hang up');
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.body,
      text: async () => (typeof answer.text === 'string' ? answer.text : JSON.stringify(answer.body ?? {})),
    };
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function answersFrom(fixtures) {
  return {
    '/alpha/whoami': { status: 200, body: fixtures.whoami },
    '/alpha/usage/summary': { status: 200, body: fixtures.summary },
    '/alpha/billing/credits': { status: 200, body: fixtures.credits },
    '/alpha/billing/subscriptions': { status: 200, body: fixtures.subscription },
  };
}

async function setup({
  credentials = makeCredentials({ [KEY_REF]: 'user_test_key_0123456789' }),
  rejection,
  fixtures = GOAT,
  answers,
  config,
} = {}) {
  const { ctx, routes, disposers } = makeCtx(credentials, rejection);
  apply(ctx, config ?? {});
  const net = stubFetch(answers ?? answersFrom(fixtures));
  return { routes, disposers, net, credentials };
}

// ---------------------------------------------------------------------------
// The day's own figure, folded from session logs on disk
// ---------------------------------------------------------------------------

/** One `assistant/message` event, shaped like the ones the Harness writes. */
function assistantEvent({ time, provider = 'commandcode', input = 100, output = 10, cacheRead = 900 }) {
  return {
    type: 'assistant/message',
    seq: 1,
    time,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        source: { kind: 'model', provider, model: 'deepseek/deepseek-v4.1-flash' },
      },
      usage: { inputTokens: input, outputTokens: output, totalTokens: input + output + cacheRead, cacheReadTokens: cacheRead },
    },
  };
}

/** Write one session log as a sequence of zstd frames, the way the log is appended. */
function writeSessionLog(root, workspace, session, events, mtimeMs) {
  const dir = join(root, workspace, session);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.v4.jsonl.zstd');
  const frames = events.map((event) => zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)));
  writeFileSync(file, Buffer.concat(frames));
  if (mtimeMs !== undefined) utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

/** A session store holding three sessions: two touched today and one left from yesterday. */
function makeSessionStore() {
  const root = mkdtempSync(join(tmpdir(), 'ccq-sessions-'));
  const now = Date.now();
  const todayAt = now - 60 * 60 * 1000;
  const yesterdayAt = now - 26 * 60 * 60 * 1000;
  writeSessionLog(root, '--ws--', 'session-a', [
    { type: 'session', seq: 0, time: yesterdayAt, data: { id: 'session-a' } },
    assistantEvent({ time: todayAt, input: 1000, output: 100, cacheRead: 9000 }),
    assistantEvent({ time: todayAt, provider: 'deepseek', input: 7000, output: 700, cacheRead: 70000 }),
    assistantEvent({ time: yesterdayAt, input: 500, output: 50, cacheRead: 5000 }),
    { type: 'tool/call', seq: 9, time: todayAt, data: {} },
  ]);
  writeSessionLog(root, '--ws--', 'session-b', [assistantEvent({ time: todayAt, input: 300, output: 30, cacheRead: 2700 })]);
  // Touched today but never counted: the mtime filter is what keeps a scan cheap.
  writeSessionLog(root, '--ws--', 'session-c', [assistantEvent({ time: todayAt, input: 9, output: 9, cacheRead: 9 })], yesterdayAt);
  // A file that is not a session log at all: skipped, and reported as unreadable.
  const broken = join(root, '--ws--', 'session-d');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, 'session.v4.jsonl.zstd'), Buffer.from('not a zstd frame'));
  return root;
}

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

test('module identity and injection match the bundle row', () => {
  assert.equal(name, 'commandcode-quota');
  assert.deepEqual(inject, ['webServer', 'connection']);
});

test('apply registers one state route and one settings route', async () => {
  const { routes, disposers, net } = await setup();
  try {
    assert.deepEqual([...routes.keys()].sort(), ['/commandcode/settings', '/commandcode/state']);
    assert.equal(disposers.length, 2);
    assert.equal(routes.get('/commandcode/state').kind, 'exact');
  } finally {
    net.restore();
  }
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

test('a GOAT account reads as three windows plus the period request count', async () => {
  const { routes, net } = await setup();
  try {
    const { status, body } = await call(routes.get('/commandcode/state'));
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.configured, true);
    assert.equal(body.keyHint, `user_t${ELLIPSIS}6789`);
    assert.equal(body.usage.account, 'xjphhh');
    assert.equal(body.usage.plan.id, 'individual-goat');
    assert.equal(body.usage.requests.total, 709);
    assert.equal(body.usage.requests.successRate, 100);

    const { fiveHour, weekly, monthly } = body.usage.windows;
    assert.equal(fiveHour.cap, 14);
    assert.ok(Math.abs(fiveHour.percent - 0.9485) < 0.001, `fiveHour percent ${fiveHour.percent}`);
    assert.ok(Math.abs(weekly.percent - 6.7093) < 0.001, `weekly percent ${weekly.percent}`);
    // The monthly cap is used + remaining, so the share always agrees with the account.
    assert.ok(Math.abs(monthly.used - 2.2986040503999994) < 1e-9);
    assert.ok(Math.abs(monthly.remaining - 67.6517552326) < 1e-9);
    assert.ok(Math.abs(monthly.cap - (monthly.used + monthly.remaining)) < 1e-9);
    assert.ok(Math.abs(monthly.percent - 3.2863) < 0.001, `monthly percent ${monthly.percent}`);
    assert.equal(monthly.resetsAt, '2026-11-06T01:12:14.000Z');
    assert.equal(fiveHour.resetsAt, new Date(1791351771195).toISOString());
    assert.deepEqual(body.usage.failures, []);
  } finally {
    net.restore();
  }
});

test('a metered plan without rolling windows still reports the period', async () => {
  const { routes, net } = await setup({ fixtures: PROVIDER });
  try {
    const { body } = await call(routes.get('/commandcode/state'));
    assert.equal(body.usage.windows.fiveHour, null);
    assert.equal(body.usage.windows.weekly, null);
    assert.equal(body.usage.windows.monthly.remaining, 17.5);
    assert.equal(body.usage.windowLimits.limited, false);
  } finally {
    net.restore();
  }
});

test('purchased and free credits count towards what is left', async () => {
  const fixtures = {
    ...GOAT,
    credits: { ...GOAT.credits, credits: { monthlyCredits: 10, purchasedCredits: 5, freeCredits: 1 } },
  };
  const { routes, net } = await setup({ fixtures });
  try {
    const { body } = await call(routes.get('/commandcode/state'));
    assert.equal(body.usage.windows.monthly.remaining, 16);
    assert.equal(body.usage.windows.monthly.purchased, 5);
    assert.equal(body.usage.windows.monthly.free, 1);
  } finally {
    net.restore();
  }
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

test('every reading 404 means the plan has no API access', async () => {
  const { routes, net } = await setup({ answers: {} });
  try {
    const { body } = await call(routes.get('/commandcode/state'));
    assert.equal(body.usage, null);
    assert.equal(body.error.code, 'no-api-access');
    assert.equal(net.calls.length, 4);
  } finally {
    net.restore();
  }
});

test('a rejected key reads as unauthorized', async () => {
  const answers = Object.fromEntries(
    ['/alpha/whoami', '/alpha/usage/summary', '/alpha/billing/credits', '/alpha/billing/subscriptions'].map((path) => [
      path,
      { status: 401, body: { error: 'invalid api key' } },
    ]),
  );
  const { routes, net } = await setup({ answers });
  try {
    const { body } = await call(routes.get('/commandcode/state'));
    assert.equal(body.error.code, 'unauthorized');
  } finally {
    net.restore();
  }
});

test('one failed endpoint does not sink the report', async () => {
  const answers = answersFrom(GOAT);
  answers['/alpha/whoami'] = { networkError: true };
  const { routes, net } = await setup({ answers });
  try {
    const { body } = await call(routes.get('/commandcode/state'));
    assert.equal(body.error, null);
    assert.equal(body.usage.requests.total, 709);
    assert.equal(body.usage.account, null);
    assert.equal(body.usage.failures.length, 1);
    assert.equal(body.usage.failures[0].source, 'whoami');
  } finally {
    net.restore();
  }
});

test('nothing recognizable in a 200 answer is reported as an unexpected payload', async () => {
  const answers = answersFrom({ whoami: { success: true }, summary: {}, credits: {}, subscription: { success: true } });
  const { routes, net } = await setup({ answers });
  try {
    const { body } = await call(routes.get('/commandcode/state'));
    assert.equal(body.usage, null);
    assert.equal(body.error.code, 'unexpected-payload');
  } finally {
    net.restore();
  }
});

test('no stored key: no upstream request is made', async () => {
  const { routes, net } = await setup({ credentials: makeCredentials({}) });
  try {
    const { body } = await call(routes.get('/commandcode/state'));
    assert.equal(body.configured, false);
    assert.equal(body.usage, null);
    assert.equal(body.error.code, 'missing-credential');
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

test('the switch off reports the feature off and reads nothing', async () => {
  const credentials = makeCredentials({ [KEY_REF]: 'user_test_key_0123456789', [ENABLED_REF]: '0' });
  const { routes, net } = await setup({ credentials });
  try {
    const { body } = await call(routes.get('/commandcode/state'));
    assert.equal(body.enabled, false);
    assert.equal(body.usage, null);
    assert.equal(body.error, null);
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

test('a second read inside the cache window hits the account once', async () => {
  const { routes, net } = await setup();
  try {
    await call(routes.get('/commandcode/state'));
    await call(routes.get('/commandcode/state'));
    assert.equal(net.calls.length, 4);
    await call(routes.get('/commandcode/state'), { url: '/commandcode/state?refresh=1' });
    assert.equal(net.calls.length, 8);
  } finally {
    net.restore();
  }
});

test('a rotated key never reads the previous key cached numbers', async () => {
  const credentials = makeCredentials({ [KEY_REF]: 'user_first_key_0123456789' });
  const { routes, net } = await setup({ credentials });
  try {
    const first = await call(routes.get('/commandcode/state'));
    assert.equal(first.body.keyHint, `user_f${ELLIPSIS}6789`);
    credentials.refs.set(KEY_REF, 'user_second_key_9876543210');
    await call(routes.get('/commandcode/state'));
    assert.equal(net.calls.length, 8);
  } finally {
    net.restore();
  }
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test('an unauthenticated request is answered with the rejection status', async () => {
  const { routes, net } = await setup({ rejection: 403 });
  try {
    const { status, body } = await call(routes.get('/commandcode/state'));
    assert.equal(status, 403);
    assert.equal(body, null);
  } finally {
    net.restore();
  }
});

test('the state route takes GET only', async () => {
  const { routes, net } = await setup();
  try {
    const { status, headers } = await call(routes.get('/commandcode/state'), { method: 'POST' });
    assert.equal(status, 405);
    assert.equal(headers.allow, 'GET');
  } finally {
    net.restore();
  }
});

test('the settings route takes POST only', async () => {
  const { routes, net } = await setup();
  try {
    const { status, headers } = await call(routes.get('/commandcode/settings'), { method: 'GET' });
    assert.equal(status, 405);
    assert.equal(headers.allow, 'POST');
  } finally {
    net.restore();
  }
});

test('saving the switch writes the flag and re-reads', async () => {
  const credentials = makeCredentials({ [KEY_REF]: 'user_test_key_0123456789' });
  const { routes, net } = await setup({ credentials });
  try {
    const { status, body } = await call(routes.get('/commandcode/settings'), { method: 'POST', body: { enabled: false } });
    assert.equal(status, 200);
    assert.equal(credentials.refs.get(ENABLED_REF), '0');
    assert.equal(body.enabled, false);
  } finally {
    net.restore();
  }
});

test('saving a key stores it trimmed; clearing removes it', async () => {
  const credentials = makeCredentials({});
  const { routes, net } = await setup({ credentials });
  try {
    await call(routes.get('/commandcode/settings'), { method: 'POST', body: { apiKey: '  user_pasted_key_abcdefgh  ' } });
    assert.equal(credentials.refs.get(KEY_REF), 'user_pasted_key_abcdefgh');
    const cleared = await call(routes.get('/commandcode/settings'), { method: 'POST', body: { apiKey: null } });
    assert.equal(credentials.refs.has(KEY_REF), false);
    assert.equal(cleared.body.configured, false);
  } finally {
    net.restore();
  }
});

test('a body that is not JSON is refused without touching the store', async () => {
  const credentials = makeCredentials({ [KEY_REF]: 'user_test_key_0123456789' });
  const { ctx, routes } = makeCtx(credentials, undefined);
  apply(ctx, {});
  const { status, body } = await call(routes.get('/commandcode/settings'), { method: 'POST', raw: '{not json' });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'invalid-body');
  assert.equal(credentials.refs.get(KEY_REF), 'user_test_key_0123456789');
});

// ---------------------------------------------------------------------------
// Today, from the session logs
// ---------------------------------------------------------------------------

test('today folds this provider only, from the logs touched today', async () => {
  const store = makeSessionStore();
  const { routes, net } = await setup({ config: { sessionsDir: store } });
  try {
    const { body } = await call(routes.get('/commandcode/state'));
    const at = new Date();
    assert.equal(body.today.day, `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`);
    // session-a and session-b carry today's commandcode calls; the deepseek one is not ours,
    // yesterday's is not today, and session-c is skipped because its log was not touched today.
    assert.equal(body.today.calls, 2);
    assert.equal(body.today.input, 1300);
    assert.equal(body.today.output, 130);
    assert.equal(body.today.cacheRead, 11700);
    assert.equal(body.today.total, 13130);
    assert.equal(body.today.sessions, 2);
    assert.equal(body.today.unreadable, 1);
  } finally {
    net.restore();
    rmSync(store, { recursive: true, force: true });
  }
});

test('an unreadable session store leaves the day off rather than at zero', async () => {
  const missing = join(tmpdir(), `ccq-absent-${String(Date.now())}`);
  const { routes, net } = await setup({ config: { sessionsDir: missing } });
  try {
    const { body } = await call(routes.get('/commandcode/state'));
    assert.equal(body.today, null);
  } finally {
    net.restore();
  }
});

test('the day survives an unreadable account', async () => {
  const store = makeSessionStore();
  const { routes, net } = await setup({ config: { sessionsDir: store }, answers: {} });
  try {
    const { body } = await call(routes.get('/commandcode/state'));
    assert.equal(body.error.code, 'no-api-access');
    assert.equal(body.usage, null);
    assert.equal(body.today.calls, 2);
  } finally {
    net.restore();
    rmSync(store, { recursive: true, force: true });
  }
});
