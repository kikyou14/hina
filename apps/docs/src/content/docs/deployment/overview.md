---
title: 部署概览
description: 了解 Hina Server 的部署架构与三种部署方式
---

### 方式 1：一键脚本

```bash
curl -fsSL https://raw.githubusercontent.com/kikyou14/hina/main/scripts/install.sh | sudo bash
```

上面的命令会打开交互式 `hina-ctl` 菜单，在菜单中选择安装即可。若想跳过菜单直接安装最新发布版本，可以使用：

```bash
curl -fsSL https://raw.githubusercontent.com/kikyou14/hina/main/scripts/install.sh | sudo bash -s -- install
```

安装完成后可通过 `hina-ctl` 执行常用操作：

```bash
sudo hina-ctl status       # 查看状态与版本
sudo hina-ctl upgrade      # 升级到最新版本
sudo hina-ctl logs         # 跟踪 journal 日志
sudo hina-ctl restart      # 重启服务
sudo hina-ctl uninstall    # 卸载服务
```

### 方式 2：Docker（推荐）

```bash
docker run -d \
  --name hina \
  -p 3000:3000 \
  -v ./data:/app/data \
  ghcr.io/kikyou14/hina:latest
```

完整的 `docker-compose.yml` 配置见 [Docker 部署](/deployment/docker/)。

### 方式 3：从源码编译

只在需要定制构建（修改源码、内网私有 registry 等）时使用。用 `build-release.sh` 构建出单文件二进制，然后在 systemd 下运行。

详细步骤见 [从源码编译](/deployment/from-source/)。

## Agent 部署

主控就绪后，在每台被监控机器上安装 Agent 并指向主控的 WebSocket 地址。详见 [部署 Agent](/deployment/agent/)。

## 端口与网络

服务端默认监听 **3000** 端口（可通过 `PORT` 环境变量修改）。面板、API、Agent 连接都复用这一个端口，**不需要单独暴露第二个端口**。如果部署在反向代理后面，需要正确透传 `Upgrade` / `Connection` 头，见 [反向代理配置](/deployment/reverse-proxy/)。

## 数据目录

服务端的全部可变状态都在 **一个 SQLite 数据库** 中（`hina.sqlite`），外加两个同名的辅助文件（WAL 和 SHM）：

```text
data/
├── hina.sqlite         # 主数据库
├── hina.sqlite-wal     # Write-Ahead Log
└── hina.sqlite-shm     # 共享内存索引
```

**生产部署时请务必持久化整个 `data/` 目录**，三个文件必须一起备份才能保证一致性。
