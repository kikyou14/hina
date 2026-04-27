---
title: Uninstalling the Server
description: Remove Hina Server from the host
---

Before uninstalling, it is strongly recommended to back up your data. Uninstallation is irreversible — once the data directory is deleted, all monitoring data is permanently lost.

## Backing up data

Hina stores all data in SQLite with WAL mode enabled. For file-level backups, do not copy only `hina.sqlite`; keep `hina.sqlite-wal` and `hina.sqlite-shm` with it. The simplest reliable backup is the entire `data/` directory.

### Install script

The data directory is `/var/lib/hina/data` by default, with the database at `/var/lib/hina/data/hina.sqlite`. Configuration files live in `/etc/hina/`:

```bash
# Create a backup directory
mkdir -p ~/hina-backup

# Back up the database (using sqlite3 .backup for consistency)
sqlite3 /var/lib/hina/data/hina.sqlite ".backup '$HOME/hina-backup/hina.sqlite'"

# If sqlite3 is not installed, stop the service and copy the entire data directory
sudo systemctl stop hina-server
sudo cp -a /var/lib/hina/data ~/hina-backup/data
sudo systemctl start hina-server

# Back up configuration files
sudo cp -a /etc/hina ~/hina-backup/config
```

### Docker deployment

The data directory is the host path mounted via the `-v` flag when starting the container (e.g. `./data`):

```bash
mkdir -p ~/hina-backup

# Stop the container first, then copy the entire data directory
docker compose stop    # or: docker stop hina
cp -a ./data ~/hina-backup/data
docker compose start   # or: docker start hina
```

### Built from source

The data directory is `data/` inside the install directory by default. If you customized the path via `HINA_DB_PATH`, back up the whole directory containing that database file, or use `sqlite3 .backup` to produce a consistent single-file backup:

```bash
mkdir -p ~/hina-backup

# Back up the default data directory
sudo systemctl stop hina
sudo cp -a /opt/hina/data ~/hina-backup/data
sudo systemctl start hina

# If you used a custom database path, sqlite3 can produce a consistent backup
# sqlite3 "$HINA_DB_PATH" ".backup '$HOME/hina-backup/hina.sqlite'"
```

:::tip
The `sqlite3 .backup` command can be safely run while the database is in use, so there is no need to stop the service. If `sqlite3` is not installed, stop the service before copying the entire `data/` directory to avoid an inconsistent snapshot.
:::

---

Choose the uninstall steps that match your original installation method.

## Method 1: Install script

If you installed via the one-liner script and still have `hina-ctl`, simply run:

```bash
sudo hina-ctl uninstall
```

The script interactively walks you through the full removal—stopping/disabling the service, deleting binaries, and prompting you for each optional cleanup (data directory, config directory, control script).

If you prefer to do it manually, here are the full steps:

```bash
# Stop and disable the service
sudo systemctl disable --now hina-server

# Remove the systemd unit file and reload
sudo rm /etc/systemd/system/hina-server.service
sudo systemctl daemon-reload

# Remove the install directory (binary, frontend assets, migrations, etc.)
sudo rm -rf /opt/hina

# Remove the upgrade backup directory (if it exists)
sudo rm -rf /opt/hina.backup

# Remove the data directory (the database will be permanently lost — back up first)
sudo rm -rf /var/lib/hina

# Remove the config directory
sudo rm -rf /etc/hina

# Remove the control script
sudo rm -f /usr/local/bin/hina-ctl
```

:::caution
Deleting `/var/lib/hina` permanently removes the database — all agent data, probe records, alert rules, etc. Make sure you have a backup before proceeding.
:::

## Method 2: Docker deployment

With docker-compose:

```bash
# Stop and remove the container
docker compose down

# Remove the image (optional)
docker rmi ghcr.io/kikyou14/hina:latest
```

With docker run:

```bash
# Stop and remove the container
docker rm -f hina

# Remove the image (optional)
docker rmi ghcr.io/kikyou14/hina:latest
```

If you no longer need historical data, delete the mounted data directory:

```bash
# This is the path specified in the -v flag of your original run command
rm -rf ./data
```

:::caution
Deleting the `data/` directory permanently removes the database. Make sure you have a backup before proceeding.
:::

## Method 3: Built from source

The examples below assume the install directory is `/opt/hina` and the service name is `hina`. Replace these with your actual values if you used different paths.

```bash
# Stop and disable the service
sudo systemctl disable --now hina

# Remove the systemd unit file and reload
sudo rm /etc/systemd/system/hina.service
sudo systemctl daemon-reload

# Remove the install directory (binary, frontend assets, migrations, config, etc.)
sudo rm -rf /opt/hina
```

If you configured the database to a separate path (via `HINA_DB_PATH`), remove that directory as well:

```bash
# Example: if you set HINA_DB_PATH=/var/lib/hina/hina.sqlite
sudo rm -rf /var/lib/hina
```

:::caution
The `data/` subdirectory inside the install directory contains the database files. Make sure you have a backup before deleting it.
:::
