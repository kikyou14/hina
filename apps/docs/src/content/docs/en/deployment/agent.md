---
title: Deploying the Agent
description: Install hina-agent on monitored hosts
---

## Option 1: Install script (recommended)

**Recommended**: in the admin UI, create an agent, then click **Deploy** to open the dialog. Enter **Server URL** and **Token**, and optionally **Network interface**, **Mount points**, **Download proxy**, **Service name**, and **Installation directory**. The **Install command** section then shows the full `curl … install-agent.sh | sudo -E bash` command—copy it to the monitored host and run it there.

**Required environment variables**:

| Variable | Description |
|----------|-------------|
| `SERVER_URL` | **HTTP(S) base URL** of the server (do **not** include `/ws`). Example: `https://hina.example.com` |
| `TOKEN` | Agent token from the previous step. |

**Common optional variables**:

| Variable | Default | Description |
|----------|---------|-------------|
| `INSTALL_DIR` | `/usr/local/bin` | Where to place the `hina-agent` binary |
| `SERVICE_NAME` | `hina-agent` | systemd / launchd service name |
| `DOWNLOAD_PROXY` | empty | URL prefix for downloading from GitHub (must end with `/` if set) |
| `INTERFACE` | empty | Network interface used to resolve this host’s IP addresses |
| `MOUNT_POINTS` | empty | Mount paths to monitor; use commas to separate multiple values (e.g. `/,/data`) |

Example (replace URL and token):

```bash
curl -fsSL https://raw.githubusercontent.com/kikyou14/hina/main/scripts/install-agent.sh | \
  SERVER_URL='https://hina.example.com' TOKEN='YOUR_TOKEN_HERE' sudo -E bash
```

After install, use `systemctl status hina-agent` on Linux or `sudo launchctl print system/hina-agent` on macOS to verify.

### Automatic updates

Agents installed with the install script enable automatic updates by default on Unix systems. After startup, the agent checks for a newer version automatically, then checks again every **12 hours** by default. If you want to control agent upgrades entirely through your own rollout process, add `--no-auto-update` to the manual startup flags.

`SERVER_URL` must be the server's HTTP(S) base URL, for example `https://hina.example.com`. The install script converts it to a WebSocket URL and appends `/ws`, so do not pass `wss://.../ws` or a URL that already includes `/ws`.

## Option 2: Manual release binary

1. Download the asset matching your OS/arch from [GitHub Releases](https://github.com/kikyou14/hina/releases) (`hina-agent-linux-x86_64`, `hina-agent-linux-aarch64`, `hina-agent-darwin-aarch64`, etc.).
2. Install it e.g. as `/usr/local/bin/hina-agent` and `chmod +x`.
3. Use a full **WebSocket URL** for `--server-url` (typically `wss://<host>/ws` or `ws://<host>:3000/ws`).

Example **systemd** unit on Linux (adjust paths and token):

```ini
[Unit]
Description=Hina Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/hina-agent --server-url wss://hina.example.com/ws --token YOUR_TOKEN_HERE
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Save as `/etc/systemd/system/hina-agent.service`, then run `systemctl daemon-reload && systemctl enable --now hina-agent`.

## Option 3: Build from source

Install the **Rust** toolchain. From the repository root:

```bash
cargo build --release -p hina-agent
```

The binary is `target/release/hina-agent`. For cross-compilation targets, see `.github/workflows/release-agent.yml`.

Run example:

```bash
./target/release/hina-agent --server-url ws://127.0.0.1:3000/ws --token YOUR_TOKEN_HERE
```

## CLI flags

| Flag | Description |
|------|-------------|
| `--server-url <url>` | Server WebSocket URL (**required**), including the `/ws` path. |
| `--token <token>` | Agent authentication token (**required**). |
| `--once` | Single session; exit after disconnect (no reconnect loop). |
| `--insecure` | Skip TLS certificate verification for `wss://` (self-signed / lab use; prefer trusted certs in production). |
| `--interface <name>` | Network interface name used to resolve the host’s outward-facing IPs. |
| `--mount-points <list>` | Comma-separated mount paths; disk metrics are limited to these when set. |
| `--no-auto-update` | **Unix only**: disables automatic Agent updates. By default, the agent checks for updates every 12 hours. |

## About the token

When you create a node, the token is shown only once—save it somewhere safe. If you did not keep it or need a token later, use **Rotate token** in the admin UI to issue a new one. The node and its historical data are unchanged; the previous token stops working, and you must reconfigure running agents with the new token.
