---
name: Bug Report
description: 漏洞报告撰写技能 — 把已确认的安全问题整理成结构化报告。
---

# bug-report

漏洞报告撰写技能。把已确认的安全问题整理成结构化报告。

## 核心原则

发现漏洞后，你脑子里已经有完整的理解——位置、原因、影响、修复。报告只是把这些理解整理成第三方可读的结构化材料，不需要额外发明结论。

漏洞报告服务于不参与审计过程的读者：上游开发者、安全响应人员、产品安全负责人。报告必须只描述目标项目、漏洞事实、影响和修复建议，不暴露审计任务过程。

### 第三方读者视角

报告中可以保留代码路径、函数名、协议字段、命令参数、日志关键字等技术原文；但不要写审计系统内部语言或任务过程信息，例如：

- 不写“本次任务”“旧产物”“历史 finding”“动态复现阶段”“模型判断”等过程描述。
- 不写审计流程内部的产物和节点概念（假设、链路、认知切面、回流线索、动态复现阶段等），除非它们本身是目标项目的术语。
- 不把复现脚本执行过程、调试尝试、环境搭建过程塞进漏洞正文；这些属于 reproduction.md / 日志。

报告正文的判断依据应表达为代码事实和运行事实：哪个外部输入、经过哪个处理链、到达哪个缺陷点、造成什么可观察影响。

## 报告结构

复制 `skills/bug-report/template.yaml` 作为起点，填充四段：metadata / description / code / references。

### metadata（索引 + 评分）

| 字段 | 说明 |
|------|------|
| title | 三段式标题（见下） |
| vuln_type | 类型简写（见枚举表） |
| finding_class | vulnerability（漏洞）/ risk（风险或弱点） |
| cwe | CWE 编号（如 CWE-190，参考 cwe-guide.md 确定） |
| cvss_vector / cvss_score | CVSS v3.1 向量与分数 |
| ev_vector / ev_score / ev_priority / ev_rationale | 利用价值向量、分数、优先级、逐维度依据 |
| poc_status | pending（待复现）/ reproduced（已复现）/ fail-reproduced（已具备条件但复现失败，终态）/ blocked（执行环境或外部条件不足，可重试：后续 verify 轮次会重新捞起） |
| exp_status | awaiting-poc（漏洞类创建默认，等待 PoC 复现，由 poc-verify 推进）/ pending（待评估，PoC 复现成功后的评估就绪态；遗留数据兼容）/ confirmed（真实场景危害成立）/ downgraded（PoC 成立但真实影响降级）/ failed（真实场景不成立）/ blocked（EXP 条件无法模拟）/ not-needed（PoC 已等价真实影响）。**契约（HALL-35）：漏洞类创建时必须初始化 awaiting-poc（除非已确认 PoC 等价真实影响，可写 not-needed；禁止创建时写 pending） ；风险类必须 not-needed** |
| affected_versions | 通过 git 等信息，确定受影响版本范围；未知时写 `unknown` |
| anchors | 代码位置列表，每项 `{file_path, line, function}` |

**标题三段式**：`[功能组件/模块 + 具体位置] + [漏洞类型] + [导致结果]`。类型用惯用说法即可（不必机械套枚举全称，RCE 这类保留惯用简写）。例：

- `MOV/MP4 解复用器 trun 样本尺寸解析整数截断导致拒绝服务`
- `HTTP 请求头解析器缓冲区越界读取导致信息泄露`
- `模板渲染引擎表达式注入导致 RCE`

### description（业务背景 + 漏洞情况 + 攻击）

| 字段 | 说明 |
|------|------|
| background | 面向第三方读者补齐上下文：目标项目是什么、典型使用场景是什么；出问题的模块/协议/格式/组件负责什么、在业务/数据流里的位置；理解该漏洞所需的专有名词或安全机制是什么。读者只看本字段，应能理解“这个模块为什么存在、处理什么输入、为什么这里的缺陷重要”。 |
| detailed_description | 漏洞的详细流程与成因，重点写代码事实、设计缺口和边界条件，不写审计过程。 |
| attack_payload_description | 触发漏洞的 payload 大致情况，描述输入结构、关键字段和触发条件；不要描述调试过程。 |
| attack_description | 攻击者在实际业务场景下如何触发漏洞，包括攻击者身份、入口、前置条件和可观察影响。 |

#### background 写法

`background` 不是一句模块简介，而是漏洞报告的“科普入口”。优先从项目画像、overview、threat-model 和相关 wiki 主题中提取已有认知，压缩成几句话：

1. **项目层**：目标项目解决什么问题，通常嵌入在哪类产品或部署中。
2. **模块层**：受影响模块/协议/文件格式/组件负责什么，外部输入如何进入它。
3. **术语层**：解释读者理解漏洞所需的专有名词、安全机制或数据格式，不解释无关背景。
4. **安全意义**：说明该模块为什么处在信任边界、敏感数据流或高可用路径上。

避免空泛句式，如“该模块负责处理数据，安全性很重要”。应写出具体对象：处理什么数据、来自谁、进入哪个边界、破坏后影响什么。

#### 版本影响写法

`affected_versions` 服务于“这个问题影响哪些版本”的判断，不能凭感觉编。能确认范围时写清边界，例如 `<= 2.1.6`、`1.20.0..1.22.3`、`main before <commit>`；未做版本考古或证据不足时写 `unknown`。

### code（数据流 + 修复补丁）

| 字段 | 说明 |
|------|------|
| dataflow | 列表，逐步描述触发的代码流程（每步 step / location(file:line) / description） |
| fix_patch | 修复点明确时写以 `diff --git a/` 开头的最小 unified diff；仅无法安全给出可落地补丁时留空 |

写报告前判断修复点；边界检查、长度钳制、状态校验、错误返回等能明确定位时给出补丁。

### references

CWE / OWASP / 相关文档参考链接。

## vuln_type 枚举表

| 类型 | 简写 | 类型 | 简写 |
|------|------|------|------|
| SQL 注入 | sqli | 命令注入 | cmdi |
| 代码注入 | codei | XSS | xss |
| SSRF | ssrf | XXE | xxe |
| 路径遍历 | path | 文件上传 | upload |
| 开放重定向 | redirect | CSRF | csrf |
| 越权访问 | idor | LDAP 注入 | ldapi |
| 信息泄露 | info | 认证缺陷 | auth |
| HTTP 头注入 | httpi | XPath 注入 | xpathi |
| 沙箱逃逸 | sandbox | 反序列化 | deser |
| 原型链污染 | proto | 其他 | other |

> C/C++ 额外类型:intovf(整数溢出) bof(缓冲区溢出) heap(堆破坏) uaf(UAF) memleak(内存泄漏) race(竞态) nullptr(空指针) fmtstr(格式化字符串)

确定 `vuln_type` 与填写 `cwe` 编号时，查 `cwe-guide.md`（各类型 → CWE 编号 + 一句话定义 + 匹配场景）。

## 严重程度与 CVSS

漏洞的技术严重程度由 CVSS v3.1 基础分数度量，不用主观判断。报告只存 cvss_vector / cvss_score（危险分档由分数自然映射，不单独存 severity 字段）。

### 评估流程

1. 根据漏洞特征确定 8 个 CVSS 基础指标的值
2. 用 `cvss-calc.py` 计算精确分数:`python3 skills/bug-report/cvss-calc.py "CVSS:3.1/AV:N/AC:L/..."`
3. 将输出的向量和分数填入 `cvss_vector` 和 `cvss_score`

分档参考（供人工速择，不入字段）:9.0+ critical / 7.0+ high / 4.0+ medium / 0.1+ low / 0.0 info。

### CVSS 评分参考

完整的 CVSS v3.1 指标定义、判断标准和常见场景速查在 `cvss-v3.1-guide.md` 中。评估前先阅读该文件。

### 关键原则

- CVSS 评估必须**逐项列出 8 个指标的取值和判断理由**,不得跳过推导直接给出向量
- C/I/A 必须基于**已证明或高度确信的影响**,不得仅凭"理论上可达到代码执行"标 C:H/I:H/A:H
- 完整的判断标准和 C/I/A 规则见 `cvss-v3.1-guide.md`

## 利用价值评估 (EV)

CVSS 衡量技术严重性，EV 衡量攻击者实际利用的可能性和收益。评估标准见 `exploit-value-guide.md`。

评估流程：

1. 根据漏洞特征确定 4 个 EV 维度：Reachability / Exposure / Certainty / Impact
2. 用 `cvss-calc.py` 计算分数：`python3 skills/bug-report/cvss-calc.py ev "EV:1.0/R:N/E:D/C:D/I:X"`
3. 将输出的分数和优先级填入报告的 `ev_vector`、`ev_score`、`ev_priority` 字段
4. 在 `ev_rationale` 中逐维度写明判断依据，并说明这些判断如何落在目标项目的威胁模型里

## source/sink 思考辅助

anchors 只记代码位置；source（污点源）→ sink（危险点）的传播在 `code.dataflow` 里逐步体现。梳理 dataflow 时心里要明确源与 sink：

- 注入类：source = 用户可控输入，sink = 危险函数/拼接点
- 沙箱逃逸：source = 用户代码输入，sink = 逃逸点（如 vm.runInContext）
- 原型链污染：source = 可控对象属性，sink = 被污染的原型方法
- 认证缺陷：source = 未认证请求，sink = 受保护资源
- 信息泄露：source = 敏感数据来源，sink = 暴露方式（API/日志/响应）
