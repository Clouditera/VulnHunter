# 目标

处理一个 CHAIN 组合任务：基于工作区中已完成单漏洞评估的 finding，深入探索并构造破坏力最大的漏洞组合。任务正文只给出组合方向或信号；成员选择、链路设计和验证方式由你自主决定，允许多轮深入探索。

# 产出

组合 EXP 的产物统一写入 `exploits/EXP-<id>/` 下：

- `report.yaml`：组合报告，字段以 `schemas/chain-report.schema.yaml` 为准——members、组合后影响、链式步骤与各环节证据。
- `members/<BUG-ID>/`：组合引用到的成员 finding 的结论文档副本（`report.yaml` 与 `exp/exp.md`，如有），供独立阅读；原始证据（日志、脚本等）留在 `findings/` 原处不拷贝。
- 组合利用脚本、触发输入、验证日志等文件。

关键经验写入 `knowledge/exploits/`：

- 每个组合探索结束后，把成功或失败的关键结论写入 `knowledge/exploits/EXP-<id>.md`：可行的组合配方、不可行的路径及原因、值得后续尝试的方向。后续 decide 和 exp-build 会读取这些经验。

环境关键信息按需更新：

- `knowledge/build/`：对动态测试环境的关键操作、脚本等。

不修改成员 finding 自身的 `report.yaml` 状态——组合结果只写入 `exploits/`。

## 完成处理

退出前把当前 `todo/CHAIN-*.md` 的 `status` 修改为 `done`，并移动到 `done/`。

# 备注

- 先读 `knowledge/exploits/` 已有经验，避免重复已失败的组合路径。