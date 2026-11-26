import { delay, errorResponse, jsonResponse, parseBody } from "./mock-http";
import type { KeyEntry, ProjectEntry, Provider, ProviderModel, Sister } from "./types";

/**
 * VITE_MOCK=1 的配置台假后端：覆盖 CONTRACT §3.7 的全部端点。
 * 每个写操作都真的校验（422 / confirmation_required），界面必须能把这些 message 原样显示出来。
 * 状态只在内存里，刷新页面即回到初始值；密钥明文只用于算 hint，从不回给前端。
 */

const ENV_PATH = "~/.misaka/.env";
const WORKSPACE_ROOT = "~/Documents";
const ROLE_LAST_ORDER = "last-order";
const SISTER_PREFIX = "sister:";
const NAME_RE = /^[A-Za-z0-9][\w.-]{0,39}$/;
const PROJECT_NAME_RE = /^[\w.\u4e00-\u9fff-]{1,60}$/;

type RoleSettings = Record<string, unknown>;

/* ------------------------------------------------------------------ 目录 */

const PROVIDERS: Provider[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    configured: true,
    source: "env file",
    keyless: false,
    model_count: 2,
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat" },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    configured: false,
    source: null,
    keyless: false,
    model_count: 2,
    models: [
      { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
      { id: "claude-opus-4", name: "Claude Opus 4" },
    ],
  },
  {
    // 故意不给 models：真实服务端只回 model_count，界面得走 GET /api/settings/models
    id: "ollama",
    name: "本地 Ollama",
    configured: true,
    source: "keyless",
    keyless: true,
    model_count: 2,
  },
  {
    // 已知但一个模型都没有：目录接口回 200 + {provider, models: []}（不是 422）
    id: "bedrock",
    name: "AWS Bedrock",
    configured: false,
    source: null,
    keyless: false,
    model_count: 0,
  },
];

const FALLBACK_MODELS: Record<string, ProviderModel[]> = {
  ollama: [
    { id: "qwen2.5:14b", name: "Qwen2.5 14B" },
    { id: "llama3.1:8b", name: "Llama 3.1 8B" },
  ],
};

function modelsOf(providerId: string): ProviderModel[] {
  const provider = PROVIDERS.find((item) => item.id === providerId);
  if (!provider) return [];
  if (Array.isArray(provider.models) && provider.models.length > 0) return provider.models;
  return FALLBACK_MODELS[providerId] ?? [];
}

/* ------------------------------------------------------------------ 状态 */

const global: { provider: string; model: string; thinking: string } = {
  provider: "deepseek",
  model: "deepseek-reasoner",
  thinking: "high",
};

const roles: Array<{ role: string; settings: RoleSettings }> = [
  { role: ROLE_LAST_ORDER, settings: { defaultProvider: "deepseek", defaultModel: "deepseek-chat", defaultThinkingLevel: "medium" } },
  { role: SISTER_PREFIX + "10032", settings: { defaultProvider: "deepseek", defaultModel: "deepseek-reasoner" } },
  { role: SISTER_PREFIX + "10031", settings: {} },
];

/** 白名单与真实服务端 console.KEY_WHITELIST 同名；hint 形状也照抄 _hint()。 */
let keys: KeyEntry[] = [
  { name: "DEEPSEEK_API_KEY", label: "DeepSeek", configured: true, source: "env file", hint: "sk-d… (35 chars)" },
  { name: "OPENAI_API_KEY", label: "OpenAI", configured: true, source: "shell environment", hint: "" },
  { name: "ANTHROPIC_API_KEY", label: "Anthropic", configured: false, source: null, hint: "" },
  { name: "TAVILY_API_KEY", label: "Tavily (web search)", configured: false, source: null, hint: "" },
  { name: "EXA_API_KEY", label: "Exa (web search)", configured: false, source: null, hint: "" },
];

let sisters: Sister[] = [
  {
    id: "10032",
    specialty: "证据核对：交叉验证来源、页码与引用，宁可说「没找到」也不补全。",
    model: "deepseek/deepseek-reasoner",
    thinking: "high",
  },
  {
    id: "10031",
    specialty: "",
    model: "",
    thinking: "",
  },
];

let projects: ProjectEntry[] = [
  {
    name: "misaka-agent",
    path: WORKSPACE_ROOT + "/misaka-agent",
    has_project_md: true,
    is_git: true,
    has_sources: true,
    runs: 3,
  },
  {
    name: "notes",
    path: WORKSPACE_ROOT + "/notes",
    has_project_md: false,
    is_git: true,
    has_sources: false,
    runs: 0,
  },
];

/* ------------------------------------------------------------------ 小工具 */

/** 与 console.py::_hint 一致的形状：前 4 位 + 长度。明文到此为止。 */
function hintOf(value: string): string {
  return value.slice(0, 4) + "… (" + String(value.length) + " chars)";
}

function fail(message: string, code = "invalid_request"): Response {
  return errorResponse(422, code, message);
}

function roleSettings(role: string): RoleSettings | null {
  return roles.find((item) => item.role === role)?.settings ?? null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/* ------------------------------------------------------------------ 路由 */

export async function handleSettings(
  path: string,
  method: string,
  bodyText: string | null,
  search: URLSearchParams,
): Promise<Response | null> {
  const isSettings = path.startsWith("/api/settings/");
  const isSisters = path === "/api/sisters" || path.startsWith("/api/sisters/");
  const isProjects = path === "/api/projects";
  if (!isSettings && !isSisters && !isProjects) return null;

  await delay(60);

  /* ---------------------------------------------------- 模型 */

  if (path === "/api/settings/model" && method === "GET") {
    return jsonResponse({ global: { ...global }, roles, providers: PROVIDERS });
  }

  if (path === "/api/settings/models" && method === "GET") {
    const providerId = search.get("provider") ?? "";
    const models = modelsOf(providerId);
    if (models.length === 0) return fail("Unknown provider: " + providerId);
    return jsonResponse({ provider: providerId, models });
  }

  if (path === "/api/settings/model" && method === "PUT") {
    const body = parseBody<{ provider?: unknown; model?: unknown; role?: unknown }>(bodyText);
    if (!body) return fail("请求体不是合法 JSON。");
    const provider = (text(body.provider) ?? "").trim();
    const model = (text(body.model) ?? "").trim();
    const role = text(body.role)?.trim() || null;

    if (role !== null && role !== ROLE_LAST_ORDER && !(role.startsWith(SISTER_PREFIX) && NAME_RE.test(role.slice(SISTER_PREFIX.length)))) {
      return fail("Unknown role: " + role);
    }

    if (provider === "" || model === "") {
      // 空 provider/model + 一个角色 = 取消这个角色的覆盖，回到全局（mock 的约定，§3.7 只写了「模型不在目录里 → 422」）
      if (role === null) return fail("Both provider and model are required.");
      const settings = roleSettings(role);
      if (!settings) return fail("Unknown role: " + role);
      delete settings.defaultProvider;
      delete settings.defaultModel;
      return jsonResponse({ ok: true, role, provider: "", model: "" });
    }

    if (!modelsOf(provider).some((item) => item.id === model)) {
      return fail(provider + "/" + model + " is not in this install's model catalog.");
    }

    if (role === null) {
      global.provider = provider;
      global.model = model;
      return jsonResponse({ ok: true, role: "global", provider, model });
    }
    const settings = roleSettings(role);
    if (!settings) return fail("Unknown role: " + role);
    settings.defaultProvider = provider;
    settings.defaultModel = model;
    return jsonResponse({ ok: true, role, provider, model });
  }

  /* ---------------------------------------------------- 密钥 */

  if (path === "/api/settings/keys" && method === "GET") {
    return jsonResponse({ path: ENV_PATH, keys });
  }

  const keyMatch = /^\/api\/settings\/keys\/([^/]+)$/.exec(path);
  if (keyMatch) {
    const name = decodeURIComponent(keyMatch[1]);
    const entry = keys.find((item) => item.name === name);
    if (method === "PUT") {
      if (!entry) return fail(name + " is not a key this console manages.");
      const body = parseBody<{ value?: unknown }>(bodyText);
      if (!body) return fail("请求体不是合法 JSON。");
      const value = (text(body.value) ?? "").trim();
      if (value.length < 8) return fail("That does not look like an API key (shorter than 8 characters).");
      entry.configured = true;
      entry.source = "env file";
      entry.hint = hintOf(value);
      return jsonResponse({ ok: true, name, hint: entry.hint });
    }
    if (method === "DELETE") {
      if (!entry) return fail(name + " is not a key this console manages.");
      entry.configured = false;
      entry.source = null;
      entry.hint = "";
      return jsonResponse({ ok: true, name });
    }
    return null;
  }

  /* ---------------------------------------------------- Sisters */

  if (path === "/api/sisters" && method === "GET") {
    return jsonResponse({ sisters });
  }

  if (path === "/api/sisters" && method === "POST") {
    const body = parseBody<{ id?: unknown; specialty?: unknown; model?: unknown; thinking?: unknown }>(bodyText);
    if (!body) return fail("请求体不是合法 JSON。");
    const id = (text(body.id) ?? "").trim();
    if (!NAME_RE.test(id)) {
      return fail("A Sister id is a short name: letters, digits, dot, dash or underscore.");
    }
    if (sisters.some((item) => item.id === id)) return fail("Sister " + id + " is already registered.");
    const reference = (text(body.model) ?? "").trim();
    sisters = [
      ...sisters,
      {
        id,
        specialty: (text(body.specialty) ?? "").trim(),
        model: reference,
        thinking: (text(body.thinking) ?? "").trim(),
      },
    ].sort((left, right) => left.id.localeCompare(right.id));
    roles.push({
      role: SISTER_PREFIX + id,
      settings: reference === "" ? {} : { defaultProvider: reference.split("/")[0], defaultModel: reference.split("/")[1] },
    });
    return jsonResponse({ ok: true, id, message: "（mock）已为 Sister " + id + " 建好卡片目录。" });
  }

  const sisterMatch = /^\/api\/sisters\/([^/]+)$/.exec(path);
  if (sisterMatch) {
    const sid = decodeURIComponent(sisterMatch[1]);
    const entry = sisters.find((item) => item.id === sid);
    if (!entry) return fail("Sister " + sid + " is not registered.");

    if (method === "PATCH") {
      const body = parseBody<{ specialty?: unknown; model?: unknown; thinking?: unknown }>(bodyText);
      if (!body) return fail("请求体不是合法 JSON。");
      const changed: string[] = [];
      const specialty = text(body.specialty);
      if (specialty !== null) {
        entry.specialty = specialty.trim();
        changed.push("specialty");
      }
      const model = text(body.model);
      if (model !== null) {
        const reference = model.trim();
        if (reference !== "" && !reference.includes("/")) {
          return fail(reference + " is not a provider/model reference.");
        }
        // 空字符串 = 取消钉死，回到全局默认
        entry.model = reference;
        changed.push("model");
        const settings = roleSettings(SISTER_PREFIX + sid);
        if (settings) {
          if (reference === "") {
            delete settings.defaultProvider;
            delete settings.defaultModel;
          } else {
            settings.defaultProvider = reference.split("/")[0];
            settings.defaultModel = reference.split("/")[1] ?? "";
          }
        }
      }
      const thinking = text(body.thinking);
      if (thinking !== null) {
        entry.thinking = thinking.trim();
        changed.push("thinking");
      }
      return jsonResponse({ ok: true, id: sid, changed });
    }

    if (method === "DELETE") {
      const body = parseBody<{ confirm?: unknown }>(bodyText);
      if (body?.confirm !== true) {
        return fail("Removing a Sister needs an explicit confirm.", "confirmation_required");
      }
      sisters = sisters.filter((item) => item.id !== sid);
      const index = roles.findIndex((item) => item.role === SISTER_PREFIX + sid);
      if (index >= 0) roles.splice(index, 1);
      return jsonResponse({
        ok: true,
        id: sid,
        message: "（mock）卡片目录已移除；她已经跑过的会话与看板上的卡片都还在。",
      });
    }
  }

  /* ---------------------------------------------------- 项目 */

  if (path === "/api/projects" && method === "GET") {
    return jsonResponse({ root: WORKSPACE_ROOT, projects });
  }

  if (path === "/api/projects" && method === "POST") {
    const body = parseBody<{ name?: unknown; git?: unknown }>(bodyText);
    if (!body) return fail("请求体不是合法 JSON。");
    const name = (text(body.name) ?? "").trim();
    if (name === "" || !PROJECT_NAME_RE.test(name) || name === "." || name === "..") {
      return fail("A project name is a folder name: letters, digits, CJK, dot, dash or underscore.");
    }
    if (projects.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
      return fail(WORKSPACE_ROOT + "/" + name + " already exists and is not empty.");
    }
    const git = body.git !== false;
    const created: ProjectEntry = {
      name,
      path: WORKSPACE_ROOT + "/" + name,
      has_project_md: true,
      is_git: git,
      has_sources: true,
      runs: 0,
    };
    projects = [...projects, created].sort((left, right) => left.name.localeCompare(right.name));
    return jsonResponse({
      ok: true,
      name,
      path: created.path,
      actions: [
        "created " + created.path,
        "wrote PROJECT.md" + "（draft brief）",
        "created sources/",
        git ? "git init" : "skipped git init",
      ],
    });
  }

  return null;
}
