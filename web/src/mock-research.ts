import { delay, errorResponse, jsonResponse, parseBody } from "./mock-http";
import { buildPdf } from "./mock-pdf";
import {
  EDITABLE_LIMITS,
  type NodeDetail,
  type NodeSummary,
  type ProcessInfo,
  type RunDetail,
  type RunSummary,
  type Source,
  type SourceList,
} from "./types";

/**
 * VITE_MOCK=1 的研究面假后端：覆盖 CONTRACT §3.1 / §3.2 的全部端点。
 * 两条以上运行、三层节点（depth 0/1/2）、plan.md / cards / synthesis 多版本文本。
 *
 * 演示开关：POST /api/__mock/research {mode:"normal"|"empty"|"board_unavailable"}
 * （只有 mock 模式的研究列表页会调用它，真实后端没有这个端点。）
 */

type MockFile = { name: string; mtime: number; text: string };
type MockSynthesis = { path: string; title: string; created_at: number };
type MockTask = {
  id: string;
  title: string;
  status: string;
  assignee: string;
  kind: string;
  round: number;
  updated_at: number;
};
type MockArtifact = { kind: string; title: string; path: string; created_at: number };
type MockNode = {
  id: string;
  question?: string | null;
  depth: number;
  status: string;
  kind: string;
  session_file: string | null;
  listening: boolean;
  last_error?: string | null;
  created_at: number;
  syntheses: MockSynthesis[];
  tasks: MockTask[];
  artifacts: MockArtifact[];
  files: MockFile[];
};
type MockProcess = {
  pid: number;
  kind: string;
  alive: boolean;
  log: string;
  started_at: number;
  argv: string[];
  workspace: string;
};

type MockRun = {
  id: string;
  question: string;
  workspace: string;
  status: string;
  phase?: string | null;
  stop_requested: boolean;
  driver_active: boolean;
  created_at: number;
  updated_at: number;
  last_error?: string | null;
  limits: Record<string, unknown>;
  nodes: MockNode[];
  products: Array<{ kind: string; title: string; path: string }>;
  dissolving: string[];
  /** CONTRACT §3.4：null/缺省 = 不是本桥接启动的。 */
  process?: MockProcess | null;
  /** CONTRACT §3.9：工作目录已不在磁盘上。 */
  workspace_missing?: boolean;
  /** CONTRACT §3.9：只从本服务的列表里隐藏。 */
  hidden?: boolean;
};

type ListMode = "normal" | "empty" | "board_unavailable";
type ProcessMode = "default" | "alive" | "dead" | "null";

let listMode: ListMode = "normal";
let DATA: MockRun[] | null = null;
/** 演示开关：覆盖所有 RunDetail.process 的 alive / null 形态。 */
let processMode: ProcessMode = "default";
/** 演示开关：新建研究时返回 run_id=null（进程已起、看板还没写进来）。 */
let createRunIdNull = false;
/** 已启动但还没被看板发现的 run：下一次 GET /api/runs 时"追上来"。 */
const PENDING: MockRun[] = [];

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** §3.9 的 include_hidden 查询参数：1 / true / yes 都算打开。 */
const flag = (raw: string | null): boolean => raw === "1" || raw === "true" || raw === "yes";

/* ------------------------------------------------------------------ 文本素材 */

const DOC_PLAN_ROOT = `# 计划：把研究看板搬上手机

## 研究问题
在三层结构（run → node → task）之上做一套**移动优先**的只读驾驶舱，只放开三个写操作：

1. \`stop\`：停止整个运行
2. \`limits\`：调四个并行度整数
3. \`tell\`：把「同意」这句话发给节点的 Last Order

## 工作假设
- 审批不是写看板，而是一句话（CONTRACT §3.2）。
- 前端不引入路由库、不引入 markdown 依赖，全部手写。

> 发送成功只代表话投递到位，不代表计划已开始。

## 拆解

| 子节点 | depth | 负责 |
| --- | --- | --- |
| n-api | 1 | 研究面 API 与错误语义 |
| n-ui | 1 | 卡片与节点树的信息密度 |
| n-md | 2 | Markdown 渲染器（无依赖） |
| n-mob | 2 | 390px 横向溢出与点击目标 |

## 验收片段

~~~sh
curl -s -H "Authorization: Bearer $T" \\
  http://127.0.0.1:8787/api/runs | jq '.runs[0] | {question, awaiting_approval}'
~~~

行内示例：\`EventSource\`、**加粗**、*斜体*、[CONTRACT §3.2](CONTRACT.md)。
`;

const DOC_PLAN_API = `# 计划：研究面 API 的读取语义

## 要读的三层
1. \`GET /api/runs\` —— 卡片需要 problem / status / node_count / awaiting_approval
2. \`GET /api/runs/{id}\` —— 节点按 depth 分组
3. \`GET /api/runs/{id}/nodes/{node}\` —— tasks / files / syntheses

## 错误语义
- 503 \`board_unavailable\`：没装 MISAKA 或没有看板 → 列表页给可读提示，不弹 toast。
- 404 \`not_found\`：运行被清理了 → 详情页给返回列表的入口。
- 422 \`invalid_request\`：tell 的 message 里写着「Listening now: …」，原样展示给用户。

## 待确认
- [ ] \`updated_at\` 是秒还是毫秒？前端两种都认（见 \`toMillis\`）。
- [ ] 合成（synthesis）多版本时，默认展示最后一版还是让用户选？

> 结论倾向：默认最后一版 + 顶部版本切换。

### 表格

| 端点 | 幂等 | 审计 |
| --- | --- | --- |
| stop | 是 | audit.jsonl |
| limits | 是 | audit.jsonl |
| tell | 否 | audit.jsonl |
`;

const DOC_PLAN_UI = `# 计划：信息密度

## 卡片上必须有
- 问题（两行截断）
- 状态、节点数、待审批数（>0 时用醒目徽标）
- 相对时间（\`updated_at\`）

## 节点树
按 \`depth\` 分组，depth 越大缩进越多；每行标出 \`status\` / \`kind\` / \`listening\` / 合成版本数。

## 移动端
- 390px 宽下不允许页面级横向滚动：代码块和表格在各自容器里 \`overflow-x: auto\`。
- 点击目标 ≥ 44px，正文 ≥ 16px。
`;

const DOC_PLAN_MD = `# 计划：Markdown 渲染器

只做块级 + 行内两层，**不许任何 HTML 注入**：

1. 块级：标题、段落、有序/无序列表、引用、代码块、表格、分隔线
2. 行内：\`code\`、**粗体**、*斜体*、~~删除线~~、[链接](url) 按文本显示

~~~tsx
<div className="md__table-wrap">
  <table className="md__table">…</table>
</div>
~~~

不支持的行内嵌套（粗体里再套斜体）原样输出，不猜。
`;

const DOC_CARDS_C1 = `# 卡片 c1：研究面的 503 分支

- **现状**：列表页直接抛红字，看不出是环境问题。
- **期望**：一个可读的说明卡 + 重试按钮，写明「没装 MISAKA 或还没有看板」。

~~~sh
# 复现
curl -s -o /dev/null -w '%{http_code}\\n' -H "Authorization: Bearer $T" http://127.0.0.1:8787/api/runs
# 503
~~~

> 验收：空态与 503 都必须是「可读提示」，不是异常堆栈。
`;

const DOC_CARDS_C2 = `# 卡片 c2：limits 只放四个整数

| 键 | 下限 | 上限 |
| --- | --- | --- |
| sister_parallel | 1 | 8 |
| parallel | 1 | 8 |
| max_followups | 0 | 20 |
| max_revisions | 0 | 10 |

其余键（例如 \`budget_tokens\`）只读展示，不给输入框。
`;

const DOC_SYNTH_V1 = `# 合成 v1：API 面结论（初稿）

## 结论
1. 列表与详情都只读，写操作严格限制为 stop / limits / tell。
2. \`board_unavailable\` 必须在前端有专门的分支，不能落到通用错误。

## 证据
- CONTRACT §3.1 的错误码表
- §3.2「审批就是对话」
`;

const DOC_SYNTH_V2 = `# 合成 v2：API 面结论（修订）

## 相对 v1 的改动
- **新增**：\`tell\` 成功后必须回读 \`RunDetail.nodes[].status\`，因为投递 ≠ 开始。
- **修正**：\`board_unavailable\` 的正文要包含服务端 message（里面有「没装 MISAKA」的原文）。
- **保留**：limits 只允许四个整数键，其余只读。

## 待办
- [x] 503 分支
- [x] 二次确认层
- [ ] 多版本合成的默认选择（默认最后一版）

~~~ts
// 回读，不假设
const run = await getRun(runId);
const node = run.nodes.find((item) => item.id === nodeId);
~~~

*这一版已通过 n-api 的自检。*
`;

const DOC_SURVEY = `# 领域 survey：研究看板的前端形态

## 参考
- 看板式（Kanban）：信息密度高，但移动端横向滚动难受。
- 树状（depth 分组）：贴合 run → node → task 的天然层级，竖向滚动即可。

## 取舍
选**树状 + 详情页**：列表只看 run，节点树留在详情，节点详情再摊开 tasks/files/syntheses。
`;

const DOC_NOTES = `# 节点笔记

- 390x844 设计视口，断点 768 / 1024。
- \`env(safe-area-inset-*)\` 只加在顶栏与底部操作条上。
- 二屏返回沿用 M0 的 hash 路由，不引入路由库。

> 待补：节点树在 depth ≥ 3 时的缩进上限。
`;

/* ------------------------------------------------------------------ 进程（§3.4） */

/** 六个整数键 → 真实 CLI 参数（验收 3 的对应关系）。 */
const CLI_FLAG: Record<string, string> = {
  depth: "--depth",
  parallel: "--parallel",
  sister_parallel: "--sister-parallel",
  followups: "--followups",
  revisions: "--revisions",
  max_nodes: "--max-nodes",
};

const CREATE_LIMIT_RANGES: Record<string, { min: number; max: number }> = {
  depth: { min: 1, max: 5 },
  parallel: { min: 1, max: 8 },
  sister_parallel: { min: 1, max: 8 },
  followups: { min: 0, max: 20 },
  revisions: { min: 0, max: 10 },
  max_nodes: { min: 1, max: 200 },
};

const logPath = (runId: string): string => `~/.config/misaka-web/runs/${runId}.log`;

const defaultArgv = (run: MockRun): string[] => ["python", "-m", "misaka", "research", run.question];

function hashCode(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return hash;
}

function syntheticProcess(run: MockRun, alive: boolean): MockProcess {
  return {
    pid: 45201 + (Math.abs(hashCode(run.id)) % 900),
    kind: "new",
    alive,
    log: logPath(run.id),
    started_at: nowSec() - 600,
    argv: defaultArgv(run),
    workspace: run.workspace,
  };
}

/** 只读映射：按演示开关给出 RunDetail.process（可能 synthesized，不改底层数据）。 */
function describeProcess(run: MockRun): ProcessInfo | null {
  if (processMode === "null") return null;
  const base = run.process ?? null;
  if (!base) {
    return processMode === "alive" || processMode === "dead"
      ? { run_id: run.id, ...syntheticProcess(run, processMode === "alive") }
      : null;
  }
  if (processMode === "alive" || processMode === "dead") {
    return { run_id: run.id, ...base, alive: processMode === "alive" };
  }
  return { run_id: run.id, ...base };
}

/** 真正要动手时（resume / log / stop force）才把 synthesized 的进程落到数据上。 */
function materializeProcess(run: MockRun): MockProcess | null {
  if (processMode === "null") return null;
  if (!run.process && (processMode === "alive" || processMode === "dead")) {
    run.process = syntheticProcess(run, processMode === "alive");
  }
  return run.process ?? null;
}

const padLine = (n: number): string => String(n).padStart(5, "0");

function mockLog(run: MockRun, process: MockProcess, lines: number): string {
  const head = [
    `# misaka research — ${run.id}`,
    `# argv: ${process.argv.join(" ")}`,
    `# workspace: ${process.workspace}`,
    `# pid: ${process.pid}  kind: ${process.kind}  started: ${new Date(process.started_at * 1000).toISOString()}`,
    "",
  ];
  const want = Math.max(lines, head.length);
  const body: string[] = [];
  for (let n = 1; body.length + head.length < want; n += 1) {
    if (n % 37 === 0) {
      body.push(
        `[${padLine(n)}] [plan] 子节点提出新假设：把 since 游标下沉到 bridge，避免两次重连之间丢事件。这一行故意写得很长，用来验证日志区内部横向滚动，而不是让整个页面横向滚动。`,
      );
    } else if (n % 11 === 0) {
      body.push(`[${padLine(n)}] [tool] read_file CONTRACT.md -> ok`);
    } else if (n % 7 === 0) {
      body.push(`[${padLine(n)}] [bridge] ack stop_requested=false alive=true`);
    } else {
      body.push(`[${padLine(n)}] [agent] turn ${Math.ceil(n / 5)} · waiting for driver ack`);
    }
  }
  return [...head, ...body].join("\n");
}

function validateCreateLimits(
  raw: unknown,
): { ok: true; value: Record<string, number> } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "limits 必须是对象。" };
  }
  const value: Record<string, number> = {};
  for (const [key, item] of Object.entries(raw as Record<string, unknown>)) {
    const range = CREATE_LIMIT_RANGES[key];
    if (!range) {
      return {
        ok: false,
        message: `limits 键「${key}」不接受。只允许 depth / parallel / sister_parallel / followups / revisions / max_nodes（对应 --depth / --parallel / --sister-parallel / --followups / --revisions / --max-nodes）。`,
      };
    }
    if (typeof item !== "number" || !Number.isInteger(item)) {
      return { ok: false, message: `limits「${key}」必须是整数（收到 ${JSON.stringify(item)}）。` };
    }
    if (item < range.min || item > range.max) {
      return { ok: false, message: `limits「${key}」必须在 ${range.min}..${range.max} 之间（收到 ${item}）。` };
    }
    value[key] = item;
  }
  return { ok: true, value };
}

/** 工作区白名单（mock 版）：必须绝对路径（或以 ~ 开头），且落在 ~/Documents / ~/projects 之下。 */
function checkWorkspace(raw: string): { ok: true; value: string } | { ok: false; message: string } {
  if (raw === "") return { ok: true, value: "~/Documents" };
  const normalized = raw.replace(/\\/g, "/");
  const absolute = normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
  if (!normalized.startsWith("~") && !absolute) {
    return { ok: false, message: `工作区必须是绝对路径（或以 ~ 开头）：「${raw}」。` };
  }
  const allowed =
    normalized === "~" ||
    /^~\/(Documents|projects)(\/|$)/.test(normalized) ||
    /\/Users\/[^/]+\/(Documents|projects)(\/|$)/.test(normalized);
  if (!allowed) {
    return {
      ok: false,
      message: `工作区越界：${raw} 必须落在 MISAKA_WEB_WORKSPACE_ROOT（mock: ~/Documents、~/projects）之下，且必须已存在。`,
    };
  }
  return { ok: true, value: raw };
}

/* ------------------------------------------------------------------ 数据 */

function file(name: string, text: string, minutesAgo: number): MockFile {
  return { name, text, mtime: nowSec() - minutesAgo * 60 };
}

function tasks(nodeId: string, base: number, status: string): MockTask[] {
  return [
    {
      id: `${nodeId}-t1`,
      title: "读 CONTRACT §3.1 并列出端点",
      status: status === "pending" ? "pending" : "done",
      assignee: "misaka",
      kind: "research",
      round: 1,
      updated_at: nowSec() - base,
    },
    {
      id: `${nodeId}-t2`,
      title: "写 API 客户端与错误分支",
      status: status === "pending" ? "pending" : status === "awaiting_approval" ? "awaiting_approval" : "done",
      assignee: "misaka",
      kind: "code",
      round: 2,
      updated_at: nowSec() - base + 90,
    },
    {
      id: `${nodeId}-t3`,
      title: "移动端 390px 回归",
      status: "pending",
      assignee: "last-order",
      kind: "verify",
      round: 2,
      updated_at: nowSec() - base + 120,
    },
  ];
}

function artifacts(nodeId: string, base: number): MockArtifact[] {
  return [
    {
      kind: "synthesis",
      title: "合成 v1",
      path: `nodes/${nodeId}/synthesis/v1.md`,
      created_at: nowSec() - base,
    },
  ];
}

function node(partial: Partial<MockNode> & { id: string; depth: number }): MockNode {
  return {
    status: "pending",
    kind: partial.depth === 0 ? "root" : partial.depth === 1 ? "child" : "grandchild",
    session_file: null,
    listening: false,
    last_error: null,
    created_at: nowSec() - 3600,
    syntheses: [],
    tasks: [],
    artifacts: [],
    files: [],
    ...partial,
  };
}

function buildRuns(): MockRun[] {
  const t = nowSec();

  const rootPlan = file("plan.md", DOC_PLAN_ROOT, 95);
  const apiPlan = file("plan.md", DOC_PLAN_API, 62);
  const apiCards1 = file("cards/c1.md", DOC_CARDS_C1, 54);
  const apiCards2 = file("cards/c2.md", DOC_CARDS_C2, 51);
  const synV1 = file("synthesis/v1.md", DOC_SYNTH_V1, 40);
  const synV2 = file("synthesis/v2.md", DOC_SYNTH_V2, 18);
  const survey = file("survey.md", DOC_SURVEY, 88);
  const notes = file("notes.md", DOC_NOTES, 130);

  const rootNode = node({
    id: "n-root",
    depth: 0,
    question: "M1 研究驾驶舱要怎么拆？",
    status: "running",
    listening: true,
    session_file: "~/.misaka/sessions/root-7f3a.jsonl",
    syntheses: [{ path: "synthesis/v1.md", title: "根节点合成 v1", created_at: t - 2400 }],
    tasks: tasks("n-root", 200, "running"),
    artifacts: artifacts("n-root", 2400),
    files: [rootPlan, survey, notes],
  });

  const apiNode = node({
    id: "n-api",
    depth: 1,
    question: "研究面 API 的读取与错误语义怎么定？",
    status: "awaiting_approval",
    listening: true,
    session_file: "~/.misaka/sessions/api-3c19.jsonl",
    syntheses: [
      { path: "synthesis/v1.md", title: "API 合成 v1（初稿）", created_at: t - 2400 },
      { path: "synthesis/v2.md", title: "API 合成 v2（修订）", created_at: t - 1080 },
    ],
    tasks: tasks("n-api", 120, "awaiting_approval"),
    artifacts: [
      { kind: "synthesis", title: "API 合成 v2（修订）", path: "nodes/n-api/synthesis/v2.md", created_at: t - 1080 },
      { kind: "card", title: "卡片 c2：limits 只放四个整数", path: "nodes/n-api/cards/c2.md", created_at: t - 3000 },
    ],
    files: [apiPlan, apiCards1, apiCards2, synV1, synV2],
  });

  const uiNode = node({
    id: "n-ui",
    depth: 1,
    question: "卡片与节点树的信息密度怎么排？",
    status: "done",
    listening: false,
    session_file: "~/.misaka/sessions/ui-88b1.jsonl",
    syntheses: [{ path: "synthesis/v1.md", title: "UI 合成 v1", created_at: t - 5200 }],
    tasks: tasks("n-ui", 600, "done"),
    artifacts: artifacts("n-ui", 5200),
    files: [file("plan.md", DOC_PLAN_UI, 140), file("synthesis/v1.md", DOC_SYNTH_V1, 100)],
  });

  const mdNode = node({
    id: "n-md",
    depth: 2,
    question: "无依赖的 Markdown 渲染器要覆盖到什么程度？",
    status: "pending",
    listening: false,
    tasks: [
      {
        id: "n-md-t1",
        title: "实现块级解析（标题/列表/引用/代码块/表格）",
        status: "pending",
        assignee: "misaka",
        kind: "code",
        round: 1,
        updated_at: t - 1500,
      },
    ],
    files: [file("plan.md", DOC_PLAN_MD, 40)],
  });

  const mobNode = node({
    id: "n-mob",
    depth: 2,
    question: "390px 下哪里会横向溢出？",
    status: "done",
    listening: false,
    syntheses: [{ path: "synthesis/v1.md", title: "移动端结论 v1", created_at: t - 900 }],
    tasks: tasks("n-mob", 900, "done"),
    files: [file("plan.md", DOC_PLAN_UI, 70), file("synthesis/v1.md", DOC_SYNTH_V1, 65)],
  });

  const betaRoot = node({
    id: "n-beta-root",
    depth: 0,
    question: "since 游标该由服务端还是客户端持有？",
    status: "running",
    listening: true,
    session_file: "~/.misaka/sessions/cursor-a1f0.jsonl",
    syntheses: [{ path: "synthesis/v1.md", title: "游标结论 v1", created_at: t - 3400 }],
    tasks: tasks("n-beta-root", 3300, "running"),
    files: [file("plan.md", DOC_PLAN_API, 200)],
  });

  const betaA = node({
    id: "n-beta-a",
    depth: 1,
    question: "断线后由谁决定重放范围？",
    status: "awaiting_approval",
    listening: false,
    last_error: "socket closed: /tmp/misaka-session-9f2/control.sock",
    tasks: tasks("n-beta-a", 3500, "awaiting_approval"),
    files: [file("plan.md", DOC_PLAN_MD, 210)],
  });

  const betaB = node({
    id: "n-beta-b",
    depth: 1,
    question: "客户端的 since 传 stream_cursor 还是 cursor？",
    status: "awaiting_approval",
    listening: true,
    session_file: "~/.misaka/sessions/cursor-b7d2.jsonl",
    syntheses: [{ path: "synthesis/v1.md", title: "since 取值结论 v1", created_at: t - 3300 }],
    tasks: tasks("n-beta-b", 3400, "awaiting_approval"),
    files: [file("plan.md", DOC_PLAN_API, 205), file("synthesis/v1.md", DOC_SYNTH_V1, 190)],
  });

  const gammaRoot = node({
    id: "n-gamma-root",
    depth: 0,
    question: "研究产物按 run 还是按 workspace 归档？",
    status: "done",
    listening: false,
    syntheses: [
      { path: "synthesis/v1.md", title: "归档结论 v1", created_at: t - 200000 },
      { path: "synthesis/v2.md", title: "归档结论 v2", created_at: t - 190000 },
    ],
    tasks: tasks("n-gamma-root", 190000, "done"),
    files: [file("plan.md", DOC_PLAN_UI, 200000), file("synthesis/v2.md", DOC_SYNTH_V2, 190000)],
  });

  const gammaA = node({
    id: "n-gamma-a",
    depth: 1,
    question: "跨 workspace 的 run 怎么落盘？",
    status: "done",
    listening: false,
    syntheses: [{ path: "synthesis/v1.md", title: "落盘结论 v1", created_at: t - 195000 }],
    tasks: tasks("n-gamma-a", 195000, "done"),
    files: [file("plan.md", DOC_PLAN_MD, 195000)],
  });

  return [
    {
      id: "r-alpha-2411",
      question: "MISAKA WebUI 的 M1 研究驾驶舱：怎样在不加任何前端依赖的前提下把看板搬上手机？",
      workspace: "~/projects/misaka-web",
      status: "running",
      phase: "research",
      stop_requested: false,
      driver_active: true,
      created_at: t - 5400,
      updated_at: t - 120,
      limits: {
        sister_parallel: 2,
        parallel: 3,
        max_followups: 5,
        max_revisions: 2,
        budget_tokens: 400000,
        wall_clock_minutes: 90,
      },
      nodes: [rootNode, apiNode, uiNode, mdNode, mobNode],
      products: [
        { kind: "question", title: "研究问题", path: "runs/r-alpha-2411/question.md" },
        { kind: "survey", title: "领域 survey", path: "runs/r-alpha-2411/survey.md" },
        { kind: "draft", title: "综合草案", path: "runs/r-alpha-2411/draft.md" },
      ],
      process: {
        pid: 43122,
        kind: "new",
        alive: true,
        log: "~/.config/misaka-web/runs/r-alpha-2411.log",
        started_at: t - 5400,
        argv: ["python", "-m", "misaka", "research", "MISAKA WebUI 的 M1 研究驾驶舱"],
        workspace: "~/projects/misaka-web",
      },
      dissolving: ["n-mob"],
    },
    {
      id: "r-beta-2411",
      question: "会话事件流的断线语义：since 游标该由服务端还是客户端持有？",
      workspace: "~/projects/misaka-web",
      status: "active",
      phase: "plan",
      stop_requested: false,
      driver_active: true,
      created_at: t - 7200,
      updated_at: t - 3600,
      // 演示 §3.9：默认列表看不见它，打开「显示已隐藏」才会以弱化样式出现。
      hidden: true,
      limits: { sister_parallel: 1, parallel: 2, max_followups: 3, max_revisions: 1 },
      nodes: [betaRoot, betaA, betaB],
      process: {
        pid: 54417,
        kind: "resume",
        alive: false,
        log: "~/.config/misaka-web/runs/r-beta-2411.log",
        started_at: t - 7200,
        argv: ["python", "-m", "misaka", "research", "会话事件流的断线语义"],
        workspace: "~/projects/misaka-web",
      },
      products: [{ kind: "question", title: "研究问题", path: "runs/r-beta-2411/question.md" }],
      dissolving: [],
    },
    {
      id: "r-gamma-2410",
      question: "研究产物应该按 run 归档还是按 workspace 归档？",
      workspace: "~/projects/misaka",
      status: "done",
      phase: "final",
      stop_requested: false,
      driver_active: false,
      created_at: t - 205000,
      updated_at: t - 190000,
      // 演示 §3.9：项目文件夹被删掉之后，卡片照样在列表里，但要能看出它已经失效。
      workspace_missing: true,
      limits: { sister_parallel: 2, parallel: 2, max_followups: 2, max_revisions: 1 },
      nodes: [gammaRoot, gammaA],
      products: [
        { kind: "question", title: "研究问题", path: "runs/r-gamma-2410/question.md" },
        { kind: "final", title: "最终产物", path: "runs/r-gamma-2410/final.md" },
      ],
      dissolving: ["n-gamma-root"],
    },
  ];
}

function data(): MockRun[] {
  if (DATA === null) DATA = buildRuns();
  return DATA;
}

/* ------------------------------------------------------------------ 映射 */

const awaiting = (run: MockRun): number => run.nodes.filter((item) => item.status === "awaiting_approval").length;

function toSummary(run: MockRun): RunSummary {
  return {
    id: run.id,
    question: run.question,
    workspace: run.workspace,
    status: run.status,
    phase: run.phase ?? null,
    stop_requested: run.stop_requested,
    driver_active: run.driver_active,
    node_count: run.nodes.length,
    awaiting_approval: awaiting(run),
    created_at: run.created_at,
    updated_at: run.updated_at,
    last_error: run.last_error ?? null,
    workspace_missing: run.workspace_missing === true,
    hidden: run.hidden === true,
  };
}

function toNodeSummary(item: MockNode): NodeSummary {
  return {
    id: item.id,
    question: item.question ?? null,
    depth: item.depth,
    status: item.status,
    kind: item.kind,
    session_file: item.session_file,
    listening: item.listening,
    last_error: item.last_error ?? null,
    created_at: item.created_at,
    syntheses: item.syntheses.length,
  };
}

function toDetail(run: MockRun): RunDetail {
  return {
    ...toSummary(run),
    limits: { ...run.limits },
    nodes: run.nodes.map(toNodeSummary),
    products: run.products.map((item) => ({ ...item })),
    dissolving: [...run.dissolving],
    process: describeProcess(run),
  };
}

function toNodeDetail(run: MockRun, item: MockNode): NodeDetail {
  return {
    ...toNodeSummary(item),
    run_id: run.id,
    tasks: item.tasks.map((task) => ({ ...task })),
    artifacts: item.artifacts.map((artifact) => ({ ...artifact })),
    syntheses: item.syntheses.map((entry) => ({ ...entry })),
    files: item.files.map((entry) => ({ name: entry.name, size: entry.text.length, mtime: entry.mtime })),
  };
}

/* ------------------------------------------------------------------ 校验 */

const LIMIT_RANGES: Record<string, { min: number; max: number }> = {
  sister_parallel: { min: 1, max: 8 },
  parallel: { min: 1, max: 8 },
  max_followups: { min: 0, max: 20 },
  max_revisions: { min: 0, max: 10 },
};

function validateLimits(changes: unknown): { ok: true; value: Record<string, number> } | { ok: false; message: string } {
  if (typeof changes !== "object" || changes === null || Array.isArray(changes)) {
    return { ok: false, message: "changes 必须是对象。" };
  }
  const entries = Object.entries(changes as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, message: "changes 不能为空：至少改一个 limits 键。" };
  const value: Record<string, number> = {};
  for (const [key, raw] of entries) {
    if (!(EDITABLE_LIMITS as readonly string[]).includes(key)) {
      return {
        ok: false,
        message: `limits 键「${key}」不可改。只允许：${EDITABLE_LIMITS.join(" / ")}。`,
      };
    }
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      return { ok: false, message: `limits「${key}」必须是整数（收到 ${JSON.stringify(raw)}）。` };
    }
    const range = LIMIT_RANGES[key];
    if (range && (raw < range.min || raw > range.max)) {
      return { ok: false, message: `limits「${key}」必须在 ${range.min}..${range.max} 之间（收到 ${raw}）。` };
    }
    value[key] = raw;
  }
  return { ok: true, value };
}

function normalizeName(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

/* ------------------------------------------------------------------ 来源与引用（§3.5） */

type MockFileEntry = { mime: string; text?: string; pdfPages?: number };

const NOTES_TEXT = [
  "bridge-notes.txt —— 手动记的桥接笔记（无页码）",
  "",
  "- 断线语义：见 doc:atlas#p118 第 118 页的时序图；p.42 是它的前半段。",
  "- 对照文件：downloads/bridge-notes.txt 与 sources/atlas-of-agentic-research.pdf 都在清单里。",
  "- 故意在清单里找不到的定位符：doc:unknown#p9（点它应该只打开来源面板并高亮，不要猜文件）。",
  "- 故意不在清单里的页码：p.7（点它只打开面板，不猜来源）。",
].join("\n");

const FINAL_MD = [
  "# 最终产物：MISAKA WebUI 研究驾驶舱",
  "",
  "## 结论",
  "1. 审批就是对话（CONTRACT §3.2），界面只负责把话投递到位。",
  "2. 断线语义：since 游标由服务端持有，见 doc:atlas#p118。",
  "3. 移动端 390px 下不允许页面横向滚动。",
  "",
  "## 引用检查表",
  "",
  "| 引用 | 期望行为 |",
  "| --- | --- |",
  "| doc:atlas#p42 | 直接打开 PDF 第 42 页 |",
  "| p.42 | 只打开来源面板并高亮第 42 页 |",
  "| p.7 | 清单里没有这页 → 面板打开但不高亮来源 |",
  "| downloads/missing.pdf | 提示「这个路径不在产物里」 |",
  "",
  "## 原文",
  "- 完整清单：final/sources/bridge-notes.txt",
  "- 正文引用来自 doc:atlas#p42 与 doc:gone#p7（后者磁盘上已缺失）。",
].join("\n");

const DRAFT_MD = [
  "# 综合草案",
  "",
  "草案只说结论与出处，不重复原文：断线重放窗口见 doc:atlas#p42。",
].join("\n");

const QUESTION_MD = [
  "# 研究问题",
  "",
  "MISAKA WebUI 的 M1 研究驾驶舱：怎样在不加任何前端依赖的前提下把看板搬上手机？",
].join("\n");

const RUN_MANIFEST_TEXT = [
  "# SOURCES — r-alpha-2411（等宽纯文本，供人工核对）",
  "",
  "## sources/atlas-of-agentic-research.pdf",
  "original: downloads/atlas-of-agentic-research.pdf",
  "sha256: 9f2c8e1ab7d4c0f3…（前 8 位 9f2c8e1a）",
  "locators: doc:atlas#p42, doc:atlas#p118",
  "pages: 42, 118",
  "size: 4823111",
  "",
  "## sources/bridge-notes.txt",
  "original: downloads/bridge-notes.txt",
  "sha256: 1a77b0c3de52…",
  "pages: —",
  "",
  "## sources/removed-paper.pdf",
  "original: downloads/removed-paper.pdf",
  "sha256: —",
  "note: 清单里有、磁盘上没有（exists=false）",
].join("\n");

const NODE_MANIFEST_TEXT = [
  "# SOURCES — n-api（等宽纯文本）",
  "",
  "## sources/atlas-of-agentic-research.pdf",
  "original: downloads/atlas-of-agentic-research.pdf",
  "locators: doc:atlas#p42, doc:atlas#p118",
  "pages: 42, 118",
  "",
  "## sources/bridge-notes.txt",
  "original: downloads/bridge-notes.txt",
  "pages: —",
  "",
  "## sources/removed-paper.pdf",
  "note: 清单里有、磁盘上没有",
].join("\n");

const NODE_SYNTH_MD = [
  "# API 面结论 v2（带引用）",
  "",
  "## 结论",
  "- 投递 ≠ 开始，成功后要回读 RunDetail.nodes[].status（见 doc:atlas#p42）。",
  "- 列表页的 503 必须有专门分支，不许落到通用红条。",
  "",
  "## 依据",
  "> 摘录自 doc:atlas#p118 第 118 页：客户端只保存 stream_cursor。",
  "",
  "补充：p.42 与 downloads/bridge-notes.txt 也能点开对照。",
  "",
  "## 反引号形式（上游 manifest 的写法，也要可点）",
  "- 可以被点开：`doc:atlas#p118`、`p.42`、`final/sources/bridge-notes.txt`。",
  "- 夹带其它内容的 code span 保持原样：`p.42, 见图`、`doc:atlas#p3 见附表`。",
  "- 普通代码路径不是引用：`src/main.ts`、`npm run build`。",
].join("\n");

const PDF_NAME = "atlas-of-agentic-research.pdf";

const RUN_FILES: Record<string, MockFileEntry> = {
  "final/r-alpha-2411-SOURCES.md": { mime: "text/plain; charset=utf-8", text: RUN_MANIFEST_TEXT },
  "final/final.md": { mime: "text/markdown; charset=utf-8", text: FINAL_MD },
  "final/draft.md": { mime: "text/markdown; charset=utf-8", text: DRAFT_MD },
  "final/question.md": { mime: "text/markdown; charset=utf-8", text: QUESTION_MD },
  [`final/sources/${PDF_NAME}`]: { mime: "application/pdf", pdfPages: 128 },
  "final/sources/bridge-notes.txt": { mime: "text/plain; charset=utf-8", text: NOTES_TEXT },
};

const NODE_FILES: Record<string, Record<string, MockFileEntry>> = {
  "n-api": {
    "synthesis/v2.md": { mime: "text/markdown; charset=utf-8", text: NODE_SYNTH_MD },
    "sources/SOURCES.md": { mime: "text/plain; charset=utf-8", text: NODE_MANIFEST_TEXT },
    [`sources/${PDF_NAME}`]: { mime: "application/pdf", pdfPages: 128 },
    "sources/bridge-notes.txt": { mime: "text/plain; charset=utf-8", text: NOTES_TEXT },
  },
  "n-root": {
    "synthesis/v1.md": { mime: "text/markdown; charset=utf-8", text: FINAL_MD },
  },
};

const ATLAS: Source = {
  placed: "",
  original: "downloads/atlas-of-agentic-research.pdf",
  sha256: "9f2c8e1ab7d4c0f3a5b6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8",
  details: ["PDF · 128 页", "抓取于 2025-11-20"],
  locators: ["doc:atlas#p42", "doc:atlas#p118"],
  pages: [42, 118],
  exists: true,
  size: 4823111,
};

const BRIDGE: Source = {
  placed: "",
  original: "downloads/bridge-notes.txt",
  sha256: "1a77b0c3de5214f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6",
  details: ["UTF-8 笔记 · 无页码", "手工维护"],
  locators: [],
  pages: [],
  exists: true,
  size: 1820,
};

const REMOVED: Source = {
  placed: "",
  original: "downloads/removed-paper.pdf",
  sha256: null,
  details: ["清单里有、磁盘上没有", "抓取时 404"],
  locators: ["doc:gone#p7"],
  pages: [7],
  exists: false,
  size: null,
};

function sourceSet(runId: string, nodeId: string | null): SourceList | null {
  if (runId !== "r-alpha-2411") return null;

  if (nodeId === null) {
    return {
      path: "final/r-alpha-2411-SOURCES.md",
      node_id: null,
      products: [
        { path: "final/question.md", title: "研究问题", kind: "question" },
        { path: "final/draft.md", title: "综合草案", kind: "draft" },
        { path: "final/final.md", title: "最终产物", kind: "final" },
      ],
      sources: [
        { ...ATLAS, placed: `final/sources/${PDF_NAME}` },
        { ...BRIDGE, placed: "final/sources/bridge-notes.txt" },
        { ...REMOVED, placed: "final/sources/removed-paper.pdf" },
      ],
    };
  }

  if (nodeId === "n-api") {
    return {
      path: "sources/SOURCES.md",
      node_id: "n-api",
      products: [
        { path: "synthesis/v2.md", title: "API 合成 v2（修订）", kind: "synthesis" },
        { path: "plan.md", title: "计划", kind: "plan" },
      ],
      sources: [
        { ...ATLAS, placed: `sources/${PDF_NAME}` },
        { ...BRIDGE, placed: "sources/bridge-notes.txt" },
        { ...REMOVED, placed: "sources/removed-paper.pdf" },
      ],
    };
  }

  return null;
}

function fileResponse(entry: MockFileEntry, name: string): Response {
  const filename = name.split("/").pop() ?? name;
  if (entry.mime === "application/pdf") {
    const bytes = buildPdf(entry.pdfPages ?? 1);
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "no-store",
        "Accept-Ranges": "none",
      },
    });
  }
  return new Response(entry.text ?? "", {
    status: 200,
    headers: {
      "Content-Type": entry.mime,
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

/* ------------------------------------------------------------------ 审计（§3.3 的 mock） */

type MockAudit = Record<string, unknown>;

let auditMode: "normal" | "empty" = "normal";

const AUDIT: MockAudit[] = [
  {
    at: new Date(Date.now() - 4 * 60_000).toISOString(),
    action: "tell",
    run_id: "r-alpha-2411",
    node_id: "n-api",
    text: "同意，按这份计划开始。",
  },
  {
    at: new Date(Date.now() - 26 * 60_000).toISOString(),
    action: "limits",
    run_id: "r-alpha-2411",
    changes: { sister_parallel: 2 },
    before: { sister_parallel: 1, parallel: 3 },
  },
  {
    at: new Date(Date.now() - 95 * 60_000).toISOString(),
    action: "run_start",
    run_id: "r-alpha-2411",
    pid: 43122,
    workspace: "~/projects/misaka-web",
    argv: ["python", "-m", "misaka", "research", "MISAKA WebUI 的 M1 研究驾驶舱"],
  },
  {
    at: new Date(Date.now() - 120 * 60_000).toISOString(),
    action: "terminate",
    run_id: "r-beta-2411",
    pid: 54417,
    ok: true,
  },
  {
    at: new Date(Date.now() - 190 * 60_000).toISOString(),
    action: "resume",
    run_id: "r-beta-2411",
    pid: 54418,
  },
];

function pushAudit(entry: MockAudit): void {
  AUDIT.unshift({ at: new Date().toISOString(), ...entry });
}

/* ------------------------------------------------------------------ 路由 */

export async function handleResearch(
  path: string,
  method: string,
  bodyText: string | null,
  search: URLSearchParams,
): Promise<Response | null> {
  if (path === "/api/__mock/research" && method === "POST") {
    const body = parseBody<{
      mode?: unknown;
      process?: unknown;
      createRunIdNull?: unknown;
      audit?: unknown;
    }>(bodyText);
    if (typeof body?.mode === "string") {
      listMode = body.mode === "empty" || body.mode === "board_unavailable" ? body.mode : "normal";
    }
    if (typeof body?.process === "string") {
      processMode =
        body.process === "alive" || body.process === "dead" || body.process === "null" ? body.process : "default";
    }
    if (typeof body?.createRunIdNull === "boolean") createRunIdNull = body.createRunIdNull;
    if (body?.audit === "empty" || body?.audit === "normal") auditMode = body.audit;
    return jsonResponse({ ok: true, mode: listMode, process: processMode, createRunIdNull, audit: auditMode });
  }

  if (path === "/api/audit" && method === "GET") {
    await delay(70);
    if (auditMode === "empty") return jsonResponse({ entries: [] });
    const limitRaw = Number.parseInt(search.get("limit") ?? "200", 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 1000)) : 200;
    const action = search.get("action") ?? "";
    const rows = action === "" ? AUDIT : AUDIT.filter((item) => item.action === action);
    return jsonResponse({ entries: rows.slice(0, limit) });
  }

  if (!path.startsWith("/api/runs")) return null;
  await delay(80);

  if (path === "/api/runs" && method === "POST") {
    const body = parseBody<{
      question?: unknown;
      workspace?: unknown;
      limits?: unknown;
      diagnostics?: unknown;
    }>(bodyText);

    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (question.length < 2) {
      return errorResponse(422, "invalid_request", `问题太短：至少要 2 个字（收到「${question}」）。`);
    }

    const workspaceRaw = typeof body?.workspace === "string" ? body.workspace.trim() : "";
    const workspaceCheck = checkWorkspace(workspaceRaw);
    if (!workspaceCheck.ok) return errorResponse(422, "invalid_request", workspaceCheck.message);
    const workspace = workspaceCheck.value;

    const limitsCheck = validateCreateLimits(body?.limits);
    if (!limitsCheck.ok) return errorResponse(422, "invalid_request", limitsCheck.message);

    const diagnostics = body?.diagnostics === true;
    const id = `r-new-${Math.floor(Math.random() * 9000 + 1000)}`;
    const pid = 40000 + Math.floor(Math.random() * 20000);
    const argv = [
      "python",
      "-m",
      "misaka",
      "research",
      question,
      ...Object.entries(limitsCheck.value).flatMap(([key, value]) => [CLI_FLAG[key] ?? `--${key}`, String(value)]),
      ...(diagnostics ? ["--diagnostics"] : []),
    ];

    const created: MockRun = {
      id,
      question,
      workspace,
      status: "active",
      phase: "starting",
      stop_requested: false,
      driver_active: true,
      created_at: nowSec(),
      updated_at: nowSec(),
      limits: { ...limitsCheck.value },
      nodes: [
        node({
          id: "n-root",
          depth: 0,
          question,
          status: "running",
          listening: true,
          session_file: `~/.misaka/sessions/${id}-root.jsonl`,
          files: [file("plan.md", `# 计划（mock 新启动）\n\n## 问题\n${question}\n\n## 下一步\n1. 读 CONTRACT §3.4\n2. 起子节点\n`, 0)],
        }),
      ],
      products: [{ kind: "question", title: "研究问题", path: `runs/${id}/question.md` }],
      dissolving: [],
      process: {
        pid,
        kind: "new",
        alive: true,
        log: logPath(id),
        started_at: nowSec(),
        argv,
        workspace,
      },
    };

    if (createRunIdNull) {
      // 进程已起、看板还没写进来：先压着，下一次 GET /api/runs 再"追上来"。
      PENDING.push(created);
      pushAudit({ action: "run_start", run_id: null, pid, workspace, argv, pending: true });
      return jsonResponse({ pid, run_id: null, workspace, log: logPath(id), argv });
    }

    data().push(created);
    pushAudit({ action: "run_start", run_id: id, pid, workspace, argv });
    return jsonResponse({ pid, run_id: id, workspace, log: logPath(id), argv });
  }

  if (path === "/api/runs" && method === "GET") {
    if (listMode === "board_unavailable") {
      return errorResponse(
        503,
        "board_unavailable",
        "研究看板不可用：没有找到 MISAKA 看板（board.db）。请确认 MISAKA 已安装，并至少创建过一次看板。",
      );
    }
    if (listMode === "empty") return jsonResponse({ runs: [] });
    if (PENDING.length > 0) {
      const store = data();
      for (const item of PENDING.splice(0)) store.push(item);
    }
    const includeHidden = flag(search.get("include_hidden"));
    const rows = includeHidden ? data() : data().filter((item) => item.hidden !== true);
    return jsonResponse({ runs: rows.map(toSummary) });
  }

  // §3.9：隐藏 / 恢复 / 一键隐藏失效项。都是「只动本服务的列表」，run 本身原样留着。
  if (path === "/api/runs/hide-stale" && method === "POST") {
    const stale = data().filter((item) => item.workspace_missing === true && item.hidden !== true);
    for (const item of stale) {
      item.hidden = true;
      pushAudit({ action: "run_hide", run_id: item.id, stale: true });
    }
    const hidden = data().filter((item) => item.hidden === true).length;
    return jsonResponse({ ok: true, added: stale.length, hidden });
  }

  const hideMatch = /^\/api\/runs\/([^/]+)\/hide$/.exec(path);
  if (hideMatch && (method === "POST" || method === "DELETE")) {
    const runId = decodeURIComponent(hideMatch[1]);
    const run = data().find((item) => item.id === runId);
    if (!run) return errorResponse(404, "not_found", `运行不存在：${runId}`);
    run.hidden = method === "POST";
    pushAudit({ action: method === "POST" ? "run_hide" : "run_unhide", run_id: run.id });
    return jsonResponse({ ok: true, id: run.id, hidden: run.hidden });
  }

  const sourcesMatch = /^\/api\/runs\/([^/]+)\/sources$/.exec(path);
  if (sourcesMatch && method === "GET") {
    const runId = decodeURIComponent(sourcesMatch[1]);
    const run = data().find((item) => item.id === runId);
    if (!run) return errorResponse(404, "not_found", `运行不存在：${runId}`);
    const nodeId = search.get("node");
    const list = sourceSet(runId, nodeId);
    if (!list) {
      return errorResponse(
        404,
        "not_found",
        nodeId
          ? `没有来源清单：节点 ${nodeId} 的 sources/SOURCES.md 还没生成。`
          : "没有来源清单：final/*-SOURCES.md 还没生成（研究还没跑完）。",
      );
    }
    return jsonResponse(list);
  }

  const runFileMatch = /^\/api\/runs\/([^/]+)\/file$/.exec(path);
  if (runFileMatch && method === "GET") {
    const runId = decodeURIComponent(runFileMatch[1]);
    const run = data().find((item) => item.id === runId);
    if (!run) return errorResponse(404, "not_found", `运行不存在：${runId}`);
    const nodeId = search.get("node");
    const rawPath = search.get("path") ?? "";
    const name = normalizeName(rawPath);
    if (name === "" || name.startsWith("/") || name.includes("..")) {
      return errorResponse(
        422,
        "invalid_request",
        `路径越界：path 必须相对节点目录（带 node）或运行 workspace（收到「${rawPath}」）。`,
      );
    }
    const entry = nodeId ? NODE_FILES[nodeId]?.[name] : RUN_FILES[name];
    if (entry) return fileResponse(entry, name);
    if (nodeId) {
      const target = run.nodes.find((item) => item.id === nodeId);
      const existing = target?.files.find((file) => file.name === name);
      if (existing) {
        return fileResponse({ mime: "text/markdown; charset=utf-8", text: existing.text }, name);
      }
    }
    return errorResponse(
      404,
      "not_found",
      `这个路径不在产物里：${nodeId ?? "run"}/${name}`,
    );
  }

  const fileMatch = /^\/api\/runs\/([^/]+)\/nodes\/([^/]+)\/file$/.exec(path);
  if (fileMatch) {
    const run = data().find((item) => item.id === decodeURIComponent(fileMatch[1]));
    if (!run) return errorResponse(404, "not_found", `运行不存在：${fileMatch[1]}`);
    const target = run.nodes.find((item) => item.id === decodeURIComponent(fileMatch[2]));
    if (!target) return errorResponse(404, "not_found", `节点不存在：${fileMatch[2]}`);
    const rawName = search.get("name") ?? "";
    const name = normalizeName(rawName);
    if (name === "" || name.startsWith("/") || name.includes("..")) {
      return errorResponse(
        422,
        "invalid_request",
        `路径越界：name 只能指向节点目录内的 .md/.txt（收到「${rawName}」）。`,
      );
    }
    const found = target.files.find((entry) => entry.name === name);
    if (!found) {
      const available = target.files.map((entry) => entry.name).join(", ") || "（无）";
      return errorResponse(404, "not_found", `节点 ${target.id} 里没有「${name}」。可用文件：${available}`);
    }
    return jsonResponse({ name: found.name, text: found.text });
  }

  const nodeMatch = /^\/api\/runs\/([^/]+)\/nodes\/([^/]+)$/.exec(path);
  if (nodeMatch && method === "GET") {
    const run = data().find((item) => item.id === decodeURIComponent(nodeMatch[1]));
    if (!run) return errorResponse(404, "not_found", `运行不存在：${nodeMatch[1]}`);
    const target = run.nodes.find((item) => item.id === decodeURIComponent(nodeMatch[2]));
    if (!target) return errorResponse(404, "not_found", `节点不存在：${nodeMatch[2]}`);
    return jsonResponse(toNodeDetail(run, target));
  }

  const actionMatch = /^\/api\/runs\/([^/]+)\/(stop|limits|tell)$/.exec(path);
  if (actionMatch && method === "POST") {
    const run = data().find((item) => item.id === decodeURIComponent(actionMatch[1]));
    if (!run) return errorResponse(404, "not_found", `运行不存在：${actionMatch[1]}`);
    const action = actionMatch[2];

    if (action === "stop") {
      const body = parseBody<{ force?: unknown }>(bodyText);
      const force = body?.force === true;
      run.stop_requested = true;
      run.status = "stopping";
      run.updated_at = nowSec();
      let terminated: { ok: boolean; pid: number } | null = null;
      const managed = materializeProcess(run);
      if (force && managed) {
        run.process = { ...managed, alive: false };
        terminated = { ok: true, pid: managed.pid };
      }
      pushAudit({ action: "stop", run_id: run.id, force });
      if (terminated) pushAudit({ action: "terminate", run_id: run.id, pid: terminated.pid, ok: terminated.ok });
      return jsonResponse({ ok: true, status: "stopping", terminated });
    }

    if (action === "limits") {
      const body = parseBody<{ changes?: unknown }>(bodyText);
      const checked = validateLimits(body?.changes);
      if (!checked.ok) return errorResponse(422, "invalid_request", checked.message);
      const before = { ...run.limits };
      run.limits = { ...run.limits, ...checked.value };
      run.updated_at = nowSec();
      pushAudit({ action: "limits", run_id: run.id, changes: checked.value, before });
      return jsonResponse({ ok: true, before, after: { ...run.limits } });
    }

    const body = parseBody<{ text?: unknown; node_id?: unknown }>(bodyText);
    const text = typeof body?.text === "string" ? body.text : "";
    if (text.trim() === "") return errorResponse(422, "invalid_request", "text 不能为空。");
    const wantedId = typeof body?.node_id === "string" ? body.node_id : null;
    const target = wantedId ? run.nodes.find((item) => item.id === wantedId) : run.nodes[0];
    if (!target) return errorResponse(404, "not_found", `节点不存在：${wantedId ?? "(root)"}`);
    if (!target.listening) {
      const listeners = run.nodes
        .filter((item) => item.listening)
        .map((item) => `${item.id} (session ${(item.session_file ?? "unknown").split("/").pop()})`)
        .join(", ");
      return errorResponse(
        422,
        "invalid_request",
        `节点 ${target.id} 当前没有监听者，话没有投递。Listening now: ${listeners || "（无人监听）"}。`,
      );
    }
    target.tasks = target.tasks.map((task) =>
      task.status === "awaiting_approval" ? { ...task, status: "running", updated_at: nowSec() } : task,
    );
    run.updated_at = nowSec();
    pushAudit({ action: "tell", run_id: run.id, node_id: target.id, text: text.slice(0, 120) });
    return jsonResponse({
      ok: true,
      node_id: target.id,
      session_id: `(mock) ${(target.session_file ?? "session").split("/").pop() ?? "session"}`,
    });
  }

  const resumeMatch = /^\/api\/runs\/([^/]+)\/resume$/.exec(path);
  if (resumeMatch && method === "POST") {
    const run = data().find((item) => item.id === decodeURIComponent(resumeMatch[1]));
    if (!run) return errorResponse(404, "not_found", `运行不存在：${resumeMatch[1]}`);
    const managed = materializeProcess(run);
    if (!managed) {
      return errorResponse(404, "not_found", "这个运行不是由 WebUI 启动的，没有可恢复的进程。");
    }
    const pid = managed.pid + 1;
    run.process = { ...managed, pid, kind: "resume", alive: true, started_at: nowSec() };
    run.status = "active";
    run.updated_at = nowSec();
    pushAudit({ action: "resume", run_id: run.id, pid, kind: "resume" });
    return jsonResponse({ run_id: run.id, pid, kind: "resume", log: run.process.log, alive: true });
  }

  const logMatch = /^\/api\/runs\/([^/]+)\/log$/.exec(path);
  if (logMatch && method === "GET") {
    const run = data().find((item) => item.id === decodeURIComponent(logMatch[1]));
    if (!run) return errorResponse(404, "not_found", `运行不存在：${logMatch[1]}`);
    const managed = materializeProcess(run);
    if (!managed) {
      return errorResponse(404, "not_found", "这个运行不是由 WebUI 启动的，没有日志可读。");
    }
    const rawLines = Number.parseInt(search.get("lines") ?? "200", 10);
    const lines = Number.isFinite(rawLines) ? Math.max(1, Math.min(rawLines, 2000)) : 200;
    return jsonResponse({ path: managed.log, text: mockLog(run, managed, lines) });
  }

  const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path);
  if (runMatch && method === "GET") {
    const run = data().find((item) => item.id === decodeURIComponent(runMatch[1]));
    if (!run) return errorResponse(404, "not_found", `运行不存在：${runMatch[1]}`);
    return jsonResponse(toDetail(run));
  }

  return errorResponse(404, "not_found", `（mock）未实现 ${method} ${path}`);
}
