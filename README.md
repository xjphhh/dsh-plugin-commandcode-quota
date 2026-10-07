# dsh-plugin-commandcode-quota

在 **DeepSeek Harness (DSH)** 的 Web UI 里，把 **Command Code 订阅**的读数放进输入框下方那一排：

```
🕐 5 小时 9%    📅 本周 10%    💳 本月 95.1%    ⚡ 974 次 · 今日 67.2M
```

和 DSH 自带的「N 轮 M 步 · 缓存命中 · 上下文」并排 —— 平时是同样的灰色，不多占一行。

真实输出（`node scripts/preview.mjs` 用真实账号渲染出来的，不是示意图）：

```text
── 输入框下方那一排 ─────────────────────────────
  5 小时11%
  本周11%
  本月94.6%
  1,057 次 · 今日 86.5M
  (悬停 ⚡) 本计费周期 1,057 次请求 · 今日（本机 DSH 会话日志）391 次调用 · in 1.5M / out 475.7K · 缓存命中 84.5M

── 点开后弹出的面板 ─────────────────────────────
标题: Command Code · GOAT                                  10:39 更新
  5 小时  11%   ──────────────────────────────   10/7 13:42 重置（3 小时 3 分后）
  本周    11%   ──────────────────────────────   10/13 09:37 重置（5 天 22 小时后）
  本月     5%   ──────────────────────────────   剩 $66.19（94.6%） · 11/6 09:12 重置（29 天 22 小时后）
  ── 底部事实 ──
  今日    391 次调用 · in 1.5M / out 475.7K · 缓存命中 84.5M
  本周期  1,057 次请求 · 成功率 100%
  Token   in 99.4M / out 670.7K
  月额度  $3.77 / $69.95
  账户    GOAT · xjphhh · 2026/10/6 – 2026/11/6
  ── 操作 ──
  刷新（按钮）   官网看用量（→ https://commandcode.ai/settings/usage）
```

## 显示什么

| 胶囊 | 读数 | 来源 |
|---|---|---|
| 🕐 5 小时 | 滚动 5 小时窗口的已用百分比（`used ÷ cap`） | `/alpha/billing/credits` → `windowLimits.fiveHour` |
| 📅 本周 | 滚动 7 天窗口的已用百分比 | `/alpha/billing/credits` → `windowLimits.weekly` |
| 💳 本月 | 本计费周期的**剩余百分比**（`100 − 已用`）；没有百分比时退回剩余金额 | `/alpha/billing/credits` → `credits.*` 与 `/alpha/usage/summary` |
| ⚡ N 次 | 本计费周期的**请求次数**；今天的 token 消耗量跟在后面 | `/alpha/usage/summary` → `totalCount` ＋ 本机会话日志（见下） |

- **「今日」是本机账，不是账号账**：Command Code 的账号接口没有当天维度（`/alpha/usage/summary?period=today`、`?from&to` 都被忽略，返回的就是计费周期累计），所以这个数由 DSH 自己写的会话日志折出来 —— 遍历 `$DSH_HOME/sessions/*/*/session.v4.jsonl.zstd`（多帧 zstd，按帧魔数切开再解），只取 `assistant/message` 事件里 `message.source.provider === "commandcode"` 且时间戳在今天的那几条的 `usage`，in + 缓存命中 + out 合成一个总量跟在 **⚡ N 次** 后面（今天没调用就不出现；没有周期请求数时它自己单独占一格）。好处是**今天早些时候、插件还没加载时的调用也算得进来**；代价是**只统计经 DSH 发起的调用**，用 `command-code` CLI、编辑器或另一台机器花的量不在这里（悬停会写明这一点）。
- **胶囊只放裸数字，口径在悬停和面板里**：`本月 95.1%` 是剩余、`5 小时 9%` 是已用，宽度和另外两个保持一致；鼠标停在 💳 上能看到 `本月已用 5% · 剩余 $66.51（95.1%）`，停在 ⚡ 上能看到 `本计费周期 974 次请求 · 今日（本机 DSH 会话日志）323 次调用 · in 1.3M / out 403.1K · 缓存命中 65.5M`。
- **用量越高越显眼**：默认灰（`label-tertiary`）；≥70% 变黄，≥90% 变红（本月按已用算，也就是剩余 ≤30% 变黄、≤10% 变红）。
- **点击任一胶囊看详情**：三条进度条 + 各自的重置倒计时（`10/7 13:42 重置（2 小时 4 分后）`）、今日 `调用次数 · in/out · 缓存命中`、本月 `已用 / 上限 · 剩余`、请求次数与成功率、token 进出、套餐与账户、计费周期；点外部或按 `Esc` 关闭。面板底部两个按钮：**刷新** 立刻重读一次，**官网看用量** 在新标签打开 `https://commandcode.ai/settings/usage`（官网自己的用量页；`/usage`、`/billing` 都只是重定向到它）。
- **读数缺失不装死**：四个接口各自降级，取不到的那几项在面板里以「N 项这次没取到」列明（悬停看是哪个接口、什么错）；全失败时胶囊变成 `Command Code ⚠`，点开有原因 —— 而本机的「今日」照常显示。
- **设置里可控**：`设置 → Command Code` 提供「显示额度」开关，以及 API key 的填写/清除。
- **未配置就不打扰**：没密钥或关掉开关时，输入框下方不显示任何东西。

## 前置条件

- DeepSeek Harness 桌面版或 `dsh web`（`webServer` + `connection` 两个 Host 半边服务）。
- 一个 Command Code 账号的 API key（`user_…`，Studio → API keys）。
  **通常不用配**：插件默认读你为 `commandcode` provider 已经写好的那把
  （凭证库 `COMMAND_CODE_API_KEY`），例如 `llm-pi-ai` 里 `apiKeyEnv: COMMAND_CODE_API_KEY` 的那条路由。
- `$1` 的 **Go** 档没有 API 访问权限（四个接口都 404），插件会明确说「这个套餐没有 API 访问权限」，而不是反复报错。

## 安装

```sh
dsh plugin --profile web add github:xjphhh/dsh-plugin-commandcode-quota
```

装完刷新页面（Host 半边没热起来时重启一次 DSH）。桌面客户端的 profile 由 Electron 应用独占，
`--profile desktop` 走不通，改用应用自带的 CLI：

```powershell
& "<DeepSeek Harness 安装目录>\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add github:xjphhh/dsh-plugin-commandcode-quota
```

这条命令走的就是应用内「设置 → 插件」同一个安装器：它把包写进 profile 的 `dependencies`、
加进 `dsh.profile.bundles`，并更新 `pnpm-lock.yaml`。之后在应用内再装卸别的插件也不会把你挤掉。
也可以在界面上装：**设置 → 插件 → 添加插件**，粘贴 `github:xjphhh/dsh-plugin-commandcode-quota`
或本目录的绝对路径。

本机开发时用本地路径装（改动即时可见，不必先推 GitHub）：

```powershell
& "<…>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "<本仓库的绝对路径>"
```

> ⚠️ **不要**走「手工往 `profiles/desktop/cordis.patch.yml` 加 `- insert:`」这条路。
> 桌面端应用启动时会按自己的状态**整份重写** `cordis.patch.yml`（实测 246 行 → 750 行），
> 手加的 insert 条目会被静默丢掉——表现为插件"装了"但输入框下方什么都没有，
> 且 `GET /commandcode/state` 始终是 404。只有 bundle 路线会留存。

**npm（可选）**

```sh
dsh plugin --profile web add <包名>
```

已声明 `dsh.bundle.patch`，安装器会自己把那行 loader 条目加进组合包层 ——
这时**不要**再手工往 `cordis.patch.yml` 写同一行（重复的 loader id 会让 dsh 拒绝启动）。

**自检安装是否生效**（无需登录，看状态码即可）：

```powershell
& curl.exe -s -o NUL -w "%{http_code}`n" "http://127.0.0.1:19387/commandcode/state"
# 401 = Host 半边已加载（路由在，只是 curl 没有浏览器 cookie）
# 404 = 没加载，回去检查 dsh.profile.bundles
```

## 工作原理

```
Command Code 账号 API  https://api.commandcode.ai/alpha/*
      ▲  Authorization: Bearer <your key>
      │  四个只读 GET 并发发出，各自降级
Host 半边 (index.js)  ──  credentials.resolve(COMMAND_CODE_API_KEY)
      │                 30s 缓存 + 并发去重 + 归一化
      │                 ＋ 折本机会话日志得到「今日」token（60s 缓存）
      │  GET  /commandcode/state          （DSH cookie 鉴权，同源）
      │  POST /commandcode/settings
      ▼
浏览器半边 (client.js)  ──  只负责渲染
      ├─ conversation.composer.dock   四个胶囊（输入框下方那一排，贴最右）
      └─ settings.section             设置页
```

- Host 半边用 DSH 的 `webServer` 注册两条 `exact` 路由，并用 `connection.requestRejection` 做与内置插件同一套的 Host/Origin + cookie 校验。
- 浏览器半边不接触密钥，只读取 `state`（含脱敏提示 `user_3…rVDa`）。
- 样式只依赖 `--dsw-alias-*` 主题 token，自动跟随明暗主题；胶囊的尺寸/圆角/hover 与宿主自带的统计胶囊对齐。
- 月度上限取 `已用 + 剩余`，而不是写死套餐标价 —— 官网怎么算，面板就怎么算，换套餐或跨周期都不用改代码。
- 「今日」不从网络取：它折的是 `$DSH_HOME/sessions/*/*/session.v4.jsonl.zstd`（按帧魔数切开的多帧 zstd → JSONL），只数今天、且 `provider === "commandcode"` 的 `assistant/message`。目录可用 `sessionsDir` 配置覆盖，缓存时长用 `todayCacheMs`。

## 开发与自测

```sh
node --test                        # 39 项离线检查：归一化、错误路径、缓存、两条路由、当日折叠、渲染
node scripts/live-check.mjs        # 用真实账号打一次实盘，打印四个读数
node scripts/preview.mjs           # 用真实账号渲染胶囊 + 面板，不需要浏览器（--offline 走固定样例）
node --check index.js && node --check client.js
```

`node --test` 不联网、不需要真 key（fetch 被替换成固定应答表，会话日志用临时目录里的合成 zstd 帧）。
`scripts/live-check.mjs` 与 `scripts/preview.mjs` 会从 `$DSH_HOME/.credentials.yaml` 读 `COMMAND_CODE_API_KEY`，是真的网络请求。

- 改 `client.js`：刷新页面即可（浏览器半侧每次请求都从磁盘读）。
- 改 `index.js`：需要**重启 DSH**（Host 模块按文件路径缓存）。

## 已知限制

- **轮询，不是推送**：页面 60 秒问一次，Host 侧还有 30 秒缓存，所以额度读数最多滞后一分钟；点胶囊会强制刷新一次。
- **「今日」只算经 DSH 发起的调用**：账号接口没有当天维度，这一格是本机会话日志折出来的 —— `command-code` CLI、编辑器插件、另一台机器上的用量都不在内；日志按「今天被写过」过滤（`mtime`），所以不会为了几分钟前的调用去解压整年的日志。
- **「今日」依赖日志格式**：`session.v4.jsonl.zstd` 的名字或多帧 zstd 结构若在后续版本变化，这一格会自己消失（`today: null`），其余读数不受影响；`unreadable` 会在悬停里说明有几个文件没读出来。
- **月度只是一个数**：`/alpha` 接口不暴露「每个模型各占多少月度预算」的表，所以只看总额。
- **额度不留历史**：账号侧每次都是实时快照，不落盘（唯一的本地数据就是「今日」的折叠结果，且只活在内存里）。
- **只覆盖 Command Code**：DSH 自己的本地 token 统计（`$DSH_HOME/dsh-usage/`）不受影响。
- 上游若改 `/alpha/*` 的路径或结构，本插件需要同步更新（结构不认识时会明确报 `unexpected-payload`，不会静默显示错数字）。

## License

MIT
