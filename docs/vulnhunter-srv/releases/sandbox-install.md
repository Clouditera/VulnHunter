# SandboxPlane 子栈安装说明

平台安装包内的 `sandbox/` 目录是**可选**的 SandboxPlane 载荷。不装时平台行为与现在一致（动态验证关闭）。装上后启用动态验证/评估所需沙箱。

## 前置

- Docker 可用
- 同机模式：平台已 `install.sh` 完成并存在 `vulnhunter-internal` 网络
- QEMU 类型（可选）：主机有 `/dev/kvm`，安装时加 `--with-qemu`

## 同机安装（默认）

```bash
# 在解压后的平台安装包根目录
./sandbox/install.sh
# 可选：./sandbox/install.sh --with-qemu
```

脚本会：载入镜像 → 生成/复用令牌 → 启动 plane → 接入 `vulnhunter-internal`（alias `sandbox-plane`）→ 回写平台 `.env` 的 `SANDBOXPLANE_BASE_URL` / `SANDBOXPLANE_TOKEN` → 仅重建 `service` → 自检至少一种 profile `available=true`。

## 异机安装（远程沙箱机）

在沙箱机上：

```bash
./sandbox/install.sh --remote
```

按输出将 URL 与 token 填回平台 `.env`，再重建平台 `service`。TLS 反代与 SSH 跳板见远程拓扑手册。

## 升级（与平台解耦）

```bash
./sandbox/upgrade.sh
```

只重建 plane 容器；**不改**平台 `.env`、不碰平台容器。平台 `upgrade.sh` 也不管理 sandbox/。

## 卸载

```bash
cd sandbox && docker compose down
# 数据目录 sandbox/data 默认保留
```

平台继续运行；去掉 `.env` 中 `SANDBOXPLANE_*` 后重建 service 即关闭动态能力。

## 故障排查

| 现象 | 可能原因 |
|---|---|
| `available=false` | 镜像未 load / sysbox 未装 / 资源不足 |
| 网络 connect 失败 | 平台未装或网络名不是 `vulnhunter-internal` |
| 幂等重跑 | 密钥与 `.env` 同值会跳过，属正常 |
