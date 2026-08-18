#!/usr/bin/env bash
set -Eeuo pipefail

GATEWAY_SERVICE="token-free-gateway.service"
CHROME_SERVICE="token-free-chrome.service"
GATEWAY_PORT="${TFG_PORT:-3456}"
CDP_PORT="${TFG_CDP_PORT:-9222}"

log() { printf '[stop-vpc] %s\n' "$*"; }

need_sudo() {
  if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
    printf ''
  else
    printf 'sudo'
  fi
}

SUDO="$(need_sudo)"

stop_service_if_present() {
  local unit="$1"
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "$unit" >/dev/null 2>&1; then
    log "stopping $unit"
    $SUDO systemctl stop "$unit" || true
  fi
}

kill_matching() {
  local pattern="$1"
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    log "terminating processes matching: $pattern"
    pkill -TERM -f "$pattern" || true
    sleep 2
  fi
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    log "force killing processes matching: $pattern"
    pkill -KILL -f "$pattern" || true
  fi
}

kill_port_owner() {
  local port="$1"
  local pids=""

  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u | tr '\n' ' ' || true)"
  elif command -v ss >/dev/null 2>&1; then
    pids="$(ss -ltnp "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u | tr '\n' ' ' || true)"
  fi

  if [[ -n "${pids// /}" ]]; then
    log "killing listeners on port $port: $pids"
    for pid in $pids; do
      kill -TERM "$pid" 2>/dev/null || $SUDO kill -TERM "$pid" 2>/dev/null || true
    done
    sleep 2
    for pid in $pids; do
      if kill -0 "$pid" 2>/dev/null || $SUDO kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null || $SUDO kill -KILL "$pid" 2>/dev/null || true
      fi
    done
  fi
}

stop_service_if_present "$GATEWAY_SERVICE"
stop_service_if_present "$CHROME_SERVICE"

# Kill standalone/legacy gateway processes.
kill_matching '(^|/| )token-free-gateway( |$)'
kill_matching 'bun .*token-free-gateway'

# Kill only browser processes that belong to this gateway/debug profile.
kill_matching 'chrome.*remote-debugging-port=9222'
kill_matching 'chromium.*remote-debugging-port=9222'
kill_matching 'chrome-tfg-debug'

# Last-resort cleanup in case command lines changed but ports are still occupied.
kill_port_owner "$GATEWAY_PORT"
kill_port_owner "$CDP_PORT"

log "verifying ports"
failed=0
for port in "$GATEWAY_PORT" "$CDP_PORT"; do
  if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN; then
    log "WARNING: port $port is still listening"
    failed=1
  elif command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    log "WARNING: port $port is still listening"
    failed=1
  else
    log "port $port is free"
  fi
done

if [[ $failed -ne 0 ]]; then
  log "cleanup completed with listeners still present"
  exit 1
fi

log "token-free-gateway and headless Chrome are fully stopped"
