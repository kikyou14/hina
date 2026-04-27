---
title: Configuration
description: Environment variables for Hina Server
---

## Environment variables

Hina's server needs only a handful of environment variables. Most deployments only need to care about the port, database, initial admin password, public base URL, and trusted proxy ranges; path variables are mainly for custom layouts.

| Variable | Purpose | Default | Required |
|---|---|---|---|
| `PORT` | HTTP listen port | `3000` | No |
| `HINA_DB_PATH` | SQLite database file path | `data/hina.sqlite` | No |
| `HINA_ADMIN_PASSWORD` | Admin password on first startup. When unset, a random password is generated and written to `data/admin-credentials.txt` | auto-generated | No |
| `HINA_PUBLIC_BASE_URL` | Publicly reachable base URL, used by the `{{dashboard.url}}` alert variable | unset | No |
| `HINA_TRUSTED_PROXIES` | Reverse-proxy peers allowed to provide `X-Forwarded-For` / `X-Forwarded-Proto` | loopback | No |
| `TZ` | Default timezone used to initialize the site timezone and alert time formatting | `Asia/Shanghai` | No |
| `HINA_WEB_DIST_PATH` | Frontend static-asset directory, relative to `apps/server` | `../web/dist` | No |
| `HINA_MIGRATIONS_PATH` | Drizzle migrations directory | `./drizzle` | No |
| `HINA_GEO_DIR` | MaxMind GeoIP cache directory | `.cache/geo` | No |

A few notes:

- **`HINA_ADMIN_PASSWORD`** only takes effect on first startup (when no admin account exists in the database yet).
  - When set, the server uses this value as the initial password. No credential file is generated and no password appears in the logs.
  - When unset, a strong random password is generated and written to `data/admin-credentials.txt` (relative to the directory containing `HINA_DB_PATH`). Save the password, then delete the file.
  - Recommended for Docker / Kubernetes deployments to avoid credential leakage in container logs.
- **`PORT`** is used by both the server listener and the backend port that `bun run dev:web` proxies to by default.
- **`HINA_DB_PATH`** is resolved relative to the `apps/server` working directory. Use an absolute path (e.g. `/var/lib/hina/hina.sqlite`) if you want the database on a dedicated mount.
- **`HINA_PUBLIC_BASE_URL`** only affects links in alert notifications.
  - Unset: `{{dashboard.url}}` is empty, so alert notifications do not generate a clickable dashboard link. The rest of the panel is unaffected.
  - **Required if you want alert notifications to include dashboard links**: set it to the real public URL, e.g. `https://hina.example.com` (no trailing slash).
- **`HINA_TRUSTED_PROXIES`** controls which peers may supply trusted reverse-proxy headers. By default, only loopback is trusted. Set it when your proxy is in a separate container, pod, or VPC load balancer. It accepts `private`, `linklocal`, `cgnat`, and comma-separated CIDR ranges; see [Reverse Proxy](/en/deployment/reverse-proxy/).
- **`TZ`** initializes the default site timezone. When unset, it defaults to `Asia/Shanghai`. If a timezone has already been saved in the dashboard, the dashboard setting wins. Use an IANA timezone name such as `Asia/Shanghai`.
- **`HINA_GEO_DIR`** is a writable runtime cache directory. Relative paths resolve against the service working directory; the one-click installer sets it to `/opt/hina/.cache/geo`.
- **`HINA_WEB_DIST_PATH`** and **`HINA_MIGRATIONS_PATH`** only need overriding if you change the repo layout. The official Docker image already sets sane defaults.
