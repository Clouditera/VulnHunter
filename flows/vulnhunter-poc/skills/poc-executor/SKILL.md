---
name: poc-executor
description: POC 脚本执行器 — 通过 run_poc.py 包装器执行 poc.sh，捕获实时输出并生成标准事件日志。
---

# Skill: POC 执行器

## 使用方式

**不要直接运行 `bash poc.sh`**，使用 `run_poc.py` 包装器：

```bash
python3 /opt/vulnhunter/flows/vulnhunter-poc/skills/poc-executor/run_poc.py \
  --bug-id BUG-001 \
  --script ./poc.sh \
  --target-url http://target:8080 \
  --log ./run.log \
  --events /workspace/out/.youngflow/logs/poc-exec-BUG-001.service.jsonl \
  --timeout 300
```

## 参数

| 参数 | 说明 |
|------|------|
| `--bug-id` | 漏洞 ID（用于事件标识）|
| `--script` | poc.sh 脚本路径 |
| `--target-url` | 目标地址（作为 `$1` 传入脚本）|
| `--log` | 完整输出日志文件路径 |
| `--events` | 实时事件文件路径（`*.service.jsonl` 格式）|
| `--timeout` | 执行超时秒数（默认 300）|

## 输出

### run.log
完整的 stdout + stderr 混合输出。

### *.service.jsonl
实时事件流，每行一个 JSON 事件：

```jsonl
{"type":"poc_output","ts":"...","stage":"generate-and-run-poc/BUG-001","stream":"stdout","message":"[*] sending payload..."}
{"type":"poc_output","ts":"...","stage":"generate-and-run-poc/BUG-001","stream":"stderr","message":"curl: (7) connection refused"}
{"type":"poc_exit","ts":"...","stage":"generate-and-run-poc/BUG-001","exit_code":0,"duration_ms":12345}
```

这些事件会被 VulnHunter 的 LiveLog 系统自动发现并推送到前端。
