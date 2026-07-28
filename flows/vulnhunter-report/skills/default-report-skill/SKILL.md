---
name: default-report-skill
description: 平台内置默认报告模板（中文通用安全审计报告；可产 md / docx / xlsx）
---

# Skill: 默认安全审计报告

当用户未上传自定义 Report Skill 时使用本模板。

## 可用工具（容器内已安装）

- **Markdown**：直接写文件
- **DOCX**：`pandoc input.md -o output.docx`（可用 `--reference-doc` 控样式）
- **XLSX**：Python `openpyxl`（结构化漏洞/风险清单表）

不提供 PDF 工具；不要尝试生成 PDF。

## 输出要求

1. 主报告：`/workspace/reports/security-report.md`（**必须**）
2. 可选附加：
   - `/workspace/reports/security-report.docx`（由 md 经 pandoc 转换）
   - `/workspace/reports/findings-list.xlsx`（漏洞/风险清单表）
3. 写完后在 `/workspace/out/report-manifest.json` 声明：

```json
{
  "primary_file": "security-report.md",
  "format": "md",
  "extra_files": ["security-report.docx", "findings-list.xlsx"]
}
```

`extra_files` 仅列出实际生成的文件。

## 报告结构（中文）

1. **概述**：项目信息、扫描范围、时间、所用模型/引擎摘要
2. **风险摘要**：按严重程度统计（高/中/低/信息）、整体风险评分
3. **漏洞与风险详情**（按严重程度降序；覆盖 `findings/index.json` **全部**条目，含 `item_type=risk`）：
   - 标题、严重程度、CWE/CVSS（如有）
   - 描述、影响范围
   - 代码位置与证据片段
   - 数据流/攻击路径（如有）
   - 修复建议
   - POC/reviewed 状态（如有）
4. **结论与建议**：整体评估、优先修复清单

## 数据契约

先读 `/workspace/context/report-context.json` 与 `/workspace/context/findings/index.json`，再逐条读对应 YAML。完整约定见同 flow 的 `report-runtime` Skill。

- 不要编造不存在的数据；缺失字段写「未提供」
- 默认中文；技术术语保留英文（XSS、RCE、SQL Injection 等）
- 源码在 `/workspace/source`（可能不存在）

## docx / xlsx 生成提示

主 md 完成后：

```bash
pandoc /workspace/reports/security-report.md -o /workspace/reports/security-report.docx
```

xlsx 用短 Python 脚本 + openpyxl，列建议：序号、标题、严重程度、CWE、文件:行、状态。
