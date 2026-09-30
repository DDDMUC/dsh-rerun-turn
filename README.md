# dsh-rerun-turn

**DeepSeek Harness 的中缀重跑插件 —— 点某条模型回答旁的「重跑这一轮」，这一轮会用同一句提示词重新生成，而它之后的每一轮原样留在模型上下文里：后续调用读到的历史是 A B C1 D E F G。** 重跑由官方 surface-replace 契约 + 一次逐事件重放组成（把被遮蔽的后续轮次以官方事件追加回来），append-only 会话日志一个字节都不改写。

[中文](#中文) · [English](#english)

---

## 中文

### 为什么需要它

DSH 的模型上下文是每次调用从会话 surface 重新推导的。官方只有「回退到末尾」式的编辑（dsh-edit-turn 的默认行为是改一条消息、丢掉它之后的一切），没有「重跑中间那一轮、后面照旧」这条路——因为在 surface-replace 契约里，**模型回答永远不能充当替换载体**（`assistant/message` 被格式明令禁止携带 `sourceEventSeqs`），所以一条回答无法原地换掉。

这个插件把它做出来：

- 悬停任意一条**模型回答**，动作条里出现 ↻「重跑这一轮」；
- 点击后：这一轮从**它自己的提示词**开始重新生成（模型看到的上下文正好是 A B + 那句提示词，不带旧回答、也不带后面的轮次）；
- 生成完成之后，之前被移出 surface 的**后续轮次逐事件重放**回去（新轮号、新消息 id、原内容），它们看起来就是普通的历史；
- 后续任何一次调用发送的历史都是 **A B C1 D E F G + 新内容**——中缀拼接，前后都不受影响。

### 特性

- **中缀重跑（本插件的全部意义）** —— 重放把后续轮次以官方事件写回日志，冷读、导出、其他实例看到的内容与模型上下文完全一致。不是"改画面"，是真的上下文。
- **只用官方缝** —— 遮蔽是一条标准的 `surfaceOp: { op: 'replace', startSeq, endSeq }` 替换事件（与 `/compact` 同一契约）；重放是普通的 `append` 事件。**没有自定义事件类型**——外挂插件的事件无法通过 v4 格式校验（未知类型必须带 `ignorable`，而 `Session.append` 不写这个字段），这条约束直接排除了"自定义投影事件"的路线。
- **静默载体** —— 遮蔽载体是一个**空的 `developer/message`**（空内容投影为零条模型消息），并按格式要求包在一个开合完整的合成轮次里（格式只在打开的轮次+步骤里读 developer 消息——这一点由兄弟插件 dsh-edit-turn 在真实校验器上踩实）。
- **重放保真** —— 逐事件复制：轮次括号、用户消息、助手消息（含思考与工具调用块）、`tool/call`、`tool/result`（`sourceEventSeqs` 重映射到副本）、`TOOL_NOT_STARTED` 修复结果（保留其"无 sourceEventSeqs"的精确形状）；丢弃 `usage`（防统计翻倍）、内嵌 stream、系统消息（系统提示词由循环自己调和）与全部纯记账事件。
- **崩溃可恢复** —— 承载事件记住 `rerunId`，fold 记住它遮蔽了哪些节点，每个副本带 `originalSeq` 标记；"哪些副本还没写"永远可以从日志单独算出来。`/state` 默认自动续传（会话活着、空闲、收件箱为空时），半写的括号孤儿会被识别并续写而不是误判为忙。
- **准入失败也有正确回退** —— 重新生成没能入队时，重放会把提示词本身也复制回去，上下文内容与重跑前完全一致（不丢问题）。
- **图片可重送** —— 原提示词里的图片会重新读字节、以 base64 重走官方 prompt 准入；文件附件暂时拒绝（见已知限制）。
- **中英双语 UI，跟随 DSH 当前语言；皮肤友好**（面板自绘表面，暗色走官方 `body[data-ds-dark-theme]`）。
- **宿主路由只限本机回环**，并校验 `Host` 与 `Origin`。

### 安装

```sh
dsh plugin --profile web add dsh-rerun-turn
```

从本地目录安装（开发用）：

```sh
dsh plugin --profile web add /path/to/dsh-rerun-turn
```

`patchReload: live` 的 profile 会热加载；否则重启该 profile 对应的 DSH 进程。

### 使用

1. 把鼠标移到想重跑的那条**模型回答**上，点 ↻（官方动作条最左，编辑铅笔旁边）。
2. 后台立刻开始：旧的一轮及其后内容先从模型上下文移除，提示词重新发给模型，新回答流式出现；结束后后续轮次自动重放回来。期间按钮隐藏（避免和正在生成的轮次打架）。
3. 界面上：被退役的旧行隐藏，新生成的回答与重放的行正常出现——最终看到的顺序就是模型读到的顺序。

默认一次点击即执行（配置 `confirm: true` 恢复二次确认）。

### 配置

```yaml
- id: dsh-rerun-turn
  config:
    confirm: false            # 默认 false：一次点击即执行
    autoResume: true          # 默认 true：中断的重放在会话空闲时自动续传
    idleTimeoutMs: 600000     # 等待新回答落地的最长时间
    devTools: false           # 默认 false：端到端验证用的 /dev/* 回环路由
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `confirm` | `false` | 客户端是否先弹一次确认（按钮下方内联确认条）。 |
| `autoResume` | `true` | `/state` 是否在会话活着、空闲、收件箱为空时自动完成被中断的重放（不花模型调用）。 |
| `idleTimeoutMs` | `600000` | 等待新回答闭合的最长时间；超时后重放留给续传。 |
| `devTools` | `false` | 是否挂载验证用回环路由 `/dev/scratch`、`/dev/derived`（会发真实模型调用）。 |

### 工作原理

一次重跑是三组官方操作，按序落地：

**① 遮蔽（SHADOW）。** 从目标轮次的提示词到 surface 末尾，是一条连续的窗口；追加一条带 `surfaceOp: { op: 'replace', startSeq, endSeq }` 的**不占轮次**的 `user/message` 载体，`sourceEventSeqs` 完整列出被遮蔽的每一个节点。载体内容是单个零宽空格（真实 provider 接受、对模型不可见），`source.kind = plugin:dsh-rerun-turn`（平台不会把它当人类提问回答，也不该回答）。

> **为什么载体不能开轮次（0.1.1 的事故与修复）**：0.1.0 用"空 developer/message + 自开轮次"当载体。它通过了追加校验，但**代理循环的轮号计数器是进程内局部的**——只统计循环自己开的轮，永不重读日志里的最大轮号。于是循环为再生成开轮时**复用了载体占过的号**，日志从此冷读失败（`turn/start does not open the expected turn`）。同理，重放写下的轮次也会被循环的下一次开轮撞上。0.1.1 的修复有两件：载体彻底不占轮次；**重放完成后把循环的空闲计数器同步到日志真实最大轮号**（`syncLoopTurn`，带形状守卫、失败降级并写诊断——DSH 没有官方重同步 API，这是本插件唯一一处触及循环状态的地方）。

**② 再生成（REGENERATE）。** 走官方准入路径 `ctx.sessionController.prompt({ mode: 'queue', content: 原提示词 })`。模型看到的正是 A B + 提示词，用会话自己的模型与工具重新回答。后台任务通过 `agent.whenIdle()`（失败时轮询日志的 `turn/end`）等它闭合。

**③ 重放（REPLAY）。** 从**目标轮之后的下一轮**开始（目标轮自己的旧回答是被替换掉的，不重放），逐事件复制到日志尾部：

- `turn/start` / `step/start` / `step/end` / `turn/end` —— 轮号重排为紧接生成轮之后的连续编号（格式的 `Relationships` 要求 `turn/start` 恰好打开 `nextTurn`）；
- `user/message` / `assistant/message` / `tool/result` —— 新 id、新轮号/步骤、原文内容、`sourceEventSeqs` 重映射；消息 `source` 加 `{ rerunBy, rerunId, originalSeq }` 标记；
- `tool/call` —— 与结果成对才复制；悬空调用连同助手内容里的工具调用块一起剥掉（格式拒绝带着未决调用的轮次收尾）；`TOOL_NOT_STARTED` 修复结果保留"无 sourceEventSeqs"的形状（校验器只接受这种修复形状）；
- 系统消息与纯记账事件（attempt、retry、inbox、title、deliverable 卡片……）不复制。

**为什么不做文件改写 / 消息投影？** 会话日志 append-only；外挂插件的自定义投影事件过不了 v4 读取校验；而 `assistant/message` 不能携带 `sourceEventSeqs`，这就是"回答必须靠回退+重放换位"的根本原因（三条都在真实校验器上验证过）。

**崩溃恢复。** 承载事件源里的 `rerunId`/`promptRequestId`/`replayFrom`/`rerunTurnEnd` + fold 的 `shadowed` 列表 + 每个副本的 `originalSeq` 标记，让"哪些副本缺失"完全可从日志推导。`/state` 报出未完成的重跑；续传只写缺失的后缀，并用"尾部前缀匹配"跳过崩溃前已经落地的括号写（避免重复 `turn/start` 让日志读不出来）。

**插件接口**

| 类型 | 名称 | 说明 |
|---|---|---|
| 路由 | `GET /dsh-rerun-turn/state?sessionId=` | 可重跑的作答、hidden 账本、重跑记录（含 `complete`/`missing`）、忙碌/进度 |
| 路由 | `POST /dsh-rerun-turn/apply` | `{ sessionId, seq \| messageId }` → 遮蔽 + 后台再生成/重放；响应含 `started`/`rerunId`/`shadowed` |
| 路由 | `POST /dsh-rerun-turn/replay` | `{ sessionId, rerunId? }` → 为中断的重跑补写重放 |
| 路由 | `GET /dsh-rerun-turn/debug` | 只读请求记录（诊断"点了没反应"） |
| 路由 | `GET/POST /dev/scratch`、`GET /dev/derived` | `devTools: true` 才挂载；端到端验证用 |
| 前端 | `conversation.chat.assistant-actions` | 回答动作条里的 ↻ 入口（order 6，编辑铅笔之后） |
| 前端 | `conversation.input.overlay` | 隐藏被退役的行、跟随后台重跑、显示确认/错误 |

**给兄弟插件的契约**：每次重跑落一条 `developer/message` 替换载体（`source.kind === 'plugin:dsh-rerun-turn'`、`rerunBy`、`rerunId`）；每个重放副本的 `message.source` 带 `{ rerunBy, rerunId, originalSeq }`。按 surface 校验的入口可以沿 `/state` 的 `reruns[].shadowed` 或副本的 `originalSeq` 找到活节点。

### 验证状态

本插件在 DSH `0.1.7-rc.2`（npx 实例）上完成以下验证：

| 验证 | 命令 | 结果 |
|---|---|---|
| 单测（窗口规划、重放改写、标记、恢复匹配、计数器同步，+ 客户端 DOM stub 的注入/隐藏/重装用例） | `npm test` | **26 项通过**（18 宿主 + 8 客户端 DOM） |
| 官方校验器契约（真实 `Session` + `sessionFormatCatalog` **strict 冷读**往返） | `npm run verify:contract` | **22 项通过**：完整重跑后的日志（含重跑后新增的普通轮）通过 v4 词汇表/关系/生命周期 + `Session.fromRestore`；派生上下文恰好 **A B C1' D' E'**；链式重跑；崩溃半写后续传；准入失败回退；`TOOL_NOT_STARTED` 修复保真 |
| 客户端静态检查 + 运行中实例下发字节 | `npm run verify:client` / `npm run verify:live -- <token 日志>` | **7 项通过**：模块可加载、槽位/字典/版本/错误码一致；3080 实例下发的模块组里就是本插件的当前字节 |
| **真实沙箱端到端**（独立 DSH_HOME + 独立端口，真实模型调用） | `npm run verify:e2e` | **通过**：3 轮 scratch 会话 → `/apply` 重跑中间轮 → 后台生成+重放完成 → **追加第 4 轮提示** → 读**实时派生上下文**：提示词保序、中间回答是新生成的、后一轮是带 `originalSeq` 标记的重放副本；随后用 `tools/repair-session.mjs` 对沙箱写出的日志做**严格冷读校验：0 broken** |
| 运行中实例挂载探针 | `npm run probe:loaded [端口]` | 通过：`/state` 返 400、`/apply` 返 405 |

**尚未验证的一环（诚实说明）**：浏览器里的**交互渲染**（按钮落位、点击、隐藏行）还没有自动化冒烟——本机没有可用的浏览器驱动接线；客户端半部的加载、槽位注册与真实下发已由 `verify:client`/`verify:live` 覆盖，宿主行为由端到端覆盖。首次使用请在浏览器里刷新一次 DSH 页面确认按钮出现。

### 已知限制

- **只能重跑有提示词的轮次**：目标回答所属轮次必须有一条 `user/message` 提示词（人类提问或注入的用户消息都算）；系统提示词头不可重跑。
- **一次重跑整轮**：点某一步的回答 = 重跑它所在的整个轮次（提示词重新发送、整轮重新生成）。多步轮次的中间回答同样按整轮处理。
- **带文件附件的提示词拒绝重跑**（`attachments-unsupported`）：prompt 准入要求文件走上传收据，durable 引用无法直接重送；图片可以。
- **重放副本是有损拷贝**：`usage`、内嵌 stream 被丢弃（防 token 统计翻倍）；系统消息与 deliverable/workspace/todo 等纯记账事件不复制；被重放轮次里的工具**不会重新执行**（结果照抄）。
- **重跑期间用户又发消息**：重放会等会话空闲（忙时延后、最多 ~60 秒后转交续传），仍可能把副本排到新轮次之后——这是同一时间只有一个写者的自然限制，也是续传路径存在的原因。
- **卸载插件后**：重跑已经落地的效果保留（全是官方事件）；但被退役的旧行会重新显示，界面看起来像重复（模型上下文不受影响）。
- **会话必须当前置活**（web 实例已打开）；忙碌（有未闭合轮次/压缩中）时拒绝。
- **没有撤销**：重跑是破坏性的上下文操作（旧轮次从模型视野永久退役，日志里仍在）。想保留原文形成分支要走官方的 fork，未实现。
- **兄弟插件的已知问题（与本插件无关）**：`dsh-delete-turn` 0.1.x 删除模型回答时会落一条 `system/message` 替换载体（source 为 `plugin:dsh-delete-turn`），而格式只允许 system-prompt 来源的 system 消息——含这种事件的会话在冷读时报 `seed system/message ... must have system-prompt source`、历史打不开。修复方向与 `dsh-edit-turn` 0.2.4 相同（载体改为不占轮次的 `user/message`，或空 `developer/message` + 合成轮）。本仓库的修复工具能用 `--force` 截断这类坏日志。

### 排查

0. **点了 ↻ 提示「这条回答已经不在当前上下文里了」**：你点的是**已经被退役的旧回答**——最常见的情形是刚重跑完，客户端还没来得及刷新那一行，又点了一次。0.1.2 起这种情况会静默刷新、不报错。
1. 按钮没出现：`npm run probe:loaded [端口]`——404 说明插件没挂载；400/405 说明挂载正常，问题在浏览器（刷新页面、看控制台）。
2. 点了没反应：`GET /dsh-rerun-turn/debug`——没有 `apply` 记录 = 点击丢在浏览器半边；有 apply 且 `ok:false` = 宿主拒绝，`code` 是原因。
3. 重跑后历史看起来缺了后续轮次：等几秒（重放等待新回答闭合），或 `GET /state` 看 `reruns[].complete`/`missing` 与 `progress`；`interrupted` 时默认会自动续传。
4. **「历史加载失败 / 会话读不出来」**：可能是 0.1.0 留下的坏日志（见更新日志）。先让持有该会话的实例释放它（重启 DSH），再运行：

   ```sh
   node tools/repair-session.mjs ~/.dsh/sessions --dry-run   # 先看
   node tools/repair-session.mjs ~/.dsh/sessions             # 修复（先备份）
   ```

   工具只自动修复带 `plugin:dsh-rerun-turn` 标记的坏日志；其他坏日志只报告不动。修复后重开会话，待处理的提示词会被循环自动补答。

### 更新日志

**0.1.22** —— 修复「重新 apply 时注入节点不清理 → 幽灵按钮堆积」：行内注入前先复用已有宿主（不再删旧的再造新的），fiber dispose 时按命名空间属性清扫本插件的注入节点。

- **先复用**：注入前按 `[data-dsrr-action-host="1"]` 查一次行内已有宿主，找到就复用同一个节点（WeakMap 重新指向它），绝不新建第二个；重复的旧副本（本插件自己的节点）才删。
- **卸载即清理**：dispose 里同步扫掉自建的宿主（含行内按钮）与本插件 append 的样式表，并在下一个任务再扫一次由 React 渲染的节点（回答条按钮、浮层根）——React 会自己卸载它们，抢在它前面删会让 React 的 removeChild 抛错。只删本插件自己的节点（`data-dsrr-*` 命名空间 / 本插件 id 的 `style`），宿主与兄弟插件的节点一律不动。

**0.1.21** —— 互操作加固（AI Studio 组件契约）：输入框浮层槽位号 8 → 10、隐藏归属守卫、注入节点带命名空间。

- **槽位号（契约 §2）**：`conversation.input.overlay` 上 delete-turn 8 / edit-turn 9 / 本插件 10——同号会让两个浮层的先后未定义。回答行操作条保持 order 6（分配表内唯一）。
- **隐藏归属（契约 I4）**：`setRowHidden` 只在**没有** `data-dshdt-hidden` / `data-dshet-hidden` 时才把 `display` 置回、才删掉自己的 `data-dsrr-hidden`；兄弟插件的隐藏继续生效，自己从未设过的 `display:none` 一律不碰。
- **注入命名（契约 I3）**：用户行操作条里自建的节点带 `data-dsrr-action-host` / `data-dsrr-action`，浮层根带 `data-dsrr-overlay`；重复扫描复用同一节点，不重复插入、不动宿主与兄弟插件的节点。

**0.1.20** —— 用户消息行也有重跑按钮（与回答行同一功能）。

- 官方只给回答行 action 插槽；用户行沿用兄弟插件（`dsh-edit-turn`）的做法，运行时注入官方操作条（`[class*="_actions"]`，排在平台动作之后）。
- 点击走**同一个控制器流程**（确认弹窗、就地替换、后续轮保留）：按行上的回合号找到该回合的最终回答作为目标；回答不存在或已作废时按钮自动移除，行被隐藏时随之隐藏。
- 沙箱实测：点用户行 ↻ 正确重跑第 1 轮，拼接上下文正确。

**0.1.19** —— 修复「回答过程中旧回答提前消失、答完才恢复」。

- 根因：`hasFresh` 把新回合的**进程条/尾巴条**也算作"替代回答已到屏"——重跑一开始旧回答就被隐藏，整个生成期间原位是个空洞，完成后新回答才接上。
- 修复：只有真正的新回答行（assistant-step / 工具调用）出现，旧回答才退场。沙箱 300 ms 粒度采样验证：生成中旧回答留在原位，新回答落地的同一帧切换。

**0.1.18** —— 只有括号、没有任何消息的"空回合"也不再显示"用时"残条（末尾可能正在生成的回合除外）。

**0.1.17** —— 被整体作废的回合不再留下空"用时"条。

- `/state` 新增 `retiredTurns`（内容全部退役的回合号；镜像 hidden 的 complete/in-flight 门控），客户端把该回合的过程/尾巴条一并隐藏；只带 system 节点的回合按空回合处理。
- 现场实测：26 个残条回合消失，只剩 3 个真实交换。

**0.1.16** —— 修复**自动补写失控**（窗口里含 system 消息的会话被逐秒复制放大）。

- 根因：账本要求每个被遮蔽节点都有副本，但重放按设计**永不复制 `system/message`**——该 seq 永远 missing ⇒ `complete` 永远 false ⇒ 每次 `/state` 轮询都自动补写一整批副本并循环放大（现场：1 492 → 2 900 事件、536 轮）。
- 修复：账本只对可复制类型（user/assistant/tool）要求副本；自动补写另加"无进展"闸门（同一 missing 签名 10 秒内不重试）。
- 补充：重放本身是纯日志写入、不调用模型（现场会话只有 5 个模型请求）；全库 13 个会话用新账本重读无 incomplete。

**0.1.15** —— 消除原地重组的闪烁。

- 行样式改在 MutationObserver 回调（微任务）里**同步应用**——行出现的那一帧即被隐藏/移位，不再先闪错位置；`load()` 请求合并，行数只在增长时刷新。

**0.1.14** —— 静默载体改为**模型输入里完全不存在**的形状（采纳 dsh-delete-turn 0.2.x 的验证结论）。

- **问题**：此前的载体是零宽空格的 `user/message`——它确实在模型输入里，模型会主动指出「只包含零宽空格、几乎空白的消息」（实测）。"静默"名不副实。
- **新形状**：载体是**空内容 `system/message`**（`deriveMessages()` 直接丢弃空 system 节点，模型输入里不存在），source 为 `{ kind: 'system-prompt', plugin: 'dsh-rerun-turn', ... }`（格式只允许 system 消息来自 system-prompt 来源，`plugin` 等额外键用于标记自己的载体）。system 消息被钉在"打开中的 turn+step"，所以包在**合成簿记回合**里：`turn/start(N) → step/start(N,1) → 空载体(replace) → step/end → turn/end`，`N = 日志中 turn/end 数量 + 1`；宿主同时把空闲 loop 的轮号计数器同步到 N，保证再生成轮拿 N+1（0.2.0-rc.1 实测正常）。
- **客户端**：`/state` 新增 `markerTurns`（各次重跑的簿记回合号），客户端把这些回合的过程/尾巴行整体隐藏——簿记回合在界面上完全不可见。
- **验证**：真实校验器契约 22 项（含空 system 载体 + 合成回合的严格冷读）；**0.2.0-rc.1 沙箱端到端新增断言「模型输入里没有任何空白或零宽用户消息」并通过**；15 单测 / 客户端静态全绿。此前含零宽载体的旧测试会话建议删除。

**0.1.13** —— 修复**链式重跑会把已退役的旧内容复活**（重复历史堆叠的真正成因）。

- **根因**：重放此前按"日志区间"逐事件复制。链式重跑后，区间里会夹着**早已被前次重跑退役**的旧事件（原轮与旧副本），它们被一并复制回上下文——每多跑一次就多叠一层重复（现场会话：3 条交换被跑成 6 条，「回复1」成摞）。这不只是观感：模型上下文同样被重复污染。
- **修复**：重放只复制**当前 surface 被遮蔽的节点**（窗口的 `shadowed` 集合）+ 这些轮次的括号与 tool/call（日志伴生事件），任何已退役的日志残留一律跳过。重跑多少次，交换数量与内容都保持与重跑前一致的一一对应。
- 新增契约场景 7（真实校验器）：跑"重跑中间轮 → 再重跑更早轮"（走查区间必然包含退役事件），断言派生上下文只有 3 条交换、且第二条重跑的每个副本都只引用本次窗口内的 surface 节点。22 契约项全过。
- 已受影响的测试会话（链式重跑产生的重复历史）建议直接删除；真实工作会话无重跑、不受影响。

**0.1.12** —— 去掉进行中的提示条（按要求）。

- 生成期间不再显示「正在重跑这一轮…」的状态条；原地替换本身已经把过程表达清楚（旧回答原位换成「深度求索中 → 新回答」），不需要额外文字。错误类提示（重放中断、失败等）保持不变。

**0.1.11** —— 原地重跑：新回答在旧回答的位置流式出现，完成时无缝收口。

- **之前为什么不像"原地"**：日志 append-only，新轮必须先追加到末尾；旧实现于是表现为"新轮在底部流式生成 → 完成后整体跳到原位"。上下文推导其实一直是原地（A B C1 D E F G），但生成期间的观感不是。
- **现在（纯客户端，刷新即生效）**：会话行容器是 `flex column`，客户端用 flex `order` 在生成期间把新行**原地重排**——重发的提示词隐藏（旧提示词原位保留，不出现重复措辞）、旧回答在其新回答即将出现时退场、新回答（含「深度求索中」过程）落到旧回答的位置；之后的轮次保持原位。重放落地时清除全部临时排序，自然收口。
- **现场验证**：生成中新回答行 `order=1` 且落在旧位置；完成后临时排序清零、视图只剩一份提示词与新回答。

**0.1.10** —— 提示条不再压在输入框上。

- **现象**：`conversation.input.overlay` 槽位的宿主是 0 高度、位于输入框上沿，插件的提示/确认条在正常流中向下溢出——提示文字与输入框占位文字叠在一起（现场：提示 y 633–666，输入框 y 637–673）。
- **修复（纯客户端，刷新即生效）**：所有提示包进 `.dsrr-stack`，整体按自身高度上移（`translateY(-100%)`），完整落在输入框上方；多条提示时在栈内正常堆叠。实测：提示 600–633、输入框 637–673，零重叠、间隙 4px。

**0.1.9** —— 生成期间其它轮的入口不再消失：重跑按钮常驻，一次一个由宿主明说。

- **现象**：此前客户端在会话忙碌或有重跑在飞时把所有 ↻ 隐藏（各轮一起消失），点不到也没有任何解释——看起来像"重跑影响了其它轮"。
- **修复（纯客户端，刷新即生效）**：↻ 不再因忙碌/重跑中隐藏（仍只在"该回答已被退役"时消失）；重跑期间点其它回答的 ↻，宿主机返回 `rerunning`，客户端显示「已有一个重跑在进行中。」——明确的一次一个语义，而非静默。宿主拒绝已用连发两次 `/apply` 实测：第二次 `409 rerunning`。
- 与 0.1.7/0.1.8 合起来，生成期间的观感为：**其它轮的行和按钮原样都在**，只有目标轮在完成时才被替换。

**0.1.8** —— 无后续轮的重跑不再"提前完成"导致生成期误隐藏。

- **补根**：0.1.7 按"已完成的重跑"过滤 hidden，但**没有后续轮的重跑在提示词一落地就被判 complete**（没有副本要等），客户端于是照样提前隐藏旧行。现在进行中的那一次重跑（按 `progress.rerunId` 识别）在其结束前一律不参与隐藏。
- **现场验证（真实浏览器）**：生成中可见 = 旧的提示词/回答/尾部 + 新的提示词 +「深度求索中」——全程无空白；完成后切换为新一轮，无重复行。
- 与 0.1.6/0.1.7 合起来：生成期间旧内容保持可见 + 进行中提示；重放落地的瞬间完成切换。

**0.1.7** —— 生成期间不再提前隐藏旧行：替代内容落地前，下面保持可见。

- **缘由**：旧实现一收到 `/apply` 成功就立刻折叠被退役的行（乐观更新），而此时新回答还在生成、重放尚未落地——替换内容要等几秒才出现，于是整个生成窗口里下面看起来"空了"（现场截图：流式回答停在半句，红框区域空白）。
- **修复（纯客户端，刷新即生效）**：只对**已完成**的重跑应用 hidden 账本（`/state` 的 `reruns[].complete` 过滤）；生成期间旧行原样可见，重放落地的那一刻才切换成拼接后的视图。与生态里"替代画出来之前不许折叠"的原则一致。
- 配合 0.1.6 的进行中提示：生成期显示「正在重跑…」，完成后旧行隐藏、重放行出现。

**0.1.6** —— 重跑进行中显示状态说明，消除"下面空了"的错觉。

- **缘由**：重放要等新回答落定才写入——生成期间（流式中）下面确实是空的。现场测量：回答落地与重放写入在同一秒（02:18:20 / 02:18:20）；但等待窗口里没有任何提示，容易被理解成内容丢失。
- **修复（纯客户端，刷新即生效）**：`view.rerunning` 期间在输入框上方显示「正在重跑这一轮…新回答生成后，后面的轮次会自动重放回来。」，重放完成后自动消失。错误提示优先于它显示。
- 注：界面里的「思考/深度求索中」是模型自身推理，由平台的「过程展示」设置渲染（设置 → 过程展示：紧凑/标准/详细/完整），与本插件无关。

**0.1.5** —— 修复「被退役回答的思考（reasoning）行仍悬浮在时间线顶部」。

- **现场**：平台把回答的思考渲染成**复合 key 的额外行**（`["process","<行 key>","reasoning"]`、`["<行 key>","reasoning"]`），快照里查不到这些 key 对应的节点；隐藏逻辑此前直接跳过它们，于是主行藏了、思考行还挂在提示词上方（截图里那条 `思考 · The user just sent ...`）。
- **修复**：`applyDom` 对复合 key 沿它引用的**基础行 key** 解析隐藏状态（任一引用被隐藏则整行隐藏；解析不出的行保持原状）。纯客户端修复，**刷新页面即生效，无需重启**。
- 已用真实浏览器（CDP 驱动）现场验证：重载后 42 行里可见 8 行，思考复合行 `display:none`，时间线只剩最终的一条「回复1111…」交换与一条「回复1」交换。

**0.1.4** —— 修复「重跑后提示词那一行的原文复活」：hidden 账本沿替换链展开。

- **现场**：提示词先用 dsh-edit-turn 就地改写（载体站住原文的行），再对它重跑。重跑遮蔽的是**载体**，而旧账本只隐藏被直接遮蔽的节点——原文那一行不在其中；兄弟插件的客户端有一条"替代气泡画不出来不许折叠该行"的安全规则，其载体被遮蔽后气泡撤下、原文行就被放了出来，界面上出现「回复1」+「回复1111…」两行并存。
- **修复**：`rerunLedger` 现在对每个遮蔽窗口沿替换链展开——凡"活的替身"落进本窗口的原始节点，一并退役（`chainHits`，支持多跳链）。原文行随之隐藏，替身行由新生成/重放的行承担。
- 新增单测与契约断言：被遮蔽的兄弟载体与它代表的原始节点都在 hidden 里。

**0.1.3** —— 修复与 dsh-edit-turn 就地改写提示词的交叉场景：对提示词被改写的轮次，重跑此前永远报 `already-retired`（按钮在、点不动）。

- **修复：重跑沿替换链找到"活提示词"。** dsh-edit-turn 的就地改写是一条单节点替换（原提示词事件被遮蔽，载体站在它的位置）。此前 `planRerun` 仍按日志位置找原提示词事件，于是 surface 上明明有活节点却报 `already-retired`，而 `/state` 又把回答列为可重跑——两者不一致。现在沿 `foldSurface` 的替换映射把提示词解析到**活节点**，并且**重发改后的措辞**（正是跨插件契约要求的）。
- **修复：完成度判定按"实际重放区间"而不是"seq 大于 turnEnd"。** 活提示词是后追加的载体，seq 可能大于本轮 turn/end，旧判定把它误当待重放的尾部；另外"无后续轮"时回退区间会把本轮节点误判为应复制。现在提示词单独优先判定，其余节点按正常/回退两条重放区间精确判定。
- 新增测试：单测「就地改写提示词后重跑」；契约新增完整场景（兄弟插件改写 + 重跑 + 严格冷读 + 派生上下文把改写后的措辞重新发给模型）。真机 7 连链式重跑会话全部 ✔（含被改写过提示词的那一轮）。

**0.1.2** —— 点击已退役回答的 ↻ 不再报错（静默刷新）；修复工具支持 `--force` 与"截断后仍非法则继续截断"（能修复兄弟插件留下的 `system/message` 载体坏日志）。

- 现场复现：重跑成功后，旧行上的 ↻ 在下一次状态刷新前仍可点击，点击返回 `already-retired` 并显示红色错误。现在客户端把 `already-retired` 当作正常状态：静默重新拉取状态，旧行随之消失。
- `tools/repair-session.mjs` 增强：无本插件标记的坏日志可用 `--force` 修复；截断后若前缀仍非法（例如载体行与它的括号行必须一起删）会继续截断直到通过严格冷读。

**0.1.1** —— 修复**会让会话冷读失败**的致命缺陷（0.1.0 的载体轮与循环轮号冲突），并附带修复工具。

- **修复（致命）：重跑后的会话在下次冷读时报 `turn/start does not open the expected turn`。** 代理循环的轮号计数器是进程内局部的：它只统计循环自己开的轮，从不重读日志。0.1.0 的载体（空 developer/message + 自开轮次）占用的轮号，会被循环为再生成开的轮**再次使用**；重放写下的轮次同样会被 loop 的下一次开轮撞上。现场表现：会话重启/重开后"历史加载失败"。现在：①载体改为**不占轮次**的 `user/message`（零宽空格内容、plugin source kind）；②重放完成后把循环的空闲计数器同步到日志真实最大轮号（`syncLoopTurn`，形状守卫 + 失败降级 + `/debug` 诊断）。
- **附带产出 `tools/repair-session.mjs`**：扫描 sessions 目录，用**与冷读完全相同的严格校验路径**（`sessionFormatCatalog` 的 `restoreCurrent`）找出坏日志，先备份再在第一个非法行处截断；只自动修复带本插件标记的日志，其余只报告。本机 1 个受影响会话已按此法修复（备份 `*.corrupt-*.bak` 留在同目录），**重开该会话时待处理的提示词会由循环自动补答，重跑自行完成**。
- 修复内部缺陷：`resolveAgent` 的返回形状不一致，导致 `whenIdle` 与计数器同步拿不到 agent（此前靠轮询兜底、同步静默不生效）；`TOOL_NOT_STARTED` 修复结果的副本改为保留契约形状的 id。
- 验证升级：契约测试改用**严格冷读路径**（`validation: 'current'`，真正的 `restoreCurrent`）；端到端补"重跑后追加新轮"回归与沙箱日志严格冷读断言（13 单测 / 17 契约 / 5 客户端 / 端到端全绿）。

**0.1.0** —— 首版：中缀重跑（遮蔽 + 再生成 + 重放）、崩溃续传、准入失败回退、图片重送、确认/自动续传/开发路由配置、中英 UI。

### 姊妹插件

- [dsh-edit-turn](https://github.com/DDDMUC/dsh-edit-turn) —— 编辑任意消息 / 模型回答，同一套 surface-replace 契约。
- [dsh-delete-turn](https://github.com/DDDMUC/dsh-delete-turn) —— 单条消息/单步/单条回复的删除。
- [dsh-delete-session](https://github.com/DDDMUC/dsh-delete-session) —— 侧边栏会话删除。
- [dsh-free-search](https://github.com/DDDMUC/dsh-free-search) —— 免 key 多引擎网络搜索。

### 兼容性

- `dsh.engines.dsh`: `>=0.1.6-alpha.2`（实测 `0.1.7-rc.2`）。
- 客户端依赖：`dsh-client-locale`、`dsh-client-ui-chat`、`dsh-client-ui-conversation`、`dsh-client-ui-primitives`。
- 宿主依赖：`dsh-settings`、`dsh-tools`（peer）；`@deepseek-ai/schemastery`（直接依赖，解析失败时降级为"无设置表单"）。

### License

MIT

---

## English

### Why

DSH derives the model context from the session surface on every call. The only
official remedy for a bad answer is rolling the conversation back to the end -
there is no "rerun that middle turn and keep what came after", because in the
surface-replace contract **an assistant message can never be a replacement
carrier** (the format forbids `sourceEventSeqs` on `assistant/message`), so a
reply cannot be swapped in place.

This plugin does it:

- hover any model reply and a ↻ "Rerun this turn" action appears in the
  official action strip;
- clicking it regenerates that turn from **its own prompt** (the model sees
  exactly A B + the prompt - no old answer, no later turns);
- when the fresh answer lands, the later turns that were removed from the
  surface are **replayed event by event** (fresh turn numbers, fresh message
  ids, original content), and they read as ordinary history;
- every subsequent call sends **A B C1 D E F G + new content** - an infix
  splice that leaves both sides untouched.

### Features

- **Infix rerun** - the replay writes the later turns back into the log as
  official events, so cold reads, exports and other instances see exactly what
  the model sees.
- **Official seams only** - the shadow is one standard
  `surfaceOp: { op: 'replace', startSeq, endSeq }` event (`/compact` uses the
  same contract); the replay is ordinary appends. **No custom event types**:
  out-of-repo plugin events cannot pass the v4 format validator (unknown types
  need the `ignorable` envelope field, which `Session.append` never writes), so
  the "custom projection event" route is closed by design.
- **Silent carrier** - an empty `developer/message` (empty content projects to
  no model message), wrapped in its own closed turn (the format reads a
  developer message only inside an open turn and step - a constraint the
  sibling plugin dsh-edit-turn proved on the real validator).
- **Faithful replay** - turn brackets, user/assistant messages (reasoning and
  tool-call blocks included), `tool/call`, `tool/result` (with
  `sourceEventSeqs` remapped onto the copies), and the `TOOL_NOT_STARTED`
  repair shape (kept without `sourceEventSeqs`, which is what the validator
  accepts); `usage`, embedded streams, system messages and every bookkeeping
  record are dropped.
- **Crash recovery** - the carrier names the operation (`rerunId`), the fold
  records exactly which surface nodes it shadowed, and every copy cites its
  `originalSeq`; "which copies are missing" is computable from the log alone.
  `/state` auto-resumes by default, and a half-written bracket orphan is
  continued rather than mistaken for a busy turn.
- **Admission-failure fallback** - when the regenerated prompt never lands,
  the replay copies the prompt too, so the context keeps its content.
- **Image prompts are re-sent** (bytes re-read, base64 through official
  admission); file attachments are refused for now.
- Bilingual UI, skin-friendly, loopback-only host routes with Host/Origin
  checks.

### Install

```sh
dsh plugin --profile web add dsh-rerun-turn
```

### Usage

Hover a model reply, press ↻. The old turn and everything after it leave the
model context, the prompt is sent again, the fresh answer streams in, and the
later turns are replayed back automatically. Retired rows are hidden; the new
answer and the replayed rows appear in the order the model reads them.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `confirm` | `false` | Ask for one inline confirmation before rerunning. |
| `autoResume` | `true` | Let `/state` finish an interrupted replay (no model call). |
| `idleTimeoutMs` | `600000` | How long to wait for the fresh answer to settle. |
| `devTools` | `false` | Mount the loopback dev routes used by end-to-end verification. |

### How it works

Three official operations, in order: **shadow** (one replace event over
`[the turn's prompt .. the last surface node]`, carried by a **turn-less**
`user/message` whose content is a single zero-width space and whose
`source.kind` marks it plugin-written), **regenerate**
(`sessionController.prompt` re-sends the turn's prompt through the official
admission path, then `agent.whenIdle()` waits for the fresh answer), and
**replay** (every shadowed event after the rerun turn is appended back:
renumbered contiguous turns, fresh ids, remapped `sourceEventSeqs`, and a
`{ rerunBy, rerunId, originalSeq }` marker in each message source). The
append-only log is never rewritten.

Why the carrier owns no turn (the 0.1.0 incident and its fix): the agent
loop's turn counter is process-local - it counts only the turns the loop
itself opened and never re-reads the log. A carrier that opened its own turn
made the loop reuse that number for the regenerated turn, and the log failed
its cold read from then on. The same applies to the replayed turns, so 0.1.1
also re-points the loop's idle counter at the log's true last turn after the
replay (`syncLoopTurn`, shape-guarded and best-effort; DSH exposes no official
re-sync API). The `tools/repair-session.mjs` utility repairs logs written by
0.1.0.

### Verification status

| Check | Command | Result |
|---|---|---|
| Unit tests (host logic + client DOM stub: injection, hiding, re-apply) | `npm test` | 26 passed (18 host + 8 client DOM) |
| Real-validator contract (encode/restore round-trip) | `npm run verify:contract` | 22 passed: the rerun log survives the v4 vocabulary/relationship/lifecycle validators plus `Session.fromRestore`; the derived context is exactly **A B C1' D' E'**; chained reruns; crash-resume; admission-failure fallback; `TOOL_NOT_STARTED` fidelity |
| Client statics + live delivery bytes | `npm run verify:client` / `verify:live` | 7 passed |
| **Real sandbox end-to-end** (isolated DSH_HOME/port, real model calls) | `npm run verify:e2e` | Passed: a 3-turn scratch session, the middle turn rerun via `/apply`, background regeneration + replay, and the **live derived context** asserted to be the spliced order with a marked replay copy |
| Mounted-instance probe | `npm run probe:loaded [port]` | Passed |

**Not yet verified (honest note): the interactive browser rendering** (button
placement, clicks, row hiding) has no automated smoke test yet - the client
half's loading, slot registration and live delivery are covered, and host
behavior is covered end-to-end. Refresh the DSH page once and confirm the
button before relying on it.

### Known limitations

- A rerun targets a turn that has a prompt message; the system-prompt head
  cannot be rerun.
- Rerunning any reply reruns its whole turn.
- Prompts with file attachments are refused; images are re-sent.
- Replayed copies are lossy in the same ways the replay is: dropped `usage`
  and streams, skipped system messages and bookkeeping records, tools are not
  re-executed.
- A prompt typed during a rerun can push the replay behind the new turn; the
  resume path exists for that.
- Uninstalling the plugin keeps landed reruns but un-hides the retired rows
  (the model context is unaffected).
- There is no undo (use the official fork for branching, not implemented).

### Changelog

**0.1.22** — Fixed the ghost-button build-up on re-apply: the pass now reuses the host already in the row instead of deleting it and building another one, and a fiber dispose sweeps every node of this plugin's namespace.

- A host found by `[data-dsrr-action-host="1"]` is adopted (the WeakMap is re-pointed at it), so a re-apply - HMR, plugin toggle, bundle reload - leaves exactly one button on the row; only extra copies left by an older build are dropped.
- The dispose sweep runs by attribute, never through the WeakMap: hosts and this plugin's own stylesheet synchronously, the React-rendered nodes (strip button, overlay root) one task later, because React unmounts those itself and pulling them first would make its own `removeChild` throw. Only this plugin's own nodes are ever touched.

**0.1.21** — Interop hardening for the AI Studio component contract: the input-overlay slot moves to order 10 (delete-turn 8 / edit-turn 9), a reopen never clears a sibling plugin's hide and never touches a `display:none` this plugin did not set, and the injected row nodes carry their `data-dsrr-*` namespace.

### Compatibility

- `dsh.engines.dsh`: `>=0.1.6-alpha.2` (tested on `0.1.7-rc.2`).
- Host peers: `dsh-settings`, `dsh-tools`; direct dependency
  `@deepseek-ai/schemastery` (degrades to "no settings form" when unresolvable).

### License

MIT
