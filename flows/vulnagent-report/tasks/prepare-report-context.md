# 任务：准备报告上下文

读取报告上下文文件，了解任务信息和漏洞数据。

## 输入

- 上下文文件：`${flow_inputs.context_file}`

## 步骤

1. 读取上下文 JSON 文件，理解：
   - 项目名称和扫描范围
   - 漏洞统计（总数、按严重程度分类）
   - 每个漏洞的详细信息（finding_key、标题、严重程度、描述、位置）

2. 确认已加载的 Report Skill（通过 `--skill` 注入），理解报告格式要求。

3. 在 `/workspace/out/prepare-report-context/` 下创建 `context-summary.txt`，简要列出：
   - 项目概况
   - 漏洞数量和分布
   - 报告格式要求

## 输出

- `/workspace/out/prepare-report-context/context-summary.txt`
