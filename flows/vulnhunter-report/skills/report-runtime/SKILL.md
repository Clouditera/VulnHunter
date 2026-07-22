---
name: report-runtime
description: 报告生成运行时环境说明
---

# Skill: 报告运行时

## 运行环境

你在 Docker 容器中运行，可用工具：
- 文件读写：直接读写 `/workspace/` 下的文件
- 命令行：bash 命令
- 报告输出目录：`/workspace/reports/`
- 上下文入口索引：`/workspace/context/report-context.json`
- 源码目录：`/workspace/source`（如存在，只读）

## 完整数据契约

`report-context.json` 只是入口索引，不是完整数据。生成报告时必须读取下列富数据文件：

- `/workspace/context/task-metadata.json`：任务配置、来源、扫描预算、执行摘要、Token/阶段/工具调用统计、漏洞计数。
- `/workspace/context/findings/index.json`：**全量** finding/risk 索引，不做 20 条截断。必须按该索引枚举所有条目。
- `/workspace/context/findings/<finding_key>.yaml`：每个 finding/risk 的完整引擎 YAML，包含 CWE/CVSS、源码位置、anchors、code、data_flow、attack、remediation、references 等字段。
- `/workspace/context/wiki/*.md`：项目知识库页面。
- `/workspace/context/profiler.yaml`：项目画像/技术栈/代码统计（如存在）。
- `/workspace/context/poc/`：平台 POC 结果摘要与相关脚本/日志（如存在）。
- `/workspace/context/reviewed/`：引擎 reviewed/POC 验证产物（如存在）。
- `/workspace/source`：原始源码树（如存在），用于核对 file:line、引用代码片段和补充上下文。

## 报告生成要求

1. 先读取 `/workspace/context/report-context.json` 和 `/workspace/context/findings/index.json`。
2. 必须处理 `findings/index.json` 中的**每一个**条目，包括 `item_type=risk` 的风险项；不要只处理前 20 条。
3. 对每个条目，继续读取其对应的 YAML 文件，使用 YAML 中的完整字段生成报告，不要只依赖索引里的摘要字段。
4. 如需源码证据，从 `/workspace/source` 读取对应文件并引用行号/片段；源码目录不存在时说明未提供源码上下文。
5. 如存在 POC/reviewed 数据，应在报告中反映验证状态、证据或复现材料。
6. 不要编造不存在的数据；缺失字段应标注“未提供”或按 Report Skill 的格式要求处理。

## 报告格式默认规范

如果没有专门的 Report Skill 指定格式，使用以下默认规范：

### 结构
1. **概述**：项目基本信息、扫描范围、扫描时间
2. **风险摘要**：漏洞/风险统计（高/中/低/信息）、风险评分
3. **漏洞与风险详情**：按严重程度排序，每个条目包含：
   - 标题和严重程度
   - CWE/CVSS（如有）
   - 漏洞描述
   - 影响范围
   - 代码位置和证据片段
   - 数据流/攻击路径（如有）
   - 修复建议
   - POC/reviewed 状态（如有）
4. **结论和建议**：整体安全评估、优先修复建议

### 语言
- 默认使用中文
- 技术术语保持英文原文（XSS、RCE、SQL Injection 等）

### 输出
- 主文件：`security-report.md`
- 写入目录：`/workspace/reports/`
