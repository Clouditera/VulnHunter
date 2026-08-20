# 目标

把一份未知上传物初始化为「可审计的项目」。按固定五步执行，顺序强制，不得跳步或并步：

识别 → 预处理 → 完整性判定 → 画像/wiki → 选沙箱

判定结论的唯一落点是 `$OUTPUT_DIR/gate.yaml`，引擎按其 `next` 路由：`end` → 审计终止；`continue` → 进入审计循环。

**落盘总规则**（全文唯一权威）：失败判定（第 3 步不合格、第 5 步沙箱申请失败或无兼容类型）一形成**立即**写 gate.yaml，优先于本阶段其它一切输出；成功判定在第 5 步末写——第 4 步四件产物已落盘、动态任务已 apply_sandbox 成功之后。

gate.yaml 的 `detail` **必须用块标量**（`detail: >` 换行缩进）**或双引号包裹**——裸写含「冒号+空格」的自由文本是非法 YAML（生产实证：路由解析失败、任务误判初始化未完成），schema 校验会打回，路由也读不了。

# 固定五步

## 第 1 步 — 识别项目

快速阅读项目文档、核心文件与目录结构，识别项目类型和情况：是什么应用/库、主要语言、运行方式、代码组织。

## 第 2 步 — 预处理

按第 1 步的识别结果，依 `preprocessing` skill 执行：含 jar/war/裸 class 的项目按 skill 的 jar 参考流程反编译；其余按需轻量处理（如解压嵌套压缩包）。不编译、不装依赖、不执行项目代码。

## 第 3 步 — 完整性判定

按以下规则判定：完整 → 进入第 4 步；不合格 → 立即写失败门禁，终止审计。

- **真实用途**：先读 README/顶层文档。声明真实生产用途（web 应用、CLI 工具、可复用库、服务、完整可运行的靶场如 VAmPI/DVWA）→ 进入三要素判定。
- **片段集**：用途缺失、含糊，或自述为 demo、showcase、tutorial、marketing，且子目录内容为功能演示、使用示例、调用样例、教程、练习题 → 判 `fragment_collection`。
- **三要素**（仅真实用途项目）：① 可识别的入口/路由（URL 路径、CLI 命令、main()、消息处理器等派发结构）；② 业务逻辑（源码或编译产物：JSP/.class/.pyc/二进制）；③ 配置/依赖（web.xml、package.json、requirements.txt、pom.xml、Dockerfile 等）。三者齐备且构成连贯整体 → 完整（无 README、无构建系统、无 .java 源码亦可，如 Tomcat webapps 目录）。只有测试/文档/补丁/生成片段/缺基础应用的 overlay → 判 `partial_source`。
- **靶场豁免**：用途明确是漏洞演示靶场且本身完整可运行 → 完整。

**失败门禁**（判 `partial_source` / `fragment_collection` 时立即落盘）：

```yaml
# $OUTPUT_DIR/gate.yaml
next: end
reason: partial_source   # 或 fragment_collection
detail: >                # 块标量：人话写为什么不合格、缺了什么——平台原样展示给用户
  一句人话，自由换行，冒号顿号随便用
sandbox_type: null
```

之后不再执行第 4、5 步，不产出画像/wiki。引擎按 `next: end` 终止审计。

## 第 4 步 — 初始化画像/wiki

（仅第 3 步判定完整后执行）产出：

- `knowledge/profiler.yaml`：按 schema 输出项目画像。
- `knowledge/wiki/index.md`：知识库目录。
- `knowledge/wiki/overview.md`：项目结构、入口、关键模块和数据流概览。
- `knowledge/wiki/threat-model.md`：初始资产、信任边界、攻击面和优先审计方向。
- `knowledge/build/build.md`：动态运行环境现状；frontmatter 含 `sandbox: available | unreachable` 与 `updated` 时间。

profiler + wiki 三件是成功门禁的硬性证据，缺一不可。

## 第 5 步 — 选沙箱 + 成功门禁

**动态任务**（启用 POC/EXP 验证时）按序选沙箱：

1. `list_sandbox_types()` 列出可用沙箱类型。
2. 按项目主要运行方式选：需完整系统/内核/固件或明确要求 KVM/QEMU → 选 kvm 与 qemu 均 true 的类型；标准方式是 Docker/Compose → 选 docker=true；其余 → 无特殊能力要求的 plain Linux。需同时满足多个能力时，所选类型须全部满足。
3. `get_sandbox_type(profile_id)` 复核所选类型 `available: true`。
4. `apply_sandbox(profile_id)` 申请分配（仅一次，不重试）：
   - 成功 → 沙箱配置自动落位，写成功门禁。
   - 失败 → 立即写失败门禁：`detail` 原样写工具返回的 `message`，`next: end`，`reason: sandbox_unavailable`，收尾退出。
5. 无任何可用类型满足要求 → 立即写失败门禁：`next: end`，`reason: no_compatible_sandbox`。

**静态任务**（未启用动态验证）不查沙箱，直接写成功门禁。

**成功门禁**（第 5 步末写）：

```yaml
next: continue
reason: complete
detail: >                # 块标量：一句人话写判定依据与已完成的准备
  一句人话，自由换行
sandbox_type: <profile_id>   # 静态任务写 null
```

## 幂等

`$OUTPUT_DIR/gate.yaml` 已存在时，跳过门禁步骤（第 3/5 步的判定与 apply_sandbox 均不再执行），直接按既有结论继续。

# 产出

- `$OUTPUT_DIR/gate.yaml`：门禁结果（引擎路由依据）。
- 第 4 步的画像/wiki 产物（continue 的硬性证据）。
- `knowledge/build/build.md`：构建/动态环境记录。

## 完成处理

退出前把当前 `todo/onboard-*.md` 的 `status` 改为 `done`，并移到 `done/`。

# 备注

- 源码完整性豁免边界：项目自身构建机制声明需要的源码缺席时（如 Makefile 的源码拉取目标、.gitmodules、vendoring 脚本），补齐源码（拉取属静态信息搜集）后重新走第 3 步判定；用户提供的代码本身残缺不补，判 `partial_source` 退出。
- 不编译、不安装依赖、不执行项目代码、不跑测试（第 2 步的反编译除外）。
- 非 onboard 阶段禁止读写 `gate.yaml`。
