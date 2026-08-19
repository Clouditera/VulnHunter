# 目标

按固定五步完成项目初始化，并在第 3 步和第 5 步末通过平台门禁（gate）。顺序强制，不得跳步、不得并步。门禁结果统一写入 `$OUTPUT_DIR/gate.yaml`，由引擎按其 `next` 字段路由（end → 审计终止；continue → 进入审计循环）。

# 固定五步

## 第 1 步 — 识别项目

快速阅读项目文档与核心文件、目录结构，识别项目类型和情况：这是什么应用/库、主要语言、运行方式、代码组织。

## 第 2 步 — 预处理

按第 1 步识别的类型和情况，依 `preprocessing` skill 执行预处理（含 jar/war/裸 class 的项目走其 jar 参考流程；其余按需做轻量预处理，如解压嵌套压缩包）。不编译、不装依赖、不执行项目代码。

## 第 3 步 — 是否继续（完整性门禁）

按以下规则判定项目完整性（三要素 + 片段集规则 + 靶场豁免）：

- **真实用途判定**：先读 README/顶层文档。声明了真实生产用途（web 应用、CLI 工具、可复用库、服务、完整可运行的靶场应用如 VAmPI/DVWA）→ 进入三要素判定。
- **片段集**（用途缺失/含糊/自述为 demo、showcase、tutorial、marketing）：查看子目录内容性质——是功能演示、使用示例、调用样例、教程、练习题 → 判 `fragment_collection`。
- **三要素**（仅真实用途项目）：① 可识别的入口/路由（URL 路径、CLI 命令、main()、消息处理器等派发结构）；② 业务逻辑（源码或编译产物：JSP/.class/.pyc/二进制）；③ 配置/依赖（web.xml、package.json、requirements.txt、pom.xml、Dockerfile 等）。三者齐备且构成连贯整体 → 完整（无 README/无构建系统/无 .java 源码亦可，如 Tomcat webapps 目录）。只有测试/文档/补丁/生成片段/缺基础应用的 overlay → 判 `partial_source`。
- **靶场豁免**：用途明确是漏洞演示靶场且本身是完整可运行应用 → 完整。

**不合格处理**：代码不完整（`partial_source`）或纯 demo/代码片段类（`fragment_collection`）时，写失败门禁并退出审计：

```yaml
# $OUTPUT_DIR/gate.yaml
next: end
reason: partial_source   # 或 fragment_collection
detail: <一句人话：为什么不完整，缺了什么——平台会把这句原样展示给用户>
sandbox_type: null
```

写完后当前 `todo/onboard-*.md` 的 `status` 改 `done`、移到 `done/`，不再执行第 4、5 步，不产出画像/wiki。引擎会按 `next: end` 终止审计。

## 第 4 步 — 初始化画像/wiki

项目画像与知识库（判定合格后才执行）：

- `knowledge/profiler.yaml`：按 schema 输出项目画像。
- `knowledge/wiki/index.md`：知识库目录。
- `knowledge/wiki/overview.md`：项目结构、入口、关键模块和数据流概览。
- `knowledge/wiki/threat-model.md`：初始资产、信任边界、攻击面和优先审计方向。
- `knowledge/build/build.md`：动态运行环境现状；frontmatter 含 `sandbox: available | unreachable` 与 `updated` 时间。

以上四件（profiler + wiki 三件）是门禁 continue 的硬性证据，缺一不可。

## 第 5 步 — 沙箱选择（仅动态验证启用时）

启用 POC/EXP（动态验证）时：

1. 调用 `list_sandbox_types()` 列出当前可用沙箱类型。
2. 按项目主要运行方式选择：需完整系统/内核/固件或明确要求 KVM/QEMU → 选 kvm+qemu 均 true 的类型；标准运行方式是 Docker/Compose → 选 docker=true 的类型；其余 → 无特殊能力要求的 plain Linux。两者都需要时所选类型须同时满足。
3. 用 `get_sandbox_type(profile_id)` 复核所选类型 `available: true`。
4. 调用 `apply_sandbox(profile_id)` 申请分配（仅一次，不重试）：
   - 成功 → 沙箱配置自动落位，继续写成功门禁。
   - 失败 → 把工具返回的 `message` 原样写进 `detail`，`next: end`，`reason: sandbox_unavailable`，收尾退出。
5. 无可用类型满足要求 → `next: end`，`reason: no_compatible_sandbox`。

**成功门禁**（动态任务，`apply_sandbox` 成功后）：

```yaml
next: continue
reason: complete
sandbox_type: <profile_id>
```

静态任务（未启用动态验证）不查沙箱，直接写：

```yaml
next: continue
reason: complete
sandbox_type: null
```

## 幂等

`$OUTPUT_DIR/gate.yaml` 已存在时跳过门禁步骤（第 3/5 步判定与 apply_sandbox 均不再执行），直接按既有结论继续。

# 产出

- `$OUTPUT_DIR/gate.yaml`：门禁结果（引擎路由依据）。
- 第 4 步列出的画像/wiki 产物（continue 的硬性证据）。
- `knowledge/build/build.md`：构建/动态环境记录。

## 完成处理

退出前把当前 `todo/onboard-*.md` 的 `status` 修改为 `done`，并移动到 `done/`。

# 备注

- 源码完整性豁免边界：项目自身构建机制声明需要的源码缺席时（如 Makefile 的源码拉取目标、.gitmodules、vendoring 脚本），补齐源码（拉取属静态信息搜集）后重新走第 3 步判定；用户提供的代码本身残缺不补，判 `partial_source` 退出。
- 不编译、不安装依赖、不执行项目代码、不跑测试（第 2 步预处理 skill 的反编译操作除外）。
- 非 onboard 阶段禁止读写 `gate.yaml`。
