# CONTRACT (frozen, M0) — misaka-web

> 本文件由 lead 冻结。子任务只读，不改。改动需求走 hand_back。
> 上游 MISAKA checkout 在上一层目录 `../`（`misaka/` 包）。**任何子任务都不得修改上游任何文件。**

## 0. 不可违背的不变量

1. 永不直接读写 `~/.misaka/**` 里的 session 文件；会话交互只走控制 socket（snapshot/input/pause/resume）。
2. 审批 = 向属主会话发一条消息，不是写看板。
3. 上游目录只读；本包只通过进程/协议/sqlite 只读方式与它协作。
4. 服务器不装 node：前端构建产物随包发布，运行时只跑 Python。
5. 控制 socket 在系统临时目录（POSIX 为 `/tmp/misaka-session-*/control.sock`，见上游 `misaka/core/session_catalog.py:107-108`），因此**部署时禁止给服务开 `PrivateTmp=yes`**：私有 /tmp 会让所有会话不可达（症状：全部 `has_control:false`、input 502）。`/api/health` 的 `control_parent` 字段就是为这条准备的。

## 1. 目录与归属

```
misaka-web/
  CONTRACT.md        lead（冻结）
  pyproject.toml     lead
  README.md          lead
  src/misaka_web/    lead（服务器实现）
  tests/             lead
  web/               子任务 A（Vite + React + TS）
  deploy/            子任务 B（systemd / Caddy / install.sh）
  docs/ops.md        子任务 B（运维文档）
```

## 2. 运行时与配置

| 项 | 值 |
|---|---|
| Python 包 | `misaka_web`，console script `misaka-web` |
| 服务器 | FastAPI + uvicorn，默认 `127.0.0.1:8787` |
| 环境变量 | `MISAKA_WEB_HOST`、`MISAKA_WEB_PORT`、`MISAKA_WEB_TOKEN_FILE`（默认 `~/.config/misaka-web/token`）、`MISAKA_WEB_STATIC`（默认包内 `static/`）、`MISAKA_WEB_DEV_ORIGIN`（开发期 CORS） |
| 前端产物 | `web/dist` → 同步到 `src/misaka_web/static/`（`scripts/sync-web.sh`） |
| 认证 | `Authorization: Bearer <token>`，或 `POST /api/login` 换取 HttpOnly + SameSite=Strict cookie `mw_session` |

## 3. HTTP API（M0 冻结面）

所有错误：`{"error":{"code":"...","message":"..."}}` + 恰当状态码。除 `/api/health`、`/api/login` 外全部要求认证（401）。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/health` | — | `{ok, version, misaka_version, board_schema, uptime_s, sessions_root, catalog_present, catalog_records, sessions_live, control_parent}`（新增字段为诊断用，客户端可忽略） |
| POST | `/api/login` | `{token}` | `{ok:true}` + Set-Cookie |
| POST | `/api/logout` | — | `{ok:true}` |
| GET | `/api/me` | — | `{authenticated:true, version}` |
| GET | `/api/sessions` | — | `{sessions:[Session]}` |
| GET | `/api/sessions/{id}` | — | `Snapshot` |
| POST | `/api/sessions/{id}/input` | `{text}` | `{ok:true}`（投递未确认 → 502 + 明确文案，绝不自动重发） |
| POST | `/api/sessions/{id}/pause` | — | `{ok:true, paused:true}` |
| POST | `/api/sessions/{id}/resume` | — | `{ok:true, paused:false}` |
| GET | `/api/sessions/{id}/events?since=<stream_cursor>` | — | SSE（见下） |

```ts
type Session = {
  id: string; role: string; cwd?: string | null;
  state: "live" | "saved"; title?: string | null;
  has_control: boolean; last_activity?: string | null;
};

type Entry = { role: string; content: unknown; ts?: string };  // 原样透传上游会话条目

type Snapshot = {
  id: string; cwd?: string | null; state: "idle" | "working";
  paused: boolean; error?: string | null; workflow?: unknown;
  streaming: Entry | null; entries: Entry[] | null;
  cursor: unknown; stream_cursor: unknown;
};
```

SSE 事件（`text/event-stream`，每条 `event: <name>` + `data: <json>`，25s 心跳 `: ping`）：

| event | data | 说明 |
|---|---|---|
| `snapshot` | `Snapshot` | 连接建立后立刻发一次全量 |
| `delta` | `{state?, entries?, streaming?, cursor?, stream_cursor?}` | 增量；`entries` 出现即表示有新增条目，客户端按 cursor 重同步 |
| `error` | `{code, message}` | 会话失效/属主变更；客户端应停下并提示，不自动重连（除非用户点重试） |


### 3.1 研究运行面（M1）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/runs` | — | `{runs:[RunSummary]}` |
| GET | `/api/runs/{run_id}` | — | `RunDetail` |
| GET | `/api/runs/{run_id}/nodes/{node_id}` | — | `NodeDetail` |
| GET | `/api/runs/{run_id}/nodes/{node_id}/file?name=plan.md` | — | `{name, text}`（相对节点目录；越界 422） |
| POST | `/api/runs/{run_id}/tell` | `{text, node_id?}` | `{ok, node_id, session_id}`；节点没人监听时 422，message 里写明「Listening now: …」 |
| POST | `/api/runs/{run_id}/stop` | — | `{ok, status:"stopping"}` |
| POST | `/api/runs/{run_id}/limits` | `{changes:{sister_parallel?:int, parallel?:int, max_followups?:int, max_revisions?:int}}` | `{ok, before, after}` |

错误码（新增）：`board_unavailable`(503，环境里没装 MISAKA 或还没有看板)、`not_found`(404)、`invalid_request`(422)。

```ts
type RunSummary = {
  id: string; question: string; workspace: string;
  status: string; phase?: string | null;
  stop_requested: boolean; driver_active: boolean;
  node_count: number; awaiting_approval: number;
  created_at: number; updated_at: number; last_error?: string | null;
};

type NodeSummary = {
  id: string; question?: string | null; depth: number; status?: string | null;
  kind?: string | null; session_file?: string | null; listening: boolean;
  last_error?: string | null; created_at?: number | null; syntheses: number;
};

type RunDetail = RunSummary & {
  limits: Record<string, unknown>;
  nodes: NodeSummary[];                       // 按 depth, 开启顺序
  products: {kind: string; title: string; path: string}[];  // 运行级产物（question/survey/draft/final…）
  dissolving: string[];                       // 消解了研究问题的节点 id
};

type NodeDetail = NodeSummary & {
  run_id: string;
  tasks: {id: string; title?: string; status?: string; assignee?: string; kind?: string; round?: number; updated_at?: number}[];
  artifacts: {kind: string; title: string; path: string; created_at: number}[];
  syntheses: {path: string; title: string; created_at: number}[];
  files: {name: string; size: number; mtime: number}[];   // 节点目录下的 .md/.txt，形如 plan.md, cards/c1.md
};
```

### 3.2 审批就是对话（M1 的关键约束）

「同意并开始」不是写看板，而是 `POST /api/runs/{id}/tell` 发一句话给该节点的 Last Order，由她调用 `misaka_research_start`。因此：

- 界面上的同意按钮必须有二次确认，并明确告诉用户「将把你的话发给这个节点的 Last Order」；
- 节点不在监听时（`listening:false`）按钮应禁用或点击后原样展示服务端 422 的 message（里面写了谁在听）；
- 发送成功只代表话投递到位，不代表计划已开始；状态要回读 `RunDetail.nodes[].status`。

### 3.3 审计

`stop` / `limits` / `tell` 每次成功都追加一行 JSON 到 token 目录旁的 `audit.jsonl`（`{at, action, run_id, …}`，0600）。
## 4. 上游接缝（只读参考，供实现者对齐语义）

- 控制协议：`misaka/core/session_control.py:1-5,29-46,186-214`（一命令一 ack；`snapshot` 支持 cursor 增量）
- 会话发现：`misaka/core/session_catalog.py`（记录在 `<sessions_root>/.catalog/<sha256>.json`，含 `id`/`control`/`instance`/`role`/`path`）
- 本地 socket：`misaka/utils/local_socket.py`（POSIX AF_UNIX、Windows 命名管道，均以文件路径命名）

## 5. 开发命令（本机 Windows，工具链用 bundled）

```sh
export PATH="/c/Users/GJMJi/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:$PATH"
PNPM="/c/Users/GJMJi/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs"
cd misaka-web/web && node "$PNPM" install && node "$PNPM" exec vite build   # -> web/dist
cd misaka-web && ../.venv-web/Scripts/python.exe -m pytest -q                  # -> tests/
../.venv-web/Scripts/python.exe -m misaka_web serve --host 127.0.0.1 --port 8787
```

注意：pnpm 会提示 `Ignored build scripts: esbuild`，这是策略提示，vite build 仍可正常完成（已实测）。

## 6. 视觉与可用性基线（子任务 A 的验收前提）

- 移动优先：设计视口 390x844；断点 768 / 1024。
- 点击目标 ≥44px；正文 ≥16px；支持 `env(safe-area-inset-*)`。
- 深色与浅色各一份；跟随 `prefers-color-scheme`，可手动切换。
- 流式文本不抖动（增量追加不重排已渲染内容）；输入框固定底部，键盘弹出不遮挡。
- 断线状态必须显式（顶部 banner + 手动重连按钮）。