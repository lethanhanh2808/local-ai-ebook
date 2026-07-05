#!/usr/bin/env bash
# scripts/install-worker-launchd.sh
#
# Installs a macOS LaunchAgent that auto-starts the BullMQ conversion worker
# at login. The agent restarts the worker if it crashes (KeepAlive=true)
# and runs in the foreground auto-restart loop so it self-heals.
#
# Usage:
#   ./scripts/install-worker-launchd.sh          # install + load
#   ./scripts/install-worker-launchd.sh --uninstall  # unload + remove

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

LABEL="com.localai.ebook-worker"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$APP_DIR/data/worker-runtime"
LOG_FILE="$LOG_DIR/launchd.log"
mkdir -p "$LOG_DIR"

generate_plist() {
  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <!-- Auto-restart the worker if it dies (crash, OOM, etc.) -->
  <key>KeepAlive</key>
  <true/>

  <!-- Run at user login AND keep alive across system events -->
  <key>RunAtLoad</key>
  <true/>

  <!-- Only run when the user is logged in (no need for headless server) -->
  <key>LimitLoadToSessionType</key>
  <array>
    <string>Aqua</string>
    <string>StandardIO</string>
  </array>

  <!-- Working dir = project root so relative paths resolve -->
  <key>WorkingDirectory</key>
  <string>${APP_DIR}</string>

  <!-- Run the auto-restart loop (no args = infinite loop with 3s retry) -->
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${APP_DIR}/scripts/start-worker.sh</string>
  </array>

  <!-- stdout/stderr to a log file we can tail for debugging -->
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>

  <!-- Don't kill the worker on logout -->
  <key>ProcessType</key>
  <string>Interactive</string>

  <!-- Throttle restart attempts so we don't spin if there's a real bug -->
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
EOF
}

case "${1:-}" in
  --uninstall)
    echo "[uninstall] unloading ${LABEL}"
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "[uninstall] removed ${PLIST_PATH}"
    ;;
  ""|--install)
    echo "[install] generating plist at ${PLIST_PATH}"
    generate_plist
    # If already loaded, unload first so changes take effect
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    echo "[install] loading into launchd…"
    launchctl load "$PLIST_PATH"
    # Give launchd a moment to spawn the process
    sleep 2
    echo "[install] current status:"
    launchctl list "$LABEL" || true
    echo ""
    echo "[install] ✅ Done. The worker will:"
    echo "          • Start automatically when you log in"
    echo "          • Auto-restart if it crashes (3s delay, throttled to once per 10s)"
    echo "          • Log to: ${LOG_FILE}"
    echo "          • Stop with: launchctl unload ${PLIST_PATH}"
    echo "          • Or:           ./scripts/install-worker-launchd.sh --uninstall"
    ;;
  *)
    echo "usage: $0 [--install|--uninstall]"
    exit 1
    ;;
esac