#!/usr/bin/env bash
# Installs the single-executable exporter as a launchd agent of this user (docs/NATIVE.md).
#   bash packaging/install-macos.sh ./ecoflow-exporter-darwin-arm64
# Data, .env and logs live in ~/Library/Application Support/ecoflow-exporter. Uninstall: --uninstall.
set -euo pipefail
label=io.github.ecoflow-dashboard.exporter
data="$HOME/Library/Application Support/ecoflow-exporter"
bin="$data/ecoflow-exporter"
plist="$HOME/Library/LaunchAgents/$label.plist"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$plist" "$bin"
  echo "Removed the agent and the binary. Your data is still in $data (delete it yourself)."
  exit 0
fi

src="${1:?usage: install-macos.sh <path to ecoflow-exporter binary> | --uninstall}"
mkdir -p "$data" "$(dirname "$plist")"
chmod 700 "$data"
install -m 755 "$src" "$bin"
# Downloaded files are quarantined; the binary is only ad-hoc signed (no Developer ID yet).
xattr -d com.apple.quarantine "$bin" 2>/dev/null || true
"$bin" --self-check
[ -f "$data/.env" ] || printf '# See .env.example in the repository. The status page is http://127.0.0.1:9101/\n' > "$data/.env"
chmod 600 "$data/.env"
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$bin</string></array>
  <key>WorkingDirectory</key><string>$data</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$data/exporter.log</string>
  <key>StandardErrorPath</key><string>$data/exporter.log</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Running. Status page: http://127.0.0.1:9101/  Log: $data/exporter.log"
echo "A sleeping Mac stops the exporter too: see docs/NATIVE.md (sleep)."
