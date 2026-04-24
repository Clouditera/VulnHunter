# 任务：生成并执行单个漏洞的 POC

针对当前漏洞报告，生成可独立运行的 PoC 脚本，执行脚本并记录结果。

## 流程

### 1. 分析漏洞
阅读漏洞报告文件，理解：
- 漏洞类型（XSS、SQLi、CSRF、SSRF、路径遍历等）
- 受影响端点和参数
- 扫描器给出的 payload 或证据

### 2. 判断复现方式
- **浏览器复现**（XSS、CSRF、认证绕过等）→ 使用 DevEye
- **HTTP 复现**（SQLi、SSRF、路径遍历等）→ 使用 curl
- **无法复现** → 标记 SKIPPED 并说明原因

### 3. 编写 poc.sh
参考 `skills/poc-reproducer/SKILL.md` 中的模板和指引，在输出目录创建 `poc.sh`。

脚本要求：
- 自包含，目标地址通过参数传入（`$1`），默认值为当前目标
- 每一步操作前打印说明
- 最终明确输出漏洞是否复现成功

### 4. 执行 poc.sh
使用 `run_poc.py` 执行脚本（不要直接 `bash poc.sh`）：

```bash
python3 /opt/vulnhunt/flows/vulnhunt-poc/skills/poc-executor/run_poc.py \
  --bug-id <BUG-ID> \
  --script ./poc.sh \
  --target-url <TARGET_URL> \
  --log ./run.log \
  --events <EVENTS_DIR>/<BUG-ID>.service.jsonl \
  --timeout 300
```

### 5. 截图留证
使用 DevEye 截图（浏览器类漏洞）或保存 HTTP 响应截图。

### 6. 写入 result.json

```json
{
  "bug_id": "<BUG-ID>",
  "vuln_type": "<type>",
  "severity": "<severity>",
  "endpoint": "<affected endpoint>",
  "status": "REPRODUCED | PARTIALLY_REPRODUCED | NOT_REPRODUCED | SKIPPED",
  "evidence": "<复现过程描述>",
  "poc_script": "poc.sh",
  "screenshot": "screenshot.png",
  "reproduction_steps": ["步骤1", "步骤2", "..."]
}
```

## 输出目录结构

在输出根目录下创建 `<BUG-ID>/` 子目录：

```
findings/<BUG-ID>/
  poc.sh           # PoC 脚本
  run.log          # 执行日志
  result.json      # 结构化结果
  screenshot.png   # 截图（可选）
```
