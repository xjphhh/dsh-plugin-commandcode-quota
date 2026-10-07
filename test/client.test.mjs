/**
 * Offline checks for the browser half: the bundle declaration, the two slot
 * registrations, and what the pill row renders for each Host state.
 *
 * The bundle is loaded the way the Harness loads it — through
 * `window.__ModuleLoader__.load` — with a React stub, so no DOM and no React
 * install are needed. `useState` is driven by `hooks.state`, which is how a
 * render is set up without a renderer.
 *
 *   node --test test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

/** Whatever the next render reads as the shared store value. */
const hooks = { state: undefined, have: false, queue: [] };

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  // `queue` feeds successive useState calls in order, which is how the open panel
  // (state, open=true, anchor) is rendered without a renderer.
  useState: (initial) => [
    hooks.queue.length > 0 ? hooks.queue.shift() : hooks.have ? hooks.state : initial,
    () => {},
  ],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
};

function requireStub(id) {
  if (id === 'react') return React;
  throw new Error(`unexpected require: ${id}`);
}

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(module) {
      captured = module;
    },
  },
};

await import(new URL('../client.js', import.meta.url).href);

const module = captured.factory(requireStub);

/** Collect every element whose class list contains `name`. */
function collect(node, className, found = []) {
  if (node === null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, className, found);
    return found;
  }
  const list = typeof node.props?.className === 'string' ? node.props.className.split(/\s+/) : [];
  if (list.includes(className)) found.push(node);
  for (const child of node.children ?? []) collect(child, className, found);
  return found;
}

/** All text under one element, in document order. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return (node.children ?? []).map(textOf).join('');
}

function render(component, state) {
  hooks.state = state;
  hooks.have = true;
  const tree = component();
  hooks.have = false;
  return tree;
}

/** The same render with the detail panel open: state, then open=true, then the anchor. */
function renderPanel(component, state) {
  hooks.have = true;
  hooks.queue = [state, true, { left: 24, bottom: 220 }];
  try {
    return component();
  } finally {
    hooks.have = false;
    hooks.queue = [];
  }
}

function pillTexts(tree) {
  return collect(tree, 'ccq-pill').map((pill) => textOf(pill).trim());
}

/** The one-line reset note under each window row of the panel. */
function resetLines(tree) {
  return collect(tree, 'ccq-reset').map((line) => textOf(line).trim());
}

/** Style elements carry the plugin's CSS as their only child. */
function stylesIn(tree, found = []) {
  if (tree === null || typeof tree !== 'object') return found;
  if (Array.isArray(tree)) {
    for (const child of tree) stylesIn(child, found);
    return found;
  }
  if (tree.type === 'style') found.push(textOf(tree));
  for (const child of tree.children ?? []) stylesIn(child, found);
  return found;
}

const GOAT_STATE = {
  ok: true,
  enabled: true,
  configured: true,
  source: 'credentials',
  writable: true,
  keyHint: 'user_t…6789',
  fetchedAt: '2026-10-06T10:00:00.000Z',
  error: null,
  usage: {
    account: 'xjphhh',
    periodBasis: 'billing-period',
    windowLimits: { limited: true, exceeded: null },
    windows: {
      fiveHour: { used: 0.132790966, cap: 14, percent: 0.948507, exceeded: false, resetsAt: '2026-10-07T02:00:00.000Z' },
      weekly: { used: 2.3482447674, cap: 35, percent: 6.70927, exceeded: false, resetsAt: '2026-10-13T01:00:00.000Z' },
      monthly: {
        used: 2.2986040503999994,
        cap: 69.950359283,
        percent: 3.28606,
        remaining: 67.6517552326,
        purchased: 0,
        free: 0,
        exceeded: null,
        resetsAt: '2026-11-06T01:12:14.000Z',
      },
    },
    requests: { total: 709, completed: 709, failed: 0, successRate: 100 },
    tokens: { input: 21235607, output: 235665, total: 21471272 },
    plan: {
      id: 'individual-goat',
      status: 'active',
      periodStart: '2026-10-06T01:12:14.000Z',
      periodEnd: '2026-11-06T01:12:14.000Z',
    },
    failures: [],
  },
};

test('the bundle declares itself under its package name and returns the plugin shape', () => {
  assert.equal(captured.id, '@local/commandcode-quota');
  assert.deepEqual(module.inject, ['slots']);
  assert.equal(typeof module.apply, 'function');
});

test('apply contributes the composer row and the settings page', () => {
  const registered = [];
  module.apply({
    slots: {
      inject(_name, contribute) {
        contribute();
      },
      register(descriptor, component) {
        registered.push({ descriptor, component });
      },
    },
  });
  assert.deepEqual(
    registered.map((entry) => entry.descriptor.name),
    ['conversation.composer.dock', 'settings.section'],
  );
  assert.deepEqual(
    registered.map((entry) => entry.descriptor.id),
    ['commandcode-quota', 'commandcode-quota'],
  );
  assert.equal(registered[1].descriptor.label, 'Command Code');
  assert.equal(typeof registered[0].component, 'function');
  assert.equal(typeof registered[1].component, 'function');
});

test('a GOAT snapshot renders the four pills', () => {
  const pills = collect(render(registeredPills(), GOAT_STATE), 'ccq-pill');
  assert.equal(pills.length, 4);
  const texts = pills.map((pill) => textOf(pill).trim());
  assert.deepEqual(texts, ['5 小时1%', '本周7%', '本月96.7%', '709 次']);
});

test('the row asks for the far right of the composer dock', () => {
  const css = stylesIn(render(registeredPills(), GOAT_STATE)).join('\n');
  // Both forms of the placement rule: my root as the dock's flex item, and a slot wrapper as it.
  assert.match(css, /\.ccq-root \{[^}]*order: 1; margin-left: auto;/);
  assert.ok(
    css.includes(':is([class*="_dock"]):has(.ccq-root) > :is(.ccq-root, :has(.ccq-root)) { order: 1; margin-left: auto; }'),
    'the slot-wrapper form of the far-right rule is missing',
  );
});

test('a monthly window whose money is unknown still reads as a remaining share', () => {
  const state = JSON.parse(JSON.stringify(GOAT_STATE));
  state.usage.windows.monthly.remaining = null;
  const texts = pillTexts(render(registeredPills(), state));
  assert.deepEqual(texts, ['5 小时1%', '本周7%', '本月96.7%', '709 次']);
});

test('a monthly window with neither figure reads as unknown', () => {
  const state = JSON.parse(JSON.stringify(GOAT_STATE));
  state.usage.windows.monthly.percent = null;
  state.usage.windows.monthly.remaining = null;
  assert.equal(pillTexts(render(registeredPills(), state))[2], '本月—');
});

test('an untouched month reads as a whole share, not a rounded one', () => {
  const state = JSON.parse(JSON.stringify(GOAT_STATE));
  state.usage.windows.monthly.used = 0;
  state.usage.windows.monthly.percent = 0;
  state.usage.windows.monthly.remaining = 69.95;
  assert.equal(pillTexts(render(registeredPills(), state))[2], '本月100%');
});

test('a monthly window with no used share falls back to the money', () => {
  const state = JSON.parse(JSON.stringify(GOAT_STATE));
  state.usage.windows.monthly.percent = null;
  state.usage.windows.monthly.remaining = 12;
  assert.equal(pillTexts(render(registeredPills(), state))[2], '本月$12.00');
});

test('the open panel still spells out the monthly money, its share, and the reset', () => {
  const lines = resetLines(renderPanel(registeredPills(), GOAT_STATE));
  assert.equal(lines.length, 3);
  assert.match(lines[2], /^剩 \$67\.65（96\.7%） · /);
});

test('a metered plan renders only what it has', () => {
  const state = JSON.parse(JSON.stringify(GOAT_STATE));
  state.usage.windows.fiveHour = null;
  state.usage.windows.weekly = null;
  state.usage.requests = null;
  const texts = pillTexts(render(registeredPills(), state));
  assert.deepEqual(texts, ['本月96.7%']);
});

test('a window past its cap is toned as an alert', () => {
  const state = JSON.parse(JSON.stringify(GOAT_STATE));
  state.usage.windows.fiveHour.percent = 96.4;
  const pills = collect(render(registeredPills(), state), 'ccq-pill');
  assert.ok(pills[0].props.className.includes('ccq-alert'));
  assert.ok(!pills[1].props.className.includes('ccq-alert'));
});

/** The local day fold the Host hands over beside the account numbers. */
const TODAY = {
  day: '2026-10-07',
  provider: 'commandcode',
  calls: 291,
  input: 1234567,
  output: 381000,
  cacheRead: 54200000,
  total: 55825567,
  sessions: 4,
  unreadable: 0,
};

const withToday = (today) => ({ ...JSON.parse(JSON.stringify(GOAT_STATE)), today });

test("the day rides on the period's request count", () => {
  assert.deepEqual(pillTexts(render(registeredPills(), withToday(TODAY))), [
    '5 小时1%',
    '本周7%',
    '本月96.7%',
    '709 次 · 今日 55.8M',
  ]);
});

test('a day with no calls leaves the request count alone', () => {
  const state = withToday({ ...TODAY, calls: 0, total: 0 });
  assert.deepEqual(pillTexts(render(registeredPills(), state)), ['5 小时1%', '本周7%', '本月96.7%', '709 次']);
});

test('a day with no period count still keeps a pill of its own', () => {
  const state = withToday(TODAY);
  state.usage.requests = null;
  assert.deepEqual(pillTexts(render(registeredPills(), state)), ['5 小时1%', '本周7%', '本月96.7%', '今日55.8M']);
});

test('the day stands on the row while the account read fails', () => {
  const state = { ...withToday(TODAY), usage: null, error: { code: 'unauthorized', message: '密钥被拒绝。' } };
  assert.deepEqual(pillTexts(render(registeredPills(), state)), ['今日55.8M', 'Command Code⚠']);
});

test('the open panel spells the day out in full', () => {
  const facts = collect(renderPanel(registeredPills(), withToday(TODAY)), 'ccq-fact').map((fact) => textOf(fact).trim());
  assert.equal(facts[0], '今日291 次调用 · in 1.2M / out 381.0K · 缓存命中 54.2M');
});

test('the panel links out to the account usage page in a new tab', () => {
  const links = collect(renderPanel(registeredPills(), withToday(TODAY)), 'ccq-link');
  assert.equal(links.length, 1);
  assert.equal(links[0].props.href, 'https://commandcode.ai/settings/usage');
  assert.equal(links[0].props.target, '_blank');
  assert.match(links[0].props.rel, /noopener/);
  assert.equal(textOf(links[0]).trim(), '官网看用量');
});

test('the row stays quiet while off, unconfigured, or without a reading', () => {
  assert.equal(render(registeredPills(), null), null);
  assert.equal(render(registeredPills(), { ...GOAT_STATE, enabled: false }), null);
  assert.equal(render(registeredPills(), { ...GOAT_STATE, configured: false }), null);
  assert.equal(render(registeredPills(), { ...GOAT_STATE, usage: null, error: { code: 'missing-credential', message: 'x' } }), null);
});

test('a failure is visible as one warning pill instead of nothing', () => {
  const state = { ...GOAT_STATE, usage: null, error: { code: 'unauthorized', message: '密钥被拒绝。' } };
  const pills = collect(render(registeredPills(), state), 'ccq-pill');
  assert.equal(pills.length, 1);
  assert.equal(textOf(pills[0]).trim(), 'Command Code⚠');
  assert.equal(pills[0].props.title, '密钥被拒绝。');
});

/** The composer component as applied, so the render checks exercise the real registration. */
function registeredPills() {
  let pills = null;
  module.apply({
    slots: {
      inject(_name, contribute) {
        contribute();
      },
      register(descriptor, component) {
        if (descriptor.name === 'conversation.composer.dock') pills = component;
      },
    },
  });
  return pills;
}
