/**
 * One live read of the real account, through the real route handler.
 *
 *   node scripts/live-check.mjs
 *
 * Reads the key the profile already stores for the `commandcode` provider
 * (`$DSH_HOME/.credentials.yaml` → refs.COMMAND_CODE_API_KEY), which is exactly
 * what the plugin resolves at runtime. Prints the numbers the pills would show
 * and exits non-zero when nothing readable came back.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../index.js';

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');

function readKeyFromCredentialStore(ref) {
  let text;
  try {
    text = readFileSync(join(DSH_HOME, '.credentials.yaml'), 'utf8');
  } catch {
    return null;
  }
  const match = new RegExp(`^\\s+${ref}:\\s*(\\S+)\\s*$`, 'm').exec(text);
  return match === null ? null : match[1];
}

const value = readKeyFromCredentialStore('COMMAND_CODE_API_KEY');
if (value === null || value.length === 0) {
  console.error(`no ${'COMMAND_CODE_API_KEY'} in ${join(DSH_HOME, '.credentials.yaml')}`);
  process.exit(2);
}

const credentials = {
  resolve: async (ref) => (ref === 'COMMAND_CODE_API_KEY' ? { value, source: 'credentials' } : undefined),
  describe: async () => ({ writable: false }),
  set: async () => {},
  unset: async () => {},
};

const routes = new Map();
apply(
  {
    get: (service) => (service === 'credentials' ? credentials : undefined),
    effect: (run) => {
      run();
    },
    connection: { requestRejection: () => undefined },
    webServer: {
      register: (route) => {
        routes.set(route.path, route);
        return () => {};
      },
    },
  },
  {},
);

const res = {
  statusCode: 0,
  headers: {},
  body: '',
  setHeader(key, v) {
    this.headers[key] = v;
  },
  end(chunk) {
    if (chunk !== undefined) this.body += String(chunk);
  },
};

await routes.get('/commandcode/state').handler({ method: 'GET', url: '/commandcode/state?refresh=1' }, res);

const state = JSON.parse(res.body);
console.log(`HTTP ${res.statusCode} · key ${state.keyHint} · origin ${state.origin}`);

if (state.usage === null) {
  console.error(`error: ${state.error?.code} — ${state.error?.message}`);
  process.exit(1);
}

const money = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '—');
const pct = (n) => (typeof n === 'number' ? `${n.toFixed(2)}%` : '—');
const { fiveHour, weekly, monthly } = state.usage.windows;

console.log(`account     ${state.usage.account ?? '—'} · ${state.usage.plan?.id ?? '—'} · ${state.usage.plan?.status ?? '—'}`);
console.log(`5 小时      ${pct(fiveHour?.percent)} 已用 · ${money(fiveHour?.used)} / ${money(fiveHour?.cap)} · 重置 ${fiveHour?.resetsAt ?? '—'}`);
console.log(`本周        ${pct(weekly?.percent)} 已用 · ${money(weekly?.used)} / ${money(weekly?.cap)} · 重置 ${weekly?.resetsAt ?? '—'}`);
console.log(`本月        ${pct(monthly?.percent)} 已用 · 剩 ${money(monthly?.remaining)} · 上限 ${money(monthly?.cap)} · 重置 ${monthly?.resetsAt ?? '—'}`);
console.log(`本周期      ${state.usage.requests?.total ?? '—'} 次请求 · 成功率 ${state.usage.requests?.successRate ?? '—'}%`);
console.log(`token       in ${state.usage.tokens?.input ?? '—'} / out ${state.usage.tokens?.output ?? '—'}`);
if (state.today !== null && state.today !== undefined) {
  console.log(
    `今日(本机)  ${state.today.calls} 次调用 · in ${state.today.input} / out ${state.today.output} / 缓存 ${state.today.cacheRead} · 合计 ${state.today.total}` +
      (state.today.unreadable > 0 ? ` · ${state.today.unreadable} 个日志没读出` : ''),
  );
} else {
  console.log('今日(本机)  不可用（会话日志读不到）');
}
if (state.usage.failures.length > 0) console.log(`failures    ${JSON.stringify(state.usage.failures)}`);
