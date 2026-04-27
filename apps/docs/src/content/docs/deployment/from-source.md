---
title: 从源码编译
description: 使用 build-release.sh 构建单文件二进制并在 systemd 下运行
---

## 前置要求

- **构建机**：Bun 1.x + git。构建结束后 Bun 不再被使用。
- **运行机**：无额外运行时依赖。产物是 `bun build --compile` 出的单文件二进制，自带 Bun runtime。

如果构建机和运行机是同一台服务器，只需要装一次 Bun 用于构建。

## 构建发布包

```bash
git clone https://github.com/kikyou14/hina.git /tmp/hina-build
cd /tmp/hina-build
./scripts/build-release.sh
```

脚本会安装依赖、构建前端，并用 `bun build --compile` 把服务端打成单文件二进制。产物位于 `dist/hina-server-<platform>/`，结构如下：

```text
dist/hina-server-linux-x64/
├── hina-server          # 单文件二进制（含 Bun runtime）
├── start.sh             # 启动脚本，显式设置资源路径
├── drizzle/             # 数据库迁移
├── public/              # 前端静态资源
└── .env.example         # 配置模板
```

同时会生成 `dist/hina-server-linux-x64.tar.gz`。下面命令中的 `linux-x64` 请按实际平台替换（`linux-arm64`、`darwin-arm64` 等）。

## 部署到目标目录

安装目录可以任选。下面以 `/opt/hina` 为例；若使用其他路径，请在本节、systemd 单元与「更新流程」中把所有对应路径一并替换。

### 1. 安放产物

```bash
sudo mv /tmp/hina-build/dist/hina-server-linux-x64 /opt/hina
sudo mkdir -p /opt/hina/data /opt/hina/.cache
```

### 2. 配置

```bash
sudo cp /opt/hina/.env.example /opt/hina/.env
```

根据需要编辑 `/opt/hina/.env`。完整变量列表与含义见 [配置参考](/deployment/configuration/#环境变量)。

构建产物已经自包含，`/tmp/hina-build/` 可以删掉；保留下来的话以后更新时可以直接 `git pull` 重新构建。

## systemd 单元文件

将以下内容写入 `/etc/systemd/system/hina.service`：

```ini
[Unit]
Description=Hina Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/hina
EnvironmentFile=/opt/hina/.env
ExecStart=/opt/hina/start.sh
Restart=on-failure
RestartSec=5s

# 基本安全加固
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/hina/data /opt/hina/.cache

[Install]
WantedBy=multi-user.target
```

关键配置说明：

- `ExecStart=/opt/hina/start.sh`：`start.sh` 会把 `HINA_WEB_DIST_PATH`、`HINA_MIGRATIONS_PATH` 和 `HINA_GEO_DIR` 默认指向二进制同目录的 `public/`、`drizzle/` 和 `.cache/geo/`，不用在 systemd 里重复设置。
- `WorkingDirectory=/opt/hina`：默认的 `HINA_DB_PATH=data/hina.sqlite` 会相对此目录解析为 `/opt/hina/data/hina.sqlite`。
- `ReadWritePaths` 只开放数据目录和 GeoIP 缓存目录，其余文件系统对服务只读。
- 如果把 `HINA_DB_PATH` 改成绝对路径（例如独立挂载点），记得同步加到 `ReadWritePaths`。

启用并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hina
sudo systemctl status hina
sudo journalctl -u hina -f        # 查看启动日志
```

首次启动时，管理员密码会写入数据目录下的 `data/admin-credentials.txt`（上例中即 `/opt/hina/data/admin-credentials.txt`）。保存密码后请删除该文件。也可以在 `.env` 中设置 `HINA_ADMIN_PASSWORD` 预设密码，跳过文件生成。

## 更新流程

更新思路：在构建目录重新执行脚本，然后把新产物**叠加**到安装目录（上例为 `/opt/hina`）——`data/`、`.env`、`.cache/` 都不在产物中，会被自然保留。

```bash
# 1. 重新构建（如果之前删掉了 /tmp/hina-build 就重新 clone 一次）
cd /tmp/hina-build
git pull
./scripts/build-release.sh

# 2. 停止服务并备份数据目录
sudo systemctl stop hina
sudo mkdir -p /opt/hina/backups
sudo cp -a /opt/hina/data /opt/hina/backups/$(date +%F)

# 3. 覆盖产物 → 启动
sudo cp -a dist/hina-server-linux-x64/. /opt/hina/
sudo systemctl start hina
```

`cp -a dist/hina-server-linux-x64/.` 中结尾的 `/.` 让 cp 把目录**内容**复制到 `/opt/hina/`，不会影响 `data/`、`.env` 等不在产物里的文件。

SQLite 在 WAL 模式下允许通过 `sqlite3 .backup` 热备份；这里使用文件级复制，因此先停止服务再复制整个 `data/` 目录。

## 数据目录的位置

默认数据库为安装目录下的 `data/hina.sqlite`（上文以 `/opt/hina` 为例时，即 `/opt/hina/data/hina.sqlite`）。如果想放到独立挂载点，在对应安装目录的 `.env` 中设置绝对路径：

```bash
HINA_DB_PATH=/var/lib/hina/hina.sqlite
```

同时把 `/var/lib/hina` 加入 systemd 单元的 `ReadWritePaths`。
