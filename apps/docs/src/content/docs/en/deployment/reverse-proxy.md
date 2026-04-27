---
title: Reverse Proxy
description: Put Hina Server behind Nginx or Caddy for HTTPS and a real domain name
---

Hina Server itself doesn't terminate TLS and doesn't know your public hostname — both are handled by a reverse proxy in front of it.

:::caution[Always enable HTTPS in production]
Agent telemetry, dashboard login credentials, session cookies, and the frontend's live-update WebSocket all flow over this single connection. If you expose plain `http://` or bare `ws://`, that traffic can be sniffed or hijacked. **Strongly recommended: enable HTTPS/WSS on the reverse proxy.**
:::

:::note[Trusted proxy ranges]
Hina Server trusts **only loopback** (`127.0.0.0/8`, `::1/128`) as a reverse proxy by default; `X-Forwarded-For` / `X-Forwarded-Proto` from any other peer are ignored. This stops non-proxy hosts on the same LAN, Docker network, or VPC from forging the client IP or protocol, which would otherwise affect login rate limiting, audit IPs, Secure cookie / HSTS decisions, and WebSocket upgrade rate limiting.

Origin matching for WebSocket upgrades uses the transport `Host` header only — **`X-Forwarded-Host` is never read**. Your reverse proxy must forward the original Host header (nginx `proxy_set_header Host $host;`, Caddy's default); otherwise `/live/*` upgrades will be rejected by the CSWSH guard.

No configuration is needed when the reverse proxy runs on the same host as Hina. When the proxy lives in a separate container, pod, or VPC load balancer, append the appropriate ranges with `HINA_TRUSTED_PROXIES`:

```bash
# Docker Compose / VPC: append RFC 1918 + ULA (the common case)
HINA_TRUSTED_PROXIES=private

# Tailscale / WireGuard overlay
HINA_TRUSTED_PROXIES=cgnat

# Explicit CIDR list
HINA_TRUSTED_PROXIES=10.0.0.0/8,192.168.16.0/20
```

Named groups: `private` (`10.0.0.0/8` / `172.16.0.0/12` / `192.168.0.0/16` / `fc00::/7`), `linklocal`, `cgnat`. Loopback is always trusted; there is no need to list it.
:::

## Nginx reference configuration

```nginx
upstream hina {
    server 127.0.0.1:3000;
}

server {
    listen 80;
    server_name example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name example.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # WebSocket endpoints: agent /ws + frontend /live/*
    location ~ ^/(ws$|live/) {
        proxy_pass http://hina;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Agent WebSocket is long-lived; bump the timeouts explicitly
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    gzip on;
    gzip_proxied any;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/javascript
               application/javascript application/json
               application/manifest+json image/svg+xml;

    # API + static frontend (Hono handles SPA fallback)
    location / {
        proxy_pass http://hina;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Origin pulls through a CDN to Nginx

If Nginx proxies to `127.0.0.1:3000`, Hina trusts that local proxy by default. You do not need to set `HINA_TRUSTED_PROXIES`. For CDN deployments, use one of the final `location` configurations below and leave the rest of your Nginx config unchanged.

#### Cloudflare

Cloudflare sends `CF-Connecting-IP` on origin requests. Use these two `location` blocks:

```nginx
location ~ ^/(ws$|live/) {
    proxy_pass http://hina;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $http_cf_connecting_ip;
    proxy_set_header X-Forwarded-For $http_cf_connecting_ip;
    proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;

    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}

location / {
    proxy_pass http://hina;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $http_cf_connecting_ip;
    proxy_set_header X-Forwarded-For $http_cf_connecting_ip;
    proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
}
```

#### CDNs that only provide standard X-Forwarded-For

If your CDN does not provide a dedicated real-client-IP header and sets standard `X-Forwarded-For` to a **single real client IP** on origin requests, use these two `location` blocks:

```nginx
location ~ ^/(ws$|live/) {
    proxy_pass http://hina;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $http_x_forwarded_for;
    proxy_set_header X-Forwarded-For $http_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;

    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}

location / {
    proxy_pass http://hina;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $http_x_forwarded_for;
    proxy_set_header X-Forwarded-For $http_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
}
```

If the CDN appends to `X-Forwarded-For` as a comma-separated chain instead of overwriting it with a single real client IP, do not use this configuration directly. Use a dedicated real-client-IP header from your CDN instead.

:::caution[Restrict origin access]
These configurations trust the real IP and protocol headers sent by the CDN. Your origin should only be reachable from the CDN / load balancer, so clients cannot bypass the CDN and forge those headers directly.
:::

## Caddy reference configuration

```text
example.com {
    encode zstd gzip

    # Long-lived agent WebSocket
    @ws {
        path /ws /live/*
    }
    reverse_proxy @ws 127.0.0.1:3000 {
        transport http {
            read_timeout 24h
            write_timeout 24h
        }
    }

    # API + static frontend
    reverse_proxy 127.0.0.1:3000
}
```

## Troubleshooting

**Agents reconnect every few minutes?**
Almost always a reverse-proxy idle timeout. Nginx defaults to 60 seconds, Caddy to two minutes — both are shorter than the idle gaps between agent heartbeats and will kill the connection. Apply the `proxy_read_timeout` / `read_timeout` values from the examples above.

**Frontend live updates frozen?**
The `/live/*` WebSockets use the same upgrade flow as `/ws`. Make sure your reverse proxy's location matcher covers those paths too — the most common mistake is setting Upgrade headers only for `/ws`.

**Admin login or live updates return `forbidden_origin` behind a CDN?**
Check the Nginx access log values for `host`, `scheme`, and the incoming `X-Forwarded-Proto`. If `host` is the dashboard domain, `scheme=http`, and `X-Forwarded-Proto=https`, the CDN terminates HTTPS but pulls from the origin over HTTP, and Nginx is overwriting the external protocol with `$scheme`. Use the CDN `location` configuration above, or switch the CDN origin connection to HTTPS.

**Alert notifications do not include a dashboard link?**
Check that `HINA_PUBLIC_BASE_URL` is set to your real public URL (e.g. `https://hina.example.com`). When it is unset, `{{dashboard.url}}` is empty and does not fall back to `localhost`. See [Configuration → Environment variables](/en/deployment/configuration/#environment-variables) for details.
