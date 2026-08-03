<p align="center">
  <img src="packages/web/public/favicon.svg" width="80" height="80" alt="VulnHunter Logo">
</p>

<h1 align="center">VulnHunter</h1>

<p align="center">
  <strong>AI-Powered Automated Vulnerability Discovery Agent Platform</strong>
</p>

<p align="center">
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/license-AGPL%20v3-blue.svg" alt="License">
  </a>
  <img src="https://img.shields.io/badge/version-2.3.2-green.svg" alt="Version">
  <img src="https://img.shields.io/badge/node-20+-brightgreen.svg" alt="Node.js">
  <img src="https://img.shields.io/badge/docker-required-blue.svg" alt="Docker">
</p>

<p align="center">
  English | <a href="./README.md">中文</a>
</p>

---

VulnHunter is an open-source AI vulnerability hunting workbench that combines automated target profiling, AI-assisted vulnerability discovery, chat-based investigation, POC/EXP generation and verification, review workflows, and report delivery — all in a self-hosted deployment.

---

## 📸 Screenshots

### 🎛️ Dashboard

![Dashboard](docs/images/dashboard.png)
_Real-time scan progress and security posture at a glance_

### 🔍 Vulnerability Findings

![Findings](docs/images/findings.png)
_AI-discovered vulnerabilities with per-finding review workflow_

### 🤖 AI Chat Assistant

![Chat](docs/images/chat.png)
_Conversational interface: query findings, operate tasks, generate reports_

### 💥 POC/EXP Verification

![POC](docs/images/poc.png)
_One-click POC generation with automated verification_

### 📊 Audit Reports

![Report](docs/images/report.png)
_Professional report output with Markdown export_

---

## ⚡ Why VulnHunter?

| 😫 Traditional Approach | 💡 VulnHunter Solution |
|---|---|
| **Manual code audit is slow** — can't keep up with code iteration | **🤖 AI Agent automation** — YoungFlow orchestrates multi-agent collaboration |
| **High false positives** — traditional SAST lacks semantic understanding | **🧠 Context-aware analysis** — AI combines code semantics and business logic |
| **Can't confirm exploitability** — no way to know if a finding is real | **💥 Automated POC verification** — generates and executes POC to confirm impact |
| **Scattered results** — reports, POCs, communication across multiple tools | **🏠 Unified workbench** — scanning, Chat, POC, reports, and review in one platform |
| **Steep learning curve** — need to master multiple security tools | **💬 Conversational ops** — natural language interaction through Chat |

---

## 🎯 Feature Matrix

| Feature | Description |
|---------|-------------|
| 🔍 **AI Vulnerability Discovery** | YoungFlow agent orchestration for automated target analysis and vulnerability detection |
| 💬 **Chat AI Assistant** | 16+ MCP tools — query findings, operate tasks, switch models via conversation |
| 💥 **POC/EXP Generation** | AI-generated POC scripts with DeVeye browser automation for verification |
| 📊 **Audit Reports** | YoungFlow-orchestrated professional Markdown report generation |
| ✅ **Finding Review** | Per-finding and bulk review workflow with 4-state management |
| 📋 **Task Management** | Full lifecycle: create, pause, cancel, resume, re-run |
| 🎛️ **Dashboard** | Real-time statistics, severity distribution, review progress tracking |
| 🔐 **Credential Management** | Multi-model credential configuration, runtime switching, availability diagnostics |
| 🐳 **Containerized Deployment** | Docker Compose one-click deployment, isolated worker containers |

### Edition Comparison

| Feature | Community (Open Source) | Enterprise |
|---------|:-:|:-:|
| All features above | ✅ | ✅ |
| Single user | ✅ | ✅ |
| Multi-user RBAC | ❌ | ✅ |
| License activation | Free, no activation | ✅ |
| Support | Community | Dedicated |

---

## 🏗️ Architecture

```text
┌─────────────────────────────────────────────────────┐
│                  Browser (React/Vite)                │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│        VulnHunter Service (Hono + WebSocket + MCP)    │
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
│Tasks     │  │Files       │   │ ┌───────────────┐ │
│Findings  │  │Reports     │   │ │ YoungFlow Scan│ │
│Users     │  │Sources     │   │ │ Chat Worker   │ │
│Settings  │  │Artifacts   │   │ │ Report Worker │ │
└────────┘   └────────────┘   │ │ POC/Eval      │ │
                               │ └───────────────┘ │
                               └───────────────────┘
```

**Packages**:

```text
packages/
├── shared/           Shared API types and contracts
├── service/          Core backend service
├── web/              React frontend
├── worker-bridge/    Worker-side bridge for chat/report modes
└── enterprise/       Commercial add-ons (BSL 1.1)
```

---

## 🚀 Quick Start

### Requirements

- Linux host (Ubuntu 22.04+ recommended)
- Docker + Docker Compose
- 8GB+ RAM

### Docker Compose Deployment

```bash
# Clone
git clone https://github.com/user/VulnHunter.git
cd VulnHunter

# Configure
cp deploy/.env.example .env
# Edit .env: set passwords, ports, data directory, etc.

# Start
docker compose -f deploy/docker-compose.yml --env-file .env up -d
```

Open `http://localhost:23000` and create your admin account on the bootstrap page.

### Development

```bash
pnpm install
pnpm build
pnpm test

# Start infrastructure only
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.example up -d db minio
```

---

## ⚙️ Configuration

See `deploy/.env.example` for all options. Common settings:

| Variable | Description | Default |
|----------|-------------|---------|
| `WEB_PORT` | Web UI port | `23000` |
| `DATA_DIR` | Persistent data directory | `/opt/vulnhunter/data` |
| `DOCKER_SUBNET` | Docker bridge subnet | `10.177.0.0/24` |
| `VULNHUNTER_MASTER_KEY_FILE` | Credential encryption key path | — |
| `WORKER_IMAGE` | Scan worker image | `vulnhunter-worker:latest` |
| `EDITION` | Edition mode | `community` |

---

## 📜 Licensing

This project uses an **Open Core** model:

- **Core** (root directory): [Apache License 2.0](./LICENSE) — free to use, modify, and distribute
- **Enterprise** (`packages/enterprise/`): [Business Source License 1.1](./packages/enterprise/LICENSE) — free for personal, educational, and research use; commercial use requires a license. Converts to AGPL-3.0 on 2030-06-01.

---

## 🤝 Contributing

Contributions are welcome! The detailed contribution guide is being finalized. For now:

1. Open an issue describing the bug, feature, or documentation improvement.
2. Fork and develop — keep changes focused.
3. Run `pnpm build && pnpm test` before submitting.
4. Open a Pull Request.

**Do not submit**: secrets, private scan data, customer data, or generated runtime artifacts.

---

## ⚠️ Security Notice

VulnHunter is a security research tool. Only scan systems, codebases, and services that you own or are explicitly authorized to test.

---

<p align="center">
  <sub>Built with ❤️ for the security research community</sub>
</p>
