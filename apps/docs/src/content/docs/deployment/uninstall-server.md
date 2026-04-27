---
title: 卸载 Server
description: 从主机上卸载 Hina Server
---

在卸载之前，强烈建议先备份数据。卸载操作不可逆，一旦删除数据目录将永久丢失所有监控数据。

## 备份数据

Hina 使用 SQLite 数据库存储所有数据，并启用 WAL 模式。文件级备份时不要只复制 `hina.sqlite`，还需要一起保留同目录下的 `hina.sqlite-wal` 和 `hina.sqlite-shm`；最简单可靠的方式是备份整个 `data/` 目录。

### 一键脚本安装

数据目录默认位于 `/var/lib/hina/data`，数据库文件是 `/var/lib/hina/data/hina.sqlite`；配置文件位于 `/etc/hina/`：

```bash
# 创建备份目录
mkdir -p ~/hina-backup

# 备份数据库（使用 sqlite3 的 .backup 命令，确保数据一致性）
sqlite3 /var/lib/hina/data/hina.sqlite ".backup '$HOME/hina-backup/hina.sqlite'"

# 如果没有安装 sqlite3，请停止服务后复制整个 data 目录
sudo systemctl stop hina-server
sudo cp -a /var/lib/hina/data ~/hina-backup/data
sudo systemctl start hina-server

# 备份配置文件
sudo cp -a /etc/hina ~/hina-backup/config
```

### Docker 部署

数据目录是启动容器时通过 `-v` 参数挂载的宿主机路径（例如 `./data`）：

```bash
mkdir -p ~/hina-backup

# 推荐先停止容器，再复制整个 data 目录
docker compose stop    # 或 docker stop hina
cp -a ./data ~/hina-backup/data
docker compose start   # 或 docker start hina
```

### 从源码编译安装

数据目录默认位于安装目录下的 `data/`。如果通过 `HINA_DB_PATH` 自定义了路径，请备份该数据库文件所在的整个目录，或使用 `sqlite3 .backup` 生成一致的单文件备份：

```bash
mkdir -p ~/hina-backup

# 备份默认 data 目录
sudo systemctl stop hina
sudo cp -a /opt/hina/data ~/hina-backup/data
sudo systemctl start hina

# 如果使用了自定义数据库路径，也可以使用 sqlite3 生成一致备份
# sqlite3 "$HINA_DB_PATH" ".backup '$HOME/hina-backup/hina.sqlite'"
```

:::tip
`sqlite3 .backup` 命令可以在数据库运行中安全执行，无需停止服务。如果没有安装 `sqlite3`，则需要先停止服务再复制整个 `data/` 目录，以避免复制到不一致的数据。
:::

---

根据安装方式选择对应的卸载步骤。

## 方式一：一键脚本安装

如果通过一键脚本安装并保留了 `hina-ctl`，直接执行：

```bash
sudo hina-ctl uninstall
```

脚本会交互式地引导你完成卸载，包括停止/禁用服务、删除二进制文件，并逐项询问是否删除数据目录、配置目录和控制脚本本身。

如需手动操作，完整步骤如下：

```bash
# 停止并禁用服务
sudo systemctl disable --now hina-server

# 删除 systemd 服务文件并重新加载
sudo rm /etc/systemd/system/hina-server.service
sudo systemctl daemon-reload

# 删除安装目录（二进制、前端资源、迁移文件等）
sudo rm -rf /opt/hina

# 删除升级时产生的备份目录（如果存在）
sudo rm -rf /opt/hina.backup

# 删除数据目录（数据库将永久丢失，请确保已备份）
sudo rm -rf /var/lib/hina

# 删除配置目录
sudo rm -rf /etc/hina

# 删除控制脚本
sudo rm -f /usr/local/bin/hina-ctl
```

:::caution
删除 `/var/lib/hina` 将永久移除数据库（包括所有 Agent 数据、探针记录、告警规则等）。执行前请确认已完成备份。
:::

## 方式二：Docker 部署

使用 docker-compose：

```bash
# 停止并移除容器
docker compose down

# 删除镜像（可选）
docker rmi ghcr.io/kikyou14/hina:latest
```

使用 docker run：

```bash
# 停止并移除容器
docker rm -f hina

# 删除镜像（可选）
docker rmi ghcr.io/kikyou14/hina:latest
```

如果不再需要历史数据，手动删除挂载的数据目录：

```bash
# 默认为启动命令中 -v 参数指定的路径
rm -rf ./data
```

:::caution
删除 `data/` 目录将永久移除数据库。执行前请确认已完成备份。
:::

## 方式三：从源码编译安装

以下示例假设安装目录为 `/opt/hina`、服务名为 `hina`。如果安装时使用了其他路径，请替换为实际值。

```bash
# 停止并禁用服务
sudo systemctl disable --now hina

# 删除 systemd 服务文件并重新加载
sudo rm /etc/systemd/system/hina.service
sudo systemctl daemon-reload

# 删除安装目录（二进制、前端资源、迁移文件、配置等）
sudo rm -rf /opt/hina
```

如果将数据库配置到了独立路径（通过 `HINA_DB_PATH`），需要额外删除该目录：

```bash
# 示例：如果配置了 HINA_DB_PATH=/var/lib/hina/hina.sqlite
sudo rm -rf /var/lib/hina
```

:::caution
安装目录中的 `data/` 包含数据库文件，删除前请确认已完成备份。
:::
