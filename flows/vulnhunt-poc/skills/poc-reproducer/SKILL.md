---
name: poc-reproducer
description: 漏洞复现指引 — 分析漏洞报告、编写可独立运行的 PoC 脚本、使用 DevEye 或 curl 复现漏洞。
---

# Skill: 漏洞复现

## 目标

针对单个漏洞，生成可独立运行的 PoC 脚本（`poc.sh`），并执行验证。

## 复现流程

### 1. 分析漏洞

阅读 finding YAML 文件，理解：
- 漏洞类型（XSS、SQLi、CSRF、SSRF、路径遍历等）
- 受影响端点和参数
- 扫描器给出的 payload 或证据

判断复现方式：
- **浏览器复现**（XSS、CSRF、认证绕过等）→ DevEye
- **HTTP 复现**（SQLi、SSRF、路径遍历等）→ curl
- **无法复现** → 标记 SKIPPED

### 2. 编写 poc.sh

脚本要求：
- 自包含：目标地址通过 `$1` 传入，默认值硬编码当前目标
- 过程可视：每步操作前打印说明，阶段间短暂停顿
- 结果明确：最终输出复现成功/失败
- 依赖最少：优先用 curl / deveye

参考 `repro-instruction.md` 中的详细模板和各漏洞类型的 PoC 要点。

### 3. 产出文件

在 `<输出目录>/<BUG-ID>/` 下创建：

| 文件 | 说明 |
|------|------|
| `poc.sh` | 可执行 PoC 脚本（`chmod +x`）|
| `screenshot.png` | 复现截图（浏览器类）|
| `result.json` | 结构化复现结果 |

### result.json 格式

```json
{
  "bug_id": "BUG-001",
  "vuln_type": "xss",
  "severity": "high",
  "endpoint": "/search?q=",
  "status": "REPRODUCED",
  "evidence": "注入的 script 标签被执行",
  "poc_script": "poc.sh",
  "screenshot": "screenshot.png",
  "reproduction_steps": ["步骤1", "步骤2"]
}
```

## 复现结果判定

| 状态 | 判定条件 |
|------|---------|
| REPRODUCED | 成功触发漏洞，有明确证据 |
| PARTIALLY_REPRODUCED | 触及漏洞行为但未完全复现 |
| NOT_REPRODUCED | 尝试后无法触发 |
| SKIPPED | 无法通过当前手段复现 |
