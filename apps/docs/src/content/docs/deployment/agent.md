---
title: 部署 Agent
description: 在被监控主机上安装 hina-agent
---

## 方式一：一键安装脚本（推荐）

**推荐**：在管理后台创建 Agent 后，点击 **「部署」** 打开对话框；依次填写「服务器地址」「令牌」，以及按需填写「网络接口」「挂载点」「下载代理」「服务名称」「安装目录」等可选项。随后在 **「安装命令」** 区域会生成完整的 `curl … install-agent.sh | sudo -E bash`，将其复制到被监控主机上执行即可。

**必填环境变量**：

| 变量 | 说明 |
|------|------|
| `SERVER_URL` | 主控的 **HTTP(S) 根地址**（不要带 `/ws`）。例如 `https://hina.example.com` |
| `TOKEN` | 上一步得到的 Agent token。 |

**常用可选变量**：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `INSTALL_DIR` | `/usr/local/bin` | 二进制安装目录 |
| `SERVICE_NAME` | `hina-agent` | systemd / launchd 服务名 |
| `DOWNLOAD_PROXY` | 空 | 下载 GitHub 资源时的代理 URL 前缀（需以 `/` 结尾） |
| `INTERFACE` | 空 | 指定用于解析本机 IP 的网卡名 |
| `MOUNT_POINTS` | 空 | 指定监控的挂载点，多个使用逗号分隔（如 `/,/data`） |

示例（将 URL 与 token 换成你的值）：

```bash
curl -fsSL https://raw.githubusercontent.com/kikyou14/hina/main/scripts/install-agent.sh | \
  SERVER_URL='https://hina.example.com' TOKEN='YOUR_TOKEN_HERE' sudo -E bash
```

安装后可用 `systemctl status hina-agent`（Linux）或 `sudo launchctl print system/hina-agent`（macOS）查看状态。

### 自动更新

通过安装脚本部署的 Agent 在 Unix 系统上默认启用自动更新：Agent 启动后会自动检查新版本，之后默认每 **12 小时** 检查一次。若希望完全由自己的发布流程控制 Agent 版本，可在手动启动参数中加入 `--no-auto-update`。

`SERVER_URL` 必须是主控的 HTTP(S) 根地址，例如 `https://hina.example.com`。安装脚本会自动把它转换为 WebSocket 地址并追加 `/ws`，因此不要传入 `wss://.../ws` 或已经带 `/ws` 的地址。

## 方式二：手动安装 Release 二进制

1. 在 [GitHub Releases](https://github.com/kikyou14/hina/releases) 中下载与本机平台一致的资源，名称形如 `hina-agent-linux-x86_64`、`hina-agent-linux-aarch64`、`hina-agent-darwin-aarch64` 等。
2. 将文件放到例如 `/usr/local/bin/hina-agent` 并 `chmod +x`。
3. 使用与主控可达的 **完整 WebSocket URL** 作为 `--server-url`（通常为 `wss://<host>/ws` 或 `ws://<host>:3000/ws`）。

Linux systemd 示例（请替换路径与参数）：

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

保存为 `/etc/systemd/system/hina-agent.service` 后执行 `systemctl daemon-reload && systemctl enable --now hina-agent`。

## 方式三：从源码编译

需要安装 **Rust** 工具链。在仓库根目录：

```bash
cargo build --release -p hina-agent
```

可执行文件位于 `target/release/hina-agent`。交叉编译可参考 `.github/workflows/release-agent.yml` 中的目标三元组。

运行示例：

```bash
./target/release/hina-agent --server-url ws://127.0.0.1:3000/ws --token YOUR_TOKEN_HERE
```

## 命令行参数

| 参数 | 说明 |
|------|------|
| `--server-url <url>` | 主控 WebSocket 地址（**必填**），须包含路径 `/ws`。 |
| `--token <token>` | Agent 认证 token（**必填**）。 |
| `--once` | 只建立一次会话，断开后退出，不自动重连。 |
| `--insecure` | 使用 `wss://` 时**跳过 TLS 证书校验**（适用于自签证书或内网测试；生产环境优先配置受信任证书）。 |
| `--interface <name>` | 指定用于解析本机对外 IP 的网络接口名称。 |
| `--mount-points <list>` | 逗号分隔的挂载点列表；设置后磁盘相关指标仅针对这些挂载点。 |
| `--no-auto-update` | **仅 Unix**：禁用 Agent 自动更新。默认情况下，Agent 每 12 小时检查一次新版本。 |

## 关于令牌

创建节点时，令牌仅会显示一次，请妥善保存。若未保存或日后仍需使用，可在管理后台选择 **「轮换令牌」**，系统将生成新的令牌；该节点及其历史数据会保留，原令牌随即失效，已部署的 Agent 需改用新令牌。
