---
title: VulnHunter 2.3.0 环境要求
---

# VulnHunter 2.3.0 环境要求

## 服务器

- CPU 架构：Linux x86_64
- 内存：建议 ≥ 32GB
- 磁盘：建议可用空间 ≥ 100GB，部署数据目录使用持久化磁盘
- Docker：Docker Engine 可用
- Compose：Docker Compose v2（`docker compose`）或 legacy `docker-compose`

## 网络

- 浏览器可访问 `http://<服务器IP>:23000`
- 服务器可访问配置的模型服务 API Base URL
- 离线安装不需要从互联网拉取代码或镜像；模型调用是否需要外网取决于实际配置的模型服务

## 浏览器

建议使用最新版 Chrome、Edge 或 Firefox。

## 部署前检查

```bash
docker --version
docker compose version || docker-compose version
docker ps
free -h
df -h
```
