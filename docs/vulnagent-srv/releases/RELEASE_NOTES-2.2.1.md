---
title: VulnAgent 2.2.1 Release Notes
---

# VulnAgent 2.2.1 Release Notes

## 版本信息

- Product: VulnAgent
- Version: 2.2.1
- Build commit: c277a21
- YoungFlow: 0.3.8
- License schema: v1

准确构建信息以包内 `VERSION.json` 为准。

## 📝 问题修复

- 修复报告生成功能内容缺失的问题。

## 🚀 体验优化

- 优化任务详情展示、代码预览、Chat 附件交互等功能。

## 安装

```bash
sha256sum -c vulnagent-release-2.2.1-c277a21.tar.gz.sha256
tar -xzf vulnagent-release-2.2.1-c277a21.tar.gz
cd vulnagent-release-2.2.1-c277a21
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

- 部署环境需配置有效 License。
- 扫描和报告生成依赖可用模型服务；模型不可达或限流会影响任务完成。
- 需备份 `DATA_DIR`、`$DATA_DIR/.secrets/vulnagent-master.key` 和安装目录 `.env`。
