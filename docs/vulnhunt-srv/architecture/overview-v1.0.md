# VulnHunter 架构说明 v1.0

> 输出：架构师 ｜ 日期：2026-09-03 ｜ 基线：main @ a2282bf（v2.3.9）
> 权威规范以 docs/dev-guide.md 为准，本文是现状快照 + 导航。

## 一、总体形态

TypeScript monorepo（pnpm workspace + Turbo + Biome），Node >= 20。AGPL-3.0。
系统由三个独立交付物构成，通过 `@vulnhunter/shared` 共享契约：

```
shared (零运行时依赖：DTO / 错误码 / 领域模型 / WS 事件 schema)
   ↑            ↑                ↑
  web        service        worker-bridge
(React SPA)  (Hono 后端)    (沙箱内 agent 桥接进程)
```

包间无横向依赖；feature 之间只允许从对方的 `index.ts` 导入。

## 二、包划分

### packages/shared（契约层，唯一允许跨进程引用）
- `api/` HTTP DTO；`events/` WS 事件 schema（live-log 等）；`domain/` 领域模型
  （finding、severity、task）；`errors/` ERROR_CATALOG 错误码目录
- 红线：不得有任何 runtime dependency，新增 API/WS 类型只能放这里

### packages/service（后端核心，Hono + postgres.js + MinIO + dockerode + ws + MCP SDK）
- `server.ts` 按 role 启动两类进程：**business**（业务 API）与 **admin**（管理面），
  admin 账号通过 `ADMIN_FORBIDDEN_PREFIXES` 中间件被禁止访问业务 API
- `features/`（23 个域，按 domain 而非分层组织，标准结构 routes/service/storage/index）：
  - 核心业务：tasks（扫描任务）、workers（调度）、findings（漏洞发现 + review/dynamic）、
    reports、source-archives、workspace、artifacts、files
  - 平台能力：auth、tenant（多租户预留）、settings、notifications、dashboard、wiki、
    chat、prepare（动态验证开关/契约）、dynamic、admin、system、events（event-store /
    event-tail / WS live-log）
- `infra/`：db（SQL migrations，当前到 057）、minio、crypto、config、fd-monitor、logger（pino）
- `mcp/`：MCP server（tools 注册），对外暴露 agent 工具面
- `workers/` 是最重的子域：scheduler（1.1k 行，任务认领/调度）、reconciler（容器对账）、
  scan-worker、src-tree-sync / sync-outputs（源码上传与产出回流的增量同步）、
  gate-perception、audit-completion
- `enterprise-api.ts`：社区版向企业版暴露的唯一扩展面（sandbox 等企业模块经此注入，
  通过 `enterprise-module.d.ts` / `saas-module.d.ts` 声明类型）。packages/enterprise 仅含
  LICENSE，企业实现为私有仓

### packages/web（前端，React 18 + Vite + TanStack Query + Tailwind + react-router）
- **双入口**：`main.tsx`（业务端）与 `main-admin.tsx`（管理端），产出 dist / dist-admin
  两套产物，分别由 deploy/nginx.conf 与 nginx-admin.conf 承载
- `features/` 与后端域对齐（admin/auth/chat/dashboard/tasks/settings/live-log/onboarding…），
  `shared/api` 封装 api-client，禁止裸 fetch 字面量

### packages/worker-bridge（沙箱内进程，esbuild 打包成单 bundle）
- 跑在扫描 worker 容器里，通过 WS 与 service 通信；负责 model-config、
  rpc-command-tracker、tool-event-normalize（工具事件归一化后回流 live-log）

## 三、外围资产

- `deploy/`：docker-compose、4 个 Dockerfile（service/web/worker/worker-arm64，service
  另有 community 变体）、install/upgrade/uninstall/doctor 脚本、sandbox/ 子部署
- `flows/`：vulnforge（已 vendoring 拍平进本仓，见 FLOW_VERSION）、vulnhunter-report；
  子模块 youngflow 与 pi-web-access 需 `git submodule update --init --recursive`
- `docs/`：dev-guide.md（架构红线权威文档）、vulnhunter-srv/releases（发布说明）、
  vulnhunt-srv/architecture（本目录）

## 四、关键横切机制

1. **多租户**：所有业务表带 tenant_id，v1 单默认租户，查询必须过滤（red line）
2. **错误处理**：统一 AppError + shared ERROR_CATALOG，middleware/error-handler 格式化
3. **事件流**：event-store 持久化 + event-tail 订阅 + WS 推送 live-log 到前端
4. **同步治理**（近期主线）：src-tree 上传流受控销毁、manifest 原子写、增量轮次
   per-task in-flight 守卫（PR #48 / HALL-18/19）
5. **发布**：镜像 tag 带 edition 后缀，避免 community/enterprise 共享 daemon 互相覆盖
   （a2282bf）；web 双产物分离 business/admin
6. **可观测**：pino redact 脱敏、trace-id 中间件、fd 自监控（nofile 阈值告警）

## 五、当前风险与关注点

- `workers/scheduler.ts` 已 1166 行，调度/认领/恢复逻辑单点膨胀，后续变更需警惕
- enterprise 扩展面靠 enterprise-api.ts 手工导出维护，新增企业能力时易漏导出
- flows/vulnforge vendoring 后上游同步策略需明确（目前依赖 FLOW_VERSION 人工对齐）
- 多租户仍是"字段就绪、开关未开"状态，切换前需要全量回归 SQL 过滤
