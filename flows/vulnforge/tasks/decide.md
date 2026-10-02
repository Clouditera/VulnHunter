# 目标

查看当前审计进展，选择本轮唯一推进方向，并为本轮派发任务。只做调度和派发，不亲自建认知、狩猎、论证、复现或报告。

# 相关信息

- 每轮用 `coverage` 查看代码阅读覆盖（仅记录 `hunt` 阶段），并结合 `audit_scope` 判断进展。
- `workspace_diff` 工具返回自上一轮基线以来工作区的变化；`workspace_snapshot` 把当前状态固化为新基线。两者配合：开场 diff 看上轮增量，结束前 snapshot 固化本轮基线。
- 当前运行以 `sched_instr` 限定调度范围，优先级高于 `audit_scope`；`completion reason` 仅在该范围内推进，与具体任务相关的约束写进任务正文。

工作区的目录结构、产物定位和写入规则见系统提示。

# 产出

## 处理回流线索

只处理 `sched_instr` 范围内的 `leads/LEAD-*`；范围外线索留待后续运行：

- `knowledge`：沉淀成 wiki 主题文档，按当前主题重建 `knowledge/wiki/index.md`；情报类内容（历史漏洞、上游动态等）沉淀到 `knowledge/research/` 并维护其 `index.md`。完成后标 `done` 并移到 `done/`。
- `threat-model`：合并进 `knowledge/wiki/threat-model.md`；完成后标 `done` 并移到 `done/`。涉及源码缺失的，先补齐代码再调度该区域审计。
- `hunt`：判断是否值得追。不值得追时标 `closed`、写明原因并移到 `done/`。值得追时，必须在本轮创建或派发可执行下游工件后，才能标 `done` 并移到 `done/`：
  - 边界还不清楚：创建 `todo/COG-*.md` 或 `leads/ADV-*.md`。
  - 已有清晰审计路径：创建/派发 `ADV-*`。
  - 已有明确代码锚点、触发路径和危害主张：创建/派发 `HYP-*`，进入 verify。
  - 重复线索只能重复到已有 finding、HYP 或 ADV；只重复到另一个 LEAD 时，不能直接关闭。

## 派发本轮任务

综合项目认知、覆盖率、任务池、上轮结果和用户指令选择本轮唯一方向，写入 `decision.yaml` 并准备任务文件；`completion reason` 中超出 `sched_instr` 的缺口留待后续运行。同一方向可派发多个任务，frontmatter 统一为 `round` / `id` / `status: pending`。

- **onboard**：项目画像/初始化产物缺失，或 `$OUTPUT_DIR/gate.yaml` 缺席或其 `next` ≠ continue（gate 未通过时唯一合法 next=onboard，不得派发其它方向）；启用 POC/EXP 且缺少动态环境记录。创建 `todo/onboard-*.md`。
- **cognize**：有代码区域尚未被覆盖到时，可以创建一个或多个 `todo/COG-*.md`，由 `cognize` 阅读代码产出审计链路 `ADV`。
- **research**：检索公开信息发现审计面。审计早期（onboard 完成后、覆盖率低时）优先派发；存在情报类回流线索时也可派发。创建 `todo/RES-*.md`，正文指定检索方向（项目、版本、关注面）。research 与 cognize 产出的 `ADV` 统一由 hunt 消费。
- **hunt**：存在待执行 ADV。把本轮选中的一个或多个 ADV 从 `leads/` 移入 `todo/`，frontmatter 无需额外处理。
- **verify**：存在待研判 HYP。把本轮选中的一个或多个 HYP 从 `leads/` 移入 `todo/`，frontmatter 无需额外处理。
- **exp-build**：已启用组合链、动态环境可用，且出现组合利用信号（同一组件或攻击面上有多个已完成 ev-assess 的 vulnerability，或 `knowledge/exploits/` 的经验指向可行组合）。创建 `todo/CHAIN-*.md`，正文只写组合方向与信号；成员由 exp-build 自主探索。exp-build 是第二阶段方向，原语清单太薄时不派发。

动态验证链（poc-verify / ev-assess）由引擎调度，不是 decide 的派发方向：`verify` 结束后固定进入引擎动态门禁（读取平台写入的 `dynamic.yaml`），按 finding 的 `poc_status` / `exp_status` 串行推进，无需也不应为其创建任何任务文件。

「动态环境可用」即 `knowledge/build/build.md` frontmatter 中 `sandbox` 为 available；为 unreachable 时不派发 exp-build，`sched_instr` 范围内只剩动态工作时走 exit。
- **report**：`sched_instr` 范围内无待推进项时，交由 report 复核；范围外 `leads/` 不阻止进入 report，也不创建 `REPORT-*` 任务。
- **exit**：目标项目不完整、动态环境不满足 POC/EXP 需要等异常情况时，退出任务。写 `decision.yaml.next: exit`。

未选中的 ADV、HYP 和静态候选留在 `leads/` 原处，等待后续轮次处理。

## 任务正文

对于 `todo/onboard-*.md` 和 `todo/COG-*.md`，完全由决策阶段起草，任务正文需要描述清楚。ADV/HYP 主要移动源 `leads/` 产物，不补充正文；CHAIN 新建任务，但正文只写组合方向与必要边界。只转写与当前任务直接相关的用户补充说明。

如“用户补充说明: 只查找内存溢出漏洞”，此时可以在 HYP 任务中，补充说明“仅关注内存溢出相关问题，若没有此类问题则无需处理”。

## worklog

在 `knowledge/worklog.md` 追加一条记录，字段 `Round | Decision | Reason`：

- `Round`：`decision.yaml` 的 `round` 字段。
- `Decision`：`decision.yaml` 的 `next` 字段，即本轮选定的方向（onboard / cognize / research / hunt / verify / exp-build / report / exit）。
- `Reason`：一句话说明本轮为什么这么选择。

# 备注

- 决策开始时调用 `workspace_diff()` 和 `coverage()`；首轮通读工作区并用 `workspace_snapshot()` 建立基线。
- 全部产出写入完成后，调用 `workspace_snapshot()` 固化新基线，使下一轮 `workspace_diff()` 只看到执行环节增量。
- 任务文件的正文内容简洁明了即可，如“对 src/service/upload.js 模块建立日志”“对 BUG-xxx.md 进行 exp 构建”。另外，用户指令中与任务目标相关的部分，也需要通过任务文件正文来传递。
- 对于不符合审计目标等用户关注方向的 `leads/` 产物，可以根据实际情况置为 `closed` 并标注原因，然后移入 `done/`。
- `gate.yaml` 是 onboard 阶段的门禁产物，非 onboard 阶段一律禁止读写；decide 不得代替 onboard 判定门禁。
