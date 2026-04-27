---
title: 配置参考
description: Hina Server 的环境变量
---

## 环境变量

Hina 的服务端只需要少量的环境变量。常规部署通常只需要关注端口、数据库、初始管理员密码、公开访问地址和可信反代范围；路径类变量主要用于自定义目录结构。

| 变量 | 用途 | 默认值 | 是否必填 |
|---|---|---|---|
| `PORT` | HTTP 监听端口 | `3000` | 否 |
| `HINA_DB_PATH` | SQLite 数据库文件路径 | `data/hina.sqlite` | 否 |
| `HINA_ADMIN_PASSWORD` | 首次启动时的管理员密码。未设置则随机生成并写入 `data/admin-credentials.txt` | 随机生成 | 否 |
| `HINA_PUBLIC_BASE_URL` | 对外可访问的基址，用于告警通知中的 `{{dashboard.url}}` 变量 | 未设置 | 否 |
| `HINA_TRUSTED_PROXIES` | 允许提供 `X-Forwarded-For` / `X-Forwarded-Proto` 的反向代理来源 | loopback | 否 |
| `TZ` | 默认时区，用于初始化站点时区和告警时间格式 | `Asia/Shanghai` | 否 |
| `HINA_WEB_DIST_PATH` | 前端静态资源目录，相对 `apps/server` 工作目录 | `../web/dist` | 否 |
| `HINA_MIGRATIONS_PATH` | Drizzle 迁移目录 | `./drizzle` | 否 |
| `HINA_GEO_DIR` | MaxMind GeoIP 缓存目录 | `.cache/geo` | 否 |

几点说明：

- **`HINA_ADMIN_PASSWORD`** 仅在首次启动（数据库中尚无管理员账户）时生效。
  - 设置后，服务端使用该值作为初始密码，不会生成文件，日志中也不会出现密码。
  - 未设置时，服务端随机生成一个高强度密码，写入 `data/admin-credentials.txt`（路径相对 `HINA_DB_PATH` 所在目录）。保存密码后请删除该文件。
  - Docker / Kubernetes 部署建议通过此变量注入密码，避免在容器日志中泄露凭证。
- **`PORT`** 同时影响服务端监听端口，以及 `bun run dev:web` 默认代理到的后端端口。
- **`HINA_DB_PATH`** 相对于 `apps/server` 的工作目录解析。如果要放到独立挂载点，请填写绝对路径（如 `/var/lib/hina/hina.sqlite`）。
- **`HINA_PUBLIC_BASE_URL`** 只影响告警通知正文中的链接。
  - 留空：`{{dashboard.url}}` 为空，告警通知不会生成可点击的面板链接，面板其他功能不受影响。
  - **希望告警通知带面板链接时必填**：设为真实对外地址，如 `https://hina.example.com`（不带结尾斜杠）。
- **`HINA_TRUSTED_PROXIES`** 控制哪些来源的反向代理头会被信任。默认只信任 loopback；反代在独立容器、独立 Pod 或 VPC LB 时通常需要设置。支持 `private`、`linklocal`、`cgnat` 和逗号分隔的 CIDR，详见 [反向代理](/deployment/reverse-proxy/)。
- **`TZ`** 只用于初始化默认站点时区；未设置时默认为 `Asia/Shanghai`。如果已经在面板里保存过时区设置，面板设置优先。建议使用 IANA 时区名，例如 `Asia/Shanghai`。
- **`HINA_GEO_DIR`** 是运行期可写缓存目录，相对路径按服务工作目录解析；一键安装会显式设置为 `/opt/hina/.cache/geo`。
- **`HINA_WEB_DIST_PATH`** 和 **`HINA_MIGRATIONS_PATH`** 仅在自定义目录结构时才需要覆盖，官方 Docker 镜像已经把默认值对齐。
