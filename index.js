/**
 * Host half of the Command Code quota bundle.
 *
 * Command Code meters a plan on three axes: a rolling 5-hour window, a rolling
 * week, and the billing period's credit allowance — plus a request count for the
 * period. The account API reports them under `/alpha/*` for the API key that
 * pays for the plan (`user_…`, from Studio → API keys).
 *
 * This half owns the key and the on/off choice, both stored in the Harness
 * credential store under this plugin's own keys — never read from another
 * provider's route and never written into a settings file:
 *   COMMAND_CODE_API_KEY        the key the user already configured for the
 *                               `commandcode` provider, so the pills need no setup
 *   COMMAND_CODE_USAGE_ENABLED  '1' (default) or '0'
 *
 * The browser half cannot reach Command Code itself, so this half serves one
 * authenticated state route and one settings route; the key never reaches the
 * page, only a masked hint of it.
 *
 * No Config is declared: a profile-installed bundle cannot resolve the Harness
 * installation's own packages (such as the schema library).
 */

const DEFAULT_BASE_URL = 'https://api.commandcode.ai';
const DEFAULT_KEY_REF = 'COMMAND_CODE_API_KEY';
const DEFAULT_ENABLED_REF = 'COMMAND_CODE_USAGE_ENABLED';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_CACHE_MS = 30000;
const DEFAULT_TODAY_CACHE_MS = 60000;

/** The append-only session log the Harness writes, one file per session. */
const LOG_FILE_NAME = 'session.v4.jsonl.zstd';

/** Absolute pathnames the Host registers; the browser addresses them document-relative. */
const STATE_PATH = '/commandcode/state';
const SETTINGS_PATH = '/commandcode/settings';

/**
 * The four read-only endpoints behind one snapshot. Each degrades on its own:
 * `billing/*` carries the windows, `usage/summary` the request count, and the
 * other two only enrich the panel.
 */
const ENDPOINTS = {
  whoami: '/alpha/whoami',
  summary: '/alpha/usage/summary',
  credits: '/alpha/billing/credits',
  subscription: '/alpha/billing/subscriptions',
};

export const name = 'commandcode-quota';

export const inject = ['webServer', 'connection'];

/** JSON response; quota numbers are live facts, so nothing is cached by the browser. */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** 405 naming the route's supported methods. */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405;
  res.setHeader('allow', allow);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, error: { code: 'method-not-allowed', message: `use ${allow}` } }));
}

/** Settings payloads are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Show enough of a key to recognize it, never enough to use it. */
function hintOf(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length <= 10) return '••••';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Epoch milliseconds or an ISO string, normalized to ISO; anything else is unknown. */
function isoFrom(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** Used share of a cap, clamped so a rounding wobble never renders 101%. */
function percentOf(used, cap) {
  if (used === null || cap === null || !(cap > 0)) return null;
  return Math.max(0, Math.min(100, (used / cap) * 100));
}

/**
 * One metered window: `{ used, cap }` upstream, `{ used, cap, percent, exceeded,
 * resetsAt }` here. `fallbackReset` is the billing period end, which is what the
 * monthly allowance resets on.
 */
function normalizeWindow(raw, fallbackReset) {
  if (raw === null || typeof raw !== 'object') return null;
  const used = asNumber(raw.used);
  const cap = asNumber(raw.cap);
  if (used === null && cap === null) return null;
  return {
    used,
    cap,
    percent: percentOf(used, cap),
    exceeded: raw.exceeded === true,
    resetsAt: isoFrom(raw.resetAt) ?? fallbackReset ?? null,
  };
}

function objectOrNull(value) {
  return value !== null && typeof value === 'object' ? value : null;
}

/**
 * Read the four upstream payloads into the one shape the browser half renders.
 * Unknown fields never cross this line, and a payload that carries nothing
 * recognizable yields null rather than an empty report.
 *
 * The monthly window's figures come from two endpoints, so the cap is
 * `used ÷ (used + remaining)` rather than a catalog price: the share can never
 * disagree with the account's own numbers, whatever plan or period it is on.
 */
function normalizeReport(payloads) {
  const summary = objectOrNull(payloads.summary);
  const credits = objectOrNull(payloads.credits);
  const subscription = objectOrNull(payloads.subscription);
  const whoami = objectOrNull(payloads.whoami);

  const planSource = objectOrNull(subscription?.data) ?? subscription;
  const plan = {
    id: asString(planSource?.planId),
    status: asString(planSource?.status),
    periodStart: isoFrom(planSource?.currentPeriodStart),
    periodEnd: isoFrom(planSource?.currentPeriodEnd),
  };
  const hasPlan = plan.id !== null || plan.status !== null || plan.periodEnd !== null;

  const limitsSource = objectOrNull(credits?.windowLimits);
  const fiveHour = normalizeWindow(limitsSource?.fiveHour, null);
  const weekly = normalizeWindow(limitsSource?.weekly, null);

  const monthlyUsed = asNumber(summary?.totalMonthlyCredits) ?? asNumber(summary?.totalCredits);
  const creditSource = objectOrNull(credits?.credits);
  const remaining =
    creditSource === null
      ? null
      : (asNumber(creditSource.monthlyCredits) ?? 0) +
        (asNumber(creditSource.purchasedCredits) ?? 0) +
        (asNumber(creditSource.freeCredits) ?? 0);
  const monthlyCap = monthlyUsed !== null && remaining !== null ? monthlyUsed + remaining : null;
  const monthly =
    monthlyUsed === null && remaining === null
      ? null
      : {
          used: monthlyUsed,
          cap: monthlyCap,
          percent: percentOf(monthlyUsed, monthlyCap),
          remaining,
          purchased: asNumber(creditSource?.purchasedCredits),
          free: asNumber(creditSource?.freeCredits),
          exceeded: null,
          resetsAt: plan.periodEnd,
        };

  const windows = fiveHour !== null || weekly !== null || monthly !== null ? { fiveHour, weekly, monthly } : null;

  const total = asNumber(summary?.totalCount);
  const requests =
    total === null
      ? null
      : {
          total,
          completed: asNumber(summary?.completedCount),
          failed: asNumber(summary?.failedCount),
          successRate: asNumber(summary?.successRate),
        };

  const tokensIn = asNumber(summary?.totalTokensIn);
  const tokensOut = asNumber(summary?.totalTokensOut);
  const tokens =
    tokensIn === null && tokensOut === null
      ? null
      : { input: tokensIn, output: tokensOut, total: asNumber(summary?.totalTokens) };

  if (windows === null && requests === null && !hasPlan) return null;

  return {
    windows,
    requests,
    tokens,
    plan: hasPlan ? plan : null,
    account: asString(whoami?.user?.name) ?? asString(whoami?.user?.userName),
    periodBasis: asString(summary?.periodBasis),
    // A metered plan answers with `windowLimits: null`: read as "no rolling gates", not as missing data.
    windowLimits: credits === null ? null : { limited: limitsSource?.limited === true, exceeded: asString(limitsSource?.exceeded) },
  };
}

/**
 * Today's Command Code tokens, folded from this machine's own session logs.
 *
 * The account API has no per-day dimension — `usage/summary` answers for the billing
 * period and ignores `period`/`from`/`to` — so the day comes from the events DSH has
 * already written: every `assistant/message` names the provider that answered and
 * carries a `usage` record. Reading the logs (rather than counting live traffic) has
 * one real advantage: calls made earlier today, before this plugin was loaded, are
 * included. What it cannot see is Command Code usage from outside DSH — the CLI, an
 * editor, another machine — and that limit belongs in the label, not in silence.
 */

/** Local midnight as epoch milliseconds: the day boundary the person reading the pill lives in. */
function startOfDay(now) {
  const at = new Date(now);
  at.setHours(0, 0, 0, 0);
  return at.getTime();
}

/** The same boundary as `YYYY-MM-DD`, for the cache key and the client's label. */
function dayKey(now) {
  const at = new Date(now);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/**
 * A session log is a sequence of zstd frames, not one stream, so a single
 * `zstdDecompressSync` on the whole file stops at the first frame boundary. Split on the
 * frame magic and inflate each piece; a frame still being written fails and is skipped
 * rather than sinking the file.
 */
function decodeFrames(buffer, inflate) {
  const offsets = [];
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer[index] === 0x28 && buffer[index + 1] === 0xb5 && buffer[index + 2] === 0x2f && buffer[index + 3] === 0xfd) {
      offsets.push(index);
    }
  }
  if (offsets.length === 0) return null;
  let text = '';
  for (let index = 0; index < offsets.length; index += 1) {
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
    try {
      text += inflate(buffer.subarray(offsets[index], end)).toString('utf8');
    } catch {
      // A torn tail frame: skip it.
    }
  }
  // No frame at all, or none this runtime can inflate: the caller reports the file as unread
  // rather than folding it as empty.
  return text.length === 0 ? null : text;
}

/** The usage record of one event line, read without parsing the reasoning text beside it. */
const USAGE_BLOCK = /"usage":\{([^{}]*)\}/;
const EVENT_TIME = /"time":(\d+)/;

function usageOf(line) {
  const block = USAGE_BLOCK.exec(line);
  if (block === null) return null;
  const field = (key) => {
    const hit = new RegExp(`"${key}":(\\d+)`).exec(block[1]);
    return hit === null ? 0 : Number(hit[1]);
  };
  return { input: field('inputTokens'), output: field('outputTokens'), total: field('totalTokens'), cacheRead: field('cacheReadTokens') };
}

/** Where the profile keeps its session logs, unless the profile configured otherwise. */
async function resolveSessionsDir(configured) {
  if (typeof configured === 'string' && configured.length > 0) return configured;
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const home = String(process.env.DSH_HOME ?? '').trim();
  return join(home.length > 0 ? home : join(homedir(), '.dsh'), 'sessions');
}

/**
 * Sum today's Command Code usage across the sessions touched today. Returns null when the
 * store cannot be read at all, so the caller can leave the figure off rather than show a zero.
 */
async function scanToday(configuredDir, now) {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { zstdDecompressSync } = await import('node:zlib');
  const { join } = await import('node:path');

  const sessionsDir = await resolveSessionsDir(configuredDir);
  const dayStart = startOfDay(now);
  const totals = {
    day: dayKey(now),
    provider: 'commandcode',
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    total: 0,
    sessions: 0,
    unreadable: 0,
  };

  for (const workspace of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = join(sessionsDir, workspace.name);
    for (const session of readdirSync(workspaceDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const file = join(workspaceDir, session.name, LOG_FILE_NAME);
      let touched;
      try {
        touched = statSync(file);
      } catch {
        continue;
      }
      // A log is appended while its session runs, so today's calls only live in files written today.
      if (touched.mtimeMs < dayStart) continue;

      let text;
      try {
        text = decodeFrames(readFileSync(file), zstdDecompressSync);
      } catch {
        text = null;
      }
      if (text === null) {
        totals.unreadable += 1;
        continue;
      }

      let counted = false;
      for (const line of text.split('\n')) {
        if (line.length === 0 || !line.includes('"assistant/message"')) continue;
        const at = Number(EVENT_TIME.exec(line)?.[1]);
        if (!Number.isFinite(at) || at < dayStart) continue;
        if (!line.includes('"provider":"commandcode"')) continue;
        const usage = usageOf(line);
        if (usage === null) continue;
        totals.calls += 1;
        totals.input += usage.input;
        totals.output += usage.output;
        totals.cacheRead += usage.cacheRead;
        totals.total += usage.total;
        counted = true;
      }
      if (counted) totals.sessions += 1;
    }
  }
  return totals;
}

export function apply(ctx, config) {
  const supplied = config !== null && typeof config === 'object' ? config : {};
  const options = {
    keyRef: typeof supplied.credentialRef === 'string' ? supplied.credentialRef : DEFAULT_KEY_REF,
    enabledRef: typeof supplied.enabledRef === 'string' ? supplied.enabledRef : DEFAULT_ENABLED_REF,
    baseURL: String(typeof supplied.baseURL === 'string' ? supplied.baseURL : DEFAULT_BASE_URL).replace(/\/+$/, ''),
    timeoutMs: typeof supplied.timeoutMs === 'number' ? supplied.timeoutMs : DEFAULT_TIMEOUT_MS,
    cacheMs: typeof supplied.cacheMs === 'number' ? supplied.cacheMs : DEFAULT_CACHE_MS,
    todayCacheMs: typeof supplied.todayCacheMs === 'number' ? supplied.todayCacheMs : DEFAULT_TODAY_CACHE_MS,
    sessionsDir: typeof supplied.sessionsDir === 'string' && supplied.sessionsDir.length > 0 ? supplied.sessionsDir : null,
  };

  const credentials = ctx.get('credentials');

  /** Last account answer and the moment it was taken; the UI polls faster than the account should be hit. */
  let cache = { at: 0, key: '', payload: undefined };
  let inflight;

  /** Today's local fold and the day it belongs to; a minute is enough for logs that grow slowly. */
  let todayCache = { at: 0, day: '', value: null };

  const readToday = async (force) => {
    const day = dayKey(Date.now());
    if (!force && todayCache.day === day && Date.now() - todayCache.at < options.todayCacheMs) return todayCache.value;
    let value = null;
    try {
      value = await scanToday(options.sessionsDir, Date.now());
    } catch {
      // No session store, or a build whose logs this reader does not know: leave the figure off.
      value = null;
    }
    todayCache = { at: Date.now(), day, value };
    return value;
  };

  /** Read one stored credential value, treating present-but-empty as absent. */
  const resolveValue = async (ref) => {
    if (credentials === undefined) return undefined;
    try {
      const hit = await credentials.resolve(ref);
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) {
        return { value: hit.value, source: typeof hit.source === 'string' ? hit.source : null };
      }
    } catch {
      // A broken store reads as unconfigured; the settings page reports the write failure instead.
    }
    return undefined;
  };

  const readEnabled = async () => {
    const stored = await resolveValue(options.enabledRef);
    return stored === undefined ? true : stored.value !== '0';
  };

  const store = async (ref, value) => {
    if (credentials === undefined) throw new Error('此部署没有可写的凭证库。');
    await credentials.set(ref, value);
  };

  const remove = async (ref) => {
    if (credentials === undefined) return;
    await credentials.unset(ref);
  };

  /** One endpoint, never throwing: a failed reading is reported, not propagated. */
  const fetchOne = async (key, path) => {
    try {
      const response = await fetch(`${options.baseURL}${path}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${key}`,
          accept: 'application/json',
          'user-agent': 'dsh-commandcode-quota/1.0',
        },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return { ok: false, status: response.status, message: detail.slice(0, 300) || `HTTP ${response.status}` };
      }
      const body = await response.json().catch(() => null);
      if (body === null || typeof body !== 'object') {
        return { ok: false, status: response.status, message: '响应不是合法 JSON。' };
      }
      return { ok: true, status: response.status, body };
    } catch (error) {
      return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) };
    }
  };

  /** All four readings at once; the slowest endpoint is the read's deadline, not their sum. */
  const fetchAll = async (key) => {
    const entries = await Promise.all(
      Object.entries(ENDPOINTS).map(async ([source, path]) => [source, await fetchOne(key, path)]),
    );
    const payloads = {};
    const failures = [];
    for (const [source, result] of entries) {
      if (result.ok) payloads[source] = result.body;
      else failures.push({ source, httpStatus: result.status > 0 ? result.status : null, message: result.message });
    }

    const report = normalizeReport(payloads);
    const everyReadingFailed = entries.every(([, result]) => !result.ok);
    const everyReadingMissing = entries.every(([, result]) => !result.ok && result.status === 404);
    const unauthorized = entries.some(([, result]) => !result.ok && (result.status === 401 || result.status === 403));

    if (report === null) {
      if (unauthorized) {
        return { report: null, failures, error: { code: 'unauthorized', message: '密钥被拒绝；请在设置中检查 Command Code API key。' } };
      }
      if (everyReadingMissing) {
        return {
          report: null,
          failures,
          error: { code: 'no-api-access', message: '这个套餐没有 API 访问权限（Go $1 档没有），额度读不到。' },
        };
      }
      if (everyReadingFailed) {
        return { report: null, failures, error: { code: 'network', message: failures[0]?.message ?? '无法连接 Command Code。' } };
      }
      return { report: null, failures, error: { code: 'unexpected-payload', message: '额度接口返回了无法识别的结构。' } };
    }

    return { report: { ...report, failures }, failures, error: null };
  };

  /** One snapshot of everything the UI needs: the choice, the key's presence, and the numbers. */
  const buildState = async (force) => {
    const [enabled, stored, info] = await Promise.all([
      readEnabled(),
      resolveValue(options.keyRef),
      Promise.resolve(credentials === undefined ? undefined : credentials.describe(options.keyRef)).catch(() => undefined),
    ]);

    const base = {
      ok: true,
      enabled,
      configured: stored !== undefined,
      source: stored !== undefined ? stored.source : null,
      writable: info !== undefined && info !== null && info.writable === true,
      keyHint: stored !== undefined ? hintOf(stored.value) : null,
      origin: options.baseURL,
    };
    const stamp = () => new Date().toISOString();

    if (!enabled) {
      return { ...base, usage: null, error: null, today: null, fetchedAt: stamp() };
    }
    if (stored === undefined) {
      return {
        ...base,
        usage: null,
        error: { code: 'missing-credential', message: '尚未找到 Command Code API key。' },
        today: null,
        fetchedAt: stamp(),
      };
    }

    // The day's own figure comes from local logs, so it stands on its own: an account read
    // that fails does not take it down, and it is there before the first upstream answer.
    const today = await readToday(force);

    const now = Date.now();
    if (!force && cache.payload !== undefined && cache.key === stored.value && now - cache.at < options.cacheMs) {
      return { ...base, usage: cache.payload, error: null, today, fetchedAt: new Date(cache.at).toISOString() };
    }
    if (!force && inflight !== undefined) {
      const settled = await inflight;
      return { ...base, usage: settled.report, error: settled.error, today, fetchedAt: stamp() };
    }

    inflight = fetchAll(stored.value);
    let settled;
    try {
      settled = await inflight;
    } finally {
      inflight = undefined;
    }
    if (settled.report !== null) cache = { at: Date.now(), key: stored.value, payload: settled.report };
    return { ...base, usage: settled.report, error: settled.error, today, fetchedAt: stamp() };
  };

  /** Answer an untrusted or unauthenticated request; true when it was rejected. */
  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: STATE_PATH,
        handler: async (req, res) => {
          if (rejected(req, res)) return;
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendMethodNotAllowed(res, 'GET');
            return;
          }
          const url = new URL(String(req.url ?? '/'), 'http://localhost');
          const force = url.searchParams.get('refresh') === '1';
          try {
            sendJson(res, 200, await buildState(force));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 500, { ok: false, error: { code: 'internal', message } });
          }
        },
      }),
    `commandcode-quota: GET ${STATE_PATH}`,
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SETTINGS_PATH,
        handler: async (req, res) => {
          if (rejected(req, res)) return;
          if (req.method !== 'POST') {
            sendMethodNotAllowed(res, 'POST');
            return;
          }
          let body;
          try {
            body = await readJsonBody(req);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 400, { ok: false, error: { code: 'invalid-body', message } });
            return;
          }
          try {
            if (typeof body.enabled === 'boolean') {
              await store(options.enabledRef, body.enabled ? '1' : '0');
            }
            if (body.apiKey === null) {
              await remove(options.keyRef);
            } else if (typeof body.apiKey === 'string' && body.apiKey.trim().length > 0) {
              await store(options.keyRef, body.apiKey.trim());
            }
            sendJson(res, 200, await buildState(true));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 400, { ok: false, error: { code: 'write-failed', message } });
          }
        },
      }),
    `commandcode-quota: POST ${SETTINGS_PATH}`,
  );
}
