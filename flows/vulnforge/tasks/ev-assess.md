# 目标

处理一个 EXP 任务，根据任务指定的 `target`，理解该 finding 相关的业务和威胁模型，搭建准业务环境，评估它在真实场景下的最大影响力。只对 `finding_class: vulnerability` 的 finding 执行，只做单个漏洞。

当报告声称的影响力在真实环境下无法实现时，对数据和报告做降级处理。

# 产出

exp 相关文件统一写入 `findings/<target-BUG>/exp/` 下：

- `business-model.md`：漏洞相关功能的业务模型。
- `threat-model.md`：围绕当前 finding 的威胁模型。
- `exp.md`：本 exp 相关的重要信息和结论。
- 其它环境搭建过程使用的脚本、测试日志等文件。

exp 环境关键信息和报告信息按需更新：

- `findings/<target-BUG>/report.yaml`：根据真实业务影响修正 CVSS、EV、finding_class、标题、影响描述和攻击前提等；声称影响无法达成时下调评分与影响描述，并更新 `exp_status`。
- `knowledge/build/`：对动态测试环境的关键操作、脚本等。

## 完成处理

退出前把当前 `todo/EXP-*.md` 的 `status` 修改为 `done`，并移动到 `done/`。
