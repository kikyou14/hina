---
title: 卸载 Agent
description: 从被监控主机上卸载 hina-agent
---

以下步骤假设安装时使用了**默认配置**（服务名 `hina-agent`，安装目录 `/usr/local/bin`）。如果安装时自定义了 `SERVICE_NAME` 或 `INSTALL_DIR`，请将命令中的对应值替换为实际值。

## Linux (systemd)

```bash
# 停止并禁用服务
sudo systemctl stop hina-agent
sudo systemctl disable hina-agent

# 删除 systemd 服务文件并重新加载
sudo rm /etc/systemd/system/hina-agent.service
sudo systemctl daemon-reload

# 删除二进制文件
sudo rm /usr/local/bin/hina-agent
```

## macOS (launchd)

```bash
# 卸载 daemon
sudo launchctl bootout system/hina-agent

# 删除 plist 文件
sudo rm /Library/LaunchDaemons/hina-agent.plist

# 删除二进制文件
sudo rm /usr/local/bin/hina-agent

# 删除日志文件（可选）
sudo rm -f /var/log/hina-agent.log
```

## 从管理后台移除

卸载主机上的 Agent 后，该节点在管理后台会显示为离线状态。如果不再需要保留该节点的历史数据，可以在管理后台中将其删除。
