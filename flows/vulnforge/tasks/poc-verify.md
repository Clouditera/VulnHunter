# 目标

动态复现一个静态确认的漏洞 finding。当前任务的 finding 报告路径由提示词给出（`当前 finding 报告`），直接读取该 `findings/BUG-*/report.yaml`，在动态验证环境里复现它。用动态证据检验 finding 的关键声称——跑出异常不等于复现成功，必须确认异常来自 finding 声称的真实入口、真实路径和真实危害。

动态验证链由引擎按 finding 状态调度（只消费 `poc_status: pending` 的 finding），本任务不读取、不创建任何 `todo/` 任务文件。

# 入口防御校验

开始前先读 finding 报告并校验，任一不满足时直接结束本轮、不修改任何状态（保持待处理，留给后续轮次重试）：

- `metadata.finding_class` 必须为 `vulnerability`；`risk` 类不做 POC。
- `metadata.poc_status` 必须为 `pending`；已复现/已失败/已阻塞的 finding 不重复处理。

# 产出

poc 相关文件统一写入 `findings/<BUG-id>/poc/` 下：

- `poc.md`：本 poc 相关的重要信息和结论。
- 其它复现过程使用的脚本、触发输入、测试日志等文件。

poc 环境关键信息和报告信息按需更新：

- `findings/<BUG-id>/report.yaml`：按复现结果把 `poc_status` 与 `exp_status` 一起原子推进，避免半迁移状态：
  - 复现成功：`poc_status: reproduced`，`exp_status: pending`（成为 ev-assess 候选）。
  - 复现失败（条件已具备但未触发）：`poc_status: fail-reproduced`，`exp_status: not-needed`。
  - 执行环境或外部条件不足：`poc_status: blocked`，`exp_status: blocked`。
  - 复现中发现分类有误（如应降级为 risk）：修正 `finding_class`，并将 `poc_status` / `exp_status` 置为对应终态（risk 类为 `not-needed`）。
  - 必要时修正标题、影响描述和攻击前提等。
- `knowledge/build/`：对动态测试环境的关键操作、脚本等。

# 备注

- 只对 `finding_class: vulnerability` 的 finding 复现；`risk` 类不做 POC。
- `exp_status: awaiting-poc` 是 verify 创建 vulnerability finding 时的初始 EXP 状态：PoC 成功后必须推进为 `pending`，失败/阻塞/降级则推进为对应终态——ev-assess 只消费 `exp_status: pending`，不要让它越过 PoC 门禁。
- 沙箱不可达等阻塞场景按系统提示处理：记录 blocked 原因后退出，不要把 finding 改成不可重试的终态。
