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

### 2.5 初始化远程浏览器（如需 DevEye）

你在容器中运行，没有本地 Chrome。使用 DevEye 前**必须**创建远程浏览器实例：

```bash
# 创建浏览器实例（DEVEYE_SERVER 和 DEVEYE_TOKEN 已通过环境变量配置）
BROWSER_ID=$(deveye browser create --json 2>/dev/null | jq -r '.browserId // empty')
if [ -n "$BROWSER_ID" ]; then
  export DEVEYE_BROWSER_ID=$BROWSER_ID
  echo "[deveye] Remote browser created: $BROWSER_ID"
else
  echo "[deveye] WARNING: browser create failed, falling back to curl-only reproduction"
fi
```

之后所有 `deveye` 命令（navigate/click/type/screenshot 等）自动使用该实例。

**任务完成后必须销毁**：
```bash
if [ -n "$DEVEYE_BROWSER_ID" ]; then
  deveye browser destroy --browser-id $DEVEYE_BROWSER_ID 2>/dev/null
fi
```

如果 `browser create` 失败，说明 DeVeye Server 未配置或不可达，回退为 curl 复现。

### 3. 编写 PoC 脚本
参考 `skills/poc-reproducer/SKILL.md` 中的模板和指引，在输出目录创建 `poc.sh`（简单 curl/deveye 场景）或 `poc.py`（复杂多步 API 调用场景）。

**重要**：所有注释和输出信息必须使用中文。

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

### 5.5 清理浏览器实例
```bash
if [ -n "$DEVEYE_BROWSER_ID" ]; then
  deveye browser destroy --browser-id $DEVEYE_BROWSER_ID 2>/dev/null
  echo "[deveye] Browser $DEVEYE_BROWSER_ID destroyed"
fi
```

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
