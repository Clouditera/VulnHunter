---
name: poc-report
description: POC 复现报告汇总 — 读取各漏洞的 result.json，生成 reproduction-report.json 和 .md 汇总报告。
---

# Skill: POC 复现报告汇总

## 任务

遍历所有漏洞的 `result.json`，汇总生成两份报告：

### reproduction-report.json

```json
{
  "target_url": "http://...",
  "total_findings": 10,
  "reproduced": 5,
  "partially_reproduced": 2,
  "not_reproduced": 2,
  "skipped": 1,
  "reproduction_rate": 0.7,
  "findings": [...]
}
```

### reproduction-report.md

人类可读 Markdown 报告：
- 标题 + 目标信息
- 汇总统计表（各状态数量 + 复现率）
- 每个漏洞的详情（状态 badge、端点、证据摘要、PoC 路径）
- 按复现状态分组排列（REPRODUCED → PARTIAL → NOT_REPRODUCED → SKIPPED）
