#!/usr/bin/env bash
# go_dev.sh — bring up the whole PowderMonkey desktop setup with one command.
#
# PowderMonkey on the desktop is two pieces: the SUPERVISOR (the backend — API, PGlite,
# tmux, reconcile, PR-watch, on http://localhost:PORT) and the DESKTOP APP (a Tauri
# window that is just the front-end talking to the supervisor). Both must be up to "use
# PowderMonkey on the desktop", so this script guarantees both.
#
# Usage:
#   ./go_dev.sh                  # dev: ensure everything's up, then open the Tauri window live
#   ./go_dev.sh --build          # build the installable PowderMonkey.app instead, reveal it
#   ./go_dev.sh --install-agent  # macOS: start the supervisor on every login (survives reboots)
#   ./go_dev.sh --uninstall-agent# remove that LaunchAgent
#
# Ctrl-C closes the app; the supervisor keeps running in tmux behind it (reattach with
# `bun run attach`). Override the port with PORT=xxxx ./go_dev.sh (default 4500).
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-4500}"
PM_URL="${PM_URL:-http://localhost:${PORT}}"
MODE="${1:-dev}"

AGENT_LABEL="com.powdermonkey.supervisor"
AGENT_PLIST="${HOME}/Library/LaunchAgents/${AGENT_LABEL}.plist"

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

# Poll /health until the supervisor answers (or give up after ~30s).
wait_for_health() {
  say "Waiting for the supervisor to answer /health…"
  for i in $(seq 1 30); do
    if curl -fsS "${PM_URL}/health" >/dev/null 2>&1; then
      echo "  healthy."
      return 0
    fi
    if [ "${i}" -eq 30 ]; then
      echo "  supervisor did not become healthy after 30s — inspect it with: bun run attach" >&2
      return 1
    fi
    sleep 1
  done
}

# Install a macOS LaunchAgent that runs `serve` at every login. `serve` launches the tmux
# serve-loop and returns, so the loop (not launchd) owns the process — which keeps `bun run
# attach` working exactly as before. RunAtLoad (not KeepAlive) is what "survives reboots"
# needs: at each login the agent re-establishes the supervisor if it isn't already up.
install_agent() {
  [ "$(uname)" = "Darwin" ] || { echo "The LaunchAgent is macOS-only (this is $(uname))." >&2; exit 1; }
  local bun_bin proj bun_dir tmux_dir domain
  bun_bin="$(command -v bun)" || { echo "bun not found on PATH." >&2; exit 1; }
  proj="$(pwd -P)"
  bun_dir="$(dirname "${bun_bin}")"
  tmux_dir="$(dirname "$(command -v tmux || echo /opt/homebrew/bin/tmux)")"
  mkdir -p "${HOME}/Library/LaunchAgents" "${proj}/data"

  say "Writing LaunchAgent → ${AGENT_PLIST}"
  cat > "${AGENT_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bun_bin}</string>
    <string>run</string>
    <string>bin/powdermonkey.ts</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>${proj}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${bun_dir}:${tmux_dir}:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PORT</key><string>${PORT}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${proj}/data/supervisor-agent.log</string>
  <key>StandardErrorPath</key><string>${proj}/data/supervisor-agent.log</string>
</dict>
</plist>
PLIST

  domain="gui/$(id -u)"
  say "Loading it (launchctl bootstrap ${domain})…"
  launchctl bootout "${domain}/${AGENT_LABEL}" 2>/dev/null || true
  launchctl bootstrap "${domain}" "${AGENT_PLIST}"
  launchctl kickstart -k "${domain}/${AGENT_LABEL}" 2>/dev/null || true

  wait_for_health && say "Done — the supervisor now starts on every login and survives reboots."
  echo "  logs: ${proj}/data/supervisor-agent.log · undo: ./go_dev.sh --uninstall-agent"
}

uninstall_agent() {
  local domain
  domain="gui/$(id -u)"
  say "Removing the LaunchAgent…"
  launchctl bootout "${domain}/${AGENT_LABEL}" 2>/dev/null || true
  rm -f "${AGENT_PLIST}"
  echo "  Removed — the supervisor no longer auto-starts. A running one keeps running (stop via tmux)."
}

# ── Mode dispatch ────────────────────────────────────────────────────────────────
case "${MODE}" in
  --install-agent|install-agent) install_agent; exit 0 ;;
  --uninstall-agent|uninstall-agent) uninstall_agent; exit 0 ;;
esac

# ── 1. Dependencies ─────────────────────────────────────────────────────────────
say "Installing dependencies (bun install)…"
bun install

# ── 2. Supervisor up + healthy ──────────────────────────────────────────────────
# `serve` is idempotent: it launches the tmux serve-loop, or no-ops if it's already up.
say "Ensuring the supervisor is running on ${PM_URL}…"
PORT="${PORT}" bun run serve
wait_for_health

# ── 3. Desktop app ──────────────────────────────────────────────────────────────
# The app stores its server origin in Settings → Server (defaults to http://localhost:4500).
# On a non-default PORT, set it there once.
if [ "${MODE}" = "--build" ] || [ "${MODE}" = "build" ]; then
  say "Building the installable desktop app (Tauri release — compiles Rust, give it a few min)…"
  bun run desktop:build
  APP="src-tauri/target/release/bundle/macos/PowderMonkey.app"
  if [ -d "${APP}" ]; then
    say "Built ${APP}"
    echo "  Drag it into /Applications. First launch: right-click → Open (it's unsigned)."
    open -R "${APP}" 2>/dev/null || true
  else
    echo "  Build finished — look under src-tauri/target/release/bundle/ for your platform's artifact." >&2
  fi
  exit 0
fi

say "Launching the PowderMonkey desktop app (Tauri dev) → ${PM_URL}…"
echo "  In the app: Settings → Server should read ${PM_URL}."
echo "  Ctrl-C closes the app; the supervisor stays up (reattach: bun run attach)."
exec bun run desktop:dev
