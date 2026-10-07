/**
 * Render the real client component against the live account, and print the text it
 * produces — the pill row and the open detail panel — without a browser.
 *
 *   node scripts/preview.mjs            # live read, then render
 *   node scripts/preview.mjs --offline  # render a fixed fixture instead (no network, no key)
 *
 * The React stub is the same trick the offline tests use: `useState` is fed a queue so
 * the panel (state, open=true, anchor) renders as it would after a click.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../index.js';

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const OFFLINE = process.argv.includes('--offline');

// ---------------------------------------------------------------------------
// The Host state: either a live read through the real route, or a fixture.
// ---------------------------------------------------------------------------

const FIXTURE = {
  ok: true,
  enabled: true,
  configured: true,
  writable: true,
  keyHint: 'user_t…6789',
  fetchedAt: '2026-10-07T02:00:00.000Z',
  error: null,
  usage: {
    account: 'xjphhh',
    periodBasis: 'billing-period',
    windowLimits: { limited: true, exceeded: null },
    windows: {
      fiveHour: { used: 0.31, cap: 14, percent: 2.2143, exceeded: false, resetsAt: '2026-10-07T05:42:51.195Z' },
      weekly: { used: 2.53, cap: 35, percent: 7.2286, exceeded: false, resetsAt: '2026-10-13T01:37:08.661Z' },
      monthly: {
        used: 2.2986,
        cap: 69.9504,
        percent: 3.2861,
        remaining: 67.6518,
        purchased: 0,
        free: 0,
        exceeded: null,
        resetsAt: '2026-11-06T01:12:14.000Z',
      },
    },
    requests: { total: 739, completed: 739, failed: 0, successRate: 100 },
    tokens: { input: 25452209, output: 296018, total: 25748227 },
    plan: {
      id: 'individual-goat',
      status: 'active',
      periodStart: '2026-10-06T01:12:14.000Z',
      periodEnd: '2026-11-06T01:12:14.000Z',
    },
    failures: [],
  },
};

async function liveState() {
  const text = readFileSync(join(DSH_HOME, '.credentials.yaml'), 'utf8');
  const value = new RegExp('^\\s+COMMAND_CODE_API_KEY:\\s*(\\S+)\\s*$', 'm').exec(text)?.[1];
  if (value === undefined) throw new Error(`no COMMAND_CODE_API_KEY in ${join(DSH_HOME, '.credentials.yaml')}`);

  const routes = new Map();
  apply(
    {
      get: (service) => (service === 'credentials' ? {
        resolve: async (ref) => (ref === 'COMMAND_CODE_API_KEY' ? { value, source: 'credentials' } : undefined),
        describe: async () => ({ writable: false }),
        set: async () => {},
        unset: async () => {},
      } : undefined),
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
    body: '',
    setHeader() {},
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk);
    },
  };
  await routes.get('/commandcode/state').handler({ method: 'GET', url: '/commandcode/state?refresh=1' }, res);
  return JSON.parse(res.body);
}

const state = OFFLINE ? FIXTURE : await liveState();

// ---------------------------------------------------------------------------
// The browser half, loaded the way the Harness loads it.
// ---------------------------------------------------------------------------

const hooks = { state, have: false, queue: [] };
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [hooks.queue.length > 0 ? hooks.queue.shift() : hooks.have ? hooks.state : initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
};

let captured = null;
globalThis.window = { __ModuleLoader__: { load: (module) => { captured = module; } } };
await import(new URL('../client.js', import.meta.url).href);
const plugin = captured.factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require: ${id}`);
});

let pills = null;
plugin.apply({
  slots: {
    inject: (_name, contribute) => contribute(),
    register: (descriptor, component) => {
      if (descriptor.name === 'conversation.composer.dock') pills = component;
    },
  },
});

function render(open) {
  hooks.have = true;
  hooks.queue = open ? [state, true, { left: 24, bottom: 220 }] : [];
  try {
    return pills();
  } finally {
    hooks.have = false;
    hooks.queue = [];
  }
}

const text = (node) => {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return (node.children ?? []).map(text).join('');
};

const walk = (node, visit) => {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};

function classesOf(node, name) {
  const found = [];
  walk(node, (element) => {
    const list = typeof element.props?.className === 'string' ? element.props.className.split(/\s+/) : [];
    if (list.includes(name)) found.push(element);
  });
  return found;
}

console.log('── 输入框下方那一排 ─────────────────────────────');
const row = render(false);
if (row === null) {
  console.log('(不显示：未配置 / 开关关闭 / 无读数)');
} else {
  for (const pill of classesOf(row, 'ccq-pill')) console.log('  ' + text(pill).trim());
  for (const pill of classesOf(row, 'ccq-pill')) console.log('  title: ' + pill.props.title);
}

console.log('\n── 点开后弹出的面板 ─────────────────────────────');
const panel = render(true);
if (panel === null) {
  console.log('(无面板)');
} else {
  console.log('标题: ' + text(classesOf(panel, 'ccq-panel-title')[0]).trim());
  const rows = classesOf(panel, 'ccq-row');
  const resets = classesOf(panel, 'ccq-reset');
  const values = classesOf(panel, 'ccq-row-value');
  rows.forEach((rowNode, index) => {
    console.log(`  ${text(rowNode).trim()}   →   值 ${text(values[index]).trim()}`);
    console.log(`      ${text(resets[index]).trim()}`);
  });
  console.log('  ── 底部事实 ──');
  for (const fact of classesOf(panel, 'ccq-fact')) console.log('  ' + text(fact).trim());
  const actions = classesOf(panel, 'ccq-actions')[0];
  if (actions !== undefined) {
    const items = (actions.children ?? []).map((child) => {
      const label = text(child).trim();
      const href = child.props?.href;
      return href === undefined ? `${label}（按钮）` : `${label}（→ ${href}）`;
    });
    console.log('  ── 操作 ──');
    console.log('  ' + items.join('   '));
  }
}
