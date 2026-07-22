# 任务：打包报告

验证生成的报告文件完整性，创建 manifest 供平台入库。

## 输入

- 报告目录：`${flow_inputs.reports_dir}`
- 报告 ID：`${flow_inputs.report_id}`
- 任务 ID：`${flow_inputs.task_id}`

## 步骤

1. 列出 `${flow_inputs.reports_dir}/` 下所有生成的文件。

2. 确认主报告文件存在（`security-report.md` 或其他）。如不存在，报错。

3. 在 `/workspace/out/report-manifest.json` 写入 manifest：

```json
{
  "schema_version": 1,
  "report_id": "<report_id>",
  "task_id": "<task_id>",
  "primary_file": "security-report.md",
  "format": "md",
  "files": ["security-report.md"],
  "language": "zh-CN"
}
```

`files` 数组列出所有生成的报告文件（相对于 reports_dir）。
`primary_file` 是主报告文件名。
`format` 是主文件格式（md / pdf / html）。

4. 确认 manifest 写入成功。

## 输出

- `/workspace/out/report-manifest.json`
