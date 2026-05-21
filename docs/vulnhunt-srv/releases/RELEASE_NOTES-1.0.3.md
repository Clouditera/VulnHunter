---
title: VulnHunt 1.0.3 Release Notes
---

# VulnHunt 1.0.3 Release Notes

## 版本信息

- Product: VulnHunt
- Version: 1.0.3
- YoungFlow: 0.2.5
- License schema: v1

准确构建 commit 以包内 `VERSION.json` 为准。

## 主要变化

- 支持扫描任务并发和任务内 agent 并发配置。
- 增强模型凭证可用性诊断。
- 支持自托管模型可选 API Key 场景。
- 修复并强化 one-click install、DATA_DIR、License 激活和生产部署配置。
- 正式离线包包含 Docker 镜像、部署脚本、Markdown/HTML 文档与基础平台 UI 操作截图。

## 安装

```bash
sha256sum -c vulnhunt-release-1.0.3.tar.gz.sha256
tar -xzf vulnhunt-release-1.0.3.tar.gz
cd vulnhunt-release-1.0.3
./install.sh
./doctor.sh
```

## 支持命令

```bash
./doctor.sh
docker compose ps
docker compose logs -f service
docker compose logs -f web
```

## 已知前提

- 客户现场需提供有效 License。
- 扫描任务依赖可用模型服务；模型不可达或限流会影响任务完成。
- 必须备份 `DATA_DIR` 和 `$DATA_DIR/.secrets/vulnhunt-master.key`。
