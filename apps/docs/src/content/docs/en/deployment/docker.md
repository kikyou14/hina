---
title: Docker Deployment
description: Run Hina Server with Docker or docker-compose
---

## Using docker-compose (recommended)

The `docker-compose.yml` in the repo root is the minimal runnable configuration:

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

Start it:

```bash
docker compose up -d
```

On first launch the server generates a random admin password and writes it to a file inside the data volume:

```bash
cat ./data/admin-credentials.txt
```

Delete the file after you have saved the password. You can also pre-set the password via the `HINA_ADMIN_PASSWORD` environment variable to skip file generation entirely (see [Configuration](/en/deployment/configuration/#environment-variables)).

Upgrade to the latest image:

```bash
docker compose down
docker compose pull
docker compose up -d
```

## Using docker run

If you prefer plain `docker run`, the equivalent command is:

```bash
docker run -d \
  --name hina \
  --restart unless-stopped \
  -p 3000:3000 \
  -v ./data:/app/data \
  ghcr.io/kikyou14/hina:latest
```

## Injecting environment variables

Add `-e KEY=VALUE` (for `docker run`) or `environment:` (for `compose`) on top of either starter command above, for example:

```yaml
environment:
  HINA_PUBLIC_BASE_URL: https://hina.example.com
  TZ: Asia/Shanghai
```

The full list of environment variables is documented in [Configuration](/en/deployment/configuration/#environment-variables).

## Building your own image

To build a custom image from source:

```bash
git clone https://github.com/kikyou14/hina.git
cd hina
docker build -t hina:local .
```

Once built, swap `ghcr.io/kikyou14/hina:latest` for `hina:local` in any of the starter commands above.
