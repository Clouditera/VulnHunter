---
title: VulnAgent 1.0.4 Release Notes
---

# VulnAgent 1.0.4 Release Notes

## 版本信息

- Product: VulnAgent
- Version: 1.0.4
- YoungFlow: 0.2.5
- License schema: v1

准确构建 commit 以包内 `VERSION.json` 为准。

## 主要变化

1.0.4 是 1.0.3 的 hotfix 版本，包含以下修复：

- 修复 Git URL 创建扫描任务时 service 运行环境缺少 `git` 导致克隆失败的问题。
- 修复 worker 镜像缺少 VulnAgent-flow extension 资产导致 profiler 阶段 `empty response` 的问题。
- 修复 worker workspace 清理 fallback 硬编码 `vulnagent-worker:latest` 导致清理失败的问题。
- 修复新建模型凭证时修改上下文大小后测试连接报 `contextWindowTokens is not defined` 的问题。
- 修复用户管理编辑弹窗 `userModal.disable` 原始 i18n key 泄漏问题。
- 保留 1.0.3 的正式离线包、部署脚本、Markdown/HTML 文档与基础平台 UI 操作截图。

## 安装

```bash
sha256sum -c vulnagent-release-1.0.4.tar.gz.sha256
tar -xzf vulnagent-release-1.0.4.tar.gz
cd vulnagent-release-1.0.4
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
- 扫描任务依赖可用模型服务；模型不可达或限流会影响任务完成。
- 需备份 `DATA_DIR` 和 `$DATA_DIR/.secrets/vulnagent-master.key`。
