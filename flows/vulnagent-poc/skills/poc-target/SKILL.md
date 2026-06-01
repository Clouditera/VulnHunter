---
name: poc-target
description: 目标环境准备 — 自动部署被测应用或检测用户提供的目标服务可用性。
---

# Skill: 目标环境准备

## 自动部署模式 (auto_deploy)

1. 在源码目录查找部署配置：
   - `docker-compose.yml` / `docker-compose.yaml` → `docker compose up -d`
   - `Dockerfile` → `docker build` + `docker run`
   - `Makefile` → 检查 `make run` 或 `make docker` 目标
2. 使用源码构建，不拉取外部镜像
3. 端口映射 `-p`，通过 `http://$HOST_IP:<映射端口>` 访问
4. 如环境变量 `DOCKER_NETWORK` 存在，使用 `--network $DOCKER_NETWORK` 加入平台网络
5. 等待服务启动（轮询健康检查，最多 120 秒）
6. 输出 `target-info.yaml`

## 用户提供地址模式 (provided)

1. 使用用户提供的 `target_url`
2. HTTP GET 检测目标可达性
3. 基本探测：首页状态码、Server header、常见路径
4. 输出 `target-info.yaml`

## 输出格式

`target/target-info.yaml`：

```yaml
ready: true
target_url: "http://host:port"
deploy_mode: "auto_deploy"
services:
  - name: "web"
    port: 8080
    status: "running"
failure_reason: ""
```
