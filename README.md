# Hina

[简体中文](README.zh-CN.md)

Hina is a distributed server monitoring system designed for self-hosting. Use a single web dashboard to manage multiple machines, view resource usage, online status, and historical data, and continuously track service health with built-in probes and alerts.

The goal is not to build a complex monitoring platform, but to offer a lighter, more direct path: deploy one server, install agents on the machines you want to monitor, and start managing your nodes from a unified interface.

## Features

- **Unified dashboard for multiple servers** — View node status, core resource metrics, and recent changes in one place.
- **Lightweight Rust agent** — Simple to deploy, low resource footprint, suitable for long-running monitoring on target hosts.
- **Built-in probes and alerts** — Common probe tasks and alert rules to help you catch issues early.
- **Simple self-hosting workflow** — Server, Web UI, and Agent work together cleanly, ideal for personal projects, small teams, and self-managed infrastructure.
- **Public-facing sharing support** — Selectively expose node pages for external status display or team-wide read access.

## Quick Start

### 1. Deploy the server

Choose whichever approach fits your setup:

**One-line install**

For quickly getting the server running on a Linux machine:

```bash
curl -fsSL https://raw.githubusercontent.com/kikyou14/hina/main/scripts/install.sh | sudo bash
```

After installation, verify the service status:

```bash
sudo hina-ctl status
```

**Docker**

Recommended for most self-hosting users. Here is a minimal `docker-compose.yml`:

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

Start the service:

```bash
docker compose up -d
```

On first launch the server generates a random admin password and writes it to a file inside the data volume:

```bash
cat ./data/admin-credentials.txt
```

Delete the file after you have saved the password. You can also pre-set the password via the `HINA_ADMIN_PASSWORD` environment variable to skip file generation entirely.

**From source**

For custom builds or tailored releases:

```bash
git clone https://github.com/kikyou14/hina.git
cd hina
./scripts/build-release.sh
```

Build artifacts will appear in `dist/hina-server-<platform>/`.

### 2. Sign in to the dashboard

The server listens on port `3000` by default. Admin credentials are generated on first startup and written to `data/admin-credentials.txt`. Once logged in, you can begin creating and managing nodes.

### 3. Deploy agents to monitored machines

After creating an agent in the dashboard, use the generated install command. A typical command looks like:

```bash
curl -fsSL https://raw.githubusercontent.com/kikyou14/hina/main/scripts/install-agent.sh | \
  SERVER_URL='https://hina.example.com' TOKEN='YOUR_TOKEN_HERE' sudo -E bash
```

Where:

- `SERVER_URL` is the HTTP(S) address of the server (without `/ws`)
- `TOKEN` is the agent token generated in the dashboard

After installation, check the agent status on the target machine:

```bash
systemctl status hina-agent
```

### 4. Finish production setup if needed

If you plan to expose the dashboard to the public internet, consider setting up a reverse proxy and completing the remaining configuration. See the full deployment guides:

- [Deployment overview](apps/docs/src/content/docs/deployment/overview.md)
- [Docker deployment](apps/docs/src/content/docs/deployment/docker.md)
- [Building from source](apps/docs/src/content/docs/deployment/from-source.md)
- [Deploying agents](apps/docs/src/content/docs/deployment/agent.md)
- [Reverse proxy configuration](apps/docs/src/content/docs/deployment/reverse-proxy.md)
- [Configuration reference](apps/docs/src/content/docs/deployment/configuration.md)
