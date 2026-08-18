# 目标

复核任务完成度，并汇总当前工作区已有的审计认知、静态结论和动态复现结果。report 只引用和归纳已有产物，不新建切面，不提出新假设，不重新验证结论。

# 产出

## 1. 复核完成度

先读取 `sched_instr` 与 `audit_scope`，再结合 coverage、任务池和已有产物复核完成度。完成标准按 `sched_instr > audit_scope`：前者明确限定本次任务时只验收该范围，范围外缺口记入限制而不影响完成；否则严格按 `audit_scope` 验收。

- 必须检查当前完成标准内的实际产物，轮次数、finding 数和任务状态不能单独证明完成。
- 完整审计时，coverage 记录的 hunt 精读是正式证据，wiki、cognize、worklog 和报告不能替代；外部可达生产代码未覆盖、浅覆盖或可达性不明时判定 `incomplete`。
- 完整审计中的排除项必须逐项举证并与 coverage 精确对账；约数、笼统分类或上层模块已审计不能作为依据。
- 当前完成标准涉及 LEAD 消费时，逐条检查其内容和下游产物；仅有 `done/closed` 状态不算消费证据。

将结论写入 `report/completion.yaml`：满足当前完成标准写 `status: complete`，否则写 `status: incomplete`；`reason` 说明依据、范围内缺口及范围外限制。

## 2. 汇总项目认知

从 `knowledge/profiler.yaml`、`knowledge/wiki/`、`knowledge/worklog.md` 和 coverage 中汇总项目类型、入口、核心能力域、高价值资产、信任边界和已覆盖范围。

## 3. 汇总漏洞结论

存在 `exploits/` 时，先汇总组合 EXP 链（成员、组合后影响、动态证据），作为最高价值结论。

从 `findings/` 汇总结果：`finding_class: vulnerability` 进入漏洞结论，`finding_class: risk` 进入风险/弱点；再结合 `poc_status` / `exp_status` 描述证据层级。字段语义以 `schemas/bug-report.schema.yaml` 为准。

`leads/` 中 `type: hunt` 且未处理的 LEAD 记录了值得继续追的线索，一并摘要。

## 4. 汇总审计限制

写清当前认知边界、未覆盖区域、复现限制、动态执行环境能力边界和仍需后续处理的事项。若存在 `knowledge/build/build.md`，归纳其中记录的已准备能力和当前限制。

## 报告文件

生成：

- `report/completion.yaml`
- `report/audit-report.yaml`
- `report/summary.md`

报告应包含：

- 目标项目与威胁模型概览。
- 已建立认知的切面和 coverage 情况。
- 漏洞结论摘要、风险/弱点摘要和未处理线索摘要。
- 当前认知收敛情况、审计限制和阶段性安全结论。
