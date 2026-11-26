# MISAKA WebUI（web/）

移动优先的 MISAKA WebUI（M0 会话 + M1 研究驾驶舱）：Vite + React 19 + TypeScript，**手写 CSS**
（CSS 变量做主题，无路由库 / 无 Tailwind / 无 UI 组件库 / 无 markdown 依赖）。

产物 `web/dist` 由 Python 服务静态托管（见 `CONTRACT.md` §2），**服务器不装 node**：
构建只发生在开发机。

## 目录

```
web/
  index.html            单页入口（viewport-fit=cover、manifest、theme-color）
  public/               manifest.webmanifest、icon.svg（PWA 安装所需）
  src/
    main.tsx            入口：先落主题；VITE_MOCK=1 时装载 mock 后端
    App.tsx             认证状态机 + 顶层导航（会话 / 研究）+ 极简 hash 路由
    api.ts              所有 M0 + M1 HTTP 端点（Bearer + cookie 双通道）
    stream.ts           EventSource 订阅 SSE（snapshot / delta / error）
    mock.ts             VITE_MOCK=1 的本地后端（替换 fetch + EventSource）
    mock-research.ts    研究面假后端（/api/runs*，三条 run / 三层节点 / plan/cards/synthesis 文本）
    mock-http.ts        mock 共用的 json/error/delay 工具
    merge.ts            delta.entries 合并策略（追加、绝不重排）
    markdown-parse.ts   Markdown 块级 + 行内解析（纯函数、可在 Node 里自检）
    markdown.tsx        Markdown → React 元素（**不用 dangerouslySetInnerHTML**）
    errors.ts           读请求异常归类（503 board_unavailable / 401 / 404 / 422）
    theme.ts / useAppHeight.ts / format.ts
    components/         LoginView / SessionListView / SessionView / MessageList / Composer / Banner / ThemeSwitch
                        Tabs / ResearchListView / RunDetailView / NodeDetailView / StatusChip / ConfirmLayer / FileViewer
                        NewRunSheet（新建研究）/ LogSheet（进程日志）
    styles.css          设计视口 390x844、断点 768/1024、深/浅色、safe-area
```

## 本机工具链（Windows，node 不在 PATH）

```sh
export PATH="/c/Users/GJMJi/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:$PATH"
PNPM="/c/Users/GJMJi/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs"
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

## 已知限制（M0/M1/M2 未做）

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
