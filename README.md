# misaka-web

MISAKA 的移动优先 WebUI：把服务器上的研究运行搬到手机/平板的浏览器里。

- 契约：`CONTRACT.md`（接口、运行时、不变量，冻结）
- 计划：`../MISAKA-WEB-PLAN.md`
- 运维：`docs/ops.md`

## 快速启动（开发机）

```sh
../.venv-web/Scripts/python.exe -m misaka_web token          # 生成 token
../.venv-web/Scripts/python.exe -m misaka_web serve          # 127.0.0.1:8787
```

前端构建（只有开发/发布时需要 node）：

```sh
cd web && pnpm install && pnpm exec vite build && ../scripts/sync-web.sh
```
