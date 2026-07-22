# 任务：准备报告上下文

读取报告上下文入口索引，确认完整数据文件可用，并生成报告前置摘要。

## 输入

- 上下文入口索引：`${flow_inputs.context_file}`
- 报告输出目录：`${flow_inputs.reports_dir}`

## 数据源

`report-context.json` 不是完整数据，只是索引。必须按索引读取：

- `/workspace/context/task-metadata.json`：任务配置与执行摘要
- `/workspace/context/findings/index.json`：全量 finding/risk 索引
- `/workspace/context/findings/*.yaml`：每个 finding/risk 的完整详情
- `/workspace/context/wiki/*.md`：项目知识库
- `/workspace/context/profiler.yaml`：项目画像（如存在）
- `/workspace/context/poc/` 与 `/workspace/context/reviewed/`：POC/reviewed 产物（如存在）
- `/workspace/source`：源码树（如存在，只读）

## 步骤

1. 读取 `${flow_inputs.context_file}`，理解上下文目录结构和数据契约。
2. 读取 `/workspace/context/task-metadata.json`，提取项目名称、来源、扫描时间、执行摘要、Token/阶段统计等。
3. 读取 `/workspace/context/findings/index.json`，统计全部条目数量、finding/risk 数量、严重程度分布。
   - 注意：必须处理索引里的全部条目，不得只处理前 20 条。
   - `item_type=risk` 的风险项也必须纳入报告素材。
4. 抽样检查若干 `/workspace/context/findings/*.yaml`，确认完整字段可用（CWE/CVSS/code/data_flow/attack/remediation/anchors 等）。
5. 检查 wiki/profiler/poc/reviewed/source 是否存在，记录可用数据源。
6. 在 `/workspace/out/prepare-report-context/context-summary.txt` 下创建摘要，列出：
   - 项目概况
   - findings/risk 总数和严重程度分布
   - 可用数据文件列表
   - 报告格式要求/已加载 Report Skill

## 输出

- `/workspace/out/prepare-report-context/context-summary.txt`
