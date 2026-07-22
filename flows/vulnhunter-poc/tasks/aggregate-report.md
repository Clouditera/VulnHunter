# 任务：汇总 POC 复现报告

扫描 POC 结果目录下所有 finding 的 `result.json`，汇总生成复现报告。

## 流程

1. 遍历 `findings/*/result.json`，读取每个漏洞的复现结果
2. 统计复现率：REPRODUCED + PARTIALLY_REPRODUCED / 总数
3. 生成汇总报告

## 输出

### `reproduction-report.json`

```json
{
  "target_url": "http://...",
  "total_findings": 10,
  "reproduced": 5,
  "partially_reproduced": 2,
  "not_reproduced": 2,
  "skipped": 1,
  "reproduction_rate": 0.7,
  "findings": [
    {
      "bug_id": "BUG-001",
      "vuln_type": "xss",
      "endpoint": "/search?q=",
      "status": "REPRODUCED",
      "evidence": "...",
      "poc_script": "findings/BUG-001/poc.sh",
      "screenshot": "findings/BUG-001/screenshot.png"
    }
  ]
}
```

### `reproduction-report.md`

人类可读的 Markdown 报告，包含：
- 汇总统计（复现率、各状态数量）
- 每个漏洞的详情（状态、端点、证据摘要、PoC 脚本路径）
- 如有目标服务信息，包含部署方式和访问地址
