# AGENTS.md — dsh-rerun-turn（给并行 agent 的说明）

本仓库是 DSH web 插件 **dsh-rerun-turn** 的唯一正本，经 `~/.dsh/profiles/web` 符号链接装到用户实例。改动前请先读本文件。

## 当前状态（2026-10-01）

- 版本 **0.1.22**；`lib/index.js`、`lib/client.js`、`package.json` 三处版本号必须一致。
- 改完必须本地全绿：`npm test && npm run verify:contract && npm run verify:client`（当前 **42** 单测 / 22 契约 / 7 客户端检查；单测 = 18 宿主 + 8 客户端 DOM + 16 跨插件契约，由 0.1.21/0.1.22 两轮加固与 2026-10-01 的契约固化带入 —— 原记 17、26 均为过期值）。
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

## 跨插件运行时契约：dsh-edit-turn → dsh-rerun-turn（请勿破坏）

dsh-edit-turn **0.2.12+** 的提示词编辑器里有一个「重跑」按钮：只有检测到本插件挂载才出现；点击后先走它自己的
`POST /dsh-edit-turn/apply` 保存改写（就地替换、不调模型），紧接着链式调用本插件的 `POST /dsh-rerun-turn/apply {sessionId, seq}`，
好让重跑用**改后的文本**生成。它只走公开回环路由，不碰我们的 client/DOM；反过来，纯 dsh-edit-turn（没装我们）
没有任何重跑入口。它依赖以下形状 —— 全部由 `test/contract.test.js`（16 例）钉死：

| # | 形状 | 现状（file:line） |
| --- | --- | --- |
| 1 | **挂载探测**：不带 sessionId 的 `GET /state` 在挂载时答 **400**（它按 400/405=装着、404=没装；改语义按钮会静默消失） | `lib/index.js:1810`、`:1976` |
| 2 | **目标解析**：`/state` 返回 `replies[]`，元素形如 `{seq, turn}`（它取被编辑那一轮里 seq 最大者） | `lib/index.js:1056`、`:1622` |
| 3 | **调用形状**：`POST /apply` 只要求 `sessionId` + (`seq` \| `messageId`)，**不得新增必填参数**（确认令牌之类会让链式调用直接失败） | `lib/index.js:2022` |
| 4 | **不收文本、忽略未知字段**：它不传文本；额外观测字段被忽略，不报 400 | `lib/index.js:2023` |
| 5 | **错误码机读且稳定**：`invalid` / `busy` / `rerunning` / `stale` / `session-not-found` / `session-not-active` / `not-rerunnable` / `already-retired` / `attachments-unsupported` —— 它原样提示给用户 | `lib/index.js:1650-1656`（RerunPlanError → HttpError 保留 code）、`:1815` |
| 6 | **链式解析**：`planRerun` 继续沿 `source.kind = plugin:dsh-edit-turn` 的就地替换链读活节点 | 回归见 `test/logic.test.js:357`（单跳）、`:619`（两跳） |

**改动前的纪律**：任何触及路由、`planRerun`、错误码的改动，先跑 `node --test test/contract.test.js`。
该文件的断言经过变异验证（在 `/tmp` 副本上做，仓库文件不动）：把探测的 400 改成 404 → 2 例转红；给 `/apply`
加一个必填 `confirmToken` → 5 例转红。也就是说，破坏上述任一形状都会被测试挡住，而不是等用户发现按钮点不动。
