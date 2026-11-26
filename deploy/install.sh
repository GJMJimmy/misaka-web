#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# misaka-web 安装器：venv → 依赖 → token → 自检（可选：systemd / Caddy 片段）
#
# 幂等：可以反复执行。已存在的 venv、已存在的 token 都不会被破坏。
# 不安装系统包、不改防火墙、不写 /etc（除非你显式传 --systemd）。
#
# 用法：
#   ./deploy/install.sh                          # 装到 <repo>/.venv，交互填 token
#   ./deploy/install.sh --with-misaka            # 同时装上游 misaka（研究面需要）
#   ./deploy/install.sh --token-stdin            # 从 stdin 读 token：printf %s "$T" | ./deploy/install.sh --token-stdin
#   ./deploy/install.sh --generate --yes         # 生成新 token 并直接打印一次
#   ./deploy/install.sh --systemd                # 生成并启用 systemd 单元（需要 root）
#   ./deploy/install.sh --print-caddy --lan      # 打印内网 Caddy 片段（tls internal）
#
# 运维文档：docs/ops.md
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${MISAKA_WEB_VENV:-$REPO_ROOT/.venv}"
WITH_MISAKA=0
TOKEN_VALUE=""
TOKEN_FROM_STDIN=0
FORCE_GENERATE=0
INSTALL_SYSTEMD=0
PRINT_CADDY=0
LAN_MODE=0
DRY_RUN=0
ASSUME_YES=0
# id 在精简环境里可能不存在；whoami 更常见，最后兜底 root（只有 --systemd 会用到这个值）
RUN_USER="${SUDO_USER:-${USER:-${LOGNAME:-$(whoami 2>/dev/null || echo root)}}}"
HOST="127.0.0.1"
PORT="8787"

say()  { printf "\n==> %s\n" "$*"; }
warn() { printf "WARN: %s\n" "$*" >&2; }
die()  { printf "ERROR: %s\n" "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" -eq 1 ]; then printf "    [dry-run] %s\n" "$*"; else "$@"; fi; }

usage() {
  cat <<'USAGE'
misaka-web 安装器：venv -> 依赖 -> token -> 自检（可选：systemd / Caddy 片段）

用法: ./deploy/install.sh [选项]

安装位置
  --venv DIR         虚拟环境目录（默认 <repo>/.venv；也可用 MISAKA_WEB_VENV）
  --with-misaka      同时安装上游 misaka[providers]（研究 / 来源 / 起 run 需要；优先用本地 ../misaka）

token
  --token VALUE      直接指定 token（会留在 shell 历史里，谨慎使用）
  --token-stdin      从 stdin 读一行：printf %s "$T" | ./deploy/install.sh --token-stdin
  --generate         生成一个新 token（替换已有的），并只打印这一次
  不带以上参数时：已有 token 就保留；交互终端里会提示粘贴，直接回车＝自动生成

监听与服务
  --host ADDR        绑定地址（默认 127.0.0.1）
  --port PORT        端口（默认 8787）
  --lan              等价于 --host 0.0.0.0，并打印安全上下文方面的代价
  --systemd          生成 /etc/systemd/system/misaka-web.service 并启用（需要 root）
  --user NAME        --systemd 时单元里用的账号（默认 SUDO_USER 或当前用户）
  --print-caddy      打印 Caddy 反代片段（配合 --lan 给 tls internal 的内网版）

其它
  -y, --yes          不交互（配合 --generate 实现无人值守）
  --dry-run          只打印将执行的命令，不创建任何东西
  -h, --help         显示本帮助

环境变量
  MISAKA_WEB_VENV / MISAKA_WEB_PYTHON / MISAKA_WEB_TOKEN_FILE / XDG_CONFIG_HOME
  运行期（不是安装期）另有 MISAKA_WEB_MISAKA_BIN，用来指定上游 misaka 可执行文件。

运维文档: docs/ops.md
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --venv)        [ "$#" -ge 2 ] || die "--venv 需要一个目录"; VENV_DIR="$2"; shift 2 ;;
    --venv=*)      VENV_DIR="${1#--venv=}"; shift ;;
    --with-misaka) WITH_MISAKA=1; shift ;;
    --token)       [ "$#" -ge 2 ] || die "--token 需要一个值"; TOKEN_VALUE="$2"; shift 2 ;;
    --token=*)     TOKEN_VALUE="${1#--token=}"; shift ;;
    --token-stdin) TOKEN_FROM_STDIN=1; shift ;;
    --generate)    FORCE_GENERATE=1; shift ;;
    --systemd)     INSTALL_SYSTEMD=1; shift ;;
    --print-caddy) PRINT_CADDY=1; shift ;;
    --lan)         LAN_MODE=1; HOST="0.0.0.0"; shift ;;
    --host)        [ "$#" -ge 2 ] || die "--host 需要一个地址"; HOST="$2"; shift 2 ;;
    --port)        [ "$#" -ge 2 ] || die "--port 需要一个端口"; PORT="$2"; shift 2 ;;
    --user)        [ "$#" -ge 2 ] || die "--user 需要一个账号"; RUN_USER="$2"; shift 2 ;;
    --yes|-y)      ASSUME_YES=1; shift ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             usage >&2; die "未知参数: $1" ;;
  esac
done

[ -f "$REPO_ROOT/pyproject.toml" ] || die "找不到 $REPO_ROOT/pyproject.toml"

# --- 0. 目标路径 -----------------------------------------------------------
if [ -n "${MISAKA_WEB_TOKEN_FILE:-}" ]; then
  TOKEN_FILE="$MISAKA_WEB_TOKEN_FILE"
elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
  TOKEN_FILE="$XDG_CONFIG_HOME/misaka-web/token"
else
  TOKEN_FILE="$HOME/.config/misaka-web/token"
fi
case "$TOKEN_FILE" in "~/"*) TOKEN_FILE="$HOME/${TOKEN_FILE#~/}" ;; esac

say "misaka-web 安装器"
echo "    仓库:   $REPO_ROOT"
echo "    venv:   $VENV_DIR"
echo "    token:  $TOKEN_FILE"
echo "    监听:   $HOST:$PORT"
[ "$DRY_RUN" -eq 1 ] && echo "    模式:   dry-run（只打印将执行的命令）"

# --- 1. 前置检查（只检查，不安装） ----------------------------------------
say "检查 Python >= 3.12"
PYTHON_BIN="${MISAKA_WEB_PYTHON:-}"
if [ -z "$PYTHON_BIN" ]; then
  for candidate in python3.12 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 &&
       "$candidate" -c "import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 12) else 1)" 2>/dev/null; then
      PYTHON_BIN="$candidate"; break
    fi
  done
fi
[ -n "$PYTHON_BIN" ] || die "没有 Python >= 3.12。本脚本不装系统包：Debian/Ubuntu 用 sudo apt install python3.12 python3.12-venv"
echo "    ok: $("$PYTHON_BIN" -c "import sys; print(sys.version.split()[0])") ($PYTHON_BIN)"

# --- 2. venv ---------------------------------------------------------------
say "准备 venv"
if [ -x "$VENV_DIR/bin/python" ]; then
  echo "    复用已存在的 venv"
else
  run "$PYTHON_BIN" -m venv "$VENV_DIR"
fi
# venv 的布局随平台不同：POSIX 是 bin/，Windows 是 Scripts/
VENV_BIN="$VENV_DIR/bin"
[ -x "$VENV_BIN/python" ] || { [ -x "$VENV_DIR/Scripts/python.exe" ] && VENV_BIN="$VENV_DIR/Scripts"; }
VENV_PY="$VENV_BIN/python"
VENV_PIP="$VENV_BIN/pip"
if [ "$DRY_RUN" -eq 0 ]; then
  [ -x "$VENV_PY" ] || die "venv 创建失败：$VENV_PY 不存在"
  "$VENV_PY" -c "import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 12) else 1)" || die "已存在的 venv 用的是旧 Python，删掉 $VENV_DIR 再试"
fi

# --- 3. 安装本包装与依赖 ---------------------------------------------------
EXTRAS=""
[ "$WITH_MISAKA" -eq 1 ] && EXTRAS="[research]"
say "安装 misaka-web$EXTRAS（可编辑安装，改代码不用重装）"
run "$VENV_PY" -m pip install --upgrade pip || warn "pip 升级失败，继续（离线或受限环境可忽略）"
if [ -f "$REPO_ROOT/../misaka/pyproject.toml" ] && [ "$WITH_MISAKA" -eq 1 ]; then
  echo "    发现本地上游 checkout，优先用它：$REPO_ROOT/../misaka"
  run "$VENV_PY" -m pip install -e "$REPO_ROOT/../misaka[providers]"
fi
run "$VENV_PY" -m pip install -e "$REPO_ROOT$EXTRAS"

# --- 4. token --------------------------------------------------------------
say "配置访问 token"
mkdir -p "$(dirname -- "$TOKEN_FILE")"
chmod 700 "$(dirname -- "$TOKEN_FILE")" 2>/dev/null || true

read_token_from_stdin() {
  local value
  IFS= read -r value || value=""
  printf "%s" "$value"
}

generate_token() {
  "$VENV_PY" -c "import secrets; print(secrets.token_urlsafe(32))"
}

TOKEN_CREATED=0
TOKEN_VISIBLE=""
if [ -s "$TOKEN_FILE" ] && [ "$FORCE_GENERATE" -eq 0 ] && [ -z "$TOKEN_VALUE" ] && [ "$TOKEN_FROM_STDIN" -eq 0 ]; then
  echo "    已有 token，保留原值（内容不打印）：$TOKEN_FILE"
  echo "    忘记内容？用 --generate 换一个新的，或直接 cat 这个文件"
else
  if [ -n "$TOKEN_VALUE" ]; then
    NEW_TOKEN="$TOKEN_VALUE"
  elif [ "$TOKEN_FROM_STDIN" -eq 1 ]; then
    NEW_TOKEN="$(read_token_from_stdin)"
    [ -n "$NEW_TOKEN" ] || die "stdin 里没有读到 token"
  elif [ "$FORCE_GENERATE" -eq 1 ] || [ "$ASSUME_YES" -eq 1 ] || [ ! -t 0 ]; then
    NEW_TOKEN="$(generate_token)"
    TOKEN_CREATED=1
  else
    printf "    粘贴你的 token（直接回车＝自动生成一个）："
    IFS= read -r -s NEW_TOKEN || NEW_TOKEN=""
    printf "\n"
    if [ -z "$NEW_TOKEN" ]; then
      NEW_TOKEN="$(generate_token)"
      TOKEN_CREATED=1
    fi
  fi
  NEW_TOKEN="$(printf "%s" "$NEW_TOKEN" | tr -d "\r\n" | sed "s/^ *//;s/ *$//")"
  [ -n "$NEW_TOKEN" ] || die "token 为空"
  [ "${#NEW_TOKEN}" -ge 16 ] || warn "token 只有 ${#NEW_TOKEN} 个字符，建议至少 16 位（本脚本生成的是 43 位）"
  if [ "$DRY_RUN" -eq 0 ]; then
    ( umask 077; printf "%s\n" "$NEW_TOKEN" > "$TOKEN_FILE" )
    chmod 600 "$TOKEN_FILE" 2>/dev/null || true
  fi
  TOKEN_VISIBLE="$NEW_TOKEN"
  echo "    已写入：$TOKEN_FILE（0600）"
fi

# --- 5. 自检 ---------------------------------------------------------------
say "自检（misaka-web doctor）"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "    [dry-run] $VENV_BIN/misaka-web doctor"
else
  MISAKA_WEB_HOST="$HOST" MISAKA_WEB_PORT="$PORT" MISAKA_WEB_TOKEN_FILE="$TOKEN_FILE" \
    "$VENV_BIN/misaka-web" doctor || warn "doctor 有致命项失败，先按上面的 [FAIL] 修掉再启动"
fi

# --- 6. 可选：systemd ------------------------------------------------------
if [ "$INSTALL_SYSTEMD" -eq 1 ]; then
  say "安装 systemd 单元（User=$RUN_USER）"
  [ "$(id -u 2>/dev/null || echo 1)" -eq 0 ] || die "--systemd 需要 root（sudo ./deploy/install.sh --systemd）"
  UNIT_SRC="$REPO_ROOT/deploy/systemd/misaka-web.service"
  UNIT_DST="/etc/systemd/system/misaka-web.service"
  [ -f "$UNIT_SRC" ] || die "找不到 $UNIT_SRC"
  HOME_DIR="$("$VENV_PY" -c "import os,pwd;print(pwd.getpwnam("$RUN_USER").pw_dir)")"
  TOKEN_DIR="$(dirname -- "$TOKEN_FILE")"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "    [dry-run] 用 User=$RUN_USER HOME=$HOME_DIR ExecStart=$VENV_DIR/bin/misaka-web serve 写入 $UNIT_DST"
  else
    sed \
      -e "s|^User=.*|User=$RUN_USER|" \
      -e "s|^Group=.*|Group=$RUN_USER|" \
      -e "s|^WorkingDirectory=.*|WorkingDirectory=$REPO_ROOT|" \
      -e "s|^Environment=HOME=.*|Environment=HOME=$HOME_DIR|" \
      -e "s|^Environment=MISAKA_WEB_HOST=.*|Environment=MISAKA_WEB_HOST=127.0.0.1|" \
      -e "s|^Environment=MISAKA_WEB_PORT=.*|Environment=MISAKA_WEB_PORT=$PORT|" \
      -e "s|^Environment=MISAKA_WEB_TOKEN_FILE=.*|Environment=MISAKA_WEB_TOKEN_FILE=$TOKEN_FILE|" \
      -e "s|^ExecStart=.*|ExecStart=$VENV_DIR/bin/misaka-web serve|" \
      -e "s|^ReadWritePaths=.*|ReadWritePaths=$TOKEN_DIR|" \
      -e "s|^ReadOnlyPaths=.*|ReadOnlyPaths=$HOME_DIR/.misaka|" \
      "$UNIT_SRC" > "$UNIT_DST"
    echo "    写入 $UNIT_DST"
    echo "    检查：systemd-analyze verify $UNIT_DST"
    systemctl daemon-reload
    systemctl enable --now misaka-web
    echo "    已启动：journalctl -u misaka-web -f"
  fi
fi

# --- 7. 可选：Caddy 片段 ---------------------------------------------------
if [ "$PRINT_CADDY" -eq 1 ]; then
  say "Caddy 片段（保存到 /etc/caddy/Caddyfile 后 sudo systemctl reload caddy）"
  if [ "$LAN_MODE" -eq 1 ]; then
    SITE="misaka.lan"
    echo "注意：misaka.lan 需要能解析到本机（路由器 DNS / hosts / Tailscale MagicDNS），"
    echo "      并且手机要信任 Caddy 的本地根证书（~/.local/share/caddy/pki/authorities/local/root.crt）。"
  else
    SITE="misaka.example.com"
  fi
  cat <<CADDY
{
    local_certs
}

"$SITE" {
    tls internal
    encode {
        match {
            not path /api/sessions/*/events
        }
        zstd gzip
    }
    reverse_proxy 127.0.0.1:$PORT {
        flush_interval -1
    }
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "SAMEORIGIN"
        Referrer-Policy "no-referrer"
        -Server
    }
}
CADDY
fi

# --- 8. 收尾 ---------------------------------------------------------------
say "完成"
LAN_IP=""
if command -v hostname >/dev/null 2>&1; then
  LAN_IP="$(hostname -I 2>/dev/null | awk "{print \$1}")" || LAN_IP=""
fi
if [ "$HOST" = "0.0.0.0" ]; then
  echo "    本机访问：  http://127.0.0.1:$PORT/"
  [ -n "$LAN_IP" ] && echo "    内网访问：  http://$LAN_IP:$PORT/   （手机用这个）"
  warn "0.0.0.0 意味着内网其它机器可达：明文 HTTP 下 token 会被同网段看到，"
  warn "      且浏览器不把明文局域网地址当安全上下文（离线壳、通知、剪贴板不可用）。"
  warn "      内网长期测试建议：保持 127.0.0.1，用 --print-caddy --lan 起一个带 tls internal 的 Caddy。"
else
  echo "    访问地址：  http://$HOST:$PORT/"
fi
if [ -n "$TOKEN_VISIBLE" ]; then
  echo ""
  echo "    访问 token："
  echo "      $TOKEN_VISIBLE"
  echo ""
  if [ "$TOKEN_CREATED" -eq 1 ]; then
    echo "    这是自动生成的 token，只显示这一次。请现在就存进密码管理器；"
    echo "    忘了可以重看：cat $TOKEN_FILE"
  fi
  echo "    手机登录时粘贴上面这串即可。"
else
  echo "    token 已在 $TOKEN_FILE（需要查看：cat $TOKEN_FILE）"
fi
echo ""
echo "    启动：  $VENV_DIR/bin/misaka-web serve"
echo "    自检：  $VENV_DIR/bin/misaka-web doctor"
echo "    文档：  $REPO_ROOT/docs/ops.md"
if [ "$WITH_MISAKA" -eq 0 ]; then
  echo ""
  echo "    注意：没有装 misaka，会话面可用，研究/来源/起 run 会返回 503。"
  echo "          需要时重跑：./deploy/install.sh --with-misaka"
fi