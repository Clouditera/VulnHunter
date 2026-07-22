# 任务：生成安全审计报告

根据完整文件化上下文和 Report Skill 的格式要求，生成安全审计报告。

## 输入

- 上下文摘要：`/workspace/out/prepare-report-context/context-summary.txt`
- 上下文入口索引：`${flow_inputs.context_file}`
- 报告输出目录：`${flow_inputs.reports_dir}`

## 必读数据

1. `/workspace/context/report-context.json`：入口索引和路径说明。
2. `/workspace/context/task-metadata.json`：项目配置、执行摘要、扫描统计。
3. `/workspace/context/findings/index.json`：**全量** finding/risk 索引。
4. `/workspace/context/findings/<finding_key>.yaml`：每个条目的完整详情。
5. 按需读取：`wiki/`、`profiler.yaml`、`poc/`、`reviewed/`、`/workspace/source`。

## 步骤

1. 读取上下文摘要和入口索引，确认可用数据源。
2. 读取 `findings/index.json`，枚举**所有**条目：
   - 不得只处理前 20 条；
   - 不得只处理 `finding`，也要覆盖 `risk`；
   - 按严重程度和 Report Skill 要求组织顺序。
3. 对每个条目读取其 YAML 文件，优先使用 YAML 中的完整字段：
   - CWE/CVSS/EV（如有）
   - title / severity / vuln_type
   - anchors / primary_file / primary_line
   - description / code / data_flow / attack / remediation / references
   - reviewed / POC 状态（如有）
4. 如报告需要源码证据，从 `/workspace/source` 读取对应源码文件，引用 file:line 和必要代码片段；源码目录不存在时不要编造代码。
5. 读取 wiki/profiler/task-metadata，补充项目画像、技术栈、执行摘要和统计数据。
6. 读取 poc/reviewed 数据，补充复现状态、证据、脚本/日志摘要。
7. 严格按照已加载 Report Skill 的格式、语言、字段和输出文件名要求生成报告。
8. 将报告文件写入 `${flow_inputs.reports_dir}/`。如 Skill 未指定，默认写 `security-report.md`。

## 语言要求

- 报告语言由 Report Skill 指定，默认使用**中文**。
- 技术术语（如 XSS、RCE、SQL 注入）保持英文原文。

## 输出

- `${flow_inputs.reports_dir}/security-report.md`（或 Report Skill 指定的主文件名）
- 如需多个文件（附录、图表等），一并写入同目录
