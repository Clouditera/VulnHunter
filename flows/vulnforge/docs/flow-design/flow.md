# VulnForge Flow Protocol

## 身份与背景

身份：安全专家。  
背景：解决复杂安全审计任务。  
方法：反思、决策与执行。

- **反思、决策**：由 `decide` 节点完成。`decide` 检查工作区状态，决定下一轮要采取的行动。
- **执行**：执行 `decide` 派发的行动。

---

## 工作区结构

工作区使用三个核心目录组织任务和线索：

| 目录 | 含义 |
|---|---|
| `todo/` | 待执行任务。执行节点从这里读取并处理任务。 |
| `leads/` | 跨阶段信号。`leads/ADV-*.md`、`leads/HYP-*.md` 是待 `decide` 选择的审计链路和风险假设；`leads/LEAD-*.md` 是其它阶段交回 `decide` 的回流线索。 |
| `done/` | 已处理完成的任务和线索文件。处理完成的文件不再保留在 `todo/` 或 `leads/` 中，而是移动到 `done/`。`done/` 不再按来源分子目录，保留原文件名即可。 |

`todo/`、`leads/`、`done/` 同级。

---

## 文件格式

所有任务和线索文件都是 Markdown 文件，frontmatter 统一包含三个基础字段：

```yaml
---
round: 1
id: onboard-R1
status: pending
---
```

### status

`status` 统一表示任务/线索的处理生命周期，适用于 `todo/`、`leads/` 和 `done/` 中的 onboard、COG、ADV、HYP、LEAD、CHAIN 等文件：

| 值 | 含义 |
|---|---|
| `pending` | 待处理。 |
| `done` | 已由执行节点正常消费。 |
| `closed` | 被 `decide` 判断为重复、低价值、不符合用户需求或存在问题而关闭。 |

### HYP 的额外字段

HYP 文件额外包含 `hyp_status` 字段，用于描述风险假设的研判状态：

```yaml
hyp_status: pending # pending | confirmed | refuted
```

HYP 的生命周期在 `verify` 结束后结束，确认的 HYP 会转化为 finding，后续动态复现以 finding 为对象继续推进。

---

## findings

`findings/` 是漏洞最终出口，不论是静态确认还是动态复现都写到这里。`findings/` 下不再直接放 yaml，而是按漏洞创建目录：

```text
findings/
└── BUG-R2-C1-A1-H1/
    ├── report.yaml
    ├── poc/              # 启用 POC 并完成/尝试复现后产出
    └── exp/              # 启用 EXP 后产出
        ├── business-model.md
        ├── threat-model.md
        └── exp.md
```

`report.yaml` 用 `finding_class` 区分漏洞与风险，用 `poc_status` / `exp_status` 描述动态复现和 EXP 状态（`exp_status` 含 `awaiting-poc`：漏洞类 finding 创建时的初始状态，PoC 成功后推进为 `pending`）：

---

## 动态验证链（引擎调度）

`poc-verify` / `ev-assess` 不由 `decide` 派发，也不使用 `todo/` 任务。`verify` 结束后固定进入引擎动态门禁：

```text
verify ──→ poc_gate（读 dynamic.yaml）──开启──→ poc-verify（map：poc_status=pending）
                                              └─关闭→ exp_gate ──开启→ ev-assess ──→ 回 decide
poc-verify collector ──exp 开启──→ ev-assess（map：exp_status=pending）──→ 回 decide
```

- `dynamic.yaml` 由平台（`scan-mode.sh`）根据受信环境变量写入输出目录，字段 `dynamic.poc_enabled` / `dynamic.exp_enabled`；静态运行双 false，不启动任何 PoC/EV worker。本地直跑需手动写入。
- 两个 map 阶段均串行（`concurrency: 1`），直接迭代 `findings/BUG-*/report.yaml`，`report.yaml` 是唯一状态源。
- worker 入口做防御校验：poc-verify 校验 `finding_class: vulnerability`；ev-assess 校验 `poc_status: reproduced`（兼容历史 `poc_status: pending, exp_status: pending` 数据，不满足时不动状态直接退出）。
- 未完成项保持待处理状态，在后续 verify 轮次重试（`error_strategy: continue`）。

---

## decide 的工作模式

`decide` 的一般工作模式：

1. 检查工作区情况。
2. 使用 `workspace_diff` 查看工作区变更。
3. 写入 `decision.yaml`，用 `next` 明确本轮路由到哪个执行节点。
4. 对不同文件做针对性处理：
   - `leads/LEAD-*` 需要由 `decide` 消费；处理完成后将 `status` 更新为 `done` 或 `closed`，并移动到 `done/`。
   - `leads/ADV-*`、`leads/HYP-*` 需要由 `decide` 阅读并按需转移到 `todo/`；若不处理，可将 `status` 更新为 `closed` 并移动到 `done/`。
   - `todo/` 中已完成的任务需要移动到 `done/`。
5. 在 `decide` 结束前创建工作区快照。

`decision.yaml` 是路由决策信号，`todo/` 是执行内容信号。启用 POC/EXP 时，`onboard` 确认动态执行环境并写入 `knowledge/build/build.md`；环境错误阻断动态目标时，`decide` 可写 `next: exit` 退出。

---

## 示例流程

### 1. 首轮：onboard

首轮，`decide` 观察到工作区干净，决定执行 `onboard`，于是写入 `todo/onboard-R1.md`：

```markdown
---
round: 1
id: onboard-R1
status: pending
---
初始化项目画像、wiki 和威胁模型。
```

然后 `decide` 创建工作区快照并结束。

`onboard` 消费 `todo/onboard-R1.md`，创建画像、wiki 和威胁模型；启用 POC/EXP 时确认动态执行环境并写入 `knowledge/build/build.md`。退出前将任务标 `done` 并移动到 `done/`。

### 2. 第二轮：cognize

第二轮，`decide` 会话复用，使用 diff 工具确认 `onboard` 执行完成，按照流程应该执行 `cognize`。派发 `cognize` 时，`decide` 需要根据项目画像、覆盖率和用户审计要求综合产出 `todo/COG`：

```markdown
---
round: 2
id: COG-R2-C1
status: pending
---
快速阅读 src/files 模块，更新 wiki，并提供合理的审计方向建议 ADV-R2-C1-A*。
```

然后 `decide` 创建工作区快照并结束。

`cognize` 开始，消费 `todo/COG-R2-C1.md`，阅读代码，更新 wiki，并产出 ADV：

```markdown
---
round: 2
id: ADV-R2-C1-A1
status: pending
---
src/files/download.py，负责完成 xxx，功能独立，可供审计。
```

退出前修改 `todo/COG-R2-C1.md` 的 `status` 为 `done`，并移动到 `done/`。

### 3. 第三轮：hunt

第三轮，`decide` 会话复用，使用 diff 工具确认 `cognize` 处理完毕。此时若存在未消费的 `leads/ADV`，`decide` 可以选择继续派发新的 `cognize`，也可以处理 `leads/ADV`。

选择处理 `leads/ADV` 时，将选中的 ADV 文件移动到 `todo/`，frontmatter 无需额外处理，然后 `decide` 创建工作区快照并结束。

`hunt` 开始，消费指定的 `todo/ADV-R2-C1-A1.md`，并产出 HYP：

```markdown
---
round: 3
id: HYP-R2-C1-A1-H1
status: pending
hyp_status: pending
---

某某函数第 xxx 行存在 xx 问题，在 xxx 情况下可能导致 xxx。
```

退出前修改 `todo/ADV-R2-C1-A1.md` 的 `status` 为 `done`，并移动到 `done/`。

### 4. 第四轮：verify

第四轮，`decide` 会话复用，使用 diff 工具确认工作区状态，发现 ADV 处理完毕且有新的 HYP。`decide` 此时可选择执行 `cognize`、`hunt` 或 `verify`；一般情况下执行 `verify`。

若 HYP 不符合用户需求、重复或明显低价值，`decide` 可以不派发，直接将 HYP 的 `status` 改为 `closed`，添加注释并移入 `done/`。

若执行 `verify`，`decide` 将选中的 HYP 文件移动到 `todo/`，然后创建工作区快照并结束。

`verify` 开始，消费指定的 `todo/HYP-R2-C1-A1-H1.md`，对风险假设做完整的双向论证：

1. 先从攻击者角度尝试证实。
2. 再从防御者角度寻找反证。

若假设成立：

- 产出 `findings/BUG-R2-C1-A1-H1/report.yaml`。
- 将 HYP 的 `hyp_status` 修改为 `confirmed`。
- 将 HYP 的 `status` 修改为 `done`。

若假设不成立：

- 将 HYP 的 `hyp_status` 修改为 `refuted`。
- 将 HYP 的 `status` 修改为 `done`。

完成后将 HYP 文件移动到 `done/`。

### 5. 后续：poc-verify（引擎调度）

启用 POC 时，`verify` 结束后由引擎动态门禁自动调度 `poc-verify`：串行迭代所有 `poc_status: pending` 的 vulnerability finding，worker 直接接收 `findings/BUG-*/report.yaml` 路径，不经过 `todo/`。提供 `sandbox-config` 时在沙箱执行；未提供时本地执行。

`poc-verify` 处理该 finding，并把 `poc_status` 与 `exp_status` 一起原子推进：

- 复现成功后：
  - 在该 finding 目录下生成 `poc/`。
  - `report.yaml` 的 `poc_status` 更新为 `reproduced`，`exp_status` 从 `awaiting-poc` 推进为 `pending`。
- 复现失败：
  - 已具备必要能力但未复现时，`poc_status` 更新为 `fail-reproduced`、`exp_status` 置为 `not-needed`，记录失败证据。
  - 执行环境或外部条件不足时，`poc_status` / `exp_status` 均更新为 `blocked`，记录缺失条件。

`fail-reproduced` 和 `blocked` 暂时视为动态复现链路的终态，不做额外重试约定。

### 6. 后续：ev-assess 与 exp-build

启用 EXP 时，`ev-assess` 同样由引擎在 poc-verify 之后自动调度：串行迭代所有 `exp_status: pending` 的 finding，入口校验 `poc_status: reproduced`，不满足时不动状态直接退出（留给 poc-verify）。启用组合链且出现组合利用信号时，`decide` 可派发 `todo/CHAIN-*.md` 给 `exp-build`（exp-build 仍由 decide 派发）。提供 `sandbox-config` 时在沙箱执行；未提供时本地执行。风险类 finding 不做 POC/EXP。

`ev-assess` 处理的 finding，必产文件统一写入 `findings/<BUG-id>/exp/`：

- `business-model.md`：漏洞相关功能的真实业务环境和运行方式。
- `threat-model.md`：围绕当前 finding 的攻击者、前提、边界和攻击路径。
- `exp.md`：EXP 模拟环境、脚本使用方式、执行结果、影响结论和 report 修正说明。

可选补充 `findings/<target-BUG>/exp/**`，仅在需要脚本、场景文件或运行日志时创建。`exp_status` 按 `schemas/bug-report.schema.yaml` 更新。

`exp-build` 处理组合任务：产物写入 `exploits/EXP-<id>/`（`report.yaml` 以 `schemas/chain-report.schema.yaml` 为准），成功与失败的关键经验写入 `knowledge/exploits/EXP-<id>.md` 供后续轮次复用。
