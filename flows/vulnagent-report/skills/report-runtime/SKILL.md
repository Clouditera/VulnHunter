---
name: report-runtime
description: 报告生成运行时环境说明
---

# Skill: 报告运行时

## 运行环境

你在 Docker 容器中运行，可用工具：
- 文件读写：直接读写 `/workspace/` 下的文件
- 命令行：bash 命令
- 上下文数据在 `/workspace/context/report-context.json`

## 报告格式默认规范

如果没有专门的 Report Skill 指定格式，使用以下默认规范：

### 结构
1. **概述**：项目基本信息、扫描范围、扫描时间
2. **风险摘要**：漏洞统计（高/中/低/信息）、风险评分
3. **漏洞详情**：按严重程度排序，每个漏洞包含：
   - 标题和严重程度
   - 漏洞描述
   - 影响范围
   - 修复建议
   - 相关代码位置
4. **结论和建议**：整体安全评估、优先修复建议

### 语言
- 默认使用中文
- 技术术语保持英文原文（XSS、RCE、SQL Injection 等）

### 输出
- 主文件：`security-report.md`
- 写入目录：`/workspace/reports/`
