#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${TFG_REPO_URL:-https://github.com/danielvidal/token-free-gateway.git}"
BRANCH="${TFG_BRANCH:-main}"
APP_USER="${TFG_USER:-${SUDO_USER:-${USER:-dev}}}"
SRC_DIR="${TFG_SRC_DIR:-/srv/token-free-gateway}"
INSTALL_DIR="${TFG_INSTALL_DIR:-/opt/token-free-gateway}"
GATEWAY_PORT="${TFG_PORT:-3456}"
CDP_PORT="${TFG_CDP_PORT:-9222}"
GATEWAY_SERVICE="token-free-gateway.service"
CHROME_SERVICE="token-free-chrome.service"

log() { printf '[setup-vpc] %s\n' "$*"; }
die() { printf '[setup-vpc] ERROR: %s\n' "$*" >&2; exit 1; }

if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  SUDO=""
else
  command -v sudo >/dev/null 2>&1 || die "sudo is required"
  SUDO="sudo"
fi

id "$APP_USER" >/dev/null 2>&1 || die "user '$APP_USER' does not exist; set TFG_USER if needed"
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
[[ -n "$APP_HOME" ]] || die "could not resolve home directory for $APP_USER"

run_as_app() {
  if [[ "$(id -un)" == "$APP_USER" ]]; then
    "$@"
  else
    $SUDO -H -u "$APP_USER" "$@"
  fi
}

apt_install() {
  command -v apt-get >/dev/null 2>&1 || die "this installer currently supports Debian/Ubuntu (apt-get)"
  log "installing OS dependencies"
  $SUDO apt-get update -y
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates curl git lsof procps xvfb xauth
}

install_native_chrome() {
  local arch
  arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"

  if command -v google-chrome-stable >/dev/null 2>&1 || [[ -x /opt/google/chrome/google-chrome ]]; then
    log "native Google Chrome already installed"
    $SUDO apt-get update -y >/dev/null 2>&1 || true
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade google-chrome-stable >/dev/null 2>&1 || true
    return
  fi

  case "$arch" in
    amd64|x86_64)
      log "installing native Google Chrome .deb"
      local deb
      deb="$(mktemp --suffix=.deb)"
      trap 'rm -f "${deb:-}"' RETURN
      curl -fsSL \
        https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
        -o "$deb"
      $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y "$deb"
      rm -f "$deb"
      trap - RETURN
      ;;
    *)
      die "native Google Chrome installer currently supports amd64 only (detected: $arch). Set up a native Chrome/Chromium binary and rerun."
      ;;
  esac
}

find_chrome() {
  local candidates=(
    /usr/bin/google-chrome-stable
    /usr/bin/google-chrome
    /opt/google/chrome/google-chrome
  )
  local p
  for p in "${candidates[@]}"; do
    if [[ -x "$p" ]]; then
      printf '%s\n' "$p"
      return 0
    fi
  done
  return 1
}

install_bun() {
  if run_as_app bash -lc 'command -v bun >/dev/null 2>&1'; then
    log "Bun already installed"
    return
  fi

  log "installing Bun for $APP_USER"
  run_as_app bash -lc 'curl -fsSL https://bun.sh/install | bash'
  run_as_app bash -lc 'command -v bun >/dev/null 2>&1 || "$HOME/.bun/bin/bun" --version >/dev/null'
}

sync_repo() {
  log "syncing repository: $REPO_URL ($BRANCH)"
  $SUDO mkdir -p "$(dirname "$SRC_DIR")"
  $SUDO chown "$APP_USER:$APP_USER" "$(dirname "$SRC_DIR")"

  if [[ -d "$SRC_DIR/.git" ]]; then
    run_as_app git -C "$SRC_DIR" remote set-url origin "$REPO_URL"
    run_as_app git -C "$SRC_DIR" fetch --prune origin
    run_as_app git -C "$SRC_DIR" checkout "$BRANCH"
    run_as_app git -C "$SRC_DIR" reset --hard "origin/$BRANCH"
  elif [[ -e "$SRC_DIR" ]]; then
    die "$SRC_DIR exists but is not a git repository"
  else
    run_as_app git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$SRC_DIR"
  fi
}

cleanup_existing() {
  log "stopping services and cleaning legacy processes"
  if [[ -f "$SRC_DIR/scripts/stop-vpc.sh" ]]; then
    TFG_PORT="$GATEWAY_PORT" TFG_CDP_PORT="$CDP_PORT" bash "$SRC_DIR/scripts/stop-vpc.sh" || true
  else
    $SUDO systemctl stop "$GATEWAY_SERVICE" "$CHROME_SERVICE" 2>/dev/null || true
    pkill -TERM -f 'token-free-gateway' 2>/dev/null || true
    pkill -TERM -f "remote-debugging-port=$CDP_PORT" 2>/dev/null || true
  fi
}

build_gateway() {
  log "installing JS dependencies and building standalone binary"
  run_as_app bash -lc "cd '$SRC_DIR' && export PATH=\"\$HOME/.bun/bin:\$PATH\" && bun install --frozen-lockfile && bun run typecheck && bun test && bun run build"

  $SUDO install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$INSTALL_DIR"
  $SUDO install -o "$APP_USER" -g "$APP_USER" -m 0755 \
    "$SRC_DIR/token-free-gateway" "$INSTALL_DIR/token-free-gateway"
}

write_services() {
  local chrome_bin="$1"
  local chrome_profile="$APP_HOME/.config/chrome-tfg-debug"

  command -v xvfb-run >/dev/null 2>&1 || die "xvfb-run not found after installing xvfb"

  log "writing systemd services"
  $SUDO install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$chrome_profile"
  $SUDO install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$APP_HOME/.token-free-gateway"

  $SUDO tee "/etc/systemd/system/$CHROME_SERVICE" >/dev/null <<EOF
[Unit]
Description=Token-Free Gateway Chrome on virtual X display
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
Environment=HOME=$APP_HOME
ExecStart=/usr/bin/xvfb-run -a -s "-screen 0 1280x960x24 -nolisten tcp" $chrome_bin --remote-debugging-address=127.0.0.1 --remote-debugging-port=$CDP_PORT --user-data-dir=$chrome_profile --window-size=1280,960 --no-first-run --no-default-browser-check --disable-background-networking --disable-sync --disable-translate --disable-features=TranslateUI --disable-dev-shm-usage --remote-allow-origins=* about:blank
Restart=always
RestartSec=2
TimeoutStopSec=10
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF

  $SUDO tee "/etc/systemd/system/$GATEWAY_SERVICE" >/dev/null <<EOF
[Unit]
Description=Token-Free Gateway
After=network-online.target $CHROME_SERVICE
Wants=network-online.target
Requires=$CHROME_SERVICE

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
Environment=HOME=$APP_HOME
Environment=TFG_HOST=127.0.0.1
Environment=TFG_PORT=$GATEWAY_PORT
Environment=TFG_CDP_URL=http://127.0.0.1:$CDP_PORT
Environment=TFG_REQUEST_TIMEOUT_SEC=300
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/token-free-gateway serve
Restart=always
RestartSec=2
TimeoutStopSec=15
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF

  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "$CHROME_SERVICE" "$GATEWAY_SERVICE" >/dev/null
}

start_and_verify() {
  log "restarting services"
  $SUDO systemctl restart "$CHROME_SERVICE"

  local ready=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ $ready -ne 1 ]]; then
    $SUDO systemctl --no-pager --full status "$CHROME_SERVICE" || true
    printf '\n[setup-vpc] recent Chrome/Xvfb logs:\n' >&2
    $SUDO journalctl -u "$CHROME_SERVICE" -n 80 --no-pager || true
    die "Chrome on Xvfb did not become ready on 127.0.0.1:$CDP_PORT"
  fi

  $SUDO systemctl restart "$GATEWAY_SERVICE"

  ready=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$GATEWAY_PORT/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ $ready -ne 1 ]]; then
    $SUDO systemctl --no-pager --full status "$GATEWAY_SERVICE" || true
    printf '\n[setup-vpc] recent gateway logs:\n' >&2
    $SUDO journalctl -u "$GATEWAY_SERVICE" -n 80 --no-pager || true
    die "gateway did not become ready on 127.0.0.1:$GATEWAY_PORT"
  fi

  log "health:"
  curl -fsS "http://127.0.0.1:$GATEWAY_PORT/health" || true
  printf '\n'
  log "models:"
  curl -fsS "http://127.0.0.1:$GATEWAY_PORT/v1/models" || true
  printf '\n'
}

main() {
  apt_install
  install_native_chrome
  install_bun
  sync_repo
  cleanup_existing
  build_gateway

  local chrome_bin
  chrome_bin="$(find_chrome)" || die "native Google Chrome executable not found after installation"
  log "using browser: $chrome_bin (Xvfb, non-headless)"

  write_services "$chrome_bin"
  start_and_verify

  log "installation complete"
  log "gateway: http://127.0.0.1:$GATEWAY_PORT/v1"
  log "logs: sudo journalctl -u $GATEWAY_SERVICE -f"
  log "chrome/xvfb logs: sudo journalctl -u $CHROME_SERVICE -f"
  log "stop everything: bash $SRC_DIR/scripts/stop-vpc.sh"
}

main "$@"
