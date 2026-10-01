# AGENTS.md — dsh-rerun-turn（给并行 agent 的说明）

本仓库是 DSH web 插件 **dsh-rerun-turn** 的唯一正本，经 `~/.dsh/profiles/web` 符号链接装到用户实例。改动前请先读本文件。

## 当前状态（2026-10-01）

- 版本 **0.1.22**；`lib/index.js`、`lib/client.js`、`package.json` 三处版本号必须一致。
- 改完必须本地全绿：`npm test && npm run verify:contract && npm run verify:client`（当前 **26** 单测 / 22 契约 / 7 客户端检查；单测含 8 条客户端 DOM 用例，由 0.1.21/0.1.22 两轮加固带入 —— 2026-10-01 校正，原记 17 为过期值）。
- 远端正本：GitHub `DDDMUC/dsh-rerun-turn`。本地有提交后请同步（git 直连在本机不通时，用 GitHub REST API 推 blobs→tree→commit→ref，**blob 请求必须带 `"encoding":"base64"`**，否则会把 base64 文本当文件存）。
  - 2026-10-01 实测补充：本机 `github.com:443` 会超时（`Failed to connect` / `curl 28 Operation too slow`），但 `api.github.com` 正常（0.3s）。走 API 时 **commit 的 `date` 必须是 ISO 8601 且保留原时区偏移**（git 存的是 `<epoch> <±HHMM>`；直接送 `1790835054 +0800` 会 422，归一化成 `Z` 会让 sha 变掉）。把 tree/parents/author/committer/message 原样回填后，API 生成的新 commit **sha 与本地完全一致**，分支不会分叉 —— 2026-10-01 的 fc4f702 就是这样推上去的。

## 事故记录：点不动（2026-10-01 13:5x）

- 现象：用户点击回答行/用户行的 ↻ 无响应；宿主 `/debug` 无 `apply` 请求；直取 `/plugins/??...dsh-rerun-turn...` bundle 返回空。
- 根因：**混合态**。client 侧经历多次 HMR 重载（0.1.21/0.1.22 改动触发），页面里是「新 bundle 实例 + 旧控制器已被 dispose / 旧按钮监听已死」；而宿主进程仍是旧版（未重启）。代码本身无缺陷。
- 修复动作：**重启宿主 + 硬刷新页面**（已在用户实例执行并验证：host 0.1.22、bundle 200 非空、两处按钮齐备；沙箱用同一份代码实测两种 ↻ 点击均正常触发 apply）。
- 约定：**改 client.js 后必须重启宿主并让页面硬刷新**，不要停在 HMR 混合态交付用户。跨端（host/client）不兼容改动必须 bump 版本。

## 协作规则

- 不要用另一分支的版本整体覆盖 `lib/`、`test/`、`README.md`；有冲突先与本地 HEAD / GitHub main diff。
- 顶层行为改动（隐藏规则、注入、宿主生命周期）是共享面：`dsh-edit-turn`、`dsh-delete-turn`、`dsh-rerun-turn` 三兄弟的 DOM 注入现已走命名空间归属（`data-*-hidden`/`data-*-action`），改一侧请检查另两侧不受影响。
- 不要替用户重启 / 发布（npm）/ force-push，除非用户明确要求。
