---
title: Build from Source
description: Build a single-file binary with build-release.sh and run it under systemd
---

## Prerequisites

- **Build host**: Bun 1.x + git. Bun is only needed for the build — you can uninstall it afterwards.
- **Runtime host**: No extra runtime dependency. The artifact is a single-file binary produced by `bun build --compile`, with the Bun runtime embedded.

If the build host and runtime host are the same machine, you only need to install Bun once, for the build.

## Build the release package

```bash
git clone https://github.com/kikyou14/hina.git /tmp/hina-build
cd /tmp/hina-build
./scripts/build-release.sh
```

The script installs dependencies, builds the frontend, and runs `bun build --compile` on the server entrypoint. Output lands in `dist/hina-server-<platform>/`:

```text
dist/hina-server-linux-x64/
├── hina-server          # Single-file binary (bundles the Bun runtime)
├── start.sh             # Startup wrapper that sets resource paths
├── drizzle/             # Database migrations
├── public/              # Frontend static assets
└── .env.example         # Config template
```

A matching `dist/hina-server-linux-x64.tar.gz` is produced alongside. Replace `linux-x64` in the commands below with your actual platform (`linux-arm64`, `darwin-arm64`, etc.).

## Deploy to a target directory

You can install under any path. The steps below use `/opt/hina` as an example—if you choose another directory, keep every path consistent across this section, the systemd unit, and the upgrade flow.

### 1. Place the artifact

```bash
sudo mv /tmp/hina-build/dist/hina-server-linux-x64 /opt/hina
sudo mkdir -p /opt/hina/data /opt/hina/.cache
```

### 2. Configure

```bash
sudo cp /opt/hina/.env.example /opt/hina/.env
```

Edit `/opt/hina/.env` to override any variables you need. For the full list and what each variable does, see [Configuration reference](/en/deployment/configuration/#environment-variables).

The release artifact is self-contained, so `/tmp/hina-build/` can be removed. Keep it around if you'd rather `git pull` and rebuild in place during future upgrades.

## systemd unit

Write this into `/etc/systemd/system/hina.service`:

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

# Basic hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/hina/data /opt/hina/.cache

[Install]
WantedBy=multi-user.target
```

Key points:

- `ExecStart=/opt/hina/start.sh`: the wrapper defaults `HINA_WEB_DIST_PATH`, `HINA_MIGRATIONS_PATH`, and `HINA_GEO_DIR` to `public/`, `drizzle/`, and `.cache/geo/` next to the binary, so the systemd unit doesn't have to repeat them.
- `WorkingDirectory=/opt/hina`: the default `HINA_DB_PATH=data/hina.sqlite` resolves against this directory, landing at `/opt/hina/data/hina.sqlite`.
- `ReadWritePaths` only opens the data directory and the GeoIP cache; the rest of the filesystem is read-only to the service.
- If you change `HINA_DB_PATH` to an absolute path (e.g. a dedicated mount), add that path to `ReadWritePaths` as well.

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hina
sudo systemctl status hina
sudo journalctl -u hina -f        # Tail logs
```

On first boot, the admin password is written to `data/admin-credentials.txt` inside the working directory (with the `/opt/hina` example above, that is `/opt/hina/data/admin-credentials.txt`). Save the password, then delete the file. You can also set `HINA_ADMIN_PASSWORD` in your `.env` to supply the password yourself and skip file generation.

## Upgrade flow

The idea: rebuild in the build directory, then **overlay** the new artifact onto the install directory (above, `/opt/hina`). `data/`, `.env`, and `.cache/` aren't in the artifact, so they're preserved automatically.

```bash
# 1. Rebuild (re-clone if you deleted /tmp/hina-build earlier)
cd /tmp/hina-build
git pull
./scripts/build-release.sh

# 2. Stop the service and back up the data directory
sudo systemctl stop hina
sudo mkdir -p /opt/hina/backups
sudo cp -a /opt/hina/data /opt/hina/backups/$(date +%F)

# 3. Overlay → start
sudo cp -a dist/hina-server-linux-x64/. /opt/hina/
sudo systemctl start hina
```

The trailing `/.` in `dist/hina-server-linux-x64/.` tells `cp` to copy the directory **contents** into `/opt/hina/`, leaving files that aren't in the artifact (like `data/` and `.env`) untouched.

SQLite in WAL mode supports hot backups through `sqlite3 .backup`. This flow uses a file-level copy, so it stops the service first and copies the entire `data/` directory.

## Where the data directory lives

By default the database is `data/hina.sqlite` under the install directory (with the `/opt/hina` example above, that is `/opt/hina/data/hina.sqlite`). To put it on a dedicated mount, set an absolute path in the `.env` file under your install directory:

```bash
HINA_DB_PATH=/var/lib/hina/hina.sqlite
```

Don't forget to add `/var/lib/hina` to the systemd unit's `ReadWritePaths`.
