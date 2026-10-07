/**
 * Browser half of the Command Code quota bundle.
 *
 * Two surfaces share one Host-owned state:
 *   1. `conversation.composer.dock` — four pills beside the host's own stats
 *      pills: the 5-hour and weekly windows, the billing period's remaining
 *      credits, and the period's request count. Rendered only while the feature
 *      is on and a key is configured.
 *   2. `settings.section` — the page that turns the feature on or off and
 *      stores the user's own Command Code key.
 *
 * Styling copies the host's primitives rather than importing them: pill metrics
 * from the composer stats pills, and the field / switch / input / save rules
 * from `@deepseek-ai/dsh-client-ui-primitives`. The key never reaches this half;
 * the Host serves a masked hint only.
 */
window.__ModuleLoader__.load({
  id: '@local/commandcode-quota',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Document-relative forms first (mount proxies keep a prefix); the absolute form is the fallback. */
    const STATE_ROUTES = ['commandcode/state', '/commandcode/state'];
    const SETTINGS_ROUTES = ['commandcode/settings', '/commandcode/settings'];
    const REFRESH_MS = 60000;
    const FRESH_MS = 15000;
    const WARN_AT = 70;
    const ALERT_AT = 90;
    /** The account's own usage page — `/usage` and `/billing` only redirect here. */
    const USAGE_URL = 'https://commandcode.ai/settings/usage';

    const WINDOWS = [
      { key: 'fiveHour', label: '5 小时', icon: 'clock' },
      { key: 'weekly', label: '本周', icon: 'calendar' },
      { key: 'monthly', label: '本月', icon: 'card' },
    ];

    const SOURCE_LABELS = {
      whoami: '账户',
      summary: '用量',
      credits: '额度',
      subscription: '订阅',
    };

    /** One request per route list, document-relative first. */
    async function requestJson(routes, init) {
      let lastError = null;
      for (const route of routes) {
        try {
          const response = await fetch(route, {
            cache: 'no-store',
            ...init,
            headers: { accept: 'application/json', ...(init !== undefined && init.headers !== undefined ? init.headers : {}) },
          });
          if (response.status === 404) {
            lastError = new Error('额度路由未注册');
            continue;
          }
          const body = await response.json().catch(() => null);
          if (body === null) {
            lastError = new Error(`HTTP ${response.status}`);
            continue;
          }
          return body;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new Error('请求失败');
    }

    /** One shared snapshot: both surfaces read it, and either write publishes to the other. */
    const store = (() => {
      let value = null;
      let at = 0;
      let inflight = null;
      const listeners = new Set();
      const emit = () => {
        for (const listener of listeners) listener(value);
      };
      const commit = (next) => {
        value = next;
        at = Date.now();
        emit();
      };
      return {
        get: () => value,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async load(force) {
          if (!force && value !== null && Date.now() - at < FRESH_MS) return value;
          if (inflight !== null) return inflight;
          inflight = (async () => {
            const next = await requestJson(force ? STATE_ROUTES.map((route) => `${route}?refresh=1`) : STATE_ROUTES);
            if (next !== null && next.ok === true) commit(next);
            return next;
          })();
          try {
            return await inflight;
          } finally {
            inflight = null;
          }
        },
        async save(payload) {
          const next = await requestJson(SETTINGS_ROUTES, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (next !== null && next.ok === true) commit(next);
          return next;
        },
      };
    })();

    function useStoreState() {
      const [state, setState] = React.useState(store.get());
      React.useEffect(() => store.subscribe(setState), []);
      return state;
    }

    function toneOf(percent) {
      if (percent === null || percent === undefined) return '';
      if (percent >= ALERT_AT) return 'ccq-alert';
      if (percent >= WARN_AT) return 'ccq-warn';
      return '';
    }

    function colorFor(percent) {
      if (percent === null || percent === undefined) return 'var(--dsw-alias-state-idle-primary)';
      if (percent >= ALERT_AT) return 'var(--dsw-alias-state-error-primary)';
      if (percent >= WARN_AT) return 'var(--dsw-alias-state-warn-primary)';
      return 'var(--dsw-alias-brand-primary)';
    }

    function round(value) {
      return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
    }

    function formatPercent(percent) {
      const value = round(percent);
      return value === null ? '—' : `${value}%`;
    }

    /** The share of a cap still available — the complement of the used share. */
    function remainingPercent(percent) {
      return typeof percent === 'number' && Number.isFinite(percent) ? 100 - percent : null;
    }

    /** A remaining share keeps one decimal where it carries information: 96.7%, but 100% not 100.0%. */
    function formatShare(percent) {
      if (typeof percent !== 'number' || !Number.isFinite(percent)) return '—';
      const value = Math.max(0, Math.min(100, percent));
      return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
    }

    /** Money stays exact: two decimals until the figure is large enough that they are noise. */
    function formatMoney(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      const digits = Math.abs(value) >= 100 ? 0 : 2;
      return `$${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
    }

    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
      if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
      if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
      return String(Math.round(value));
    }

    /** How long until a window rolls over, in the coarsest unit that still reads as a countdown. */
    function countdown(iso) {
      if (typeof iso !== 'string') return null;
      const at = new Date(iso);
      if (Number.isNaN(at.getTime())) return null;
      const remaining = at.getTime() - Date.now();
      if (remaining <= 0) return '即将重置';
      const minutes = Math.floor(remaining / 60000);
      if (minutes < 60) return `${Math.max(1, minutes)} 分钟后`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours} 小时 ${minutes % 60} 分后`;
      const days = Math.floor(hours / 24);
      return `${days} 天 ${hours % 24} 小时后`;
    }

    function formatReset(iso) {
      if (typeof iso !== 'string') return '重置时间未知';
      const at = new Date(iso);
      if (Number.isNaN(at.getTime())) return '重置时间未知';
      const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const left = countdown(iso);
      const day = `${at.getMonth() + 1}/${at.getDate()}`;
      return left === null ? `${day} ${time} 重置` : `${day} ${time} 重置（${left}）`;
    }

    function formatClock(iso) {
      if (typeof iso !== 'string') return '';
      const at = new Date(iso);
      if (Number.isNaN(at.getTime())) return '';
      return `${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 更新`;
    }

    function formatDay(iso) {
      if (typeof iso !== 'string') return null;
      const at = new Date(iso);
      if (Number.isNaN(at.getTime())) return null;
      return `${at.getFullYear()}/${at.getMonth() + 1}/${at.getDate()}`;
    }

    /** `individual-goat` reads as `GOAT`; an unfamiliar id is shown as it came. */
    function planLabel(id) {
      if (typeof id !== 'string' || id.length === 0) return null;
      const tail = id.includes('-') ? id.slice(id.lastIndexOf('-') + 1) : id;
      return tail.toUpperCase();
    }

    /** 14px stroked glyphs in the host's icon weight, inheriting the pill colour. */
    function Glyph(props) {
      const common = {
        viewBox: '0 0 14 14',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      };
      if (props.name === 'calendar') {
        return h(
          'svg',
          common,
          h('rect', { key: 'b', x: 1.6, y: 2.8, width: 10.8, height: 9.6, rx: 1.8 }),
          h('path', { key: 'l', d: 'M1.6 6h10.8' }),
          h('path', { key: 't', d: 'M4.6 1.6v2.4M9.4 1.6v2.4' }),
        );
      }
      if (props.name === 'card') {
        return h(
          'svg',
          common,
          h('rect', { key: 'b', x: 1.4, y: 3.2, width: 11.2, height: 8, rx: 1.8 }),
          h('path', { key: 's', d: 'M1.4 6.2h11.2' }),
          h('path', { key: 'c', d: 'M4 8.9h3' }),
        );
      }
      if (props.name === 'chart') {
        return h(
          'svg',
          common,
          h('path', { key: 'a', d: 'M2.4 11.8V7.2' }),
          h('path', { key: 'b', d: 'M7 11.8V3.4' }),
          h('path', { key: 'c', d: 'M11.6 11.8V5.6' }),
        );
      }
      if (props.name === 'bolt') {
        return h('svg', common, h('path', { key: 'b', d: 'M7.8 1.4 3.4 7.6h3l-.9 5 4.6-6.4h-3z' }));
      }
      return h(
        'svg',
        common,
        h('circle', { key: 'c', cx: 7, cy: 7, r: 5.4 }),
        h('path', { key: 'h', d: 'M7 3.9V7.3l2.2 1.3' }),
      );
    }

    /** The three-bar gauge used inside the panel title. */
    function Gauge() {
      const bars = [];
      for (let index = 0; index < 3; index += 1) {
        bars.push(h('rect', { key: index, x: 1.5, y: 2.4 + index * 3.6, width: 11, height: 1.9, rx: 0.95 }));
      }
      return h('svg', { viewBox: '0 0 14 14', fill: 'currentColor', 'aria-hidden': true }, ...bars);
    }

    /** Host pill metrics: 12px figures, 20px line box, 999px radius, 14px glyph. */
    const PILL_CSS = `
.ccq-root {
  box-sizing: border-box; min-width: 0; max-width: 100%; display: flex; justify-content: center; gap: 12px;
  /* Far right of the composer dock row: after the context meter, with the free space in front. */
  order: 1; margin-left: auto;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}
.ccq-anchor { min-width: 0; display: inline-flex; }
.ccq-pill {
  box-sizing: border-box; corner-shape: round; max-width: 100%; color: var(--dsw-alias-label-tertiary);
  font: inherit; font-variant-numeric: tabular-nums; line-height: inherit; white-space: nowrap;
  background: 0 0; border: none; border-radius: 999px; cursor: pointer;
  align-items: center; gap: 6px; padding: 1px 8px; display: inline-flex;
}
.ccq-pill svg { flex: none; width: 14px; height: 14px; }
.ccq-pill:hover, .ccq-pill[aria-expanded="true"] {
  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary);
}
.ccq-pill:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: 1px;
}
.ccq-pill.ccq-warn { color: var(--dsw-alias-state-warn-primary); }
.ccq-pill.ccq-alert { color: var(--dsw-alias-state-error-primary); }
.ccq-label { text-overflow: ellipsis; min-width: 0; overflow: hidden; }
.ccq-value { font-variant-numeric: tabular-nums; }
/* The dock is one centred flex row whose last child is the context meter, and a slot wrapper
   may be the flex item rather than .ccq-root itself — so reorder whichever box carries these
   pills to the end and let it swallow the free space. Each form is a no-op where the other
   applies: order and auto margins do nothing outside a flex container. */
:is([class*="_dock"]):has(.ccq-root) > :is(.ccq-root, :has(.ccq-root)) { order: 1; margin-left: auto; }
.ccq-panel {
  z-index: 1100; box-sizing: border-box; position: fixed; width: max-content;
  min-width: min(272px, 100vw - 24px); max-width: min(340px, 100vw - 24px);
  border-radius: var(--dsw-radius-lg); background: var(--dsw-specific-menu, var(--dsw-alias-bg-overlay));
  backdrop-filter: var(--dsw-menu-backdrop-filter); box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-secondary); cursor: default; border: 0; padding: 16px;
  font-size: 12px; line-height: 18px;
}
.ccq-panel-title {
  color: var(--dsw-alias-label-primary); justify-content: space-between; align-items: center;
  gap: 16px; margin-bottom: 8px; font-weight: 500; display: flex;
}
.ccq-panel-label { align-items: center; gap: 6px; min-width: 0; display: inline-flex; }
.ccq-panel-label svg { flex: none; width: 14px; height: 14px; }
.ccq-panel-value { font-variant-numeric: tabular-nums; font-weight: 400; color: var(--dsw-alias-label-tertiary); }
.ccq-rule { border-top: .5px solid var(--dsw-alias-border-l2); margin-bottom: 10px; }
.ccq-row { display: flex; align-items: center; gap: 10px; }
.ccq-row + .ccq-row { margin-top: 9px; }
.ccq-row-label { flex: none; width: 44px; color: var(--dsw-alias-label-secondary); }
.ccq-track {
  flex: 1 1 auto; height: 6px; border-radius: 999px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-2); border: .5px solid var(--dsw-alias-border-l1);
}
.ccq-fill { height: 100%; border-radius: 999px; transition: width .3s ease; }
.ccq-row-value { flex: none; width: 52px; text-align: right; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.ccq-reset { margin: 2px 0 0 54px; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.ccq-facts { margin-top: 12px; padding-top: 10px; border-top: .5px solid var(--dsw-alias-border-l2); display: flex; flex-direction: column; gap: 4px; }
.ccq-fact { display: flex; justify-content: space-between; gap: 12px; color: var(--dsw-alias-label-tertiary); }
.ccq-fact-value { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; text-align: right; }
.ccq-error { color: var(--dsw-alias-state-error-primary); word-break: break-word; }
.ccq-actions { display: flex; gap: 8px; margin-top: 12px; }
.ccq-ghost {
  appearance: none; border: .5px solid var(--dsw-alias-border-l3); background: transparent;
  border-radius: var(--dsw-radius-md); padding: 4px 12px; font: inherit; font-size: 12px;
  line-height: 1.5; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.ccq-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
/* The same ghost shape as a link: an anchor needs the box and the underline taken off by hand. */
.ccq-link { display: inline-flex; align-items: center; text-decoration: none; }
`;

    function CommandCodeQuotaPills() {
      const state = useStoreState();
      const rootRef = React.useRef(null);
      const [open, setOpen] = React.useState(false);
      const [anchor, setAnchor] = React.useState(null);

      React.useEffect(() => {
        let cancelled = false;
        const tick = () => {
          if (cancelled) return;
          store.load(false).catch(() => {});
        };
        tick();
        const timer = setInterval(tick, REFRESH_MS);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, []);

      /** Place the panel above the pill row; the dock sits under the composer card. */
      const measure = React.useCallback(() => {
        const node = rootRef.current;
        if (node === null) return;
        const rect = node.getBoundingClientRect();
        setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 8 });
      }, []);

      React.useEffect(() => {
        if (!open) return undefined;
        measure();
        window.addEventListener('resize', measure);
        window.addEventListener('scroll', measure, true);
        return () => {
          window.removeEventListener('resize', measure);
          window.removeEventListener('scroll', measure, true);
        };
      }, [open, measure]);

      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const root = rootRef.current;
          if (root === null) return;
          const target = event.target;
          if (target instanceof Node && root.contains(target)) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);
      const usage = state !== null && state.usage !== null && state.usage !== undefined ? state.usage : null;
      const enabled = state !== null && state.enabled === true;
      const configured = state !== null && state.configured === true;
      const failure =
        state !== null && state.error !== null && state.error !== undefined && state.error.code !== 'missing-credential'
          ? state.error
          : null;

      // Quiet unless the feature is on, a key exists, and there is something to say.
      if (!enabled || !configured || (usage === null && failure === null)) return null;

      const windows = usage !== null && usage.windows !== null && usage.windows !== undefined ? usage.windows : {};
      const requests = usage !== null && usage.requests !== null && usage.requests !== undefined ? usage.requests : null;
      const tokens = usage !== null && usage.tokens !== null && usage.tokens !== undefined ? usage.tokens : null;
      const plan = usage !== null && usage.plan !== null && usage.plan !== undefined ? usage.plan : null;
      const monthly = windows.monthly ?? null;
      const today = state !== null && state.today !== null && state.today !== undefined ? state.today : null;
      const failures = usage !== null && Array.isArray(usage.failures) ? usage.failures : [];

      const rows = WINDOWS.map((entry) => {
        const data = windows[entry.key] ?? null;
        return { key: entry.key, label: entry.label, icon: entry.icon, data };
      }).filter((row) => row.data !== null);

      /** Headline pill figures: percentages for the two rolling gates, money and count for the period. */
      const pills = [];
      for (const window of ['fiveHour', 'weekly']) {
        const entry = WINDOWS.find((item) => item.key === window);
        const data = windows[window] ?? null;
        if (data === null) continue;
        pills.push({
          key: window,
          icon: entry.icon,
          label: entry.label,
          value: formatPercent(data.percent),
          percent: data.percent,
          title: `${entry.label}窗口已用 ${formatPercent(data.percent)}${data.cap === null ? '' : ` · 上限 ${formatMoney(data.cap)}`}`,
        });
      }
      if (monthly !== null) {
        // The pill carries the remaining share only; the money (and the used share) live in the
        // tooltip and the panel, so the row stays as narrow as its two siblings. Its colour still
        // comes from the used share — the same threshold read the other way round, 30% left ⇔ 70%
        // used — so warning and alert stay comparable at a glance.
        const left = remainingPercent(monthly.percent);
        pills.push({
          key: 'monthly',
          icon: 'card',
          label: '本月',
          // Bare figures, like its two siblings: the tooltip carries which share is which.
          value:
            left !== null
              ? formatShare(left)
              : monthly.remaining !== null
                ? formatMoney(monthly.remaining)
                : formatPercent(monthly.percent),
          percent: monthly.percent,
          title: `本月已用 ${formatPercent(monthly.percent)} · 剩余 ${formatMoney(monthly.remaining)}${
            left === null ? '' : `（${formatShare(left)}）`
          }`,
        });
      }
      // The day's own figure rides on the period's request count: both answer "how much has
      // this account done", one for the billing period and one for today.
      const dayValue = today !== null && today.total > 0 ? formatTokens(today.total) : null;
      const dayTitle =
        today === null || today.total <= 0
          ? ''
          : ` · 今日（本机 DSH 会话日志）${today.calls} 次调用 · in ${formatTokens(today.input)} / out ${formatTokens(
              today.output,
            )} · 缓存命中 ${formatTokens(today.cacheRead)}`;
      if (requests !== null) {
        pills.push({
          key: 'requests',
          icon: 'bolt',
          label: '',
          value: dayValue === null ? `${requests.total.toLocaleString('en-US')} 次` : `${requests.total.toLocaleString('en-US')} 次 · 今日 ${dayValue}`,
          percent: null,
          title: `本计费周期 ${requests.total.toLocaleString('en-US')} 次请求${dayTitle}`,
        });
      } else if (dayValue !== null) {
        // No period count to hang it on: the day keeps a pill of its own rather than vanishing.
        pills.push({
          key: 'today',
          icon: 'chart',
          label: '今日',
          value: dayValue,
          percent: null,
          title: dayTitle.replace(/^ · /, ''),
        });
      }
      // Nothing readable from the account: a pill still stands in, so a failure is visible
      // instead of silent — even when the local day's figure is up.
      if (pills.length === 0 || (failure !== null && usage === null)) {
        pills.push({
          key: 'status',
          icon: 'bolt',
          label: 'Command Code',
          value: failure === null ? '—' : '⚠',
          percent: null,
          title: failure === null ? 'Command Code 额度' : failure.message,
        });
      }

      const facts = [];
      if (today !== null && today.total > 0) {
        facts.push({
          key: 'today',
          label: '今日',
          value: `${today.calls} 次调用 · in ${formatTokens(today.input)} / out ${formatTokens(today.output)} · 缓存命中 ${formatTokens(
            today.cacheRead,
          )}`,
          hint:
            `统计自本机会话日志（$DSH_HOME/sessions），只包含经 DSH 发起的调用；` +
            `CLI、编辑器等其它客户端的用量不在内。${today.unreadable > 0 ? `另有 ${today.unreadable} 个日志读取失败。` : ''}`,
        });
      }
      if (requests !== null) {
        const parts = [`${requests.total.toLocaleString('en-US')} 次请求`];
        if (requests.successRate !== null) parts.push(`成功率 ${Math.round(requests.successRate)}%`);
        if (requests.failed !== null && requests.failed > 0) parts.push(`失败 ${requests.failed}`);
        facts.push({ key: 'requests', label: '本周期', value: parts.join(' · ') });
      }
      if (tokens !== null) {
        facts.push({
          key: 'tokens',
          label: 'Token',
          value: `in ${formatTokens(tokens.input)} / out ${formatTokens(tokens.output)}`,
        });
      }
      if (monthly !== null) {
        facts.push({
          key: 'money',
          label: '月额度',
          value: `${formatMoney(monthly.used)} / ${formatMoney(monthly.cap)}`,
        });
      }
      const planName = planLabel(plan === null ? null : plan.id);
      if (planName !== null || usage !== null) {
        const who = usage !== null && typeof usage.account === 'string' ? usage.account : null;
        const period =
          plan !== null && plan.periodStart !== null && plan.periodEnd !== null
            ? `${formatDay(plan.periodStart)} – ${formatDay(plan.periodEnd)}`
            : null;
        const parts = [planName, who, period].filter((part) => part !== null && part !== undefined);
        if (parts.length > 0) facts.push({ key: 'account', label: '账户', value: parts.join(' · ') });
      }

      const panel =
        open && anchor !== null
          ? h(
              'div',
              {
                className: 'ccq-panel',
                style: { left: `${anchor.left}px`, bottom: `${anchor.bottom}px` },
                role: 'dialog',
                'aria-label': 'Command Code 额度',
              },
              h(
                'div',
                { className: 'ccq-panel-title' },
                h(
                  'span',
                  { className: 'ccq-panel-label' },
                  h(Gauge, null),
                  planName === null ? 'Command Code' : `Command Code · ${planName}`,
                ),
                h('span', { className: 'ccq-panel-value' }, formatClock(state.fetchedAt)),
              ),
              h('div', { className: 'ccq-rule' }),
              failure !== null
                ? h('div', { className: 'ccq-error' }, failure.message)
                : rows.map((row) => {
                    const left = row.key === 'monthly' ? remainingPercent(row.data.percent) : null;
                    return h(
                      'div',
                      { key: row.key },
                      h(
                        'div',
                        { className: 'ccq-row' },
                        h('span', { className: 'ccq-row-label' }, row.label),
                        h(
                          'div',
                          { className: 'ccq-track' },
                          h('div', {
                            className: 'ccq-fill',
                            style: {
                              width: `${row.data.percent === null ? 0 : Math.max(0, Math.min(100, row.data.percent))}%`,
                              background: colorFor(row.data.percent),
                            },
                          }),
                        ),
                        h('span', { className: 'ccq-row-value' }, formatPercent(row.data.percent)),
                      ),
                      h(
                        'div',
                        { className: 'ccq-reset' },
                        row.key === 'monthly' && row.data.remaining !== null
                          ? `剩 ${formatMoney(row.data.remaining)}${left === null ? '' : `（${formatShare(left)}）`} · ${formatReset(
                              row.data.resetsAt,
                            )}`
                          : formatReset(row.data.resetsAt),
                      ),
                    );
                  }),
              failure === null && facts.length > 0
                ? h(
                    'div',
                    { className: 'ccq-facts' },
                    facts.map((fact) =>
                      h(
                        'div',
                        { key: fact.key, className: 'ccq-fact', title: fact.hint },
                        h('span', null, fact.label),
                        h('span', { className: 'ccq-fact-value' }, fact.value),
                      ),
                    ),
                  )
                : null,
              failures.length > 0
                ? h(
                    'div',
                    { className: 'ccq-facts' },
                    h(
                      'div',
                      { className: 'ccq-fact' },
                      h('span', null, '读数'),
                      h(
                        'span',
                        {
                          className: 'ccq-fact-value',
                          title: failures.map((item) => `${SOURCE_LABELS[item.source] ?? item.source}: ${item.message}`).join('\n'),
                        },
                        `${failures.length} 项这次没取到`,
                      ),
                    ),
                  )
                : null,
              h(
                'div',
                { className: 'ccq-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ccq-ghost',
                    onClick: () => {
                      store.load(true).catch(() => {});
                    },
                  },
                  '刷新',
                ),
                h(
                  'a',
                  {
                    className: 'ccq-ghost ccq-link',
                    href: USAGE_URL,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    title: '在官网打开用量页（新标签）',
                  },
                  '官网看用量',
                ),
              ),
            )
          : null;

      return h(
        'div',
        { ref: rootRef, className: 'ccq-root' },
        h('style', { key: 'ccq-pill-css' }, PILL_CSS),
        pills.map((pill) =>
          h(
            'span',
            { key: pill.key, className: 'ccq-anchor' },
            h(
              'button',
              {
                type: 'button',
                className: `ccq-pill ${toneOf(pill.percent)}`.trim(),
                title: pill.title,
                'aria-haspopup': 'dialog',
                'aria-expanded': open,
                'aria-label': `Command Code ${pill.title}`,
                onClick: () => {
                  setOpen((previous) => !previous);
                  if (!open) store.load(true).catch(() => {});
                },
              },
              h(Glyph, { name: pill.icon }),
              pill.label.length > 0 ? h('span', { className: 'ccq-label' }, pill.label) : null,
              h('span', { className: 'ccq-value' }, pill.value),
            ),
          ),
        ),
        panel,
      );
    }

    /** Field, switch, input and save rules copied from the host's settings form and primitives. */
    const FORM_CSS = `
.ccq-form { display: flex; flex-direction: column; }
.ccq-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.ccq-field + .ccq-field { border-top: .5px solid var(--dsw-alias-border-l2); }
.ccq-head { display: flex; align-items: center; gap: 8px; }
.ccq-field-label {
  flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary);
}
.ccq-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.ccq-input {
  height: 34px; padding: 0 12px; border: .5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3);
  font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary);
}
.ccq-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.ccq-input:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.ccq-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.ccq-switch {
  box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px;
  padding: 2px; border: 0; border-radius: 999px; corner-shape: round;
  background: var(--dsw-alias-border-l3); cursor: pointer;
}
.ccq-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.ccq-switch:disabled { cursor: default; opacity: .5; }
.ccq-switch:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.ccq-thumb {
  display: block; width: 16px; height: 16px; border-radius: 50%; corner-shape: round;
  background: var(--dsw-alias-label-primary-foreground); transition: transform 120ms ease;
}
.ccq-switch[aria-checked="false"] .ccq-thumb { background: var(--dsw-alias-switch-thumb); }
.ccq-switch[aria-checked="true"] .ccq-thumb { transform: translateX(16px); }
.ccq-footer { display: flex; align-items: center; gap: 8px; padding-top: 16px; }
.ccq-save {
  appearance: none; border: 1px solid transparent; border-radius: var(--dsw-radius-md);
  padding: 5px 14px; font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer;
  background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3);
}
.ccq-save:disabled { opacity: .4; cursor: default; }
.ccq-save:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.ccq-note { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.ccq-failed { margin: 0; padding-top: 8px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-error); }
`;

    function CommandCodeQuotaSettings() {
      const state = useStoreState();
      const [enabled, setEnabled] = React.useState(true);
      const [apiKey, setApiKey] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      const [touched, setTouched] = React.useState(false);

      React.useEffect(() => {
        store.load(false).catch(() => {});
      }, []);

      React.useEffect(() => {
        if (state !== null && !touched) setEnabled(state.enabled === true);
      }, [state, touched]);

      const save = async (payload, note) => {
        setBusy(true);
        setMessage(null);
        try {
          const result = await store.save(payload);
          if (result !== null && result.ok === true) {
            setApiKey('');
            setTouched(false);
            setMessage(note);
          } else {
            const reason =
              result !== null && result.error !== undefined && result.error.message !== undefined
                ? result.error.message
                : '保存失败';
            setMessage(reason);
          }
        } catch (error) {
          setMessage(error !== null && error !== undefined && error.message !== undefined ? error.message : '保存失败');
        } finally {
          setBusy(false);
        }
      };

      const submit = (event) => {
        event.preventDefault();
        const payload = { enabled };
        const trimmed = apiKey.trim();
        if (trimmed.length > 0) payload.apiKey = trimmed;
        save(payload, '已保存。');
      };

      const configured = state !== null && state.configured === true;
      const writable = state === null || state.writable !== false;
      const failure =
        state !== null && state.error !== null && state.error !== undefined && state.error.code !== 'missing-credential'
          ? state.error
          : null;

      return h(
        'form',
        { className: 'ccq-form', onSubmit: submit },
        h('style', { key: 'ccq-form-css' }, FORM_CSS),
        h(
          'div',
          { className: 'ccq-field' },
          h(
            'div',
            { className: 'ccq-head' },
            h('span', { className: 'ccq-field-label' }, '显示额度'),
            h(
              'button',
              {
                type: 'button',
                role: 'switch',
                className: 'ccq-switch',
                'aria-checked': enabled,
                'aria-label': '显示额度',
                disabled: busy,
                onClick: () => {
                  setTouched(true);
                  setEnabled((previous) => !previous);
                },
              },
              h('span', { className: 'ccq-thumb' }),
            ),
          ),
          h(
            'p',
            { className: 'ccq-hint' },
            '在输入框下方显示 5 小时 / 本周的窗口占用、本月剩余额度与本计费周期的请求次数，和自带的统计按钮并排。',
          ),
        ),
        h(
          'div',
          { className: 'ccq-field' },
          h('div', { className: 'ccq-head' }, h('span', { className: 'ccq-field-label' }, 'API Key')),
          h('input', {
            className: 'ccq-input',
            type: 'password',
            value: apiKey,
            placeholder: configured ? '已配置；留空表示保持不变' : 'user_…',
            autoComplete: 'off',
            spellCheck: false,
            disabled: busy || !writable,
            onChange: (event) => setApiKey(event.target.value),
          }),
          h(
            'p',
            { className: 'ccq-hint' },
            '默认直接使用你为 commandcode provider 配好的那把密钥（凭证库 COMMAND_CODE_API_KEY），所以通常不用在这里填任何东西；改了只影响本插件。',
          ),
          configured
            ? h(
                'p',
                { className: 'ccq-hint' },
                `当前密钥：${state.keyHint ?? '已配置'}${state.source !== null && state.source !== undefined ? ` · 来源 ${state.source}` : ''}`,
              )
            : h('p', { className: 'ccq-hint' }, '尚未找到密钥；填入后这里会显示额度。'),
          !writable ? h('p', { className: 'ccq-failed' }, '本部署的凭证库是只读的，无法在此保存。') : null,
        ),
        failure !== null ? h('p', { className: 'ccq-failed' }, `读取失败：${failure.message}`) : null,
        h(
          'div',
          { className: 'ccq-footer' },
          h('button', { className: 'ccq-save', type: 'submit', disabled: busy || !writable }, busy ? '保存中…' : '保存'),
          configured
            ? h(
                'button',
                {
                  className: 'ccq-ghost',
                  type: 'button',
                  disabled: busy || !writable,
                  onClick: () => save({ apiKey: null }, '密钥已清除。'),
                },
                '清除密钥',
              )
            : null,
          message !== null ? h('p', { className: 'ccq-note' }, message) : null,
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'commandcode-quota', order: 21 },
            CommandCodeQuotaPills,
          ),
        );
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'commandcode-quota', order: 31, label: 'Command Code' },
            CommandCodeQuotaSettings,
          ),
        );
      },
    };
  },
});
