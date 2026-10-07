# AGENTS.md — dsh-rerun-turn（给并行 agent 的说明）

本仓库是 DSH web 插件 **dsh-rerun-turn** 的唯一正本，经 `~/.dsh/profiles/web` 符号链接装到用户实例。改动前请先读本文件。

## 当前状态（2026-10-07）

- 版本 **0.1.27**；`lib/index.js`、`lib/client.js`、`package.json` 三处版本号必须一致。
- 改完必须本地全绿：`npm test && npm run verify:contract && npm run verify:client`（当前 **60** 单测 / **29** 契约 / 7 客户端检查；单测 = 宿主 + 客户端 DOM + 跨插件契约 + 轮次 bracket/seq 索引 + 载体不占轮次 + 载体两种内容形状，由 0.1.21~0.1.27 多轮加固带入 —— 原记 17、26、42、49、50、53、56 均为过期值）。
- 广告与规划**必须**共用 `resolveRerunPrompt`（0.1.24 起）；该函数现在还负责「静默载体不是提示词」（0.1.26 起；0.1.27 起「静默」= 没有可读文本，而不是"内容为空"）。详见文末。
- **载体不占轮次**（0.1.26 起，回到 0.1.1 的设计）：遮蔽载体是一条**没有可读文本**的 `user/message`（`source.kind = plugin:dsh-rerun-turn`），不写 turn/step 括号、不调 `syncLoopTurn`。0.1.14-0.1.25 的"空 system/message + 合成簿记轮"会让每重跑一次多一个没有内容的轮次（屏幕上是空的「已完成」条，轨迹视图跳号），不要再改回去；详见文末交接。
- **载体内容两态**（0.1.27 起）：装载时探测已安装的 `@deepseek-ai/dsh-llm-pi-ai` —— **读到 `dsh-delete-turn:skip-empty-user` 才写 `content: []`，否则写一个零宽空格**。写死空数组会让未打补丁的宿主（DSH 桌面版）发出 `content: ''`，provider 400 并**中断整轮**（真机事故，见文末 0.1.27 交接）。
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

| # | 形状 | 现状（file:line，2026-10-07 复核） |
| --- | --- | --- |
| 1 | **挂载探测**：不带 sessionId 的 `GET /state` 在挂载时答 **400**（它按 400/405=装着、404=没装；改语义按钮会静默消失） | `lib/index.js:2381`（路由）、`:2389`（`requireSessionId` 抛 → `failure` 映射，`:2196`、`:2202`） |
| 2 | **目标解析**：`/state` 返回 `replies[]`，元素形如 `{seq, turn}`（它取被编辑那一轮里 seq 最大者） | `lib/index.js:1953`（`stateOf`）、`:1962`（`rerunnableReplies` 调用）、`:1971`（返回 `replies`）、`:1409`（广告实现） |
| 3 | **调用形状**：`POST /apply` 只要求 `sessionId` + (`seq` \| `messageId`)，**不得新增必填参数**（确认令牌之类会让链式调用直接失败） | `lib/index.js:2419`（路由）、`:2435` |
| 4 | **不收文本、忽略未知字段**：它不传文本；额外观测字段被忽略，不报 400 | `lib/index.js:2436`（`applyRerun` 只读 `seq`/`messageId`）、`:2034-2037` |
| 5 | **错误码机读且稳定**：`invalid` / `busy` / `rerunning` / `stale` / `session-not-found` / `session-not-active` / `not-rerunnable` / `already-retired` / `attachments-unsupported` —— 它原样提示给用户 | `lib/index.js:2039`（RerunPlanError → HttpError 保留 code）、`:2202`（`failure`）、`:2048`（stale） |
| 6 | **链式解析**：`planRerun` 继续沿 `source.kind = plugin:dsh-edit-turn` 的就地替换链读活节点 | 回归见 `test/logic.test.js:547`（单跳）、`:797`（两跳） |

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

## 交接：0.1.25「没有作答的轮次也要有 ↻」（2026-10-04，Lead）

用户报告：点编辑器里的「重跑」得到「已保存，但这一轮没有可重跑的作答。」，并要求「任何时候都不能没有 ↻」。

**根因**：`rerunnableReplies` 只遍历 `assistant/message`。一轮如果没有定稿作答（用户按了停止、或那一轮失败），
它既不在 `replies[]` 里，于是三处入口一起消失：

- 回答行的 ↻ 走 `repliesByMessage`（按 messageId）→ 没有；
- 用户行的 ↻ 走 `lastReplyForTurn(turn)`（`lib/client.js:670-689`）→ 找不到该轮条目 → 同样没有；
- `dsh-edit-turn` 编辑器的「重跑」按同一份 `/state` 判断 → 直接提示 `rerun-nothing`。

**修法（两处，都在宿主半侧）**：

1. `resolveTarget` 允许 `user/message` 作为目标（原先只许 `assistant/message`）；
2. `planRerun` 里限定：提示词目标**仅**在该轮没有可重跑回答时才接受，且必须**就是该轮的活提示词**
   （`target.seq === livePromptSeq`）。判定走新抽出的 `rerunnableReplyOf`，与广告侧同一份谓词，
   不让「广告」与「规划」各写一段相似代码；
3. `rerunnableReplies` 末尾补一遍：给**没有广告回答、但有活用户提示词**的轮次发一条
   `{ seq: <提示词 seq>, turn, messageId: null }`。

**为什么这是安全的**：`planRerun` 本来就只用 `target.seq` 定位轮次，重跑窗口一直是从**提示词**起算的 ——
所以「按提示词寻址」产生的计划与「按回答寻址」逐字段一致，没有引入新的重放语义。`messageId: null` 也让
回答行插槽不会误取（它按 messageId 查表）。客户端**无需改动**。

**不变式（已钉）**：

- 旧规则不许放宽：**该轮有可重跑回答时，提示词不是合法地址**（`logic.test.js:146` 的既有断言保持原样，
  `turn-brackets.test.js` 另加一例钉住）。
- 新形状同样过「凡广告必可规划」。

**验收**：53 单测 / 22 契约 / 7 客户端全绿；负向验证（还原两处改动 → 恰好两条新测试转红）；
`check-rerun-plans.mjs` 在当前会话 **广告 95 条全部可规划（M=0）**；真实数据里 `session-2dffdf89` 的
turn 48/50（被停止但提示词还在）从「无入口」变为「有入口且可规划」。

**仍未覆盖（有意）**：提示词**已被删除**（被 `dsh-delete-turn` 替换掉）的轮次依旧没有 ↻。重发一个用户
已经删掉的提示词等于撤销那次删除，与 delete-turn 的语义冲突 —— 这是产品决定，不是缺陷。当前会话的
turn 40（22:43 被停止的那一轮）正是这种：它的提示词 seq 7102 已被替换为删除载体 7106。
（0.1.26 起这条由 `resolveRerunPrompt` 的 `'carrier'` 分支机械保证：`plugin:` 开头且内容为空的 user
载体不再被当作可重发的提示词，即使它是链解析落点。）

## 交接：0.1.26「载体不占轮次」（2026-10-06，Lead）

**现象（真机）**：同一条提问反复点 ↻，屏幕上出现空壳 ——

```
[用户] Reply with exactly: FLICK   03:27 [复制][删除][↻][编辑]
  已完成，用时 2 秒
  FLICK                             ← 真正的重跑结果
  已完成，用时 1 秒                  ← 空壳：下面什么都没有
```

**日志证据**：`session-5ce30467-535c-4b90-98b8-f206a33a04ee`（真机会话，已导出到
`~/.dsh/sessions/--Users-337mu-Documents-Default~0020Project--/`）。turn 3/5/7/9/11/13 是真问答，
turn 4/6/8/10/12/14 每个只有一条 `system/message`（`source.kind = system-prompt`、`plugin =
dsh-rerun-turn`、`content: []`）——对话视图不画 system 消息，于是只剩「已完成」条；轨迹视图也不产生
行，轮号出现 4/6/8/10/12 的空洞。

**根因（为什么载体当年必须占轮次）**：格式里只有 `user/message` 可以在**没有打开中的 turn/step** 时被
读取；`system/message`/`developer/message` 属于 `STEP_EVENT_TYPES`（`requireStep`）、
`assistant/message` 走同一检查（`tool()` 里的 `requireStep`）、替换型 `tool/result` 要
`requireTurn`，而 `turn/start` 必须等于 `nextTurn`、已关闭的轮次回不去。所以 0.1.14 想让载体"完全
不进模型输入"（空 system 消息被 `deriveMessages()` 丢弃）时，就**只能**开一个轮次把它装进去。

**修法**：载体回到**不占轮次**的空 `user/message`（`buildShadowWrites(plan, rerunId,
promptRequestId)` 只返回一条写）。"模型看不到"由另一条官方保证：两个适配器都在发请求前丢掉空 user 消息
（`dsh-llm-deepseek/lib/index.js`：`if (message.role === "user" && content.length === 0) continue`；
pi-ai 同款，注释就叫 `dsh-delete-turn:skip-empty-user`）。内容必须是**空数组**——零点宽空格是文本，
会进模型输入（0.1.13 的实测结论）。
**⚠️ 0.1.27 更正（2026-10-07）：这两句里"pi-ai 同款"只对带本地手补丁的构建成立**——桌面版内置运行时没有那一行，
空数组被转成 `content: ''`，provider 400 并中断整轮。0.1.27 起形状按装载时探测二选一，详见文末最后一节。

**连带改动**（都在宿主半侧，客户端只有一处）：

1. `resolveRerunPrompt` 新增 `'carrier'` 拒绝：`source.kind` 以 `plugin:` 开头且 `content` 为空的
   user 消息是**静默载体**，不是提示词（`isSilentPluginCarrier`）。dsh-edit-turn 的改写保持
   `kind: 'user'` + `editedBy`（带新文本），不受影响，仍然可重跑。
2. `buildReplayWrites` + `rerunLedger.expectsCopy` 同步跳过**本插件自己的载体**（`isRerunCarrier`）：
   记账不是对话，复制它只会凭空多一个空 user 节点。**两处必须同时改**，否则账本会永远认为缺一个副本
   ⇒ `/state` 每次轮询都重放一批（0.1.16 的放大事故）。
3. `applyRerun` 删掉 `carrierTurn` 计算与那一处 `syncLoopTurn`（重放之后的那一处保留）。
4. `/dev/derived` 报"适配器真正发出的请求"（去掉空 user/developer 消息），live e2e 的
   「没有空白 user 消息进模型」断言因此仍然成立。
5. 客户端 `keyTurnOf` 除了从 flow key 里抠轮号，也读平台自己的 `data-chat-turn`：DSH 现在按**节点 kind**
   作 key（`turn-tail`、`["turn-tail","response"]`），只读 key 会让旧日志（和 `retiredTurns`）的空条
   留在屏幕上。

**不变式（已钉）**：

- 遮蔽**不买轮号**：`turnSpans` / `lastTurnOf` 在遮蔽前后逐字段相同（`logic.test.js`「载体不占轮次」一
  例里，对照组是 0.1.25 的 5 条写，断言它恰好开出一个 prompt/reply 都为空的 bracket）。
- 全日志**没有任何"只装载体、没有内容"的轮次**（契约校验器 `emptyTurnBrackets()`，用真 `Session` 的
  `deriveEventMessage` 判定可见性；被 `retiredTurns` 记账的旧轮不算）。
- 旧日志的读路径**逐字段不变**：`session-5ce30467` 在新旧代码下 `foldSurface`/`rerunLedger`/
  `retiredTurnList`/`rerunnableReplies` 输出 diff 为空。

**验收（复现命令）**：

~~~sh
cd dsh-rerun-turn
npm test && npm run verify:contract && npm run verify:client      # 56 / 29 / 7

# 真机校验器（0.2.0-rc.2）跑真实会话：原日志照读 + 在它上面跑一次新形状重跑
node /tmp/verify-real-session.mjs      # 需要先把会话解成 /tmp/session-5ce30467.jsonl（多帧 zstd）

# 负向验证：/tmp 副本还原源码（保留新断言）→ 恰好 4 条新增用例转红、契约校验器第一条新断言就红（"the shadow is exactly one event"）
#   /tmp/dsh-rerun-turn-negative   （HEAD 的 lib/*  + 新测试，调用点改回 4 参）
#   /tmp/dsh-rerun-turn-baseline   （全 HEAD：53 / 22 / 7，用作 harness 自证）
~~~

**如果你要把载体改回开轮次**：先读上面「根因」——除了空洞和空壳，你还要把 `syncLoopTurn` 加回来，并且在
"再生成轮号 = 载体轮 + 1"上重新验证冷读；这是 0.1.0 事故的复现路径。

## 交接：0.1.27「载体内容按宿主适配器能力二选一」（2026-10-07，Lead）

**你接手时先读这一节。** 版本 **0.1.27**（三处已一致）；**60** 单测 / **29** 契约 / 7 客户端检查全绿。

### 出了什么事（真机整轮中止，不是外观问题）

- 现场：`~/.dsh/sessions/--Users-337mu-Documents-Default~0020Project--/session-5c3c4c12-e803-492a-b614-9a0f4c5ea6a3`，
  turn 187（2026-10-07 16:27:33）`turn/end → reason.error: Failed to create stream ... 400 {"message":"user message must have content","param":"messages.93.content"}`。
  派生消息下标 93 正是本插件的遮蔽载体：事件 `seq 10968` = `{"type":"user/message","data":{"role":"user","content":[],"source":{"kind":"plugin:dsh-rerun-turn",…}}}`。
- 根因：0.1.26 把「空 user 消息会被两个官方适配器丢掉」当成了普适事实。它**只对带本地手补丁
  `dsh-delete-turn:skip-empty-user` 的 pi-ai 成立**；补丁只在 npx 缓存副本里（web 宿主没事），
  **DSH 桌面版**（`/Applications/DeepSeek Harness.app`，运行时打在 `app.asar`）没有这一行——
  `content: []` 被转成 `{ role: 'user', content: '' }`，provider 拒绝整个请求。
- provider 实测（当日，`https://api.cline.bot/api/v1`，`cline-pass/deepseek-v4.1-flash`，与失败会话同路）：
  `content: ""` → `stream_initialization_failed`；`content: []` → 同样失败；`content: "\u200b"` → **通过**；
  `content: "ok"` → 通过。
- 只读复核（本次改动时重做）：`grep -c 'dsh-delete-turn:skip-empty-user' <app.asar>` = **0**
  （同一 asar 里 `dsh-llm-pi-ai` 出现 70 次，说明 grep 有效）；npx 缓存那份 `dsh-llm-pi-ai/lib/index.js`
  `marker = true`。

### 修法（都在宿主半侧；客户端没改）

1. `buildShadowWrites(plan, rerunId, promptRequestId, dropsEmptyUserContent = ADAPTER_DROPS_EMPTY_USER_CONTENT)`
   —— 形状是**第 4 个可选参数**，默认取装载时算一次的探测结果。测试传布尔值，不碰本机 npx 缓存、不碰 `process.argv`。
2. 纯函数三件套（都导出）：`ADAPTER_PATCH_MARKER`（`'dsh-delete-turn:skip-empty-user'`）、
   `adapterSourceDropsEmptyUserContent(adapterSource)`（源码文本 → 布尔）、
   `silentCarrierContent(dropsEmptyUserContent)`（布尔 → `[]` 或 `[{ type:'text', text:'\u200b' }]`，
   **非 `true` 一律走零宽**）；另有 `probeAdapterDropsEmptyUserContent()` 从 `process.argv[1]` 所在目录解析
   `@deepseek-ai/dsh-llm-pi-ai` 并读文件，**任何异常都是"没有证明"**。
3. `isSilentPluginCarrier` 由「`content.length === 0`」放宽为「**没有可读文本**」：空数组，或文本块只含
   空白/零宽字符（`INVISIBLE_TEXT_RE`）。非文本块（图片/文件）仍算可读。**这条是必需的**：不放宽的话，
   零宽载体在链式重跑里会被 `resolveRerunPrompt` 当成人类提示词重发。
4. `/dev/derived`：只在**有证明**时才把空 user 消息从报告里滤掉（没证明时那条零宽消息**就是**适配器发出的东西，
   如实报告），并新增 `carrier: { shape: 'empty' | 'zero-width-space', adapterDropsEmptyUserContent }`。
   `tools/verify-live-e2e.mjs` 的「没有空白 user 消息进模型」断言按这个字段分支。
5. 契约校验器 `tools/verify-surface-contract.mjs` 的载体断言改为与本机探测一致
   （`CARRIER_CONTENT = PLUGIN.silentCarrierContent(PLUGIN.ADAPTER_DROPS_EMPTY_USER_CONTENT)`），并在
   「派生上下文恰好 A B C1' D' E'」一例里钉死：**没有证明时派生请求里不得存在空 user 消息**。

### 不变式（0.1.26 原样保留，别动）

- 遮蔽仍是**恰好一条不占轮次的事件**、不写 turn/step 括号、不调 `syncLoopTurn`；`resolveRerunPrompt` 的
  `'carrier'` 拒绝、`isRerunCarrier` 的账本/重放跳过照旧 —— 形状判定**只看 source 标记，不看内容**。
- **要改回空载体，必须先证明当前安装的适配器会丢掉它**：`node -e` 解析 pi-ai 并检查标记，或跑一次真机轮次
  看 provider 是否 400。没有证明就是零宽空格。

### 验收与负向验证（本次实测数字）

~~~sh
cd dsh-rerun-turn
npm test && npm run verify:contract && npm run verify:client      # 60 / 29 / 7

# 另一支也必须绿：/tmp 副本把 ADAPTER_DROPS_EMPTY_USER_CONTENT 强制为 false
#   /tmp/dsh-rerun-turn-zwsp      → 60 / 29 / 7 全绿（证明两支都受支持）
# 负向：/tmp 副本只还原载体行为（silentCarrierContent 恒返回 []、isSilentPluginCarrier 要求精确为空），
#       保留全部新用例 → 恰好 2 条新用例转红：
#         「without the adapter proof the carrier falls back to one zero-width space」
#         「a fallback carrier standing where the prompt was is not a re-sendable prompt」
#       再把探测强制为 false → 契约校验器在「an unproven host must not write an empty carrier」转红。
#   /tmp/dsh-rerun-turn-negative
~~~

**仍未验证（诚实说明）**：桌面版（`app.asar`）里的探测**没有真机跑过**——只读复核了 asar 里没有补丁标记，
但没有在 Electron 运行时里执行 `createRequire(...).resolve(...)`。探测失败的方向是安全的（→ 零宽空格，
provider 接受）。按惯例：改 `lib/client.js` 要重启宿主 + 硬刷新页面，本次客户端只动了版本号。
