#!/usr/bin/env bash
set -euo pipefail

# ── Required ──────────────────────────────────────────────────────────
: "${SERVER_URL:?SERVER_URL is required}"
: "${TOKEN:?TOKEN is required}"

# ── Optional (with defaults) ──────────────────────────────────────────
SERVICE_NAME="${SERVICE_NAME:-hina-agent}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
DOWNLOAD_PROXY="${DOWNLOAD_PROXY:-}"
# Ensure proxy ends with '/' for correct URL concatenation
if [ -n "$DOWNLOAD_PROXY" ] && [ "${DOWNLOAD_PROXY: -1}" != "/" ]; then
  DOWNLOAD_PROXY="${DOWNLOAD_PROXY}/"
fi
INTERFACE="${INTERFACE:-}"
MOUNT_POINTS="${MOUNT_POINTS:-}"

# ── Derive WebSocket URL from HTTP(S) base URL ───────────────────────
derive_ws_url() {
  local url="$1"
  url="${url/https:\/\//wss://}"
  url="${url/http:\/\//ws://}"
  url="${url%/}"
  printf '%s/ws' "$url"
}

WS_URL="$(derive_ws_url "$SERVER_URL")"

# ── Detect OS and arch ────────────────────────────────────────────────
detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os" in
    linux)  os="linux" ;;
    darwin) os="darwin" ;;
    *)      echo "Error: unsupported OS: $os" >&2; exit 1 ;;
  esac

  case "$arch" in
    x86_64|amd64)   arch="x86_64" ;;
    aarch64|arm64)   arch="aarch64" ;;
    *)               echo "Error: unsupported architecture: $arch" >&2; exit 1 ;;
  esac

  PLATFORM_OS="$os"
  PLATFORM_ARCH="$arch"
}

# ── Download binary ───────────────────────────────────────────────────
download_binary() {
  local page=1 tag=""
  while [ "$page" -le 5 ]; do
    local body
    body=$(curl -fsSL "https://api.github.com/repos/kikyou14/hina/releases?per_page=100&page=${page}") \
      || { echo "Error: failed to fetch releases from github.com" >&2; exit 1; }
    tag=$(printf '%s' "$body" \
      | grep -oE '"tag_name" *: *"agent-v[0-9]+\.[0-9]+\.[0-9]+"' \
      | head -1 \
      | grep -oE 'agent-v[0-9]+\.[0-9]+\.[0-9]+') \
      || true
    [ -n "$tag" ] && break
    printf '%s' "$body" | grep -q '"tag_name"' || break
    page=$((page + 1))
  done
  [ -n "$tag" ] || { echo "Error: failed to find latest agent release" >&2; exit 1; }

  local asset="hina-agent-${PLATFORM_OS}-${PLATFORM_ARCH}"
  local url="${DOWNLOAD_PROXY}https://github.com/kikyou14/hina/releases/download/${tag}/${asset}"
  local tmp
  tmp="$(mktemp)"

  echo "Downloading hina-agent ${tag} from: $url"
  curl -fsSL -o "$tmp" "$url"

  mkdir -p "$INSTALL_DIR"
  mv "$tmp" "${INSTALL_DIR}/hina-agent"
  chmod +x "${INSTALL_DIR}/hina-agent"
  echo "Installed to ${INSTALL_DIR}/hina-agent"
}

# ── Linux: systemd service ────────────────────────────────────────────
install_systemd() {
  local unit_path="/etc/systemd/system/${SERVICE_NAME}.service"

  # Stop existing service if running
  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "Stopping existing ${SERVICE_NAME} service..."
    systemctl stop "$SERVICE_NAME" || true
  fi

  # Build ExecStart args
  local exec_args="--server-url ${WS_URL} --token ${TOKEN}"
  [ -n "$INTERFACE" ]    && exec_args="$exec_args --interface ${INTERFACE}"
  [ -n "$MOUNT_POINTS" ] && exec_args="$exec_args --mount-points ${MOUNT_POINTS}"

  echo "Creating systemd unit: $unit_path"
  cat > "$unit_path" <<UNIT
[Unit]
Description=Hina Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${INSTALL_DIR}/hina-agent ${exec_args}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME"
  echo "Service ${SERVICE_NAME} started."
  echo "Check status: systemctl status ${SERVICE_NAME}"
}

# ── macOS: launchd daemon ─────────────────────────────────────────────
xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  printf '%s' "$s"
}

install_launchd() {
  local plist_path="/Library/LaunchDaemons/${SERVICE_NAME}.plist"

  # Unload existing daemon if present
  if [ -f "$plist_path" ]; then
    echo "Unloading existing ${SERVICE_NAME} daemon..."
    launchctl bootout "system/${SERVICE_NAME}" 2>/dev/null || true
  fi

  local e_install_dir e_server_url e_token e_interface e_mount_points e_service_name
  e_install_dir="$(xml_escape "$INSTALL_DIR")"
  e_server_url="$(xml_escape "$WS_URL")"
  e_token="$(xml_escape "$TOKEN")"
  e_interface="$(xml_escape "$INTERFACE")"
  e_mount_points="$(xml_escape "$MOUNT_POINTS")"
  e_service_name="$(xml_escape "$SERVICE_NAME")"

  # Build ProgramArguments array
  local args_xml="    <string>${e_install_dir}/hina-agent</string>"
  args_xml="$args_xml
    <string>--server-url</string>
    <string>${e_server_url}</string>
    <string>--token</string>
    <string>${e_token}</string>"
  [ -n "$INTERFACE" ] && args_xml="$args_xml
    <string>--interface</string>
    <string>${e_interface}</string>"
  [ -n "$MOUNT_POINTS" ] && args_xml="$args_xml
    <string>--mount-points</string>
    <string>${e_mount_points}</string>"

  echo "Creating launchd plist: $plist_path"
  umask 077
  cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${e_service_name}</string>
  <key>ProgramArguments</key>
  <array>
${args_xml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/log/${e_service_name}.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/${e_service_name}.log</string>
</dict>
</plist>
PLIST

  launchctl bootstrap system "$plist_path"
  echo "Daemon ${SERVICE_NAME} started."
  echo "Check status: sudo launchctl print system/${SERVICE_NAME}"
  echo "View logs: tail -f /var/log/${SERVICE_NAME}.log"
}

# ── Main ──────────────────────────────────────────────────────────────
main() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Error: this script must be run as root (use sudo)." >&2
    exit 1
  fi

  echo "=== Hina Agent Installer ==="

  detect_platform
  echo "Platform: ${PLATFORM_OS}/${PLATFORM_ARCH}"

  download_binary

  case "$PLATFORM_OS" in
    linux)  install_systemd ;;
    darwin) install_launchd ;;
  esac

  echo ""
  echo "=== Installation complete ==="
}

main
