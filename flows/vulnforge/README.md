# VulnForge Flow

VulnForge Flow 是一个基于 YoungFlow 的 AI 代码安全分析资产包。

它不是传统漏洞扫描流水线，而是一次关于 agent 安全审计方式的设计实验：

> 用一条认知螺旋模拟安全专家持续探索、论证、积累知识，并把静态发现动态复现成真漏洞的过程。

## 核心理念

### 认知驱动的 decide 螺旋

VulnForge 的核心是一个由 `decide` 驱动的循环螺旋。审计任务被拆解成多个边界清晰的环节，由 `decide` 调度推进：每轮 `decide` 查看当前认知、待执行任务和上轮结果，选择本轮最该推进的方向并派发任务；执行阶段结束后回到 `decide`，直到项目认知基本完成、待办清空。

```text
decide ──→ onboard / cognize / hunt / verify / exp-build ──→ 回 decide ──→ … ──→ report
             └── exit（环境错误时直接退出）
verify ──→ 动态门禁（dynamic.yaml）──→ poc-verify ──→ ev-assess ──→ 回 decide
```

其中 `poc-verify` / `ev-assess` 不由 `decide` 派发：`verify` 结束后固定进入引擎动态门禁，按 finding 状态自动串行调度，避免模型调度不稳定导致动态验证被跳过。

这是 agent think-act-observe 循环的升维结构：用结构化产物（wiki、ADV、HYP、finding）在 session 间传递知识，解决单一 context window 无法承载复杂项目分析的问题。

### 安全审计是认知构建过程

安全专家做审计时不是搜索已知漏洞模式，而是先理解项目，再从理解中识别风险。VulnForge 模拟的正是这个过程：先建立对项目的安全认知（攻击面、信任边界、危险位置），再从认知中识别审计链路、提出风险假设、双向论证裁决。

### 静态候选 + 动态复现

静态论证确认的 finding 只是**静态候选**；启用 POC 时，引擎在每轮 `verify` 后自动串行调度 `poc-verify` 真实复现，复现成功的在 finding 目录下产出 `poc/` 复现包；启用 EXP 时，`ev-assess` 评估单漏洞在真实业务/威胁场景下的最大影响，达不到时降级报告；启用组合链时，`exp-build` 进一步探索漏洞组合的破坏力。`findings/` 是漏洞最终出口，组合 EXP 产物写入 `exploits/`。

### 极简循环，能力外置，知识累积

- **极简循环**：flow 只保留高层认知动作，不替模型规定过细的分析路径。
- **能力外置**：安全分析方法论沉淀为可复用的 skill，不硬编码在 flow 中。
- **知识累积**：分析过程中的理解持久化为 wiki，让下一轮不从零开始。

## 任务与线索流转

工作区使用三个同级目录组织任务和线索：

| 目录 | 含义 |
|---|---|
| `todo/` | 待执行任务。执行节点从这里读取并处理任务。 |
| `leads/` | 跨阶段信号。`leads/ADV-*.md`、`leads/HYP-*.md` 是待 `decide` 选择的审计链路和风险假设；`leads/LEAD-*.md` 是其它阶段交回 `decide` 的回流线索。 |
| `done/` | 已处理完成的任务和线索文件。 |

所有任务和线索文件都是 Markdown 文件，frontmatter 统一为 `round` / `id` / `status`，`status` 取值 `pending` / `done` / `closed`。HYP 文件额外含 `hyp_status`，LEAD 额外含 `type`。具体取值以 `schemas/` 为准。

`decide` 写 `decision.yaml`（含 `next` 和 `round`）作为路由/退出信号，并把本轮要执行的任务写入 `todo/`；执行节点从 `todo/` 读取任务，完成后把 `status` 更新为 `done` 并移动到 `done/`。

## Flow 阶段

### decide（调度决策）

每轮查看工作区状态，处理回流线索，选择本轮唯一方向并派发任务到 `todo/`。只做调度和派发，不亲自建认知、狩猎、论证、复现或报告。

### onboard（初始化）

初始化项目画像、wiki、威胁模型。启用 POC/EXP 时确认动态执行环境，结论写入 `knowledge/build/build.md`。

### cognize（认知建立）

粗读一个切面（COG），建立功能、入口、权限边界、数据形态、危险位置和初步风险估计，并识别值得继续精读的审计链路（ADV）。当 findings 较多且表现出组合利用可能性时，也可梳理组合升级机会，产出 EXP 候选或定向升级 ADV。

### hunt（漏洞狩猎）

顺着一条审计链路（ADV）做局部精读，根据安全直觉产出风险假设（HYP）。

### verify（双向论证）

对假设（HYP）做完整的双向论证：先从攻击者角度证实可达性，再从防御者角度寻找反证。裁决 `confirmed` → 转化为 finding；`refuted` → 关闭。漏洞类 finding 创建时 `exp_status` 置为 `awaiting-poc`，PoC 复现成功后才推进为 `pending`。

### poc-verify（动态复现，启用 POC 时，引擎调度）

由引擎在每轮 `verify` 后自动调度，串行处理所有 `poc_status: pending` 的 vulnerability finding（不依赖 `todo/` 任务）。提供 `sandbox-config` 时在沙箱中执行；未提供时本地执行。复现成功在该 finding 目录下产出 `poc/` 并把 `exp_status` 推进为 `pending`；复现失败标 `fail-reproduced`。

### ev-assess（单漏洞 EXP 影响评估，启用 EXP 时，引擎调度）

由引擎在 poc-verify 之后自动调度，串行处理所有 `exp_status: pending` 的 vulnerability finding，入口防御校验 `poc_status: reproduced`（不依赖 `todo/` 任务）：理解相关业务与威胁模型，搭建准业务环境，评估真实场景下的最大影响；声称影响无法达成时降级数据与报告。提供 `sandbox-config` 时在沙箱中执行；未提供时本地执行。

### exp-build（组合 EXP 构造，启用组合链时）

在单漏洞 EXP 刻画的原语基础上，深入探索并构造破坏力最大的漏洞组合。decide 看到组合信号即可派发，成员与链路设计由 exp-build 自主探索。产物写入 `exploits/EXP-<id>/`；成功与失败的关键经验写入 `knowledge/exploits/`，供后续轮次复用。

### report（结果汇总）

汇总项目认知、审计进度、确认发现与阶段性安全结论。环境错误可由 `exit` 退出。

## 命名派生链

产物编号沿产物流逐级派生，全程可溯源：

```text
COG-R{轮}-C{序}  →  ADV-R{轮}-C{序}-A{序}  →  HYP-R{轮}-C{序}-A{序}-H{序}  →  BUG-R{轮}-C{序}-A{序}-H{序}
LEAD-<来源产物去前缀部分>-L{序}
```

## 产物目录

```text
knowledge/profiler.yaml           项目画像
knowledge/wiki/                   项目理解（index / overview / threat-model / 各主题）
knowledge/worklog.md              逐轮完成记录
knowledge/build/                  动态执行环境记录（POC/EXP 按需维护）
knowledge/coverage/               代码阅读覆盖率（extension 自动维护）

todo/                             待执行任务（onboard / COG / ADV / HYP / CHAIN）
leads/                            待处理链路（ADV / HYP）和回流线索（LEAD）
done/                             已处理完成的任务和线索
decision.yaml                     decide 本轮调度方向
dynamic.yaml                      平台写入的动态门禁配置（引擎读取，非模型产物）

findings/BUG-*/                   漏洞最终出口（静态确认 + 动态复现 + EXP 影响评估）
  ├── report.yaml                 漏洞/风险报告（finding_class / poc_status / exp_status 描述状态）
  ├── poc/                        复现包（复现成功后产出）
  └── exp/                        EXP 业务模型、威胁模型、验证过程和辅助文件
      ├── business-model.md
      ├── threat-model.md
      └── exp.md
report/                           审计报告
```

## YoungFlow 提示词四层架构

| 层 | 职责 | 来源 |
|----|------|------|
| **Agent** | 身份与全局地图：审计者怎么思考、工作区结构与产物流转 | `agents/agent.md` |
| **Skill** | 方法论：怎么判断、怎么诊断（纯领域知识，零 flow 耦合） | `skills/*/SKILL.md` |
| **Task** | 做什么：当前阶段目标和产物规则 | `tasks/*.md` |
| **Prompt** | 运行时上下文：路径和变量 | `flow.audit.yaml` |

## 资产包结构

```text
VulnForge/
├── flow.audit.yaml               认知 decide 螺旋流水线定义
├── agents/
│   └── agent.md                   审计专家身份 + 工作区地图 + 协作规则
├── skills/
│   ├── wiki-maintainer/           wiki 维护方法论
│   ├── threat-modeling/           威胁建模方法论
│   ├── project-profiler/          项目画像方法论
│   ├── cognition-building/        切面认知建立方法论
│   ├── hypothesis-writer/         风险假设表达方法论
│   ├── security-affirmer/         证实论证方法论
│   ├── security-challenger/       证否论证方法论
│   ├── bug-report/                漏洞报告方法论
│   └── report-generator/          报告生成方法论
├── tasks/
│   ├── decide.md                  调度决策
│   ├── onboard.md                 初始化
│   ├── cognize.md                 认知建立
│   ├── hunt.md                    漏洞狩猎
│   ├── verify-audit.md            双向论证
│   ├── poc-verify.md              动态复现
│   ├── ev-assess.md              单漏洞 EXP 影响评估
│   ├── exp-build.md               组合 EXP 构造
│   └── report-audit.md            结果汇总
├── schemas/
│   ├── decision.schema.yaml       decide 路由
│   ├── todo.schema.yaml           通用 todo 任务 frontmatter
│   ├── cog.schema.yaml            COG frontmatter
│   ├── advice.schema.yaml         ADV frontmatter
│   ├── hypothesis.schema.yaml     HYP frontmatter（含 hyp_status）
│   ├── lead.schema.yaml           LEAD frontmatter（含 type）
│   ├── profiler.schema.yaml       项目画像
│   ├── bug-report.schema.yaml     漏洞报告（含 poc_status / exp_status）
│   └── audit-report.schema.yaml   最终报告
├── templates/                     各产物正文结构示范
├── docs/flow-design/              设计文档与实现计划
└── extensions/
    ├── coverage-core.ts           覆盖率共享逻辑
    ├── code-coverage-tracker/     代码阅读覆盖率追踪（hunt 用）
    ├── code-coverage-viewer/      覆盖率查询工具（decide/report 用）
    ├── output-contract/           产物写权限和 schema 校验
    └── workspace-diff/            工作区变更追踪（decide 用）
```

## 运行方式

引擎动态门禁读取输出目录下的 `dynamic.yaml`（平台由 `worker-assets/scan-mode.sh` 根据受信环境变量生成）。本地直跑请使用 `scripts/run-audit.sh` 包装器：`--enable-poc` / `--enable-exp` 保持为公共输入契约，包装器会在交给 youngflow 前据此生成 `dynamic.yaml`，避免双事实源/遗漏（直接裸调 youngflow 会因缺少该文件在 verify 后的门禁阶段失败）：

```bash
# 纯静态审计
scripts/run-audit.sh flow.audit.yaml \
  --work-dir /path/to/target/project \
  --output-dir .runs/example \
  --audit-scope "全面审计。" \
  --vuln-focus "重点关注外部输入解析路径中的高危内存破坏类漏洞。" \
  --sched-instr "无额外要求。" \
  --max-parallel 20

# 启用动态复现；--sandbox-config 文件说明连接方式/工作目录/执行命令；未提供时本地执行
# （包装器自动生成 poc_enabled: true）
scripts/run-audit.sh flow.audit.yaml \
  --work-dir /path/to/target/project \
  --output-dir .runs/example \
  --enable-poc 1 \
  --sandbox-config /path/to/sandbox.md \
  --max-parallel 1

# 启用动态复现 + EXP 影响评估
scripts/run-audit.sh flow.audit.yaml \
  --work-dir /path/to/target/project \
  --output-dir .runs/example \
  --enable-poc 1 \
  --enable-exp 1 \
  --max-parallel 1

# 再启用组合 EXP 构造
scripts/run-audit.sh flow.audit.yaml \
  --work-dir /path/to/target/project \
  --output-dir .runs/example \
  --enable-poc 1 \
  --enable-exp 1 \
  --enable-chain 1 \
  --max-parallel 1

# 续跑（保留业务产物，重新 decide）
scripts/run-audit.sh flow.audit.yaml \
  --work-dir /path/to/target/project \
  --output-dir .runs/example \
  --continue

# 推进到指定阶段后停（按 stage 数组截断）
scripts/run-audit.sh flow.audit.yaml ... --until cognize

# 查看阶段
scripts/run-audit.sh flow.audit.yaml --list-stages
```
