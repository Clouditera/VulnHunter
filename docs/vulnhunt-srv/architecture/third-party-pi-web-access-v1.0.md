# 第三方扩展：pi-web-access（供应链留痕）

> 状态：随 VulnForge-Flow `72c4998` 引入 · 2026-08-06

## 事实

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/nicobailon/pi-web-access |
| **Pinned commit** | `a1135b8ca054ba5f16ec4410d06928ce10da13c0`（flow 仓 `.gitmodules` 钉死） |
| 版本 | v0.13.0 |
| License | **MIT**（上游仓库 LICENSE 随扩展目录进镜像） |
| 入口 | `flows/vulnforge/extensions/pi-web-access/index.ts`（pi extension） |
| 接线 | `flow.audit.yaml` 的 `research`（信息搜集）与 `hunt`（漏洞狩猎）两阶段 extensions 列表 |
| 运行时依赖 | @mozilla/readability、linkedom、p-limit、promise.try、turndown、typebox、unpdf（7 个，`npm install --omit=dev`） |
| peer 依赖 | @earendil-works/pi-ai、@earendil-works/pi-coding-agent（worker.Dockerfile 同版本安装） |

## 运行配置

扩展读 `PI_CODING_AGENT_DIR/web-search.json`（youngflow 置 `PI_CODING_AGENT_DIR=<flowDir>/.pi-agent`）。
`scan-mode.sh` 生成 models.json 后同点写 `{"workflow":"none"}`——无人值守 worker 跳过交互式 curator，
避免每次搜索白等 20s 超时（2026-08-06 fish/architect 定）。

## 失效模式

- 搜索商全挂 → 工具报错给引擎；research 产物规则全 `min_count:0`（零产出合规）；decide 有 cognize 兜底——扫描不因搜索不可用失败，仅少情报维度
- 子模块未 `--recursive` 初始化 → 镜像内空目录：worker.Dockerfile 构建期探针 + `release_validate_worker_image` 双闸拦截
