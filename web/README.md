# MISAKA WebUI（web/）

移动优先的 MISAKA WebUI（M0 会话 + M1 研究驾驶舱）：Vite + React 19 + TypeScript，**手写 CSS**
（CSS 变量做主题，无路由库 / 无 Tailwind / 无 UI 组件库 / 无 markdown 依赖）。

产物 `web/dist` 由 Python 服务静态托管（见 `CONTRACT.md` §2），**服务器不装 node**：
构建只发生在开发机。

## 目录

```
web/
  index.html            单页入口（viewport-fit=cover、manifest、theme-color）
  public/               manifest.webmanifest、icon.svg、sw.js（手写 Service Worker，原样拷到 dist 根）
  src/
    main.tsx            入口：先落主题；VITE_MOCK=1 时装载 mock 后端
    App.tsx             认证状态机 + 顶层导航（会话 / 研究）+ 极简 hash 路由
    api.ts              所有 M0 + M1 HTTP 端点（Bearer + cookie 双通道）
    stream.ts           EventSource 订阅 SSE（snapshot / delta / error）
    mock.ts             VITE_MOCK=1 的本地后端（替换 fetch + EventSource）
    mock-research.ts    研究面假后端（/api/runs*，三条 run / 三层节点 / plan/cards/synthesis 文本）
    mock-http.ts        mock 共用的 json/error/delay 工具
    merge.ts            delta.entries 合并策略（追加、绝不重排）
    markdown-parse.ts   Markdown 块级 + 行内解析 + 引用定位符识别（纯函数、可在 Node 里自检）
    markdown.tsx        Markdown → React 元素（**不用 dangerouslySetInnerHTML**）
    errors.ts           读请求异常归类（503 board_unavailable / 401 / 404 / 422）
    theme.ts / useAppHeight.ts / format.ts
    components/         LoginView / SessionListView / SessionView / MessageList / Composer / Banner / ThemeSwitch
                        Tabs / ResearchListView / RunDetailView / NodeDetailView / StatusChip / ConfirmLayer / FileViewer
                        NewRunSheet（新建研究）/ LogSheet（进程日志）
                        SourcePanel / SourceBrowser / FileSheet（来源面板与原文）
                        AuditView（审计）/ MenuSheet（顶部菜单）
    sw.ts               Service Worker 注册 + 更新提示（仅生产）
    useReminders.ts     待办提醒：标题前缀 / tab 圆点 / 页面内通知
    print.ts            导出/打印（body class + window.print）
    styles.css          设计视口 390x844、断点 768/1024、深/浅色、safe-area
```

## 本机工具链（Windows，node 不在 PATH）

```sh
# 用你本机的 node/pnpm（macOS/Linux 装在 PATH 里就不用这两行）
export PATH="/path/to/node/bin:$PATH"
PNPM="/path/to/pnpm/bin/pnpm.mjs"
# 例：DSH 自带工具链在 ~/.dsh/dsh-runtimes/<runtime>/dependencies/{node/bin,pnpm/bin/pnpm.mjs}
cd misaka-web/web

node "$PNPM" install            # 首次
node "$PNPM" run dev            # 开发服务器 http://127.0.0.1:5173
node "$PNPM" run dev:mock       # 同上，但 VITE_MOCK=1（--mode mock）
node "$PNPM" run typecheck      # tsc --noEmit
node "$PNPM" exec vite build    # 产物 -> web/dist
```

> pnpm 会提示 `Ignored build scripts: esbuild`，那是策略提示，`vite build` 照常完成。
> 不需要（也不应该）跑 `pnpm approve-builds`。

## 环境变量（构建期注入）

| 变量 | 作用 |
|---|---|
| `VITE_MOCK=1` | 启用本地 mock 后端：无需 Python 服务即可开发/演示，SSE 流式追加由 mock 模拟 |
| `VITE_API_BASE` | 后端基址，如 `http://127.0.0.1:8787`；留空 = 同源（生产形态） |

示例：

```sh
# 纯前端 + 本地 mock
VITE_MOCK=1 node "$PNPM" exec vite build

# 连真后端（开发期 CORS 需后端放行 MISAKA_WEB_DEV_ORIGIN）
VITE_API_BASE=http://127.0.0.1:8787 node "$PNPM" run dev

# 生产：同源，留空即可
node "$PNPM" exec vite build && rm -rf ../src/misaka_web/static && cp -r dist ../src/misaka_web/static
```

SSE 说明：`EventSource` 不能自定义请求头，所以 `/api/sessions/{id}/events` 的认证走
`POST /api/login` 换来的 `mw_session` cookie（`withCredentials: true`）。开发期请让
前端与后端**同 site**（如都用 `127.0.0.1`，端口可不同），否则 `SameSite=Strict` 的 cookie 不会被带上。

## M0 端点对照（CONTRACT §3）

| 端点 | 前端位置 |
|---|---|
| `POST /api/login` | `api.ts:login` → `LoginView` |
| `GET /api/me` | `api.ts:me` → `App` 启动探测会话 |
| `GET /api/sessions` | `api.ts:listSessions` → `SessionListView` |
| `GET /api/sessions/{id}` | `api.ts:getSession` → `SessionView` 进入会话先取全量快照 |
| `GET /api/sessions/{id}/events?since=<stream_cursor>` | `stream.ts:openSessionStream` |
| `POST /api/sessions/{id}/input` | `api.ts:sendInput` → `Composer` |
| `POST /api/sessions/{id}/pause` / `resume` | `api.ts:setPaused` → `SessionView` 暂停/恢复按钮 |
| `POST /api/logout` | `api.ts:logout` → 列表页「退出登录」 |

## 行为约定

- **不重排**：`snapshot` 全量替换；`delta.entries` 只追加（若是既有前缀的扩展则整体替换，
  见 `merge.ts`）；`delta.streaming` 原位更新同一段。渲染 key 用条目下标，历史 DOM 不重挂。
- **不自动重连**：任何 SSE 错误都立刻 `close()`（浏览器因此不会自愈），顶部 banner 给
  「重连 / 重试」按钮，用户点击才用 `since=<stream_cursor>` 续订。
  `event: error`（带 data）与传输层断开（不带 data）分别提示不同文案。
- **投递未确认不重发**：`POST .../input` 失败就在输入框上方显示红色错误并**保留原文**，
  不重试、不清空；只有 `{ok:true}` 才清空。
- **主题**：默认跟随 `prefers-color-scheme`，右上角按钮在 自动 → 浅色 → 深色 之间切换，
  选择存 `localStorage`。
- **布局**：`--app-height` 取 `visualViewport` 高度，输入框始终贴在可视区底部；
  顶栏/输入框都吃 `env(safe-area-inset-*)`；按钮最小 44x44，输入与正文 >= 16px。

## mock 演示

`VITE_MOCK=1` 下用任意非空 token 登录（输入 `reject` 演示 401）。进入「重构 misaka-web 前端」
后可以直接试：

| 输入 | 效果 |
|---|---|
| 任意文本 | 助手逐块流式追加（模拟 SSE delta） |
| `/fail` | 502「投递未确认」——输入框上方报错、原文保留、不自动重发 |
| `/offline` | 模拟传输层断开 —— 顶部断线 banner +「重连」 |
| `/error` | 服务端 `event: error` —— 停止接收、不自动重连、「重试」 |
| 暂停 / 恢复 | 走 `POST .../pause|resume`，暂停期间 mock 挂起流式输出 |

## M1 研究驾驶舱

### 路由（hash，无路由库）

| hash | 页面 |
|---|---|
| `#/sessions` | 会话列表（M0，行为未改） |
| `#/session/<id>` | 会话视图（M0，SSE 流式） |
| `#/runs` | 研究列表 |
| `#/run/<id>` | 研究详情（节点树 / limits / 产物） |
| `#/run/<id>/node/<node>` | 节点详情（tasks / files / syntheses / 同意并开始） |

顶层「会话 / 研究」两个 tab 常驻；详情页左上角返回上一级。

### 端点对照（CONTRACT §3.1 / §3.2）

| 端点 | 前端位置 |
|---|---|
| `GET /api/runs` | `api.ts:listRuns` → `ResearchListView`（503 board_unavailable 与空态各一套文案） |
| `GET /api/runs/{id}` | `api.ts:getRun` → `RunDetailView` |
| `GET /api/runs/{id}/nodes/{node}` | `api.ts:getRunNode` → `NodeDetailView` |
| `GET …/file?name=` | `api.ts:getRunFile` → `FileViewer` + `Markdown` |
| `POST /api/runs/{id}/tell` | `api.ts:tellRun` → `NodeDetailView` 的「同意并开始」 |
| `POST /api/runs/{id}/stop` | `api.ts:stopRun` → `RunDetailView` 二次确认层 |
| `POST /api/runs/{id}/limits` | `api.ts:changeRunLimits` → `RunDetailView` 的 limits 编辑器 |

### 写操作的规矩

- **stop / limits / tell 全部先过二次确认层**（`ConfirmLayer`），确认按钮才发请求。
- **limits 只放四个整数**：`sister_parallel` / `parallel` / `max_followups` / `max_revisions`，
  客户端先做整数校验再提交；其余 limits 键只读展示。提交成功后**回读** `GET /api/runs/{id}`。
- **同意并开始 = 审批就是对话**：确认层写明「将把你的话发给这个节点的 Last Order，由她调用
  `misaka_research_start`」，正文预填「同意，按这份计划开始。」且可编辑；成功后提示
  「已投递，需回读状态」并自动回读一次，另给「回读状态」按钮手动再读。
  `listening=false` 时按钮禁用并写明原因；失败时把服务端 422 的 message **原样**显示（里面有 `Listening now: …`）。
- 所有成功提示都点名「已回读」——投递 ≠ 开始。

### Markdown 渲染（自写，零依赖）

支持：标题（`#`–`######`）、段落、有序/无序列表（含缩进与续行）、引用、代码块（``` 与 `~~~` 两种围栏）、
行内代码、粗体/斜体/删除线、表格、分隔线。**链接按「文本（url）」显示成纯文本**，不生成 `<a>`。
全部通过 React 元素产出，代码里没有 `dangerouslySetInnerHTML`，也不引入 marked / markdown-it / dompurify。
不支持的行内嵌套（粗体里再套斜体）原样输出，不猜。

### 390px 横向滚动

页面本身不横向滚动（`body { overflow-x: hidden }` + 所有面板 `min-width: 0`）：
代码块 `.md__pre` 与表格 `.md__table-wrap` 各自 `overflow-x: auto`，长 id / 路径 `overflow-wrap: anywhere`。

### mock 演示

`VITE_MOCK=1` 下研究列表右上角有一个 `mock: 正常 / 空态 / 503` 按钮（调 `POST /api/__mock/research`，
真实后端没有这个端点），用来现场演示空态与 `board_unavailable` 提示。

| 想试的东西 | 怎么做 |
|---|---|
| 三条 run / 三层节点 | 进入「研究」→ `r-alpha-2411`（depth 0/1/2，5 个节点） |
| 待审批徽标 | `r-alpha-2411` 的待审批 1；`r-beta-2411` 的待审批 2 |
| 节点树 / limits / 产物 | `r-alpha-2411` 详情页 |
| plan.md / cards / synthesis 多版本 | `r-alpha-2411` → `n-api`（synthesis v1/v2 可切换） |
| 同意并开始成功 | `n-api`（`listening=true`） |
| 同意并开始被 422 | `n-md` 或 `n-beta-a`（`listening=false`，按钮禁用且给出原因） |
| stop / limits 回读 | `r-alpha-2411` 详情页（limits 非法键/非整数/超范围都会 422） |

## M2 进程托管（CONTRACT §3.4）

### 端点对照

| 端点 | 前端位置 |
|---|---|
| `POST /api/runs` | `api.ts:createRun` → `NewRunSheet`（研究列表「新建研究」） |
| `POST /api/runs/{id}/resume` | `api.ts:resumeRun` → `RunDetailView` 的「恢复运行」 |
| `GET /api/runs/{id}/log?lines=300` | `api.ts:getRunLog` → `RunDetailView` 的「查看日志」→ `LogSheet` |
| `POST /api/runs/{id}/stop`（`{force:true}`） | `api.ts:stopRun(runId, force)` → 停止确认层的两个动作 |

### 新建研究（sheet 表单）

- 问题：`textarea`，必填，trim 后 **>= 2 字**（不到就不提交，页面上直接说）。
- 工作区：可选，留空即不带 `workspace`（用服务端默认）。
- 六个整数：留空即不传，对应 CLI 参数如下（验收 3 的对应关系，界面上每个框都标了 flag）：

  | 表单键 | CLI 参数 |
  |---|---|
  | `depth` | `--depth` |
  | `parallel` | `--parallel` |
  | `sister_parallel` | `--sister-parallel` |
  | `followups` | `--followups` |
  | `revisions` | `--revisions` |
  | `max_nodes` | `--max-nodes` |

- 诊断开关 → `diagnostics: true`。
- **两种成功结果分开处理**：
  - `run_id` 非空 → 跳到该 run 详情，并在详情页顶部提示「研究已启动（pid …），看板已写入 run …」；
  - `run_id === null` → 留在列表，提示「已启动，看板还没写进来」并给一个主按钮「刷新看板」+ pid/工作区/日志路径；**不自动轮询**。
- 失败（422）→ 错误提示条里**原样**显示服务端 message（工作区越界 / 问题太短 / 整数越界各有原文）。

### 运行详情的「进程」区块

| `RunDetail.process` | 界面 |
|---|---|
| `null` | 说明「这个运行不是由 WebUI 启动的（外部 CLI 在跑或已结束）」，**不给终止进程的按钮**；看板层面的「仅请求停止」仍可用 |
| 有值 | pid、kind（new/resume）、alive 徽标（存活/已退出）、日志路径、工作区、启动时间、argv 行；按钮：查看日志 / 恢复运行 / 停止运行 |

- **恢复运行**只在 `alive === false` 且 `run.status` ∈ {active, running, waiting_input, stopping} 时可用；禁用时用一句话说明原因（进程还活着 / 状态不需要恢复）。
- **停止运行**走二次确认层，层里两个动作：
  - 「仅请求停止」→ `POST stop`（无 body）；
  - 「请求停止并终止进程」→ `POST stop {force:true}`，展示返回的 `terminated`（pid）。
  - 进程为 null 时确认层只提供「仅请求停止」。
- **日志**：sheet 里等宽显示，`lines=300`，横向/纵向都在框内滚动，带「复制」（`navigator.clipboard`，失败会提示手动选取）。
- **不乐观改本地状态**：stop / resume / limits / 新建成功之后一律重新 `GET /api/runs/{id}` 回读，提示文案里都写明「已回读」。

### mock 演示开关（仅 VITE_MOCK=1）

| 位置 | 开关 | 效果 |
|---|---|---|
| 研究列表 | `mock: 正常 / 空态 / 503` | 列表空态与 `board_unavailable` |
| 运行详情「进程」区块 | `mock: 进程=跟随数据 / alive / dead / null` | 覆盖 `RunDetail.process` 的三种形态 |
| 新建研究 sheet | `mock: run_id null / 有` | 演示「进程已起、看板还没写进来」（之后点「刷新看板」那条 run 会出现） |

| 想试的东西 | 怎么做 |
|---|---|
| 新建成功 → 跳详情 | 研究列表 → 新建研究 → 填问题 → 启动研究 |
| 新建 422 | 问题只填 1 个字；或工作区填 `/etc`；或 `--depth` 填 99 |
| 进程存活 / 已退出 / null | 打开 `r-alpha-2411` 详情，用「进程」区块的 mock 按钮切换 |
| 恢复运行 | `r-beta-2411`（进程已退出、status=active），或把任一 run 切到 `dead` |
| force 停止 | `r-alpha-2411` 详情 → 停止运行 → 「请求停止并终止进程」 |
| 日志 | 任一有进程的 run → 查看日志（300 行，含超长行） |

## M3 来源与引用（CONTRACT §3.5）

### 端点对照

| 端点 | 前端位置 |
|---|---|
| `GET /api/runs/{id}/sources?node=` | `api.ts:getRunSources` → `SourceBrowser`（→ `SourcePanel`） |
| `GET /api/runs/{id}/file?path=&node=` | `api.ts:runFileUrl`（`<embed>` / 新标签）与 `api.ts:fetchRunFileText`（markdown / txt） |

入口：**运行详情页** action row 的「来源」（运行级，不带 node）与**节点详情页** action row 的「来源」（带 node）；
节点页的文件行、合成版本、产物行也都走同一个 sheet。

### 来源面板

每份来源显示：`placed`（文件名在标题，完整路径在行内）、`original`、`sha256` 前 8 位（+ size）、`details`、
`locators`、页码 chips。`exists=false` 的来源整行灰掉（虚线边框），页码 chips 禁用并写明「清单里有、磁盘上没有」。

- 点页码 chip → 打开该文件到那一页（PDF 走 `#page=n`）。
- 没有清单（服务端 404）→ 一个可读的 sheet（不是红条）：说明清单在哪生成 + 「重试 / 关闭」。

### 引用怎么变可点（只解析，不猜）

正文里的引用只在 `Markdown` 拿到 `onCitation` 时才渲染成 `<button class="md__cite">`，规则如下：

| 写法 | 行为 |
|---|---|
| `doc:<id>#p<n>` | 命中某来源的 `locators` **且该文件存在** → 直接打开第 n 页；命中不了 / 文件缺失 → 只打开来源面板并高亮该 locator（**不猜文件**） |
| `p.<n>` / `p<n>` | 只打开来源面板并高亮第 n 页（清单里可能有多份来源，猜错比不跳更糟） |
| `downloads/… nodes/… final/… sources/…` | 直接开文件 sheet（404 → 「这个路径不在产物里（404）」） |

识别是在纯文本 token 上做的（`markdown-parse.ts:findCitations`）：行内代码/代码块里的字符串不会被误判，
`map42`、`top42` 这种词内的 p+数字也不算；URL 不算相对路径。渲染仍是 React 元素，没有 HTML 注入。

### 文件 sheet

| 文件类型 | 呈现 |
|---|---|
| `.pdf` | `<embed type="application/pdf" src="…&path=…#page=n">`（改页码 = 换 key 重挂）+ 工具条：上一页 / 页码输入 / 下一页 / 复制链接 / **在新标签打开** |
| `.md` | 自写 Markdown 渲染器（引用可点） |
| `*-SOURCES.md` | 等宽纯文本 + 「打开来源面板」按钮 |
| 其它文本 | 等宽纯文本 |

- 「在新标签打开」是 iOS Safari 的兜底（iframe/embed 里 PDF 支持差），与 `<embed>` 用同一个 URL。
- 认证提醒：`<embed>` 与新标签**不能带 Bearer 头**，所以 PDF/文件打开依赖 `POST /api/login` 换来的
  `mw_session` cookie（与 SSE 同理）；纯 Bearer 场景请让服务端也接受 cookie。

### mock 演示

| 想看什么 | 怎么做 |
|---|---|
| 来源面板（3 份：PDF 带 42/118 页、txt 无页码、一份 exists=false） | `r-alpha-2411` → 来源（运行级）；或 `n-api` → 来源（节点级） |
| PDF 跳页 | 来源面板点「第 42 页」→ sheet 里 `#page=42`（mock 用一个 128 页的极简 PDF） |
| 引用命中 | 打开 `final/final.md` 里的 `doc:atlas#p42` → 直接跳第 42 页 |
| 引用命中不了 | 同页的 `doc:gone#p7`（文件缺失）与 `doc:unknown#p9`（清单里没有）→ 只高亮面板 |
| 页码引用 | `p.42` → 面板高亮第 42 页；`p.7` → 面板打开但不命中来源 |
| 路径引用 / 404 | `downloads/missing.pdf` → 「这个路径不在产物里」 |
| 没有清单（404 提示） | `r-beta-2411` 或 `n-md` 的来源按钮 |

## M4 打磨与运营

### Service Worker（离线壳，手写，无 workbox）

`public/sw.js` → `/sw.js`（scope `/`），只在**生产构建**里注册（`src/sw.ts` 顶部 `ENABLED = import.meta.env.PROD`，dev 不注册，避免缓存干扰热更新）。

| 请求 | 策略 |
|---|---|
| `/api/**`、`**/file`（含 Range 的 PDF/文件流） | **网络直通，一律不缓存**（`isNetworkOnly()` 命中就直接 `return`，不 `respondWith`） |
| 导航请求（`mode === "navigate"`） | network-first，失败回退缓存的 `index.html`（离线壳） |
| 带 hash 的静态资源 | cache-first，成功后写缓存 |

- `activate` 时删掉名字不匹配的旧 cache 并 `clients.claim()`；想作废缓存改 `sw.js` 里的 `VERSION`。
- 更新提示：`updatefound` → `installed` 且已有 controller 时，顶部出现「有新版本：点此刷新」banner，点击走 `SKIP_WAITING` 消息 + reload。
- 离线：`navigator.onLine === false` 时顶部 warn banner「离线：显示的是缓存壳」，恢复在线自动消失。
- 注意：`sw.js` 只在 `vite build` 的产物里（`dist/sw.js`），`vite dev` 不会注册。

### 导出 / 打印

- `@media print` 规则：隐藏工具栏 / 导航 / 按钮 / chip 行 / 错误条，正文铺满；`.md__cite` 保留可见但去掉边框与手型（打印里不可点）；代码块/日志 `white-space: pre-wrap` 换行；表格加边框并允许换行；链接只留文本（`.md__link-url` 隐藏）。
- 打印头：`.print-header` 屏幕上 `display:none`，打印时显示标题 + 运行 id（`RunDetailView` 是问题 + `run.id` + workspace + status；`FileSheet` 是文件名 + `runId` + path）。
- 两个「导出/打印」按钮：运行详情 action row、文件 sheet 头部。sheet 里点打印会给 `body` 加 `print-sheet`，打印样式只保留 sheet（同屏其它内容 `display:none`），`afterprint` 或 1.5s 兜底后摘掉。

### 审计页 `#/audit`

- 入口在顶部「⋯」菜单（点两下可达：⋯ → 审计日志）。
- `GET /api/audit?limit=200&action=`：列表显示时间（相对 + `title` 绝对值）、`action`、`run_id`、`node_id`/`pid`，其余字段收进 `<details>` 折叠成 JSON。
- action 过滤是一排 chip（已知的 run_start/resume/stop/terminate/limits/tell + 响应里出现过的值），点一下重新拉；空态说明「还没有写操作」并指出这些动作会写 `audit.jsonl`。
- 响应形状没有写进契约，客户端做防御式解析：数组、`{entries}`、`{events}`、`{audit}`、`{items}`、`{lines}` 都认，行内 `at/ts/time/timestamp`、`run_id/runId`、`node_id/nodeId` 也都认。
- mock：种子 5 条（stop/limits/tell/run_start/terminate/resume），并且 mock 处理 stop/limits/tell/run_start/resume 时会**真的往审计里追加**；审计页右上角 `mock: 正常/空态` 可演示空态。

### 待办提醒（不引 Web Push）

- 页面**可见**时每 30s `GET /api/runs`（`document.visibilityState === "visible"` 才拉），切到后台停，回到前台立刻拉一次。
- 计数 = `Σ awaiting_approval` + 状态为失败（`failed/error/canceled`）的运行数：
  - 浏览器标签标题前缀：`(2) MISAKA WebUI`，归零自动还原；
  - 研究 tab 上的小圆点（>9 显示 `9+`）；
  - 若 `Notification.permission === "granted"` 且计数**增加**，发一条本地通知（`tag: misaka-runs`，点击聚焦窗口）——这是页面打开时的提醒，不是服务端推送。
- **不主动弹权限请求**：只有菜单里的「开启提醒」按钮会调 `Notification.requestPermission()`。

## 已知限制（M0–M4 未做）

- **没有 Service Worker**：只提供 manifest + standalone 显示，暂不做离线缓存
  （避免 SW 缓存与静态托管/版本升级互相打架，留到下一里程碑）。
- 未与真后端联调：只按 `CONTRACT.md` §3 / §3.1 的冻结面实现。M0 的真实字段歧义（`cursor` 形状、
  `entries` 是全量还是增量批）由 `merge.ts` 两种解释都兼容；M1 的 `updated_at` 秒/毫秒两种都认
  （`toMillis`），但服务端真实取值未验证。
- **研究面不自动轮询**：状态变化靠页面上的「刷新 / 回读状态」按钮触发，避免后台高频拉看板；
  需要实时化再单独设计。
- 会话列表不做多会话并行流（进入哪个会话就只订阅哪个）。
- 真机未验证：390x844 的视觉回归、软键盘弹出行为、深/浅色截图都还没有真机/浏览器证据。
- **M2 的进程语义只在 mock 里验证过**：真实子进程是否被 `force` 终止、`run_id` 25s 等待窗口、
  `<token 目录>/runs/*.log` 的实际日志格式，都需要连真后端才能确认。
- 新建研究的表单**不做本地 limits 范围校验**（只校验整数）：越界由服务端 422 原样回显，
  避免前端与服务端两套范围定义漂移。
- `POST /api/runs` 最长等 25s：界面上只有「启动中…」的状态，没有进度条，也没有取消按钮。
- **M3 的 PDF 渲染未实测**：`<embed>` 依赖浏览器内建查看器，本会话没有浏览器可用；mock 里用的是
  自造的多页 PDF（`src/mock-pdf.ts`，结构已用 xref 偏移逐项校验），但「真的能看见第 42 页」要在浏览器里确认。
- mock 的 `/file` **不实现 Range（206）**：真实后端要求支持，前端只用它做整文件展示与 `#page` 跳转，不依赖 Range。
- 会话视图（`MessageList`）里的文本**没有**引用跳转：那里没有 run 上下文，硬猜 run 不划算；
  引用可点只在「有 run 的文件 sheet」里生效。
- 来源面板不做搜索/过滤（`details` 原样列出）；来源很多时只靠滚动。
- **SW 的离线行为未在真浏览器验证**：本会话没有可用浏览器，只做了静态检查（`dist/sw.js` 存在、
  `isNetworkOnly()` 覆盖 `/api/` 与 `/file`、注册只在 `PROD` 分支）。离线回退、更新 banner、
  `skipWaiting` 后的 reload 都需要真机确认。
- **打印预览未实测**：`@media print` 与 `print-sheet` 的取舍逻辑是 CSS 级证据，没有导出的 PDF 截图。
- **通知权限流程未实测**：`Notification` 需要安全上下文（https 或 localhost），在纯 http 的内网地址上会失败；
  界面只做「未开启/已拒绝/不支持」三态文案，不探测原因。
- 提醒只统计 `GET /api/runs` 的 `awaiting_approval` 与失败状态；不覆盖「节点级」待审批（`RunDetail.nodes` 才有的信息）。