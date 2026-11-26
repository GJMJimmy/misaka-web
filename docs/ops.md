# MISAKA WebUI 部署与运维（M0）

面向：在 Linux 服务器上把这个 WebUI 跑起来、长期看着它的人。

三个硬前提，先记住：

1. **服务器不安装 node。** 前端构建产物随 Python 包发布（`web/dist` → `src/misaka_web/static/`），
   运行时只跑 Python。Node/pnpm 只出现在发布机或开发机上（见第 2.7 节）。
2. **服务只绑回环。** `MISAKA_WEB_HOST=127.0.0.1`，对外只由 Caddy 的 443 暴露。
3. **单用户系统。** 一个 token 等于全部权限，没有多用户、没有角色、没有审计级别。别把它当多租户。

契约（接口、环境变量、SSE 语义）以 `CONTRACT.md` 为准，本文只讲怎么部署和排障。

---

## 1. 拓扑

```
手机/平板 --HTTPS(443)--> Caddy（TLS 终止、安全头、SSE 不缓冲）
                              |
                              v  明文 HTTP，回环
                         misaka-web  127.0.0.1:8787   (systemd: misaka-web.service)
                              |
                              v  unix 控制 socket（一命令一 ack）
                         MISAKA 上游进程（同一研究账号）  ~/.misaka/**
```

misaka-web 不直接读写 `~/.misaka/**` 里的 session 文件（CONTRACT 不变量 1、3），只走控制 socket。
因此它必须和上游进程跑在**同一个账号**下。

---

## 2. 首次安装

### 2.1 前置（脚本只检查，不代装）

| 项 | 要求 | 装法（自行执行） |
|---|---|---|
| Python | >= 3.12，含 `venv` 模块 | `sudo apt install python3.12 python3.12-venv` |
| git | 任意近期版本（升级流程要用） | `sudo apt install git` |
| 账号 | 研究会话的属主账号（`~/.misaka` 的 owner） | 已有研究账号，不要用 root |
| 域名 | A/AAAA 指向本机 | 你自行解析 |
| 端口 | 80/443 可达（Caddy 申请证书） | 防火墙/安全组自行放行 |

`deploy/install.sh` **不会**安装系统包、**不会**改防火墙、**不会**写 `/etc`。它只做三件事：
建/更新 venv、安装本包、准备 token，然后把需要你手动执行的东西打印出来。

### 2.2 取代码

```sh
sudo mkdir -p /opt && sudo chown "$USER" /opt
git clone <你的仓库地址> /opt/misaka-web
cd /opt/misaka-web
```

如果服务器上已有上游 `misaka` 的 checkout（例如 `/opt/misaka-web/../misaka`），`--with-misaka` 会优先用它。

### 2.3 安装（幂等，可反复执行）

```sh
./deploy/install.sh --venv /opt/misaka-web/.venv      # 首次
./deploy/install.sh --venv /opt/misaka-web/.venv --with-misaka   # 需要上游包时
```

它做什么：

- 检查 `python3.12`（含 venv 模块）与 `git`；缺了就报错退出，并给出自行安装的命令。
- 复用已存在的 venv（不会重建），否则用 3.12 建一个。
- `pip install <repo>` 装依赖与本包；再用 `--force-reinstall --no-deps` 强制换掉包体，
  保证版本号没变时重新执行也能真正更新代码（升级路径就靠这一条）。
- token：`~/.config/misaka-web/token`，**已存在则保留**并打印路径；不存在才调用
  `misaka-web token` 生成。内容永不打印，权限收到 `600`，目录 `700`。
- 自检：`import misaka_web`、`misaka-web --help`。
- 最后打印 systemd / Caddy 的**手动**安装命令。

可用的环境变量覆盖：`MISAKA_WEB_VENV`、`MISAKA_WEB_PYTHON`、`MISAKA_WEB_TOKEN_FILE`、`XDG_CONFIG_HOME`。

> 从 Windows 拷过来的 checkout 可能丢执行位：`chmod +x deploy/install.sh`，或直接用 `bash deploy/install.sh ...`。

> 以 root 执行会得到 WARN：venv 和 token 会变成 root 的，systemd 用 `User=` 启动时读不到 → 401。
> 正确姿势：用研究账号执行，`sudo -u misaka ./deploy/install.sh ...`。

### 2.4 systemd

```sh
sudo cp /opt/misaka-web/deploy/systemd/misaka-web.service /etc/systemd/system/
sudoedit /etc/systemd/system/misaka-web.service
```

必须改的四类值（文件顶部注释里有同样的清单）：

- `User=` / `Group=` → 研究账号
- `Environment=HOME=` → 该账号家目录
- `ExecStart=` → 你 venv 里的 `misaka-web`，例如 `/opt/misaka-web/.venv/bin/misaka-web serve`
- `ReadWritePaths=` → 同样的家目录下的 `~/.misaka` 与 `~/.config/misaka-web`

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now misaka-web
systemctl status misaka-web --no-pager
journalctl -u misaka-web -n 50 --no-pager
```

硬化项都写进单元里了（`NoNewPrivileges=yes`、`ProtectSystem=full`、`ProtectHome=read-only`，
配 `ReadWritePaths=`（只 token 目录）与 `ReadOnlyPaths=`（只 `~/.misaka`）两处放行），原因在各行上方的注释里。
**`PrivateTmp` 是故意不开的**：每个会话的控制 socket 在系统 `/tmp/misaka-session-*/control.sock`，
私有 `/tmp` 会让桥接看不到它（症状：所有会话 `has_control:false`、input 一律 502）。
`SystemCallFilter` / `MemoryDenyWriteExecute` 留成注释：没在本仓验证过，要开请先自己压一遍。

### 2.5 Caddy（TLS + 反代）

```sh
sudo cp /opt/misaka-web/deploy/caddy/Caddyfile.example /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile      # 改域名 + ACME 邮箱
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

三处不能删的 SSE 配置（文件里有逐条注释）：

| 配置 | 作用 |
|---|---|
| `@compressible not path /api/sessions/*/events` + `encode @compressible zstd gzip` | 压缩会把事件流攒块，必须排除 SSE |
| `flush_interval -1` | 上游到一个字节就冲刷，是逐字流式的前提 |
| `servers { timeouts { write 0 ... } }` | 不给长连接设写超时 |

用 nginx 的话看 `deploy/nginx/misaka-web.conf.example`（`proxy_buffering off` + `gzip off` + 长 `proxy_read_timeout`）。

### 2.6 验收（五分钟）

先跑一遍自检（它会指出 token 权限、UI 产物、看板能否读、控制 socket 是否可见这些最常见的坑）：

```sh
sudo -u misaka /opt/misaka-web/.venv/bin/misaka-web doctor
```

`[FAIL]` 的是必须修掉的；`[warn]` 的要看一眼（例如「控制 socket 可见但当前没有会话在跑」是正常的）。

```sh
# 1) 服务与端口：应当只有一个 127.0.0.1:8787
ss -ltnp | grep 8787

# 2) 健康检查（不需要认证），确认 version / misaka_version / board_schema
curl -sS http://127.0.0.1:8787/api/health

# 3) 带 token 认证（token 从文件读，别手敲）
curl -sS -H "Authorization: Bearer $(cat ~/.config/misaka-web/token)" http://127.0.0.1:8787/api/me

# 4) 经 Caddy 再验一次
curl -sS https://misaka.example.com/api/health

# 5) SSE 必须是"立刻有输出 + 每 25s 一条 ping"（-N 关掉 curl 自己的缓冲）
curl -N -H "Authorization: Bearer $(cat ~/.config/misaka-web/token)" \
  "https://misaka.example.com/api/sessions/<session-id>/events?since=0"
```

第 5 条如果 10 秒内一个字都没有，问题在中间层缓冲，不在应用——直接跳到第 6 节的 SSE 行。

### 2.7 前端产物（只有发布机需要 node）

`src/misaka_web/static/` 是构建产物，随仓库发布。**服务器不装 node：不跑 pnpm、不跑 vite。**
发布机上：

```sh
cd web && pnpm install && pnpm exec vite build && ../scripts/sync-web.sh
```

同步完提交 `static/`，服务器侧只需 `git pull` + 重跑 install.sh + 重启（第 3.3 节）。

---

## 3. 日常运维

### 3.1 启停与日志

```sh
sudo systemctl restart misaka-web      # 重启（会切断所有 SSE，前端会显示断线 banner）
sudo systemctl stop misaka-web
journalctl -u misaka-web -f            # 跟随日志
journalctl -u misaka-web --since "1 hour ago" --no-pager
journalctl -u misaka-web -p warning --since today --no-pager   # 只看告警以上
```

日志全在 journald（`SyslogIdentifier=misaka-web`），不写文件。想让日志跨重启保留：
`sudo mkdir -p /var/log/journal` 后 `sudo systemctl restart systemd-journald`（或设 `Storage=persistent`）。

### 3.2 token 轮换

`~/.config/misaka-web/token` 就是全部凭据。轮换 = 换文件 + 重启：

```sh
sudo systemctl stop misaka-web
cd ~ && umask 077
mv ~/.config/misaka-web/token ~/.config/misaka-web/token.old.$(date +%F)
/opt/misaka-web/.venv/bin/misaka-web token     # 重新生成（输出不要贴到聊天/工单）
ls -l ~/.config/misaka-web/token                # 应为 -rw------- 
sudo systemctl start misaka-web
```

要点：

- 轮换后所有浏览器会话立刻 401（旧 cookie 与旧 token 都失效），各设备重新登录。
- 旧的 `token.old.*` 在确认新 token 可用后**删掉**，否则等于没轮换。
- 怀疑泄露就立刻轮换，不要等计划窗口。
- 若坚持把 token 放在别处，必须同步改 systemd 的 `MISAKA_WEB_TOKEN_FILE`；两处不一致就是 401。
- 该版本 `token` 子命令的参数细节以 `misaka-web token --help` 为准（install.sh 不传额外参数，
  只用 `MISAKA_WEB_TOKEN_FILE` 指定落盘位置）。

### 3.3 升级（代码更新 + 重启）

```sh
cd /opt/misaka-web
sudo systemctl stop misaka-web          # 可选：不停机也能升级，但已在跑的 SSE 会断
git pull --ff-only
./deploy/install.sh --venv /opt/misaka-web/.venv
# 单元或 Caddyfile 也改过的话：
#   sudo cp deploy/systemd/misaka-web.service /etc/systemd/system/ && sudo systemctl daemon-reload
#   sudo cp deploy/caddy/Caddyfile.example /etc/caddy/Caddyfile（注意先 diff，别覆盖你的域名）
sudo systemctl start misaka-web
curl -sS https://misaka.example.com/api/health
```

验收：`/api/health` 的 `version` 变了、`ok` 为真；打开一次会话确认 SSE 正常。
要回滚就 `git checkout <old-tag>` 后重跑 install.sh + 重启（install.sh 幂等，不会碰 token）。

---

## 4. 备份与恢复

要备份三处，缺一处恢复就不完整：

| 路径 | 内容 | 丢了会怎样 |
|---|---|---|
| `~/.misaka/` | 上游会话数据与控制 socket 所在的目录、`.catalog/*.json` 会话索引 | 所有历史研究会话消失，控制 socket 不可达 |
| 各会话的 `workspace`（cwd） | 研究产物、脚本、数据；具体路径见 `.catalog/*.json` 的 `path` 字段 | 会话元数据在但产物没了 |
| `~/.config/misaka-web/` | token（**等同密码**） | 无需备份，重新 `misaka-web token` 即可；备份时务必加密 |

备份（先停服务，避免拷到写一半的 sqlite）：

```sh
sudo systemctl stop misaka-web
# 会话数据
rsync -a --delete ~/.misaka/ /backup/misaka/home-misaka/
# workspace（示例：按 .catalog 里列的 path 逐个来）
rsync -a /home/misaka/work/ /backup/misaka/workspace/
# token 目录：只在需要保留同一凭据时备份，并加密
tar -czf - -C ~/.config misaka-web | gpg -c > /backup/misaka/config.tgz.gpg
sudo systemctl start misaka-web
```

恢复顺序（顺序不能乱）：

1. 停服务：`sudo systemctl stop misaka-web`（上游若在同一账号跑，也先停掉会话，避免两边同时写）。
2. 恢复 `~/.misaka/` 与 workspace。
3. 改属主：`sudo chown -R misaka:misaka ~/.misaka <workspace>`，权限保持目录 700、文件 600。
4. token 两种做法：恢复备份（等同沿用旧凭据，建议恢复后立刻再轮换一次）或直接删掉重新生成。
5. `sudo systemctl start misaka-web` → `curl -sS http://127.0.0.1:8787/api/health` → 打开 UI 看会话列表。

注意：

- 不要在会话活跃时热拷 `~/.misaka`：拷到半截的 sqlite 会让上游读失败。
- `~/.misaka` 的属主/权限是上游建立的，恢复时**不要**用 `--no-preserve=ownership` 之类把权限弄乱，
  否则就是第 6 节的"控制 socket 不可达"。
- 备份里不要包含 venv（`/opt/misaka-web/.venv` 重装即可）。

---

## 5. 加固清单

上线前逐条确认：

**边界**

- [ ] `ss -ltnp | grep 8787` 只出现 `127.0.0.1:8787`；不是 `0.0.0.0`、不是 `[::]`。
- [ ] 安全组/防火墙只放行 80/443（本仓脚本**不改**这两样，请自行确认）。
- [ ] 8787 不经任何跳板/端口转发暴露到公网。
- [ ] 服务账号 = 研究账号，且不是 root、不需要 sudo（`systemctl show misaka-web -p User`）。

**传输**

- [ ] 只通过 HTTPS 访问；Caddy 证书自动续期正常（`journalctl -u caddy | grep -i cert`）。
- [ ] HSTS、`X-Content-Type-Options`、`X-Frame-Options`（必须是 `SAMEORIGIN`，`DENY` 会让应用内 PDF 打不开）、`Referrer-Policy`、`Permissions-Policy` 已下发
      （`curl -sSI https://<域名>/ | grep -i strict` 能看到）。
- [ ] 强制 CSP 之前先用 report-only 跑一遍，确认 Vite 产物不报错再收紧（`Caddyfile.example` 里有说明）。

**凭据与单用户**

- [ ] `~/.config/misaka-web/token` 权限 `600`、目录 `700`、属主是服务账号。
- [ ] token 只发给实际使用的人，不复用到其它系统；多人使用时**每人都算全权**，无隔离。
- [ ] 怀疑泄露 → 立刻按 3.2 轮换并删除旧文件。

**审计与留痕**

- [ ] journald 持久化（`/var/log/journal` 存在），`journalctl -u misaka-web` 能回溯历史。
- [ ] 可选：Caddy 访问日志（`Caddyfile.example` 里注释掉的那段），注意别把 `Authorization`/`Cookie` 打进去。
- [ ] `journalctl -u misaka-web -p warning` 无告警堆积（401 风暴往往是扫描器，也可能是配置坏了）。

**进程隔离**（单元里已配，确认没被装机器时改坏）

- [ ] `NoNewPrivileges=yes`、`ProtectSystem=full` 在 `systemctl show misaka-web -p NoNewPrivileges -p ProtectSystem` 里有值。
- [ ] **`PrivateTmp` 必须是关的**：`systemctl show misaka-web -p PrivateTmp` 应输出 `PrivateTmp=no`。
      开了它桥接就看不见 `/tmp/misaka-session-*/control.sock`（会话全 `has_control:false`、input 502）。
- [ ] `ProtectHome=read-only` 生效，且 `ReadWritePaths` 只放行 `~/.config/misaka-web`、`ReadOnlyPaths` 只放行 `~/.misaka`。
- [ ] 追加路径要谨慎：报 EPERM 时先看是不是硬化挡住的，别顺手加 `ReadWritePaths=/home`。

**操作纪律**

- [ ] 输入投递未确认时服务端返回 502 且**不自动重发**（CONTRACT 第 3 节）。
      所以运维**不要**写自动重试脚本去打 `/api/sessions/{id}/input`，会造成重复投递。
- [ ] 服务器上没有 node、没有 pnpm、没有前端构建进程（`command -v node` 应为空）。

---

## 6. 故障排查表

先看两处，再看表：`journalctl -u misaka-web -n 50 --no-pager` 和 `curl -sS http://127.0.0.1:8787/api/health`。
本机能连上但外网不行 → 问题在 Caddy/证书/防火墙；本机也不行 → 问题在服务本身。

### 401 Unauthorized

| 可能原因 | 检查 | 处理 |
|---|---|---|
| token 不匹配（手敲错、还是旧的） | `curl -sS -H "Authorization: Bearer $(cat ~/.config/misaka-web/token)" http://127.0.0.1:8787/api/me` | 用文件内容，别手抄；重新登录换取 cookie |
| 服务账号读不到 token 文件 | `sudo -u <User> cat <MISAKA_WEB_TOKEN_FILE>`；`ls -l` 看属主/`600` | `chown` 给服务账号，或让研究账号跑 install.sh |
| 两处路径不一致 | `systemctl show misaka-web -p Environment` 里的 `MISAKA_WEB_TOKEN_FILE` vs 实际文件 | 改成同一个路径后 `daemon-reload` + 重启 |
| cookie `mw_session` 丢失/被浏览器丢 | 浏览器 DevTools → Application → Cookies 里有没有 `mw_session` | 用 HTTPS 访问（明文 HTTP 下 cookie 会被丢）；别在跨站 iframe/非同站子域里打开 |
| 反代吃掉了认证头 | `journalctl -u caddy`；`curl -H ... https://<域名>/api/me` | 不要配置 `proxy_set_header Authorization ""` 之类的清除规则 |
| 刚轮换过 token | — | 预期行为：所有设备重新登录 |

`/api/health` 与 `/api/login` 不需要认证：health 通了但 me 401，就一定是凭据问题，不是服务挂了。

### SSE 卡住（点了没反应、或过一会儿突然刷出一大段）

分三层定位，**先直连上游**：

| 层 | 检查 | 判定 |
|---|---|---|
| 应用 | `curl -N -H "Authorization: Bearer $(cat ~/.config/misaka-web/token)" "http://127.0.0.1:8787/api/sessions/<id>/events?since=0"` | 立刻看到 `event: snapshot`，之后每 25s 一条 `: ping` → 应用没问题，往上查 |
| 反代 | 同一条 curl 换成 `https://<域名>/...`，对比是否卡住 | 卡住 = 中间层缓冲 |
| 浏览器 | 只看 UI 不能判断；用 DevTools → Network → 该请求 → EventStream 标签 | 能看到逐条事件 = 浏览器侧正常 |

常见坑（按出现频率）：

- `curl` 少了 `-N`：curl 自己会缓冲，看着像卡住，其实是假阳性。
- Caddy 少了 `flush_interval -1`，或 `encode` 没排除 `/api/sessions/*/events` → 压缩/缓冲把事件攒块。
- nginx 少了 `proxy_buffering off` / `gzip off`，或 `proxy_read_timeout` 太短（< 25s 心跳）→ 连接被中间层先掐断。
- 中间链路（CDN、云厂商 LB、公司网关）默认缓冲且不可控 → 换直接在 Caddy 上终止，或让 LB 走 TCP 透传。
- HTTP/2 多路复用下同一域名的并发限制：同时开很多页签时偶发排队，属正常现象。
- 契约里**客户端不自动重连**：断线时 UI 显示 banner + 手动重连按钮是设计行为，不是 bug。
- 服务端 502 + 投递未确认：这是上游没 ack，不是 SSE 问题；不要自动重发。

### 控制 socket 不可达

症状：会话列表空/报错，或列表可见但**每个会话都 `has_control:false`、`state` 恒为 `saved`**，
input 返回 502 `no_control` / `unconfirmed`；日志里出现 ENOENT / EACCES / connection refused。
注意 socket 不在家目录：`.catalog/` 索引在 `~/.misaka/.catalog/`，而 socket 在
`/tmp/misaka-session-*/control.sock`（`misaka/core/session_catalog.py:107`、`session_control.py:76-79`）。

| 可能原因 | 检查 | 处理 |
|---|---|---|
| **开了 `PrivateTmp=yes`（本单元已刻意关闭，别加回来）** | ① `systemctl show misaka-web -p PrivateTmp` 必须是 `no`；② 在服务进程的命名空间里确认 socket 可见：`sudo nsenter -t $(systemctl show -p MainPID --value misaka-web) -m ls -d /tmp/misaka-session-*/`（应列出目录，而不是 `No such file`） | 删掉 `PrivateTmp=yes`（或写 `PrivateTmp=no`），`daemon-reload` + 重启；症状是全部会话 `has_control:false`、input 502 |
| 账号不对 | `systemctl show misaka-web -p User`；对比 `ls -l ~/.misaka` 与 `ls -ld /tmp/misaka-session-*/` | 改成研究账号（socket 目录 0700 / socket 0600，属主必须是同一账号），重启 |
| 上游根本没在跑 | 用研究账号跑一次上游，再看 `~/.misaka/.catalog/` 有记录、`/tmp/misaka-session-*/control.sock` 存在 | 先启动上游会话，UI 才有东西可列 |
| 家目录被硬化挡住 | 日志 ENOENT/EPERM；`ProtectHome=read-only` 生效中 | 确认 `ReadOnlyPaths` 里有真实的 `~/.misaka` 绝对路径（systemd 不展开 `~`）；注意 `/tmp` 需要能被看见（见上面 PrivateTmp 一行） |
| 恢复备份后权限乱了 | `ls -la ~/.misaka`、`.catalog/` 属主 | `chown -R <研究账号>`，目录 700 |
| 路径变了（换盘/迁移/换了 HOME） | 日志里的实际路径 vs 现路径 | 修正 `Environment=HOME=` 与实际目录，重启 |
| 会话被上游清理（进程退出） | `.catalog/` 里的条目 vs 活的 socket | 预期行为；UI 提示会话失效时让用户重新开始 |

排查命令：`ss -xl | grep -i misaka`（看 unix socket 是否在）、`sudo -u <User> test -S /tmp/misaka-session-*/control.sock && echo ok`。
最后一步永远是**在服务进程里**再看一眼（`nsenter -m`），因为在 shell 里 `ls` 得到的结果不代表服务看到的挂载视图。

### 上游版本不匹配

症状：`/api/health` 里 `misaka_version` / `board_schema` 与预期不符；UI 某些字段缺失或只读。

| 检查 | 命令 | 判定 |
|---|---|---|
| 服务声明 | `curl -sS http://127.0.0.1:8787/api/health` | `ok:true` 时看 `version` / `misaka_version` / `board_schema` |
| 装了哪个上游 | `/opt/misaka-web/.venv/bin/python -c "import misaka, sys; print(getattr(misaka, '__version__', '?'), misaka.__file__)"` | 与上表对照 |
| 版本区间 | `pyproject.toml` 的 dev extra（当前 `>=0.19.30,<0.21`） | 超出区间就升级/降级上游 |

处理原则：

1. **不要改上游源码**去迁就本服务（CONTRACT 第 0 节不变量 3）。
2. 优先把上游装进区间：`./deploy/install.sh --with-misaka`（有本地上游 checkout 时从它装，否则从索引装）。
3. 区间对不上就换本服务的版本（`git checkout` 到与上游匹配的 tag），而不是硬凑。
4. 记录冲突：`misaka_version` 与 `board_schema` 都写进工单，别只报"版本不对"。

### 其它常见现象

| 现象 | 检查 | 处理 |
|---|---|---|
| `systemctl start` 立即失败 | `systemctl status misaka-web`、`journalctl -u misaka-web -n 50` | 多为 `ExecStart` 路径不存在（venv 装到别的目录）或 `User=` 不存在 |
| `Address already in use` | `ss -ltnp | grep 8787` | 杀掉占端口的手工起的实例，或改 `MISAKA_WEB_PORT`（同时改 Caddy） |
| 页面 404 / 白屏，API 正常 | `ls /opt/misaka-web/.venv/lib/python3.12/site-packages/misaka_web/static/` | 前端产物没随包发布/没同步：按 2.7 在发布机重建并提交 `static/` |
| Caddy `validate` 报 syntax error | `sudo caddy validate --config /etc/caddy/Caddyfile` | 常见是域名占位符没改、或 `servers/timeouts` 块被你的版本拒绝（删掉该块，默认不设写超时） |
| 证书申请失败 | `journalctl -u caddy -n 100` | 80/443 未放行、域名未解析、或 ACME 邮箱/限额问题 |
| 服务反复重启 | `journalctl -u misaka-web -n 100`；看 `Restart=on-failure` 计数 | 先修根因再 `systemctl reset-failed` |

---

## 7. 本版未覆盖 / 已知限制（M1 / M2）

- 无多用户、无角色、无按会话授权：持有 token 的人拥有一切权限。
- 无自动重连：SSE 断开后需要用户手动点重连（契约第 3 节的规定）。
- 研究面**不自动轮询**：状态变化要手动「刷新 / 回读状态」，避免手机后台高频读看板。
- 本仓**未在真实 systemd 主机上验证**过：单元按 systemd 官方语义编写，但没有跑过 `systemd-analyze verify`（交付环境为 Windows）。上线前请执行：
  `sudo systemd-analyze verify /etc/systemd/system/misaka-web.service`。
- 同理 `Caddyfile.example` 未在目标 Caddy 版本上跑过 `caddy validate`，请按 2.5 自验。
- 服务只能写两处：`ReadWritePaths` 只放行 token 目录（`~/.config/misaka-web`），`ReadOnlyPaths` 放行 `~/.misaka`（桥接只读 catalog、只 connect 控制 socket）。若还要写别处，日志会明确报 EPERM/EROFS，按需追加单条路径，不要整体放开家目录。
- 研究面（runs / 节点 / 审批 / 起 run）需要 **MISAKA 装在同一个 venv 里**；只装 misaka-web 时这些端点返回 503 `board_unavailable`，会话面照常可用（见 §8）。
- 外部（SSH）起的 run 只能看和审批，不能在 WebUI 里终止它的进程（进程不归本服务托管）。
- 日志与备份策略只给到原则：轮转交给 journald，备份保留周期由你的策略决定（token 备份必须加密）。
- 服务器上永远不需要 node：如果有人在服务器上装 node 来「修前端」，说明流程走错（应在发布机构建并提交 `static/`）。

## 8. 启动/恢复研究（M2）

WebUI 可以代你起 `misaka research`，但**服务进程必须能调用上游 CLI**：

- 默认用 `python -m misaka research …`，即在同一个 venv 里（`install.sh --with-misaka` 已经覆盖）；
- 上游装在别处时，用 `Environment=MISAKA_WEB_MISAKA_BIN=/path/to/misaka` 指定；
- 生成模型凭据走研究账号的 `~/.misaka`，因此服务必须以该账号运行（同 §2.4）；
- 起 run 的目录受白名单限制：`MISAKA_WEB_WORKSPACE_ROOT`（默认 `~/Documents`），越界 422。

子进程的 stdout/stderr 落在 `<token 目录>/runs/*.log`，进程档案在 `<token 目录>/runs.json`（0600）。
所以：

```sh
# 看某次运行的日志（也可在 UI 的「查看日志」里看）
journalctl -u misaka-web -n 50        # 服务本身
ls ~/.config/misaka-web/runs/         # 每次运行的子进程日志
tail -n 100 ~/.config/misaka-web/runs/new-*.log
```

注意：

- 服务重启后 `runs.json` 仍在，UI 会显示进程「已退出」；用「恢复运行」重新拉起（走 `--resume`），不要手工 `kill` 后重起新 run。
- 停止分两步：先请求停止（看板标记，让工作流在节点边界收尾），必要时再强制终止进程——强制终止会丢当前节点未落盘的进度。
- 外部（SSH）起的 run 不进 `runs.json`，UI 会标成「非 WebUI 启动」，只能看和审批，不能在这里终止进程。
## 9. 升级 runbook

```sh
# 1) 取新代码（研究账号执行，别用 root）
sudo -u misaka git -C /opt/misaka-web pull --ff-only

# 2) 重新安装包体（install.sh 幂等；不会动已存在的 token 与 venv）
sudo -u misaka /opt/misaka-web/deploy/install.sh --venv /opt/misaka-web/.venv

# 3) 若前端有改动：发布机上构建后同步（服务器上不要装 node）
#    cd web && pnpm install && pnpm exec vite build && ../scripts/sync-web.sh
#    然后把 src/misaka_web/static 一起提交或打包发布

# 4) 重启并自检
sudo systemctl restart misaka-web
sudo -u misaka /opt/misaka-web/.venv/bin/misaka-web doctor
curl -sS http://127.0.0.1:8787/api/health | head -c 200
```

回滚：`git checkout <上一个 tag>` → 重跑 install.sh → restart。`audit.jsonl`、`runs.json`、token 都不在代码目录里，回滚不会丢。

**前端缓存与升级**：静态资源带内容哈希，Service Worker 只缓存壳；新版本上线后旧标签页会提示「有新版本，点此刷新」。如果用户长时间不刷新而界面行为诡异，先让他硬刷新一次再看，不要先去怀疑后端。

## 10. 上线前验证清单（目标机执行）

- [ ] `sudo systemd-analyze verify /etc/systemd/system/misaka-web.service` 无输出（本仓未在真实 systemd 上跑过）
- [ ] `sudo caddy validate --config /etc/caddy/Caddyfile`（或 `nginx -t`）
- [ ] `misaka-web doctor` 全 `[ok]`（`[warn]` 逐条看过）
- [ ] `systemctl show misaka-web -p PrivateTmp` 输出 `PrivateTmp=no`
- [ ] 在服务进程命名空间里能看到控制 socket：`sudo nsenter -t $(systemctl show -p MainPID --value misaka-web) -m ls -d /tmp/misaka-session-*/`（有会话在跑时）
- [ ] `curl -sS https://<域名>/api/health` 返回 `ok:true`、`research_available:true`、`board_path` 非 null
- [ ] 手机上：登录 → 会话流式 → 研究列表 → 节点 → 来源面板 → 点一页打开 PDF
- [ ] 断网 30 秒：界面回退到缓存壳并显示离线 banner；恢复后手动重连即可续看
- [ ] `tail -n 5 ~/.config/misaka-web/audit.jsonl` 能看到刚才那几次写操作
