---
title: Deployment Overview
description: Learn Hina Server's deployment architecture and the three supported deployment paths
---

### Method 1: Install script

```bash
curl -fsSL https://raw.githubusercontent.com/kikyou14/hina/main/scripts/install.sh | sudo bash
```

The command above opens the interactive `hina-ctl` menu. Choose the install option from the menu. To skip the menu and install the latest release directly, use:

```bash
curl -fsSL https://raw.githubusercontent.com/kikyou14/hina/main/scripts/install.sh | sudo bash -s -- install
```

Once installed, `hina-ctl` covers the everyday operations:

```bash
sudo hina-ctl status       # Show version and service status
sudo hina-ctl upgrade      # Upgrade to the latest release
sudo hina-ctl logs         # Tail the journal
sudo hina-ctl restart      # Restart the service
sudo hina-ctl uninstall    # Uninstall the service
```

### Method 2: Docker (recommended)

```bash
docker run -d \
  --name hina \
  -p 3000:3000 \
  -v ./data:/app/data \
  ghcr.io/kikyou14/hina:latest
```

For the `docker-compose.yml` flow, see [Docker deployment](/en/deployment/docker/).

### Method 3: Build from source

For custom-build scenarios only — patching the source, publishing from an internal registry, etc. Use `build-release.sh` to produce a single-file binary, then run it under systemd.

See [Build from source](/en/deployment/from-source/) for the full walkthrough.

## Deploying agents

After the server is running, install the Agent on each monitored host and point it at the server’s WebSocket URL. See [Deploying the Agent](/en/deployment/agent/).

## Ports and networking

The server binds to **port 3000** by default (configurable via the `PORT` env var). The dashboard, API, and agent connections all share this single port, so **you do not need to expose a second one**. If you terminate TLS behind a reverse proxy, make sure `Upgrade` / `Connection` headers are forwarded correctly — see [Reverse Proxy](/en/deployment/reverse-proxy/).

## Data directory

All mutable server state lives in **one SQLite database** (`hina.sqlite`), plus two companion files (WAL and SHM):

```text
data/
├── hina.sqlite         # Main database
├── hina.sqlite-wal     # Write-Ahead Log
└── hina.sqlite-shm     # Shared memory index
```

**In production, persist the entire `data/` directory.** All three files must be backed up together to stay consistent.
