# Hina

[English](README.md)

Hina 是一个面向自托管场景的分布式服务器监控系统。你可以用一个统一的 Web 面板管理多台机器，查看资源使用情况、在线状态与历史数据，并基于内置探测和告警能力持续追踪服务健康度。

它的目标不是做一套复杂的监控平台，而是提供一条更轻、更直接的路径：部署一个服务端，在需要监控的机器上安装 Agent，然后开始集中查看和管理你的节点。

## Features

- Unified dashboard for multiple servers: 在一个界面里查看节点状态、核心资源指标和最近变化。
- Lightweight Rust agent: Agent 部署简单、资源占用低，适合长期运行在被监控主机上。
- Built-in probes and alerts: 支持常见探测任务与告警规则，帮助你更早发现异常。
- Simple self-hosting workflow: Server、Web UI 和 Agent 配合清晰，适合个人项目、小团队和自建基础设施。
- Public-facing sharing support: 可按需公开节点页面，便于对外展示状态或给团队成员共享查看。

## Quick Start

### 1. Deploy the server

你可以按自己的场景选择一种方式：

**One-line install**

适合想快速在 Linux 机器上启动服务的场景。

```bash
curl -fsSL https://raw.githubusercontent.com/kikyou14/hina/main/scripts/install.sh | sudo bash
```

安装完成后，可用下面的命令确认服务状态：

```bash
sudo hina-ctl status
```

**Docker**

推荐大多数自托管用户使用。下面是最短可运行的 `docker-compose.yml`：

```yaml
services:
  hina:
    image: ghcr.io/kikyou14/hina:latest
    container_name: hina
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

启动服务：

```bash
docker compose up -d
```

首次启动时，服务端会生成一个随机管理员密码，并写入数据卷中的文件：

```bash
cat ./data/admin-credentials.txt
```

保存密码后请删除该文件。你也可以通过环境变量 `HINA_ADMIN_PASSWORD` 预先设置密码，跳过文件生成。

**From source**

适合需要自行构建或做定制化发布的场景：

```bash
git clone https://github.com/kikyou14/hina.git
cd hina
./scripts/build-release.sh
```

构建完成后，发布产物会出现在 `dist/hina-server-<platform>/`。

### 2. Sign in to the dashboard

服务端默认监听 `3000` 端口。首次启动后会生成管理员账号信息并写入 `data/admin-credentials.txt`，登录面板后你就可以开始创建和管理节点。

### 3. Deploy agents to monitored machines

在后台创建 Agent 后，推荐直接使用面板里生成的安装命令。典型形式如下：

```bash
curl -fsSL https://raw.githubusercontent.com/kikyou14/hina/main/scripts/install-agent.sh | \
  SERVER_URL='https://hina.example.com' TOKEN='YOUR_TOKEN_HERE' sudo -E bash
```

其中：

- `SERVER_URL` 是主控的 HTTP(S) 地址，不要带 `/ws`
- `TOKEN` 是你在后台创建 Agent 时拿到的令牌

安装完成后，可以在目标机器上检查 Agent 状态：

```bash
systemctl status hina-agent
```

### 4. Finish production setup if needed

如果你准备对公网提供访问，建议继续完成反向代理和基础配置。更完整的部署说明见：

- [部署概览](apps/docs/src/content/docs/deployment/overview.md)
- [Docker 部署](apps/docs/src/content/docs/deployment/docker.md)
- [从源码编译](apps/docs/src/content/docs/deployment/from-source.md)
- [部署 Agent](apps/docs/src/content/docs/deployment/agent.md)
- [反向代理配置](apps/docs/src/content/docs/deployment/reverse-proxy.md)
- [配置参考](apps/docs/src/content/docs/deployment/configuration.md)
