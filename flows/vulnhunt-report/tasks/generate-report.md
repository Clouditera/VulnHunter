# 任务：生成安全审计报告

根据上下文数据和 Report Skill 的格式要求，生成完整的安全审计报告。

## 输入

- 上下文摘要：`/workspace/out/prepare-report-context/context-summary.txt`
- 完整上下文：`${flow_inputs.context_file}`
- 报告输出目录：`${flow_inputs.reports_dir}`

## 步骤

1. 重新读取完整上下文 JSON，获取所有漏洞详细数据。

2. 按照 Report Skill 的格式要求，生成报告文件。报告应包含：
   - 概述/摘要
   - 漏洞列表（按严重程度排序）
   - 每个漏洞的详细描述、影响、修复建议
   - 统计图表数据（如需要）
   - 结论和建议

3. 将报告文件写入 `${flow_inputs.reports_dir}/`。
   - 主文件名建议：`security-report.md`（或 Skill 指定的格式）
   - 如需多个文件（附录、图表等），一并写入同目录

## 语言要求

- 报告语言由 Report Skill 指定，默认使用**中文**
- 技术术语（如 XSS、RCE、SQL 注入）保持英文原文

## 输出

- `${flow_inputs.reports_dir}/security-report.md`（或其他 Skill 指定格式）
