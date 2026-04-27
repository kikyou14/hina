---
title: 反向代理
description: 使用 Nginx 或 Caddy 为 Hina Server 加上 HTTPS 与域名
---

Hina Server 端本身不处理 TLS，也不感知宿主机域名——这两件事由前置的反向代理完成。

:::caution[生产环境请务必启用 HTTPS]
Agent 上报的监控数据、面板登录凭据、会话 Cookie 和前端 WebSocket 实时推送都会走这条连接。如果直接暴露 `http://` 或裸 `ws://`，这些流量可能被嗅探甚至劫持。**强烈建议在反向代理上启用 HTTPS/WSS**
:::

:::note[可信反代范围]
Hina Server 默认只把 **loopback**（`127.0.0.0/8`、`::1/128`）视为可信反向代理；其他来源的 `X-Forwarded-For` / `X-Forwarded-Proto` 一律忽略，防止同 LAN / 同 Docker 网络 / 同 VPC 里的非代理主机伪造客户端 IP 或协议，从而影响登录限频、审计 IP、Secure Cookie / HSTS 判断以及 WebSocket upgrade 限频。

Origin 校验始终以客户端直连的 `Host` 头为准，**不读 `X-Forwarded-Host`**。反向代理必须透传原始 Host（Nginx `proxy_set_header Host $host;`、Caddy 默认行为），否则 `/live/*` WebSocket 升级会被 CSWSH 防御拒绝。

反代与 Hina 在同一主机时无需配置。若反代位于独立容器、独立 Pod 或 VPC LB，通过 `HINA_TRUSTED_PROXIES` 显式追加可信网段即可：

```bash
# Docker Compose / VPC: append RFC 1918 + ULA (the common case)
HINA_TRUSTED_PROXIES=private

# Tailscale / WireGuard overlay
HINA_TRUSTED_PROXIES=cgnat

# Explicit CIDR list
HINA_TRUSTED_PROXIES=10.0.0.0/8,192.168.16.0/20
```

支持的命名组：`private`（`10.0.0.0/8` / `172.16.0.0/12` / `192.168.0.0/16` / `fc00::/7`）、`linklocal`、`cgnat`。loopback 始终默认信任，无需列出。
:::

## Nginx 参考配置

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

### 通过 CDN 回源到 Nginx 时

如果 Nginx 反代到 `127.0.0.1:3000`，Hina 默认信任这层同机反代，无需配置 `HINA_TRUSTED_PROXIES`。下面给出 CDN 场景下两个 `location` 的最终配置，其他配置保持不变。

#### Cloudflare

Cloudflare 回源时会发送 `CF-Connecting-IP`。两个 `location` 配置如下：

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

#### 只提供标准 X-Forwarded-For 的 CDN

如果 CDN 没有专用真实 IP 请求头，只提供标准 `X-Forwarded-For`，并且回源时会把它设置为**单个真实客户端 IP**，两个 `location` 配置如下：

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

如果 CDN 回源时把 `X-Forwarded-For` 作为逗号分隔链路继续追加，而不是覆盖为单个真实客户端 IP，就不能直接使用这一组配置；请改用 CDN 提供的专用真实 IP 请求头。

:::caution[限制源站访问]
以上配置会信任 CDN 传来的真实 IP 和协议头。源站应只允许 CDN / 负载均衡访问，避免客户端绕过 CDN 直连源站伪造这些请求头。
:::

## Caddy 参考配置

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

## 常见问题

**Agent 连接几分钟后自动断开？**
几乎总是因为反向代理的空闲超时没有调大。Nginx 默认 60 秒，Caddy 默认两分钟，都会在 agent 心跳间隙直接断开。按上面示例加上 `proxy_read_timeout` / `read_timeout` 即可。

**前端实时推送卡住不动？**
`/live/*` 的 WebSocket 也走同一套升级流程，请确认反向代理的 location 匹配到了这些路径。最常见的错误是只在 `/ws` 上加了 Upgrade 头，而忘了 `/live/*`。

**套了 CDN 后登录或实时推送返回 `forbidden_origin`？**
检查 Nginx access log 中的 `host`、`scheme` 和上游传入的 `X-Forwarded-Proto`。如果 `host` 是面板域名、`scheme=http`、`X-Forwarded-Proto=https`，说明 CDN 在 HTTPS 入口后使用 HTTP 回源，而 Nginx 又把外部协议覆盖成了 `$scheme`。使用上面的 CDN `location` 配置，或把 CDN 回源改为 HTTPS。

**告警里没有面板链接？**
检查 `HINA_PUBLIC_BASE_URL` 是否被设置为真实的对外域名（例如 `https://hina.example.com`）。留空时告警模板中的 `{{dashboard.url}}` 为空，不会退回到 `localhost`。详见 [配置参考 → 环境变量](/deployment/configuration/#环境变量)。
