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

> 注意：`NodeDetail` **替换**了继承来的 `syntheses`（`NodeSummary.syntheses` 是数量，`NodeDetail.syntheses` 是版本列表）。
> TS 里写成 `Omit<NodeSummary, "syntheses"> & { syntheses: Synthesis[] }`；字面交叉类型不可满足。

### 3.2 审批就是对话（M1 的关键约束）

「同意并开始」不是写看板，而是 `POST /api/runs/{id}/tell` 发一句话给该节点的 Last Order，由她调用 `misaka_research_start`。因此：

- 界面上的同意按钮必须有二次确认，并明确告诉用户「将把你的话发给这个节点的 Last Order」；
- 节点不在监听时（`listening:false`）按钮应禁用或点击后原样展示服务端 422 的 message（里面写了谁在听）；
- 发送成功只代表话投递到位，不代表计划已开始；状态要回读 `RunDetail.nodes[].status`。

### 3.3 审计

`stop` / `limits` / `tell` 每次成功都追加一行 JSON 到 token 目录旁的 `audit.jsonl`（`{at, action, run_id, …}`，0600）。

### 3.4 进程托管（M2）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/api/runs` | `{question, workspace?, limits?, diagnostics?}` | `{pid, run_id \| null, workspace, log, argv, workspace_created}`；**工作区不存在时会在白名单内自动创建**（`workspace_created:true`，并记一条 `workspace_create` 审计）；`run_id` 是子进程写进看板后被发现的值，最长等 25s |
| POST | `/api/runs/{id}/resume` | — | `{run_id, pid, kind:"resume", log, alive:true}` |
| GET | `/api/runs/{id}/log?lines=200` | — | `{path, text}`；非本桥接启动的 run → 404 |
| POST | `/api/runs/{id}/stop` | `{force?: bool}` | 看板请求停止；`force:true` 且由本桥接托管时再终止进程，返回 `{…, terminated:{ok,pid}}` |

`RunDetail.process`：`{run_id, pid, argv, workspace, kind, log, started_at, alive} | null`（`null` 表示这个 run 不是本桥接启动的）。

**工作区白名单**：`MISAKA_WEB_WORKSPACE_ROOT`（默认 `~/Documents`，不存在则用 `~`）。绝对路径必须落在其中，否则 422。起**新 run** 时目录不存在会被创建（`--resume` 仍要求它存在）；路径上若是一个文件则 422。
**子进程命令**：默认 `python -m misaka research <问题> [--depth …]`，可用 `MISAKA_WEB_MISAKA_BIN` 指定二进制，或 `MISAKA_WEB_RESEARCH_CMD` 整体覆盖（测试用）。argv 传参，不经 shell。
**日志**：`<token 目录>/runs/*.log`；进程状态记在 `<token 目录>/runs.json`（0600）。
**审计**：`run_start` / `resume` / `stop` / `terminate` 均记入 `audit.jsonl`。


### 3.5 来源与原文（M3）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/runs/{id}/sources?node=<node_id>` | 不带 node 时读 `final/*-SOURCES.md` | `{path, node_id, products:[{path,title,kind}], sources:[Source]}`；没有清单 → 404 |
| GET | `/api/runs/{id}/file?path=<rel>&node=<node_id>` | `path` 相对节点目录（带 node）或运行 workspace | 文件本身，`content-disposition: inline`，**支持 Range（206）**；越界 422，缺失 404 |

```ts
type Source = {
  placed: string;      // sources/xxx.pdf（相对 SOURCES.md 所在目录）
  original: string;    // downloads/xxx.pdf 或 http(s) URL
  sha256: string | null;
  details: string[];   // 清单里的其余说明行
  locators: string[];  // doc:<id>#p<n> 形式的定位符
  pages: number[];     // 从定位符里解析出的页码，升序
  exists: boolean; size: number | null;
};
```

**怎么读引用**：正文里的 `doc:<id>#p42` 与 `p.<n>` 是「这条结论落在哪一页」的锚点。界面应当把它变成一次跳转，而不是假装自己知道语义：

- `doc:<id>#p42` → 若该 locator 出现在某个 source 的 `locators` 里，直接打开该文件第 42 页；匹配不到就打开来源面板并高亮这个 locator（不要猜文件）。
- `p.<n>` → 打开来源面板并高亮第 n 页（清单里可能有多份来源，猜错比不跳更糟）。
- 打开文件：应用内 sheet 用 `<embed type="application/pdf" src="…/file?path=…&node=…">`，并把页码放在 **hash**（`#page=42`）。iOS Safari 对 iframe 内 PDF 支持不佳，所以 sheet 里**必须**同时给「在新标签打开」按钮（同一 URL）。


### 3.6 审计轨迹（M4）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/audit?limit=100&action=` | `limit` 1..1000，`action` 可精确过滤 | `{path, entries:[{at, action, run_id?, node_id?, session_id?, pid?, changes?, question?, workspace?}], total}`，**最新在前** |

`entries` 只包含成功的写操作：`tell` / `stop` / `terminate` / `limits` / `run_start` / `resume`。文件是 `<token 目录>/audit.jsonl`，一行一个 JSON。


### 3.7 配置台（M5：provider/model、密钥、Sisters、项目）

> 这是本项目第一次允许 web **写** `~/.misaka`。每个写端点都必须二次确认 + 审计；密钥写入后**永不回读明文**，只回显 `hint`（前 4 位 + 长度）。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/settings/model` | — | `{global:{provider,model,thinking}, roles:[{role, settings}], providers:[Provider]}`（**不含**模型清单，只给 `model_count`） |
| GET | `/api/settings/models` | `?provider=deepseek` | `{provider, models:[{id,name}]}`；未知 provider → 422 |
| PUT | `/api/settings/model` | `{provider, model, role?}` | `{ok, role, provider, model}`；模型不在目录里 → 422；**`role` 且 provider/model 为空 = 取消该角色的钉死、回到全局**，返回 `{…, follows_global:true}` |
| GET | `/api/settings/keys` | — | `{path, keys:[{name,label,configured,source,hint}]}` |
| PUT | `/api/settings/keys/{name}` | `{value}` | `{ok, name, hint}`；名字不在白名单或值太短 → 422 |
| DELETE | `/api/settings/keys/{name}` | — | `{ok, name}` |
| GET | `/api/sisters` | — | `{sisters:[{id,specialty,model,thinking}]}` |
| POST | `/api/sisters` | `{id, specialty?, model?, thinking?}` | `{ok, id, message}` |
| PATCH | `/api/sisters/{id}` | `{specialty?, model?, thinking?}` | `{ok, id, changed:[...]}`；`model:""` 表示取消钉死、回到全局默认 |
| DELETE | `/api/sisters/{id}` | `{confirm:true}` | `{ok, id, message}`；缺 confirm → 422 `confirmation_required` |
| GET | `/api/projects` | — | `{root, projects:[{name,path,has_project_md,is_git,has_sources,runs}]}` |
| POST | `/api/projects` | `{name, git?}` | `{ok, name, path, actions:[...]}`；重名/非空/非法名字 → 422 |

```ts
type Provider = {
  id: string; name: string;
  configured: boolean; source?: string | null; keyless: boolean;
  model_count: number;      // 模型清单按 provider 懒加载：GET /api/settings/models?provider=
};
type RoleDefault = { role: string; settings: Record<string, unknown> };  // role = "last-order" | "sister:<id>"
type KeyEntry = { name: string; label: string; configured: boolean; source?: string | null; hint: string };
type Sister = { id: string; specialty: string; model: string; thinking: string };
type ProjectEntry = { name: string; path: string; has_project_md: boolean; is_git: boolean; has_sources: boolean; runs: number };
```

**界面要求（M5）**

1. 新入口「设置」`#/settings`，三块：`模型与密钥`、`Sisters`、`项目`。
2. 模型：先展示全局（provider 下拉 → 该 provider 的模型下拉），下面列出每个角色的覆盖（`跟随全局` / 具体 `provider/model`）；保存后**回读** `/api/settings/model`。
3. 密钥：每行 label + 状态（已设置·来源 / 未设置）+ hint；`设置/更换` 打开密码输入 + 二次确认（说明「将写入 ~/.misaka/.env，0600」）；成功后只显示新的 hint，**任何时刻都不显示明文**；`删除` 也要确认。
4. Sisters：卡片（ID、专长、模型/thinking）+ `新建`（ID、专长、可选 provider/model、thinking）+ `编辑`（专长文本域、模型、thinking）+ `删除`（确认层写明「她的卡片与会话会保留」）。
5. 项目：列出工作区根下的目录（名字、git 徽标、PROJECT.md、sources、已有 run 数）+ `新建`（名字 + 是否 git init）；成功后显示路径与 actions，并提示可以到「研究」里起 run。
6. 所有写操作：二次确认 → 提交 → **回读**；服务端 422 的 `message` 原样展示；失败不要乐观更新。
7. mock 覆盖以上全部端点（含 422 与 `confirmation_required`）。
## 4. 上游接缝（只读参考，供实现者对齐语义）

- 控制协议：`misaka/core/session_control.py:1-5,29-46,186-214`（一命令一 ack；`snapshot` 支持 cursor 增量）
- 会话发现：`misaka/core/session_catalog.py`（记录在 `<sessions_root>/.catalog/<sha256>.json`，含 `id`/`control`/`instance`/`role`/`path`）
- 本地 socket：`misaka/utils/local_socket.py`（POSIX AF_UNIX、Windows 命名管道，均以文件路径命名）

## 5. 开发命令（本机 Windows，工具链用 bundled）

```sh
# 用你本机的 node/pnpm（macOS/Linux 装在 PATH 里就不用这两行）
export PATH="/path/to/node/bin:$PATH"
PNPM="/path/to/pnpm/bin/pnpm.mjs"
# 例：DSH 自带工具链在 ~/.dsh/dsh-runtimes/<runtime>/dependencies/{node/bin,pnpm/bin/pnpm.mjs}
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