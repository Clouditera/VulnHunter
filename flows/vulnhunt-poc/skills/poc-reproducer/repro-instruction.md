# 漏洞复现详细指引

本文档供复现执行者阅读，指导如何对单个漏洞进行复现并产出 PoC 脚本。

## 核心原则

- 每个漏洞应产出一个**可独立运行的 PoC 脚本**（`poc.sh`）
- PoC 脚本面向最终用户，要求一键运行、输出清晰
- 在 poc 脚本中优先使用 DevEye CLI 进行浏览器操作，使脚本可复现浏览器交互类漏洞
- 复现过程中截图留证，截图内容中尽量提供用户能直观理解的内容

## 复现流程

### 1. 分析漏洞

阅读 finding 文件，理解：
- 漏洞类型（XSS、SQLi、CSRF、SSRF、路径遍历等）
- 受影响端点和参数
- 扫描器给出的 payload 或证据

判断该漏洞是否可通过浏览器复现：
- **可浏览器复现**：XSS、CSRF、认证绕过、UI 注入等 → 使用 DevEye
- **需 HTTP 复现**：SQLi、SSRF、路径遍历、命令注入等 → 使用 curl
- **无法复现**：信息泄露（仅代码层面）、配置问题等 → 标记 SKIPPED 并说明原因

### 2. 手动验证

先手动尝试复现，确认漏洞存在：

**浏览器类漏洞：**
```bash
deveye navigate goto "http://$HOST_IP:<port>/<endpoint>"
deveye screenshot -o output/findings/<BUG_ID>/before.png

# 执行攻击操作（如注入 payload）
deveye type "#input" "<script>alert(1)</script>" --enter
deveye screenshot -o output/findings/<BUG_ID>/after.png

# 检查结果
deveye console --level error
deveye dom -s "body" --depth 3
```

**HTTP 类漏洞：**
```bash
curl -v "http://$HOST_IP:<port>/<endpoint>?param=<payload>"
```

### 3. 编写 PoC 脚本

在 `output/findings/<BUG_ID>/poc.sh` 创建可执行脚本。

#### 脚本设计原则

1. **自包含**：脚本内写死目标地址（默认值），但支持通过参数/环境变量覆盖
2. **过程可视**：每一步操作前打印说明，让用户理解正在做什么；每执行新的阶段前，短暂停顿，体现出脚本的动态运行效果
3. **结果明确**：最终明确输出漏洞是否复现成功，以及影响说明
4. **依赖最少**：优先用 curl/deveye，避免引入额外依赖

#### 脚本模板

```bash
#!/bin/bash
# PoC: <漏洞类型> - <BUG_ID>
# 影响端点: <endpoint>
# 风险等级: <severity>
#
# 使用方式:
#   ./poc.sh [目标地址]
#   例: ./poc.sh http://localhost:8080
#
# 依赖: deveye (浏览器类) 或 curl (HTTP 类)

set -euo pipefail

TARGET="${1:-http://<HOST_IP>:<port>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCREENSHOT_DIR="$SCRIPT_DIR"

echo "=========================================="
echo " 漏洞 PoC: <BUG_ID>"
echo " 类型: <漏洞类型>"
echo " 目标: $TARGET"
echo "=========================================="
echo ""

# --- 步骤 1: 说明漏洞原理 ---
echo "[*] 漏洞原理:"
echo "    <用 2-3 句话解释漏洞成因和危害>"
echo ""
sleep 3

# --- 步骤 2: 发送攻击请求 ---
echo "[*] 正在发送攻击 payload..."
# 浏览器类:
deveye navigate goto "$TARGET/<endpoint>"
deveye type "#<input>" "<payload>" --enter
deveye screenshot -o "$SCREENSHOT_DIR/poc-result.png"
# 或 HTTP 类:
# RESPONSE=$(curl -s "$TARGET/<endpoint>?param=<payload>")
sleep 3

# --- 步骤 3: 验证结果 ---
echo "[*] 验证攻击结果..."
# 检查 DOM / 响应内容 / 状态码等
# RESULT=$(deveye eval "document.querySelector('...').textContent" --no-snapshot)
sleep 3

# --- 步骤 4: 输出结论 ---
echo ""
echo "=========================================="
# 根据验证结果判断
echo " [!] 漏洞复现成功"
echo " 影响: <具体影响说明>"
echo " 截图: $SCREENSHOT_DIR/poc-result.png"
echo "=========================================="
```

#### 不同漏洞类型的 PoC 要点

| 漏洞类型 | 关键操作 | 验证方法 |
|----------|---------|---------|
| XSS (反射型) | 在输入框注入 payload 或构造 URL | 检查 DOM 中是否存在注入的元素、console 是否有执行记录 |
| XSS (存储型) | 提交 payload → 刷新页面 | 刷新后 DOM 中仍存在注入内容 |
| SQLi | 发送包含 SQL payload 的请求 | 响应中出现数据库报错或非预期数据 |
| CSRF | 构造恶意表单并自动提交 | 状态被成功修改 |
| SSRF | 请求内部地址 | 返回了内部服务的响应内容 |
| 路径遍历 | 请求 `../../etc/passwd` 等路径 | 返回了文件内容 |
| 认证绕过 | 不携带凭证访问受保护端点 | 成功获取了受保护资源 |

### 4. 产出文件

每个漏洞在 `output/findings/<BUG_ID>/` 下产出：

| 文件 | 说明 |
|------|------|
| `poc.sh` | 可执行的 PoC 脚本，`chmod +x` |
| `screenshot.png` | 复现成功的关键截图（浏览器类） |
| `result.json` | 结构化复现结果 |

#### result.json 格式

```json
{
  "bug_id": "BUG-001",
  "vuln_type": "xss",
  "severity": "high",
  "endpoint": "/search?q=",
  "status": "REPRODUCED",
  "evidence": "注入的 <script> 标签在页面 DOM 中被解析执行，console 捕获到 alert 调用",
  "poc_script": "poc.sh",
  "screenshot": "screenshot.png",
  "reproduction_steps": [
    "访问 /search 页面",
    "在搜索框输入 <script>alert(document.cookie)</script>",
    "提交搜索，页面弹出 alert 显示 cookie 内容"
  ]
}
```

## 复现结果判定

| 状态 | 判定条件 |
|------|---------|
| REPRODUCED | 成功触发漏洞行为，获得明确证据（截图/响应/日志） |
| PARTIALLY_REPRODUCED | 触及了漏洞相关行为但未完全复现（如 payload 被部分过滤但仍有风险） |
| NOT_REPRODUCED | 按扫描器报告的方式尝试后无法触发漏洞 |
| SKIPPED | 该漏洞类型无法通过当前手段复现（需说明原因） |

## 环境说明

- 运行在 Docker 容器中，宿主机 IP 为 `$HOST_IP`
- DevEye 浏览器运行在远端机器（地址见 Stage Instructions 的 `DEVEYE_SERVER`）
- Docker 部署的服务通过 `-p` 端口映射后，浏览器通过 `http://$HOST_IP:<映射端口>` 访问
- 使用 `--network $DOCKER_NETWORK` 将容器加入平台网络

## 注意事项

- PoC 脚本中的目标地址使用变量，不要硬编码 IP
- 截图保存在对应漏洞目录下，文件名要有意义，截图内容中尽量提供用户能直观理解的内容
- 如果某个漏洞复现耗时过长（如需要复杂的多步操作），设置合理的超时
- 不要修改 `../target/` 或 `../subject/` 中的文件
