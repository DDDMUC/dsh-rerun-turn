# 更新日志 / Changelog

本文档按语言分节；每条对应一个版本号。

## 中文

**0.2.10** —— 行增长不再每加一行就重拉 `/state`；传输层失败自动重试。

- 行数增长改成 20 秒节流的尾随刷新：大会话单次 `/state` 可达 35 秒，旧逻辑在一次回答里能排队几十次，
  把宿主事件循环按死。现在窗口内的增长合并成一次，窗口过后补一次。
- `Failed to fetch` 这类传输层失败改为静默重试 3 次（1 s / 2 s / 4 s），成功即自愈；
  只有重试用尽才显示「状态加载失败」，不再一次断网就永久钉住错误。
- 新增 `test/refresh-throttle.test.js`：节流合并、重试自愈、重试用尽三条回归。

**0.2.9** —— 设置卡片只挂在包自己的页面上。

- 去掉 `plugins.row.config` 注册：不再给行加「配置」按钮，重跑设置只出现在 `#/panel/plugins/dsh-rerun-turn`。
- 同一张卡、同一个组件，只有一个入口。

**0.2.8** —— 设置卡片同时出现在包自己的页面上。

- 新增 `plugins.bundle.config` 注册（key 是裸包名）：`#/panel/plugins/dsh-rerun-turn` 直接能看到重跑设置，不再只能从 `…/dsh-rerun-turn/dsh-rerun-turn` 那一层进去。
- 与 `plugins.row.config` 注册的是同一个组件，设置只有一份来源。

**0.2.7** —— 修：重跑窗口、重放顺序、生成期间的那一帧。

- **遮蔽窗口按表面节点算**：区间端点取自表面节点（宿主按 `indexOf` 解析，裸 seq 会被拒），`sourceEventSeqs` 与区间出自同一个集合——此前两者不一致，宿主会把区间外的节点当悬空引用，表现为「下一轮的输入消失」。
- **只把槽位载体的直接替换目标交给客户端做乐观隐藏**：把整条 `retired` 链都藏掉会让其它轮次一起消失（界面只剩“正在思考”）。
- **重放按表面槽位顺序构造**，`logTo` 覆盖到窗口末尾；此前按日志 seq 顺序，且止于 `turn/end`，会把后一轮的提问排到它自己的回答之后、并漏掉最后一条。
- **生成期间冻结目标轮的渲染**：宿主在 apply 的瞬间就遮蔽了这一轮的表面节点，而重放的提问要等下一次渲染才出现——克隆一份旧行填上这一帧，重跑结束再撤掉。不闪回、不空白。
- **兼容**：路由与错误码不变；`/apply` 响应只**新增** `retired` 字段。

验证：单测 90、契约 29、客户端 7 全绿；真实日志副本上「不闪回 / 后续轮次仍在 / 区间与 refs 一致 / 九项校验通过」。

## English

**0.2.7** — fix: the rerun window, the replay order, and the one frame during generation.

- The shadow window is computed from surface nodes (the host resolves by `indexOf`); `sourceEventSeqs` is derived from the same set, so no node is left dangling.
- Only the prompt carrier's direct replacement targets are hidden optimistically on the client — hiding the whole retired chain blanked later turns.
- The replay is built in surface-slot order and `logTo` covers the end of the window (it used to stop at `turn/end`).
- The target turn's rows are cloned while the rerun is in flight, so the prompt never disappears for a frame; the clones are removed when the rerun completes.
