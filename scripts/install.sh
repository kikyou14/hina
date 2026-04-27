#!/usr/bin/env bash
set -euo pipefail

REPO="kikyou14/hina"
SERVICE_NAME="hina-server"

INSTALL_DIR="/opt/hina"
DATA_DIR="/var/lib/hina"
GEO_DIR="${INSTALL_DIR}/.cache/geo"
ETC_DIR="/etc/hina"
ENV_FILE="${ETC_DIR}/hina.env"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
CTL_PATH="/usr/local/bin/hina-ctl"
BACKUP_DIR="/opt/hina.backup"
VERSION_FILE="${INSTALL_DIR}/.version"

SELF_URL="https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh"

if [ -t 2 ]; then
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_RESET=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_RESET=""
fi

info() { printf '%s==>%s %s\n'  "$C_BLUE"   "$C_RESET" "$*" >&2; }
ok()   { printf '%s[ok]%s %s\n' "$C_GREEN"  "$C_RESET" "$*" >&2; }
warn() { printf '%s[!]%s  %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()  { printf '%s[x]%s  %s\n' "$C_RED"    "$C_RESET" "$*" >&2; }
die()  { err "$@"; exit 1; }


require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "此命令需要 root 权限（请使用 sudo）"
  fi
}

require_linux() {
  if [ "$(uname -s)" != "Linux" ]; then
    die "不支持的系统：$(uname -s)（仅支持 Linux）"
  fi
}

require_systemd() {
  command -v systemctl >/dev/null 2>&1 \
    || die "未检测到 systemd（找不到 systemctl）"
}

require_cmd() {
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "缺少必需的命令：$c"
  done
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "linux-x64"   ;;
    aarch64|arm64) echo "linux-arm64" ;;
    *) die "不支持的架构：$(uname -m)" ;;
  esac
}

validate_port_or_die() {
  local p="$1"
  if ! [[ "$p" =~ ^[0-9]+$ ]]; then
    die "端口必须是数字：${p}"
  fi
  if [ "$p" -lt 1 ] || [ "$p" -gt 65535 ]; then
    die "端口超出有效范围（1-65535）：${p}"
  fi
}

port_from_env_file() {
  local port=""
  if [ -f "$ENV_FILE" ]; then
    port=$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
  fi
  port="${port:-3000}"
  validate_port_or_die "$port"
  echo "$port"
}

preflight_disk() {
  local path="$1" need_mb="$2" probe avail
  probe="$path"
  while [ -n "$probe" ] && [ ! -e "$probe" ]; do
    probe=$(dirname "$probe")
  done
  avail=$(df -P "$probe" 2>/dev/null | awk 'NR==2 { print int($4 / 1024) }')
  if [ -z "$avail" ]; then
    warn "无法获取 ${path} 的剩余空间，跳过磁盘检查"
    return 0
  fi
  if [ "$avail" -lt "$need_mb" ]; then
    die "${path} 磁盘空间不足：剩余 ${avail}MB，需要约 ${need_mb}MB"
  fi
}

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq ":${port}\$"
    return
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq ":${port}\$"
    return
  fi
  return 2
}

preflight_port() {
  local port="$1" rc=0
  port_in_use "$port" || rc=$?
  case "$rc" in
    0)
      warn "端口 ${port} 已被其他进程占用"
      warn "可在安装后编辑 ${ENV_FILE}，或先停止占用该端口的服务"
      local ans
      prompt_tty "仍然继续？[y/N]: " ans "n"
      case "${ans}" in
        y|Y|yes|YES) ;;
        *) die "用户已取消" ;;
      esac
      ;;
    1) ;; # free
    2) warn "未找到 ss 或 netstat，跳过端口检查" ;;
  esac
}

local_version() {
  if [ -f "$VERSION_FILE" ]; then
    cat "$VERSION_FILE"
  else
    echo "(未安装)"
  fi
}

remote_version() {
  local page=1 tag=""
  while [ "$page" -le 5 ]; do
    local body
    body=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}") \
      || die "无法从 github.com 获取版本信息"
    tag=$(printf '%s' "$body" \
      | grep -oE '"tag_name" *: *"[0-9]+\.[0-9]+\.[0-9]+"' \
      | head -1 \
      | grep -oE '[0-9]+\.[0-9]+\.[0-9]+') \
      || true
    [ -n "$tag" ] && break
    printf '%s' "$body" | grep -q '"tag_name"' || break
    page=$((page + 1))
  done
  [ -n "$tag" ] || die "无法从 github.com 获取最新 server 版本"
  echo "$tag"
}

is_installed() { [ -x "${INSTALL_DIR}/hina-server" ]; }

is_active() { systemctl is-active --quiet "${SERVICE_NAME}"; }

status_brief() {
  if ! is_installed; then
    printf '%s未安装%s' "$C_YELLOW" "$C_RESET"
  elif is_active; then
    printf '%s运行中%s' "$C_GREEN"  "$C_RESET"
  else
    printf '%s已停止%s' "$C_RED"    "$C_RESET"
  fi
}

wait_http_ready() {
  local port="$1" timeout="${2:-45}"
  local deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS --max-time 2 "http://127.0.0.1:${port}/healthz" 2>/dev/null \
         | grep -q '"ok"'; then
      return 0
    fi
    is_active || return 1
    sleep 1
  done
  return 1
}

download_release() {
  local arch="$1" workdir="$2" version="$3"
  local tarball="hina-server-${arch}.tar.gz"
  local release_base="https://github.com/${REPO}/releases/download/${version}"

  info "下载 ${tarball}"
  curl -fSL --progress-bar -o "${workdir}/${tarball}" \
    "${release_base}/${tarball}" \
    || die "下载失败：${tarball}"

  if curl -fsSL -o "${workdir}/checksums.txt" \
       "${release_base}/checksums.txt"; then
    awk -v t="$tarball" '
      { name = $2; sub(/^\*/, "", name); if (name == t) { found = 1; exit } }
      END { exit !found }
    ' "${workdir}/checksums.txt" \
      || die "checksums.txt 中未包含 ${tarball}"
    info "校验 sha256"
    ( cd "$workdir" && sha256sum --quiet --check --ignore-missing checksums.txt ) \
      || die "sha256 校验失败"
    ok "sha256 校验通过"
  else
    warn "未找到 checksums.txt，跳过校验"
  fi

  info "解压中"
  tar -xzf "${workdir}/${tarball}" -C "${workdir}" \
    || die "解压失败"

  echo "${workdir}/hina-server-${arch}"
}

prompt_tty() {
  local prompt="$1" varname="$2" default="${3:-}"
  local val=""
  if [ -r /dev/tty ]; then
    read -r -p "$prompt" val < /dev/tty || true
  fi
  printf -v "$varname" '%s' "${val:-$default}"
}

write_env_file() {
  local port="$1" base_url="$2"
  validate_port_or_die "$port"
  mkdir -p "$ETC_DIR"
  {
    echo "# hina-server configuration"
    echo "# edit and run: systemctl restart ${SERVICE_NAME}"
    echo
    echo "PORT=${port}"
    if [ -n "${base_url}" ]; then
      echo "HINA_PUBLIC_BASE_URL=${base_url}"
    else
      echo "# HINA_PUBLIC_BASE_URL=https://status.example.com"
    fi
  } > "$ENV_FILE"
  chmod 644 "$ENV_FILE"
  ok "已写入 ${ENV_FILE}"
}

write_unit_file() {
  cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=Hina Server
Documentation=https://github.com/${REPO}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${DATA_DIR}
EnvironmentFile=-${ENV_FILE}
Environment=HINA_WEB_DIST_PATH=${INSTALL_DIR}/public
Environment=HINA_MIGRATIONS_PATH=${INSTALL_DIR}/drizzle
Environment=HINA_GEO_DIR=${GEO_DIR}
ExecStart=${INSTALL_DIR}/hina-server
Restart=on-failure
RestartSec=3
LimitNOFILE=65536

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${DATA_DIR} ${GEO_DIR}

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  ok "已写入 ${UNIT_FILE}"
}

install_payload() {
  local stage="$1" version="$2"

  mkdir -p "$INSTALL_DIR" "$GEO_DIR"

  rm -rf "${INSTALL_DIR}/hina-server.new" \
         "${INSTALL_DIR}/public.new" \
         "${INSTALL_DIR}/drizzle.new"

  install -m 755 "${stage}/hina-server" "${INSTALL_DIR}/hina-server.new"
  cp -r "${stage}/public"  "${INSTALL_DIR}/public.new"
  cp -r "${stage}/drizzle" "${INSTALL_DIR}/drizzle.new"

  mv -f "${INSTALL_DIR}/hina-server.new" "${INSTALL_DIR}/hina-server"
  rm -rf "${INSTALL_DIR}/public" "${INSTALL_DIR}/drizzle"
  mv "${INSTALL_DIR}/public.new"  "${INSTALL_DIR}/public"
  mv "${INSTALL_DIR}/drizzle.new" "${INSTALL_DIR}/drizzle"

  printf '%s\n' "$version" > "$VERSION_FILE"
}

self_install() {
  local source="${BASH_SOURCE[0]:-}"
  if [ -n "$source" ] && [ -f "$source" ]; then
    install -m 755 "$source" "$CTL_PATH"
  else
    curl -fsSL "$SELF_URL" -o "$CTL_PATH" \
      || die "从 ${SELF_URL} 下载 hina-ctl 失败"
    chmod 755 "$CTL_PATH"
  fi
  ok "已安装控制脚本：${CTL_PATH}"
}

do_install() {
  require_root
  require_linux
  require_systemd
  require_cmd curl tar sha256sum df

  if is_installed; then
    warn "hina-server 已安装在 ${INSTALL_DIR}"
    warn "如需升级请使用 'hina-ctl upgrade'，或先卸载"
    return 1
  fi

  local arch version workdir stage
  arch=$(detect_arch) || exit 1
  info "平台：${arch}"

  preflight_disk "$INSTALL_DIR" 500
  preflight_disk "${TMPDIR:-/tmp}" 200

  local prompted_port="" prompted_base_url="" effective_port=""
  if [ ! -f "$ENV_FILE" ]; then
    prompt_tty "端口 [3000]: " prompted_port "3000"
    validate_port_or_die "$prompted_port"
    prompt_tty "Base URL（例如 https://status.example.com，留空跳过）: " prompted_base_url ""
    preflight_port "$prompted_port"
    effective_port="$prompted_port"
  else
    info "配置已存在于 ${ENV_FILE}，保持不变"
    effective_port=$(port_from_env_file)
  fi

  version=$(remote_version) || exit 1
  info "最新版本：${version}"

  workdir=$(mktemp -d) || die "创建临时目录失败"
  trap 'rm -rf "$workdir"' EXIT

  stage=$(download_release "$arch" "$workdir" "$version") || exit 1

  info "安装到 ${INSTALL_DIR}"
  install_payload "$stage" "$version"

  mkdir -p "${DATA_DIR}/data" "${DATA_DIR}/.cache/geo"

  if [ ! -f "$ENV_FILE" ]; then
    write_env_file "$prompted_port" "$prompted_base_url"
  fi

  write_unit_file
  self_install

  info "启用并启动 ${SERVICE_NAME}"
  systemctl enable --now "${SERVICE_NAME}"

  if wait_http_ready "$effective_port"; then
    ok "${SERVICE_NAME} 正在运行（详情见 'hina-ctl status'）"
  else
    warn "${SERVICE_NAME} 未能就绪，请查看 'hina-ctl logs'"
  fi

  local cred_file="${DATA_DIR}/data/admin-credentials.txt"
  if [ -f "$cred_file" ]; then
    echo
    ok "管理员凭证已写入: ${cred_file}"
    cat "$cred_file"
    warn "请立即保存上述凭证，然后删除该文件: rm ${cred_file}"
  fi

  trap - EXIT
  rm -rf "$workdir"
  echo
  ok "安装完成"
}

_upgrade_workdir=""
_upgrade_backup_done=0
_upgrade_was_active=0

_on_upgrade_exit() {
  set +e
  if [ -n "$_upgrade_workdir" ] && [ -d "$_upgrade_workdir" ]; then
    rm -rf "$_upgrade_workdir"
  fi
  if [ "$_upgrade_backup_done" -eq 1 ]; then
    err "升级失败，正在自动回滚"
    systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
    if rm -rf "$INSTALL_DIR" && cp -a "$BACKUP_DIR" "$INSTALL_DIR"; then
      ok "已恢复到升级前版本"
      if [ "$_upgrade_was_active" -eq 1 ]; then
        info "尝试恢复旧版本运行"
        local port
        port=$(port_from_env_file 2>/dev/null) || port="3000"
        if systemctl start "${SERVICE_NAME}" && wait_http_ready "$port" 30; then
          ok "旧版本已恢复运行"
        else
          err "旧版本启动失败，请手动检查：journalctl -u ${SERVICE_NAME}"
        fi
      fi
    else
      err "回滚失败，请手动恢复："
      err "  cp -a ${BACKUP_DIR} ${INSTALL_DIR}"
      err "  systemctl start ${SERVICE_NAME}"
    fi
  fi
}

do_upgrade() {
  require_root
  require_linux
  require_systemd
  require_cmd curl tar sha256sum df

  is_installed || die "hina-server 未安装，请先运行 'hina-ctl install'"

  preflight_disk "$INSTALL_DIR" 500
  preflight_disk "${TMPDIR:-/tmp}" 200

  local arch local_v remote_v
  arch=$(detect_arch) || exit 1
  local_v=$(local_version)
  remote_v=$(remote_version) || exit 1

  info "当前版本：${local_v}"
  info "最新版本：${remote_v}"

  if [ "$local_v" = "$remote_v" ]; then
    ok "已是最新版本"
    return 0
  fi

  _upgrade_workdir=$(mktemp -d) || die "创建临时目录失败"
  _upgrade_backup_done=0
  _upgrade_was_active=0
  is_active && _upgrade_was_active=1 || true
  trap '_on_upgrade_exit' EXIT

  local stage
  stage=$(download_release "$arch" "$_upgrade_workdir" "$remote_v") || exit 1

  info "停止 ${SERVICE_NAME}"
  systemctl stop "${SERVICE_NAME}" || true

  info "备份当前安装到 ${BACKUP_DIR}"
  rm -rf "$BACKUP_DIR"
  cp -a "$INSTALL_DIR" "$BACKUP_DIR"
  _upgrade_backup_done=1

  info "安装新版本"
  install_payload "$stage" "$remote_v"

  local port
  port=$(port_from_env_file)

  info "启动 ${SERVICE_NAME}"
  if ! systemctl start "${SERVICE_NAME}"; then
    die "升级后服务启动失败"
  fi
  if ! wait_http_ready "$port"; then
    die "升级后服务未能就绪"
  fi

  ok "升级完成：${local_v} -> ${remote_v}"
  _upgrade_backup_done=0
  trap - EXIT
  rm -rf "$_upgrade_workdir"
}

do_uninstall() {
  require_root
  require_systemd

  if ! is_installed && [ ! -f "$UNIT_FILE" ]; then
    warn "hina-server 未安装"
    return 0
  fi

  local ans
  prompt_tty "确认卸载 hina-server？[y/N]: " ans "n"
  case "${ans}" in y|Y|yes|YES) ;; *) info "已取消"; return 0 ;; esac

  info "停止并禁用服务"
  systemctl disable --now "${SERVICE_NAME}" 2>/dev/null || true

  info "删除 unit 文件"
  rm -f "$UNIT_FILE"
  systemctl daemon-reload

  info "删除 ${INSTALL_DIR}"
  rm -rf "$INSTALL_DIR" "$BACKUP_DIR"

  prompt_tty "删除数据目录 ${DATA_DIR}？（数据库将丢失）[y/N]: " ans "n"
  case "${ans}" in y|Y|yes|YES) rm -rf "$DATA_DIR"; ok "已删除 ${DATA_DIR}";; esac

  prompt_tty "删除配置目录 ${ETC_DIR}？[y/N]: " ans "n"
  case "${ans}" in y|Y|yes|YES) rm -rf "$ETC_DIR"; ok "已删除 ${ETC_DIR}";; esac

  prompt_tty "删除控制脚本 ${CTL_PATH}？[y/N]: " ans "n"
  case "${ans}" in y|Y|yes|YES) rm -f "$CTL_PATH"; ok "已删除 ${CTL_PATH}";; esac

  ok "卸载完成"
}

do_start() {
  require_root
  is_installed || die "hina-server 未安装"
  systemctl start "$SERVICE_NAME"
  ok "已启动"
}

do_stop() {
  require_root
  is_installed || die "hina-server 未安装"
  systemctl stop "$SERVICE_NAME"
  ok "已停止"
}

do_restart() {
  require_root
  is_installed || die "hina-server 未安装"
  systemctl restart "$SERVICE_NAME"
  ok "已重启"
}

do_status() {
  echo
  echo "版本   : $(local_version)"
  if is_installed; then
    echo "二进制 : ${INSTALL_DIR}/hina-server"
    echo "配置   : ${ENV_FILE}"
    echo "数据   : ${DATA_DIR}"
    echo
    systemctl status "$SERVICE_NAME" --no-pager || true
  else
    warn "hina-server 未安装"
  fi
}

do_logs() {
  is_installed || die "hina-server 未安装"
  journalctl -u "$SERVICE_NAME" -n 100 -f --no-pager
}

print_menu() {
  cat >&2 <<EOF

=================================
  hina-server 控制台
=================================
  状态  : $(status_brief)
  版本  : $(local_version)
---------------------------------
  1) 安装
  2) 升级
  3) 启动
  4) 停止
  5) 重启
  6) 查看状态
  7) 查看日志（Ctrl+C 退出）
  8) 卸载
  9) 退出
=================================
EOF
}

menu_loop() {
  while true; do
    print_menu
    local choice
    prompt_tty "请选择 [1-9]: " choice ""
    case "${choice}" in
      1) ( do_install   ) || true ;;
      2) ( do_upgrade   ) || true ;;
      3) ( do_start     ) || true ;;
      4) ( do_stop      ) || true ;;
      5) ( do_restart   ) || true ;;
      6) ( do_status    ) || true ;;
      7) ( do_logs      ) || true ;;
      8) ( do_uninstall ) || true ;;
      9|q|Q|quit|exit) exit 0 ;;
      "") ;;
      *) warn "无效选项：${choice}" ;;
    esac
  done
}

usage() {
  cat <<EOF
hina-server 控制脚本

用法：
  hina-ctl                 打开交互菜单
  hina-ctl install         安装最新版本
  hina-ctl upgrade         升级到最新版本
  hina-ctl uninstall       卸载服务
  hina-ctl start           启动服务
  hina-ctl stop            停止服务
  hina-ctl restart         重启服务
  hina-ctl status          查看服务状态和版本
  hina-ctl logs            跟踪服务日志（Ctrl+C 退出）

一键安装：
  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | sudo bash
EOF
}

main() {
  case "${1:-}" in
    install)        do_install   ;;
    upgrade)        do_upgrade   ;;
    uninstall)      do_uninstall ;;
    start)          do_start     ;;
    stop)           do_stop      ;;
    restart)        do_restart   ;;
    status)         do_status    ;;
    logs)           do_logs      ;;
    -h|--help|help) usage        ;;
    "")             menu_loop    ;;
    *) err "未知命令：$1"; usage; exit 1 ;;
  esac
}

main "$@"
