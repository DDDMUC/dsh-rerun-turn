# AGENTS.md — dsh-rerun-turn（给并行 agent 的说明）

本仓库是 DSH web 插件 **dsh-rerun-turn** 的唯一正本，经 `~/.dsh/profiles/web` 符号链接装到用户实例。改动前请先读本文件。

## 当前状态（2026-10-02）

- 版本 **0.1.24**；`lib/index.js`、`lib/client.js`、`package.json` 三处版本号必须一致。
- 改完必须本地全绿：`npm test && npm run verify:contract && npm run verify:client`（当前 **50** 单测 / 22 契约 / 7 客户端检查；单测 = 18 宿主 + 8 客户端 DOM + 16 跨插件契约 + 8 轮次 bracket/seq 索引，由 0.1.21~0.1.24 四轮加固带入 —— 原记 17、26、42、49 均为过期值）。
- 广告与规划**必须**共用 `resolveRerunPrompt`（0.1.24 起）；详见文末。
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

## 交接：0.1.23「这条回答不支持重跑」修复（2026-10-01，Lead）

**你接手时先读这一节。** 代码提交 `564b2b2`（本文档的提交紧随其后），版本 **0.1.23**（三处已一致），已推 origin/main。
49 单测 / 22 契约 / 7 客户端检查全绿。

### 修了什么（三个缺陷，一个症状）

用户点 ↻ 得到「这条回答不支持重跑」（= 宿主 `not-rerunnable`）。用他那个会话的真实日志
（`session-2dffdf89`，629 事件、含四次重跑）复现：修复前 32 条被广告、只有 2 条能规划；修复后 **30 条广告、30 条可规划、0 拒绝**。

| # | 缺陷 | 证据 | 修法 |
| --- | --- | --- | --- |
| 1 | **轮次号被拆成多个 bracket，规划器取同号的第一个**。重放会开出复用轮次号却**没有用户消息**的记账 bracket，于是 `turnSpans(...).find(turn === n)` 命中那个空 bracket → `promptSeq: null` → 「the turn has no prompt to re-send」 | 该会话 turn 49/51 各两个 bracket（第一个 `promptSeq: null`） | 取**范围包含该作答**的 bracket；退路：带提示词的 → 同号第一个（`bracketOwning`） |
| 2 | **数组下标当 seq 读**：`events[seq]`。日志首行是 header 记录（平台扫描器会剥掉），resume 的会话还继承日志头 | 同一会话里 `events[624]` 拿到的是 `seq 623 / step/start` → 「the turn prompt is not a user message」**（截图那句）** | 所有按 seq 取事件改走索引（`eventIndex`）：规划器、logTo 游走、重放区间、busy 扫描、前缀上限（那是**计数**不是下标） |
| 3 | **广告 ≠ 承诺**：`replies[]` 广告 32 条，规划器只认 2 条 | 客户端按 `code` 渲染文案，点了必然失败 | 两侧共用 `bracketOwning` / `followToSurface` / `replacementChains`，只有一份实现；无提示词、或提示词已不在界面上的作答**不入列表** |

### 你现在要做的一件事

**重启宿主 + 硬刷新页面**（按你上午那次的方式）。这次改的是**宿主半侧**（`lib/index.js`），
HMR 不会把它带进正在跑的进程 —— 不重启的话页面上仍是旧 host，症状不变。

重启后三条验收（都不需要登录页面）：

1. `curl -s http://127.0.0.1:3080/dsh-rerun-turn/debug` → `version` 应为 **0.1.23**；
2. 打开那个会话，点任意一条作答 / 用户行的 ↻ → 应当开始重跑，**不再出现**「这条回答不支持重跑」；
3. 真机再数一次每行的注入宿主数，仍应为 1（0.1.22 的约定不变）。

### 复现与回归（改这一块之前必跑）

~~~sh
cd dsh-rerun-turn
npm test && npm run verify:contract && npm run verify:client     # 49 / 22 / 7
node --test test/turn-brackets.test.js                          # 7 例，直击本次三个缺陷
# 任意会话的实况自检（只读，不启动 DSH）：
node "../_aistudio-reports/check-rerun-plans.mjs" "$HOME/.dsh/sessions/<project>/<session>/session.v4.jsonl.zstd"
~~~

最后一个命令打印「广告 N 条 / 其中 M 条规划失败」。**M 必须为 0** —— 不为 0 就是本类缺陷复发，
输出里直接给出 `turn / seq / code / message`，不必再去猜或复现一次点击。

### 不要破坏的不变式（`test/turn-brackets.test.js` 已钉死）

- **凡广告必可规划**：`rerunnableReplies()` 返回的每一条，`planRerun()` 都必须成功 —— 第 3 个缺陷的回归网；加新过滤条件时两侧都要过它。
- **列表不是 seq 向量**：带 header 记录、继承日志头（首条事件 seq 远大于 0）、塞入无 seq 的填充记录 —— 三种形状下计划与广告必须与稠密数组**逐字段一致**。
- **没有提示词的作答不许借别人的提示词**：它自己的 bracket 没有 prompt 时宁可按 `not-rerunnable` 拒绝，也不许回退到相邻 bracket 重新提问（那会把一个从未产生这条作答的问题再发一次）。
- 跨插件契约（dsh-edit-turn → 你）在下一节，`test/contract.test.js` 16 例，同样别动。

## 交接：0.1.24「广告≠承诺」的最后一个形状（2026-10-02，Lead）

0.1.23 之后，`check-rerun-plans.mjs` 在 **`session-e81f9424`（turn 31 / seq 3979）** 仍有 M=1：
作答在界面上，但提示词被 `dsh-delete-turn` 两步替换——用户载体 → 最终 **`system/message`** 载体——
链解析落在界面上却**不是 `user/message`**。广告侧只验「活节点存在」，规划侧还验「活节点是用户消息」，两处判据仍分叉。

修法：抽出一个**唯一的** `resolveRerunPrompt(bySeq, nodeIndex, brackets, revisions, head, turn, targetSeq)`
（`lib/index.js`，`followToSurface` 之后），返回 `{ reason: null, promptSeq, span }` 或
`{ reason: 'no-prompt' | 'retired' | 'not-user' | 'head' }`。`planRerun` 与 `rerunnableReplies` 都只走它，
各自把 reason 映射成稳定错误码 / 静默排除。**凡广告必可规划**从此由构造保证，不再靠两段相似代码同步。

- 回归：`test/turn-brackets.test.js` 新增「提示词 → 兄弟用户载体 → system 载体」样例（链解析落在非用户节点 → 不广告、规划拒绝）。
- 顺带修正：`logic.test.js` 的 `standardLog` 没有 system 头，首条用户消息即 surface 头；`planRerun` 本就拒绝重跑头，
  旧的广告却发了它——该测试预期已改为 `[c1,c2,d1]` 并加了「每条广告都能规划」的交叉断言。
- 验收：8 个真实会话（含 10953 事件）`check-rerun-plans.mjs` 全部 **M=0**；50 单测 / 22 契约 / 7 客户端全绿。

**新增不变式**：广告与规划**必须**共用 `resolveRerunPrompt`。给 `rerunnableReplies` 加任何新过滤，
都要问「`planRerun` 会不会因为另一条判据拒绝它」，并把判据挪进该函数，而不是并排再加一个 `if`。
