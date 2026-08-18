# 目标

读取当前 `todo/POC-*.md` 的 `target`，找到对应 `findings/BUG-*/report.yaml`，在动态验证环境里复现它。用动态证据检验 finding 的关键声称——跑出异常不等于复现成功，必须确认异常来自 finding 声称的真实入口、真实路径和真实危害。

# 产出

poc 相关文件统一写入 `findings/<BUG-id>/poc/` 下：

- `poc.md`：本 poc 相关的重要信息和结论。
- 其它复现过程使用的脚本、触发输入、测试日志等文件。

poc 环境关键信息和报告信息按需更新：

- `findings/<BUG-id>/report.yaml`：根据复现结果更新 `poc_status`；必要时修正 finding_class、标题、影响描述和攻击前提等。
- `knowledge/build/`：对动态测试环境的关键操作、脚本等。

## 完成处理

退出前把当前 `todo/POC-*.md` 的 `status` 修改为 `done`，并移动到 `done/`。

# 备注

- 只对 `finding_class: vulnerability` 的 finding 复现；`risk` 类不做 POC。
