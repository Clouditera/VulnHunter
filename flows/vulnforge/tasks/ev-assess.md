# 目标

评估一个已 POC 复现的 vulnerability finding 在真实业务/威胁场景下的最大影响力。当前任务的 finding 报告路径由提示词给出（`当前 finding 报告`），直接读取该 `findings/BUG-*/report.yaml`。只做单个漏洞。

当报告声称的影响力在真实环境下无法实现时，对数据和报告做降级处理。

动态验证链由引擎按 finding 状态调度（只消费 `exp_status: pending` 的 finding），本任务不读取、不创建任何 `todo/` 任务文件。

# 入口防御校验

开始前先读 finding 报告并校验，任一不满足时直接结束本轮、不修改任何状态（保持待处理，留给后续轮次）：

- `metadata.finding_class` 必须为 `vulnerability`；`risk` 类不做 EXP。
- `metadata.exp_status` 必须为 `pending`。
- `metadata.poc_status` 必须为 `reproduced`——历史工作区可能存在 `poc_status: pending, exp_status: pending` 的旧数据，此时不要评估，留给 poc-verify 先复现。

# 产出

exp 相关文件统一写入 `findings/<BUG-id>/exp/` 下：

- `business-model.md`：漏洞相关功能的业务模型。
- `threat-model.md`：围绕当前 finding 的威胁模型。
- `exp.md`：本 exp 相关的重要信息和结论。
- 其它环境搭建过程使用的脚本、测试日志等文件。

exp 环境关键信息和报告信息按需更新：

- `findings/<BUG-id>/report.yaml`：根据真实业务影响修正 CVSS、EV、finding_class、标题、影响描述和攻击前提等；声称影响无法达成时下调评分与影响描述，并更新 `exp_status`（`confirmed` / `downgraded` / `failed` / `blocked` / `not-needed`）。
- `knowledge/build/`：对动态测试环境的关键操作、脚本等。
