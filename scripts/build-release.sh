#!/usr/bin/env bash
set -euo pipefail

# Build distributable release artifacts for hina-server.
#
# Usage:
#   ./scripts/build-release.sh                         # build for current platform
#   ./scripts/build-release.sh linux-x64               # cross-compile target
#   ./scripts/build-release.sh linux-x64 linux-arm64   # multiple targets
#   ./scripts/build-release.sh --skip-deps linux-x64   # skip install & frontend build (CI)
#
# Supported targets: linux-x64, linux-arm64, darwin-x64, darwin-arm64,
#                    windows-x64, windows-arm64
# Requires: bun >= 1.1

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$REPO_ROOT/dist"

# Parse flags
SKIP_DEPS=false
if [ "${1:-}" = "--skip-deps" ]; then
  SKIP_DEPS=true
  shift
fi

# Determine targets
if [ $# -eq 0 ]; then
  TARGETS=("")  # empty string = current platform
else
  TARGETS=("$@")
fi

if [ "$SKIP_DEPS" = "false" ]; then
  echo "==> Installing dependencies"
  cd "$REPO_ROOT"
  bun install --frozen-lockfile

  echo "==> Building frontend"
  cd "$REPO_ROOT/apps/web"
  bun run build
fi

# Read version from root package.json
VERSION=$(cd "$REPO_ROOT" && node -p "require('./package.json').version")

echo "==> Preparing release artifacts (v$VERSION)"
rm -rf "$DIST_DIR"

for target in "${TARGETS[@]}"; do
  if [ -z "$target" ]; then
    label="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')"
    compile_args=()
  else
    label="$target"
    compile_args=(--target "bun-$target")
  fi

  is_windows=false
  binary_name="hina-server"
  if [[ "$label" == windows-* ]]; then
    is_windows=true
    binary_name="hina-server.exe"
  fi

  stage="$DIST_DIR/hina-server-$label"
  echo "==> Building binary for $label"

  mkdir -p "$stage"

  cd "$REPO_ROOT/apps/server"
  bun build src/index.ts --compile \
    ${compile_args[@]+"${compile_args[@]}"} \
    --define "__APP_VERSION__='$VERSION'" \
    --outfile "$stage/$binary_name"

  # Migrations (required at runtime for DB schema updates)
  cp -r "$REPO_ROOT/apps/server/drizzle" "$stage/drizzle"

  # Built frontend assets
  cp -r "$REPO_ROOT/apps/web/dist" "$stage/public"

  # Example config
  cat > "$stage/.env.example" << 'ENVEOF'
# Hina Server Configuration
PORT=3000
HINA_DB_PATH=data/hina.sqlite
# HINA_PUBLIC_BASE_URL=https://status.example.com
# HINA_WEB_DIST_PATH=./public
# HINA_MIGRATIONS_PATH=./drizzle
# HINA_GEO_DIR=./.cache/geo
ENVEOF

  # Startup wrapper
  if [ "$is_windows" = "true" ]; then
    cat > "$stage/start.bat" << 'BATEOF'
@echo off
cd /d "%~dp0"
if not defined HINA_WEB_DIST_PATH set "HINA_WEB_DIST_PATH=%~dp0public"
if not defined HINA_MIGRATIONS_PATH set "HINA_MIGRATIONS_PATH=%~dp0drizzle"
if not defined HINA_GEO_DIR set "HINA_GEO_DIR=%~dp0.cache\geo"
"%~dp0hina-server.exe" %*
BATEOF
  else
    cat > "$stage/start.sh" << 'SHEOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export HINA_WEB_DIST_PATH="${HINA_WEB_DIST_PATH:-$SCRIPT_DIR/public}"
export HINA_MIGRATIONS_PATH="${HINA_MIGRATIONS_PATH:-$SCRIPT_DIR/drizzle}"
export HINA_GEO_DIR="${HINA_GEO_DIR:-$SCRIPT_DIR/.cache/geo}"
exec "$SCRIPT_DIR/hina-server" "$@"
SHEOF
    chmod +x "$stage/start.sh"
  fi

  # Create archive
  if [ "$is_windows" = "true" ]; then
    echo "==> Packaging hina-server-$label.zip"
    (cd "$DIST_DIR" && zip -rq "hina-server-$label.zip" "hina-server-$label")
    echo "    -> $DIST_DIR/hina-server-$label.zip"
  else
    echo "==> Packaging hina-server-$label.tar.gz"
    tar -czf "$DIST_DIR/hina-server-$label.tar.gz" -C "$DIST_DIR" "hina-server-$label"
    echo "    -> $DIST_DIR/hina-server-$label.tar.gz"
  fi
done

echo "==> Done"
