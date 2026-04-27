---
title: Docker 部署
description: 使用 Docker 或 docker-compose 运行 Hina Server
---

## 使用 docker-compose（推荐）

仓库根目录的 `docker-compose.yml` 是最短的可运行配置：

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

启动：

```bash
docker compose up -d
```

首次启动后，管理员密码会写入 data volume 中的文件：

```bash
cat ./data/admin-credentials.txt
```

保存密码后请删除该文件。也可以通过 `HINA_ADMIN_PASSWORD` 环境变量预设密码，跳过文件生成（见 [配置参考](/deployment/configuration/#环境变量)）。

升级到最新版本：

```bash
docker compose down
docker compose pull
docker compose up -d
```

## 使用 docker run

如果不想用 compose，等价的 `docker run` 命令是：

```bash
docker run -d \
  --name hina \
  --restart unless-stopped \
  -p 3000:3000 \
  -v ./data:/app/data \
  ghcr.io/kikyou14/hina:latest
```

## 注入环境变量

在上面任意一种启动方式里添加 `-e KEY=VALUE`（`docker run`）或 `environment:`（`compose`），例如：

```yaml
environment:
  HINA_PUBLIC_BASE_URL: https://hina.example.com
  TZ: Asia/Shanghai
```

完整的环境变量列表见 [配置参考](/deployment/configuration/#环境变量)。

## 自行构建镜像

从源码构建自定义镜像：

```bash
git clone https://github.com/kikyou14/hina.git
cd hina
docker build -t hina:local .
```

构建完成后，把上面启动命令里的 `ghcr.io/kikyou14/hina:latest` 替换为 `hina:local` 即可。
