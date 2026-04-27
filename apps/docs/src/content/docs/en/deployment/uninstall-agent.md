---
title: Uninstalling the Agent
description: Remove hina-agent from a monitored host
---

The steps below assume you used the **default settings** during installation (service name `hina-agent`, install directory `/usr/local/bin`). If you customized `SERVICE_NAME` or `INSTALL_DIR`, replace the values accordingly.

## Linux (systemd)

```bash
# Stop and disable the service
sudo systemctl stop hina-agent
sudo systemctl disable hina-agent

# Remove the systemd unit file and reload
sudo rm /etc/systemd/system/hina-agent.service
sudo systemctl daemon-reload

# Remove the binary
sudo rm /usr/local/bin/hina-agent
```

## macOS (launchd)

```bash
# Unload the daemon
sudo launchctl bootout system/hina-agent

# Remove the plist file
sudo rm /Library/LaunchDaemons/hina-agent.plist

# Remove the binary
sudo rm /usr/local/bin/hina-agent

# Remove the log file (optional)
sudo rm -f /var/log/hina-agent.log
```

## Removing from the admin UI

After uninstalling the agent from the host, the node will appear as offline in the admin panel. If you no longer need its historical data, you can delete the node from the admin UI.
