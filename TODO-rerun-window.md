# 修 rerun 的遮蔽窗口（B 方案：保留重跑任意轮）

现场：`session-ed52995a-f839-4ecd-86d3-bbedaa4a2f2d`（"测试：回复数字1"，Default Project）

## 三个缺陷（同一段代码）

`lib/index.js`：

- `planRerun()`（约 898 行）里 `const shadowed = surfaceNodes.slice(nodeIndex.get(livePromptSeq))`
  从提问一直切到表面末尾，把后续轮次和 edit 载体全卷进来。
- `buildShadowWrites()`（约 1207 行）用 `plan.startSeq/plan.endSeq` 写区间，
  用 `normalizeShadowed(plan.shadowed)` 写引用——**区间与引用不是同一个集合**。

1. **区间 ≠ 引用**：区间 `23..30`，`sourceEventSeqs` `[14,20,23,30,33]`。
   宿主按区间遮蔽、按引用校验 → 33 变悬空 → 第 2 轮输入消失。
2. **重放不完整**：只重放了提问（seq 39），没有重放被遮蔽的第 2 轮内容。
3. **遮蔽了 edit 载体**：seq 23 是 `replace 13..` 的 edit 载体，被盖掉后 13
   （`回复数字1`）复活 → rerun 生成期间 UI 先闪回原文。

## 修法（单一口径）

1. 先算 `window` = 本轮提问与其后、直到表面末尾的**可见单元**集合；
   区间取 `window` 在表面上的首尾，`sourceEventSeqs` 就是 `window` 本身（逐条一致）。
2. edit 载体（`source.kind === 'user'` 且 `surfaceOp` 为 replace）**先折平成原行**
   （换面不搬行：把载体正文写回被替换的那条原消息），再进窗口；载体本身不进
   `sourceEventSeqs`。
3. 重放 = 把 `window` 里除“本轮旧回复”以外的每个可见单元按表面顺序重新 append，
   一个都不能漏；重放单元的 `turn/step` 沿用原值。

## 验证（必须全过才叫修好）

用 `ed52995a` 的副本，断言：

1. rerun 期间与之后，第 1 轮提问始终是 `这是测试，回复数字2`，不闪回 `回复数字1`；
2. 第 2 轮的提问（`回复数字4`）与回复仍在表面；
3. `sourceEventSeqs` 与区间遮蔽集合逐条一致（无悬空 seq）；
4. 九项校验全绿（`node lib/vendor/verify-session-log.mjs <日志>`）；
5. `dsh-rerun-turn` 现有测试全过。

## 备注

- 不要为了“简单”改成只能重跑最后一轮——那会改变插件语义，用户明确否决过。
- 日志本身不能写注释（JSONL 一行一个事件，注释行会被解码器拒）；
  需要留说明就写这个同目录的旁挂文件。

---

## 状态：已完成（2026-11-04）

三条缺陷都已修并验证：

- 区间与 `sourceEventSeqs` 同一口径（`plan.shadowed` / `plan.retired` 派生自同一集合）；
- edit 载体先折平再进窗口（只把槽位载体的直接替换目标交给客户端做乐观隐藏）；
- 重放按表面槽位顺序，`logTo` 覆盖到窗口末尾。

验证：单测 90/90、契约 29/29、客户端 7/7；真实日志副本上「不闪回 / 后续轮次仍在 / 区间与 refs 一致 / 九项校验通过」。

另外补了一处外观修复：重跑期间冻结目标轮的渲染（客户端克隆行），避免宿主遮蔽与重放落地之间出现“没有提问”的一帧。
