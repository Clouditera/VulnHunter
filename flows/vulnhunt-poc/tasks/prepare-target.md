# 任务：准备目标环境

根据目标模式准备被测应用环境。

## 自动部署模式 (auto_deploy)

1. 检查源码目录中的部署文件（`docker-compose.yml`、`Dockerfile`、`Makefile` 等）
2. 使用 `docker compose up -d` 或 `docker build` + `docker run` 部署应用
3. 等待服务启动完成
4. 验证服务可访问（HTTP 健康检查）
5. 记录服务地址和端口

### 部署要点
- 使用 `-p` 端口映射，通过 `http://$HOST_IP:<映射端口>` 访问
- 加入平台网络 `--network $DOCKER_NETWORK`（如果环境变量存在）
- 不要拉取外部镜像，版本可能不一致，使用源码构建

## 用户提供地址模式 (provided)

1. 使用用户提供的目标地址
2. 验证目标可访问（HTTP 健康检查 + 基本探测）
3. 记录服务基本信息

## 输出

在输出目录创建 `target-info.yaml`：

```yaml
ready: true                          # 或 false（如果失败）
target_url: "http://host:port"       # 服务访问地址
deploy_mode: "auto_deploy"           # 或 "provided"
services:                            # 自动部署模式下的服务列表
  - name: "web"
    port: 8080
    status: "running"
failure_reason: ""                   # 如果失败，说明原因
```
