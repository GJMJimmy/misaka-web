#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# misaka-web 安装 / 升级脚本（M0）
# 幂等：可以反复执行。已存在的 venv、已存在的 token、已安装的包都不会被破坏。
#
# 有意不做的事（不越权、也不替你改系统）：
#   不安装系统包、不修改防火墙、不写 /etc —— systemd 单元与 Caddyfile 只打印安装命令；
#   不打印 token 内容（它等同于这个 WebUI 的全部凭据）。
#
# 用法：
#   ./deploy/install.sh                              装到 <repo>/.venv
#   ./deploy/install.sh --venv /opt/misaka-web/.venv 指定 venv（systemd 的 ExecStart 用这个路径）
#   ./deploy/install.sh --with-misaka                 额外安装上游 misaka[providers]（可选）
# 环境变量：MISAKA_WEB_VENV / MISAKA_WEB_PYTHON / MISAKA_WEB_TOKEN_FILE / XDG_CONFIG_HOME
# 运维文档：docs/ops.md
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${MISAKA_WEB_VENV:-$REPO_ROOT/.venv}"
WITH_MISAKA=0
# 版本区间与 pyproject.toml 的 dev extra 保持一致（那一行是权威定义）
MISAKA_REQ="misaka[providers]>=0.19.30,<0.21"

say()  { echo ""; echo "==> $*"; }
warn() { echo "WARN: $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

usage() {
  cat <<"USAGE"
misaka-web 安装 / 升级（幂等）

用法: install.sh [选项]
  --venv DIR       虚拟环境目录（默认 $MISAKA_WEB_VENV，或 <repo>/.venv）
  --with-misaka    额外安装上游 misaka[providers]（可选；研究机上通常已有）
  -h, --help       显示本帮助
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --venv)        [ "$#" -ge 2 ] || die "--venv 需要一个目录参数"; VENV_DIR="$2"; shift 2 ;;
    --venv=*)      VENV_DIR="${1#--venv=}"; shift ;;
    --with-misaka) WITH_MISAKA=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             usage >&2; die "未知参数: $1" ;;
  esac
done

[ -n "$VENV_DIR" ] || die "venv 目录为空"
[ -f "$REPO_ROOT/pyproject.toml" ] || die "找不到 $REPO_ROOT/pyproject.toml；请从仓库内的 deploy/ 目录执行本脚本"

if [ "$(id -u)" -eq 0 ]; then
  warn "当前以 root 运行：venv 与 token 将属于 root。生产环境请用研究账号执行（例如 sudo -u misaka ...），"
  warn "否则 systemd 以 User= 启动时读不到 token（见 docs/ops.md 故障排查表 401 一行）。"
fi

say "仓库: $REPO_ROOT"
say "虚拟环境: $VENV_DIR"

# --- 1. 前置检查（只检查，绝不安装） --------------------------------------
say "检查 Python >= 3.12"
PYTHON_BIN="${MISAKA_WEB_PYTHON:-}"
if [ -z "$PYTHON_BIN" ]; then
  for cand in python3.12 python3; do
    if command -v "$cand" >/dev/null 2>&1 &&
       "$cand" -c "import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 12) else 1)" 2>/dev/null; then
      PYTHON_BIN="$cand"
      break
    fi
  done
fi
if [ -z "$PYTHON_BIN" ]; then
  echo "没找到 Python >= 3.12（pyproject.toml: requires-python >= 3.12）。" >&2
  echo "本脚本不安装系统包，请自行安装后重跑：" >&2
  echo "  Debian/Ubuntu: sudo apt install python3.12 python3.12-venv" >&2
  echo "  其它发行版:    装好 3.12 后 MISAKA_WEB_PYTHON=/path/to/python3.12 $0" >&2
  exit 1
fi
"$PYTHON_BIN" -c "import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 12) else 1)" || die "$PYTHON_BIN 版本低于 3.12"
"$PYTHON_BIN" -m venv --help >/dev/null 2>&1 || die "$PYTHON_BIN 缺少 venv 模块，请自行安装（Debian/Ubuntu: apt install python3.12-venv）"
echo "    ok: $("$PYTHON_BIN" -c "import sys; print(sys.version.split()[0])") ($PYTHON_BIN)"

say "检查 git（升级流程依赖它拉代码）"
if ! command -v git >/dev/null 2>&1; then
  echo "没找到 git。本脚本不安装系统包，请自行安装（Debian/Ubuntu: sudo apt install git）。" >&2
  exit 1
fi
echo "    ok: $(git --version)"

# --- 2. venv（幂等） ------------------------------------------------------
VENV_PY="$VENV_DIR/bin/python"
VENV_PIP="$VENV_DIR/bin/pip"
if [ -x "$VENV_PY" ]; then
  say "复用已存在的 venv"
else
  say "创建 venv"
  mkdir -p "$(dirname -- "$VENV_DIR")"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi
[ -x "$VENV_PY" ] || die "venv 创建失败：$VENV_PY 不存在"
if ! "$VENV_PY" -c "import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 12) else 1)"; then
  die "已存在的 venv 用的是旧 Python；删掉 $VENV_DIR 后重跑本脚本"
fi

# --- 3. 安装依赖与本包 ----------------------------------------------------
say "升级 pip（幂等，失败不致命）"
"$VENV_PIP" install --upgrade pip || warn "pip 升级失败，继续（离线环境可忽略）"

say "安装依赖 + 本包（$REPO_ROOT）"
"$VENV_PIP" install "$REPO_ROOT"
# 版本号没变时 pip 会认为"已满足"并跳过重建；离线重装包体本身（--no-deps），
# 保证 git pull 之后重新执行本脚本能真正换掉已安装的代码。
"$VENV_PIP" install --force-reinstall --no-deps "$REPO_ROOT"

# --- 4. 可选：上游 misaka[providers] -------------------------------------
if [ "$WITH_MISAKA" -eq 1 ]; then
  say "安装上游 misaka[providers]（可选）"
  if [ -f "$REPO_ROOT/../misaka/pyproject.toml" ]; then
    echo "    发现本地上游 checkout，从它安装: $REPO_ROOT/../misaka"
    "$VENV_PIP" install "$REPO_ROOT/../misaka[providers]"
  else
    echo "    从索引安装: $MISAKA_REQ"
    "$VENV_PIP" install "$MISAKA_REQ"
  fi
fi

# --- 5. token（幂等：已存在则保留） --------------------------------------
if [ -n "${MISAKA_WEB_TOKEN_FILE:-}" ]; then
  TOKEN_FILE="$MISAKA_WEB_TOKEN_FILE"
elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
  TOKEN_FILE="$XDG_CONFIG_HOME/misaka-web/token"
else
  TOKEN_FILE="$HOME/.config/misaka-web/token"
fi
case "$TOKEN_FILE" in
  "~/"*) TOKEN_FILE="$HOME/${TOKEN_FILE#~/}" ;;
esac
TOKEN_DIR="$(dirname -- "$TOKEN_FILE")"

say "token 文件: $TOKEN_FILE"
mkdir -p "$TOKEN_DIR"
chmod 700 "$TOKEN_DIR" 2>/dev/null || warn "无法把 $TOKEN_DIR 设为 700，请手动检查权限"
if [ -s "$TOKEN_FILE" ]; then
  echo "    已存在，保留原值（内容不打印）"
else
  # 显式指定落盘位置，避免 token 落到别处；umask 收在子 shell 里。
  # 输出重定向到 /dev/null：stdout 上的 token 会进 journal / shell history。
  ( umask 077; MISAKA_WEB_TOKEN_FILE="$TOKEN_FILE" "$VENV_DIR/bin/misaka-web" token >/dev/null )
  if [ -s "$TOKEN_FILE" ]; then
    echo "    已生成"
  else
    warn "命令执行成功但 $TOKEN_FILE 不存在；该版本 token 子命令可能写到别处。"
    warn "请用 "$VENV_DIR/bin/misaka-web" token --help 确认，并把文件放到上述路径、权限 600。"
  fi
fi
if [ -s "$TOKEN_FILE" ]; then
  chmod 600 "$TOKEN_FILE" 2>/dev/null || warn "无法把 $TOKEN_FILE 设为 600，请手动检查权限"
fi

# --- 6. 自检 --------------------------------------------------------------
say "自检"
if "$VENV_PY" -c "import misaka_web" >/dev/null 2>&1; then
  echo "    ok: import misaka_web"
else
  warn "import misaka_web 失败。若报缺少 misaka，说明还需要上游包："
  warn "重跑 ./deploy/install.sh --with-misaka，或按 docs/ops.md 的说明处理后端集成。"
fi
if "$VENV_DIR/bin/misaka-web" --help >/dev/null 2>&1; then
  echo "    ok: misaka-web --help"
else
  warn "misaka-web --help 未通过（该版本可能没有 --help）；请人工验证 serve 子命令。"
fi

# --- 7. 需要人工执行的步骤（脚本不改系统） --------------------------------
cat <<EOF

--------------------------------------------------------------------------------
安装完成。以下步骤需要你手动执行（本脚本不碰系统配置、不改防火墙、不装系统包）：

1) systemd 单元
     sudo cp "$REPO_ROOT/deploy/systemd/misaka-web.service" /etc/systemd/system/misaka-web.service
     # 编辑该文件：User= / Group= / HOME / ReadWritePaths= 改成真实运行账号（通常是研究账号）
     #             ExecStart 改成 $VENV_DIR/bin/misaka-web serve
     sudo systemctl daemon-reload
     sudo systemctl enable --now misaka-web
     journalctl -u misaka-web -f

2) TLS 反代（推荐 Caddy）
     sudo cp "$REPO_ROOT/deploy/caddy/Caddyfile.example" /etc/caddy/Caddyfile   # 改成你的域名
     sudo caddy validate --config /etc/caddy/Caddyfile
     sudo systemctl reload caddy

3) 网络边界
     misaka-web 只监听 127.0.0.1:8787，对外只暴露 443。防火墙/安全组请自行按需配置
     （本脚本不修改任何防火墙规则）。

4) 服务器不需要 node
     前端构建产物随包发布，运行时只跑 Python；不要把 Node.js 装到服务器上。

文档: $REPO_ROOT/docs/ops.md
--------------------------------------------------------------------------------
EOF
