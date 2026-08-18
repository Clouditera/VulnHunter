# 目标

初始化项目画像、wiki、威胁模型。启用 POC/EXP 时，检查和配置动态运行环境。

# 产出

- `knowledge/profiler.yaml`：按 schema 输出项目画像。
- `knowledge/wiki/index.md`：知识库目录。
- `knowledge/wiki/overview.md`：项目结构、入口、关键模块和数据流概览。
- `knowledge/wiki/threat-model.md`：初始资产、信任边界、攻击面和优先审计方向。
- `knowledge/build/build.md`：记录动态运行环境的现状和配置情况；frontmatter 含 `sandbox: available | unreachable` 与 `updated` 时间。

## 完成处理

退出前把当前 `todo/onboard-*.md` 的 `status` 修改为 `done`，并移动到 `done/`。

# 备注

- 源码完整性：项目自身构建机制声明需要的源码缺席时（如 Makefile 的源码拉取目标、.gitmodules、vendoring 脚本），补齐源码（拉取属静态信息搜集）；用户提供的代码本身残缺（缺头文件/源文件）不补，在 `knowledge/build/build.md` 记为审计输入边界。缺代码区域不得直接划出审计面；无法补齐时写 `leads/LEAD-*`（type: threat-model）交 decide。
