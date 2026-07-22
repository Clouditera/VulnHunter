<p align="center">
  <img src="packages/web/public/favicon.svg" width="80" height="80" alt="VulnHunter Logo">
</p>

<h1 align="center">VulnHunter</h1>

<p align="center">
  <strong>AI 驱动的自动化漏洞发现 Agent 平台</strong>
</p>

<p align="center">
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License">
  </a>
  <img src="https://img.shields.io/badge/version-2.0.0-green.svg" alt="Version">
  <img src="https://img.shields.io/badge/node-20+-brightgreen.svg" alt="Node.js">
  <img src="https://img.shields.io/badge/docker-required-blue.svg" alt="Docker">
</p>

<p align="center">
  <a href="./README_EN.md">English</a> | 中文
</p>

---

VulnHunter 是一个开源的 AI 漏洞挖掘工作台，集成了自动化目标分析、AI 辅助漏洞发现、对话式调查、POC/EXP 生成验证、审核工作流和报告交付，支持自部署运行。

---

## 📸 界面预览

### 🎛️ Dashboard 总览

![Dashboard](docs/images/dashboard.png)
_实时掌握扫描进度与安全态势_

### 🔍 漏洞发现

![Findings](docs/images/findings.png)
_AI 发现的漏洞列表，支持逐条审核_

### 🤖 AI Chat 助手

![Chat](docs/images/chat.png)
_对话式交互：查询漏洞、操作任务、生成报告_

### 💥 POC/EXP 验证

![POC](docs/images/poc.png)
_一键生成 POC 并自动化验证_

### 📊 审计报告

![Report](docs/images/report.png)
_专业报告输出，支持 Markdown 导出_

---

## ⚡ 为什么选择 VulnHunter？

| 😫 传统方式 | 💡 VulnHunter 方案 |
|---|---|
| **人工代码审计效率低** — 跟不上代码迭代速度 | **🤖 AI Agent 自动审计** — YoungFlow 编排多 Agent 协作，全自动执行 |
| **工具误报多** — 传统 SAST 缺乏语义理解 | **🧠 上下文感知** — AI 结合代码语义和业务逻辑，精准定位真实漏洞 |
| **漏洞无法确认** — 不知道是否真实可利用 | **💥 自动 POC 验证** — 自动生成并执行 POC，确认漏洞有效性 |
| **审计结果散落** — 报告、POC、沟通分散在多个工具 | **🏠 统一工作台** — 扫描、Chat、POC、报告、审核全部在一个平台 |
| **学习成本高** — 需要熟悉多种安全工具 | **💬 对话式操作** — 自然语言交互，通过 Chat 完成大部分操作 |

---

## 🎯 功能矩阵

| 功能 | 说明 |
|------|------|
| 🔍 **AI 漏洞发现** | 基于 YoungFlow Agent 编排，自动分析目标项目并发现潜在漏洞 |
| 💬 **Chat AI 助手** | 内置 16+ MCP 工具，通过对话查询漏洞、操作任务、切换模型 |
| 💥 **POC/EXP 生成** | AI 自动生成 POC 脚本，DeVeye 浏览器自动化验证 |
| 📊 **审计报告** | YoungFlow 编排生成专业 Markdown 报告 |
| ✅ **漏洞审核** | 逐条/批量审核工作流，4 状态管理 |
| 📋 **任务管理** | 全生命周期管理：创建、暂停、取消、恢复、重跑 |
| 🎛️ **Dashboard** | 实时统计、严重度分布、审核进度追踪 |
| 🔐 **凭证管理** | 多模型凭证配置、运行时切换、可用性诊断 |
| 🐳 **容器化部署** | Docker Compose 一键部署，Worker 容器隔离执行 |

### 版本对比

| 功能 | Community（开源） | Enterprise（商业） |
|------|:-:|:-:|
| 上述所有功能 | ✅ | ✅ |
| 单用户管理 | ✅ | ✅ |
| 多用户 RBAC | ❌ | ✅ |
| License 授权 | 免费，无需激活 | ✅ |
| 技术支持 | 社区 | 专属 |

---

## 🏗️ 系统架构

```text
┌─────────────────────────────────────────────────────┐
│                    浏览器 (React/Vite)                │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│         VulnHunter Service (Hono + WebSocket + MCP)   │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Tasks    │  │ Chat     │  │ Reports/POC      │  │
│  │ Findings │  │ AI Agent │  │ Review Workflow   │  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
└───┬────────────────┬────────────────┬───────────────┘
    │                │                │
    ▼                ▼                ▼
┌────────┐   ┌────────────┐   ┌───────────────────┐
│PostgreSQL│  │   MinIO    │   │ Docker Workers    │
│ 任务/漏洞 │  │  文件/报告  │   │ ┌───────────────┐ │
│ 用户/配置 │  │  源码/产物  │   │ │ YoungFlow Scan│ │
└────────┘   └────────────┘   │ │ Chat Worker   │ │
                               │ │ Report Worker │ │
                               │ │ POC/Eval      │ │
                               │ └───────────────┘ │
                               └───────────────────┘
```

**核心组件**：

```text
packages/
├── shared/           共享 API 类型
├── service/          核心后端服务
├── web/              React 前端
├── worker-bridge/    Worker 侧桥接通信
└── enterprise/       商业增值功能（BSL 1.1）
```

---

## 🚀 快速开始

### 环境要求

- Linux 主机（推荐 Ubuntu 22.04+）
- Docker + Docker Compose
- 8GB+ 内存

### Docker Compose 部署

```bash
# 克隆项目
git clone https://github.com/user/VulnHunter.git
cd VulnHunter

# 配置环境
cp deploy/.env.example .env
# 编辑 .env：设置密码、端口、数据目录等

# 启动服务
docker compose -f deploy/docker-compose.yml --env-file .env up -d
```

访问 `http://localhost:23000`，首次启动在引导页设置管理员账号即可使用。

### 源码开发

```bash
# 安装依赖
pnpm install

# 构建
pnpm build

# 运行测试
pnpm test

# 启动基础设施（数据库 + 对象存储）
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.example up -d db minio
```

---

## ⚙️ 配置说明

参考 `deploy/.env.example`，常用配置项：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `WEB_PORT` | Web 端口 | `23000` |
| `DATA_DIR` | 数据持久化目录 | `/opt/vulnhunter/data` |
| `DOCKER_SUBNET` | Docker 网络子网 | `10.177.0.0/24` |
| `VULNHUNTER_MASTER_KEY_FILE` | 凭证加密主密钥路径 | — |
| `WORKER_IMAGE` | 扫描 Worker 镜像 | `vulnhunter-worker:latest` |
| `EDITION` | 版本模式 | `community` |

---

## 📜 开源协议

本项目采用 **Open Core** 模式：

- **核心代码**（根目录）：[Apache License 2.0](./LICENSE) — 自由使用、修改和分发
- **Enterprise 目录**（`packages/enterprise/`）：[Business Source License 1.1](./packages/enterprise/LICENSE) — 个人/学习/研究免费，商业使用需授权；2030-06-01 自动转为 Apache 2.0

---

## 🤝 参与贡献

欢迎贡献！当前贡献指南正在完善中，基本流程：

1. 提交 Issue 描述 Bug、功能建议或文档改进
2. Fork 后开发，保持改动聚焦
3. 提交前确保 `pnpm build && pnpm test` 通过
4. 提交 Pull Request

**请勿提交**：密钥、私有扫描数据、客户数据、运行时产物。

---

## ⚠️ 安全声明

VulnHunter 是安全研究工具。请仅对您拥有或获得明确授权的系统、代码库和服务进行扫描测试。

---

<p align="center">
  <sub>Built with ❤️ for the security research community</sub>
</p>
