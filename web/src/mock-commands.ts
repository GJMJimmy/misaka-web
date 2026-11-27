import { errorResponse, jsonResponse, parseBody } from "./mock-http";
import type { CommandResult } from "./types";

/**
 * VITE_MOCK=1 的斜杠命令假后端（CONTRACT §3.8）。
 *
 * 语义与真实桥接层一致：白名单解析、结构化文本回、不是命令 → 422、白名单外 → 200 + unsupported。
 * 关键约束：这里只解读文本，不碰会话——命令结果永远不会成为一条会话条目。
 */

const RECENT_RUN = "r_20240115_demo";
const RUN_IDS = [RECENT_RUN, "r_20240112_demo"];

const WHITELIST = [
  "/help",
  "/research status",
  "/research status [RUN_ID]",
  "/research stop",
  "/research stop [RUN_ID] --force",
  "/research resume [RUN_ID]",
  "/research limits [RUN_ID]",
  "/research tell [TEXT]",
  "/sister [ID]",
  "/model",
  "/board",
];

/** TUI 有、浏览器没有等价输入循环的命令：回等价路径提示。 */
const ELSEWHERE: Record<string, string> = {
  read: "浏览器里用「研究 → 运行 → 产物」打开文件（GET /api/runs/{run_id}/file）。",
  mcp: "MCP 服务器只能在 TUI 里管理：misaka mcp list。",
  share: "分享不在浏览器侧：用 TUI 的 /share 生成链接。",
  export: "导出请走「研究 → 运行」的产物下载。",
  compact: "上下文压缩由服务端在会话内自动触发，浏览器不给手动入口。",
  skill: "技能清单只在 TUI 的 /skill 里可见。",
  commit: "提交代码请在本机 git 里做，桥接层不代提交。",
  fail: "mock 演示指令已改用双斜杠：输入 //fail（// 会原样发给后端）。",
  offline: "mock 演示指令已改用双斜杠：输入 //offline（// 会原样发给后端）。",
  error: "mock 演示指令已改用双斜杠：输入 //error（// 会原样发给后端）。",
};

function ok(command: string, title: string, body: string[], extra: Partial<CommandResult> = {}): CommandResult {
  return { ok: true, command, title, lines: body, navigate: null, unsupported: false, ...extra };
}

function notOk(
  command: string,
  title: string,
  body: string[],
  extra: Partial<CommandResult> = {},
): CommandResult {
  return { ok: false, command, title, lines: body, navigate: null, unsupported: false, ...extra };
}

function unknown(head: string): CommandResult {
  const hint = ELSEWHERE[head];
  return notOk(
    head,
    hint ? "这条命令不在浏览器桥接的白名单里" : `未知命令 /${head}`,
    [
      hint ?? `/${head} 不是白名单命令，桥接层也不会把它发给模型。`,
      "白名单：/help、/research status|stop|resume|limits|tell、/sister、/model、/board。",
    ],
    { unsupported: true },
  );
}

function researchStatus(runId: string): CommandResult {
  return ok(
    "research status",
    `运行 ${runId}`,
    [
      `run_id：${runId}`,
      "state：running（3/7 节点完成）",
      "node：n4_review · 已运行 12 分 08 秒",
      "limits：max_rounds=3  max_depth=2  breadth=4  budget_tokens=200000",
      "session：s-demo（有控制权）",
    ],
    { navigate: `#/run/${runId}` },
  );
}

function researchLimits(runId: string, patch: string | undefined): CommandResult {
  if (patch === undefined) {
    return ok("research limits", `当前限额 · ${runId}`, [
      "max_rounds：3",
      "max_depth：2",
      "breadth：4",
      "budget_tokens：200000",
      "改限额：/research limits max_rounds=5",
    ]);
  }
  const [key, value] = patch.split("=");
  if (!key || value === undefined || value.trim() === "") {
    return notOk("research limits", "限额没有改动", [
      `要写成 key=value：/research limits max_rounds=5（收到的是「${patch}」）。`,
    ]);
  }
  const name = key.trim();
  const next = value.trim();
  return ok("research limits", `限额已写入 · ${runId}`, [`${name}：3 → ${next}`, "回读一致。"], {
    navigate: `#/run/${runId}`,
    data: { before: { [name]: 3 }, after: { [name]: Number(next) } },
  });
}

function researchSub(sub: string, rest: string[]): CommandResult {
  const runId = rest.find((item) => item.startsWith("r_")) ?? RECENT_RUN;
  const args = rest.filter((item) => !item.startsWith("r_") && item !== "--force");

  switch (sub) {
    case "":
    case "status":
      return researchStatus(runId);
    case "stop": {
      const force = rest.includes("--force");
      return ok(
        "research stop",
        force ? `已强制停止 ${runId}` : `已请求停止 ${runId}`,
        [
          force ? "已向子进程发送终止信号（force）。" : "已发出停止请求，等待当前节点收尾。",
          `run_id：${runId}`,
        ],
        { navigate: `#/run/${runId}` },
      );
    }
    case "resume":
      return ok("research resume", `已恢复 ${runId}`, ["从上一个检查点继续。", `run_id：${runId}`], {
        navigate: `#/run/${runId}`,
      });
    case "limits":
      return researchLimits(runId, args[0]);
    case "tell": {
      const text = args.join(" ").trim();
      if (text === "") {
        return notOk("research tell", "缺少要转述的内容", [
          "用法：/research tell 先看 sources 再写综述",
          "（审批就是对话：这句话会作为一条输入送给节点的 Last Order。）",
        ]);
      }
      return ok(
        "research tell",
        "已转述给节点",
        ["节点：n4_review", `内容：${text}`, "会话：s-demo —— 到会话视图里能看到这条输入。"],
        { navigate: "#/session/s-demo" },
      );
    }
    default:
      return unknown(`research ${sub}`);
  }
}

/** 把一段文本解析成结构化结果；不是命令时返回 422 的 Response。 */
function resolve(raw: string): CommandResult | Response {
  const text = raw.trim();
  if (!text.startsWith("/") || text.startsWith("//")) {
    return errorResponse(
      422,
      "not_a_command",
      "不是命令：文本不是以单个 / 开头，桥接层不解析，请直接当消息发出。",
    );
  }
  const body = text.slice(1).trim();
  if (body === "") {
    return errorResponse(422, "not_a_command", "不是命令：/ 后面还没有命令名（补全面板里选一个）。");
  }

  const [head, ...rest] = body.split(/\s+/);

  switch (head) {
    case "help":
      return ok("help", "浏览器里的斜杠命令", [
        "/research status [RUN_ID]  —— 现状与当前节点",
        "/research stop [RUN_ID] [--force]  —— 停止运行",
        "/research resume [RUN_ID]  —— 从检查点恢复",
        "/research limits [RUN_ID] [key=value]  —— 查看 / 修改限额",
        "/research tell TEXT  —— 给节点的 Last Order 说一句话",
        "/sister ID  —— 查看姐妹的模型与思考档位",
        "/model  —— 当前模型与角色默认",
        "/board  —— 打开研究看板",
        "注意：命令在本地解析，结果不会写进会话、也不会发给模型；// 开头的文本才原样发给模型。",
      ]);
    case "research":
      return researchSub(rest[0] ?? "", rest.slice(1));
    case "sister": {
      const id = rest[0];
      if (!id) {
        return notOk("sister", "缺少姐妹 ID", [
          "用法：/sister reviewer",
          "可用：researcher、reviewer、writer。",
        ]);
      }
      return ok(
        "sister",
        `姐妹 ${id}`,
        [
          `specialty：${id === "reviewer" ? "批判性审阅" : "通用研究"}`,
          `model：${id === "reviewer" ? "deepseek / deepseek-reasoner" : "跟随全局"}`,
          "thinking：high",
        ],
        { navigate: "#/settings" },
      );
    }
    case "model":
      return ok("model", "当前模型", [
        "全局默认：deepseek / deepseek-chat",
        "last-order：跟随全局",
        "reviewer：deepseek / deepseek-reasoner",
      ], { navigate: "#/settings" });
    case "board":
      return ok("board", "研究看板", [`${RUN_IDS.length} 个运行在本地看板里。`], {
        navigate: "#/runs",
      });
    default:
      return unknown(head);
  }
}

export async function handleCommands(
  path: string,
  method: string,
  bodyText: string | null,
): Promise<Response | null> {
  if (path === "/api/commands" && method === "GET") {
    return jsonResponse({ commands: WHITELIST });
  }

  if (path === "/api/command" && method === "POST") {
    const body = parseBody<{ text?: unknown }>(bodyText);
    if (!body || typeof body.text !== "string") {
      return errorResponse(400, "bad_request", "请求体需要 text 字段（字符串）。");
    }
    const result = resolve(body.text);
    return result instanceof Response ? result : jsonResponse(result);
  }

  return null;
}
