#!/usr/bin/env bash
# Installs the single-executable exporter as a systemd *user* service (docs/NATIVE.md).
#   bash packaging/install-linux.sh ./ecoflow-exporter-linux-x64
# Data, .env and logs live in ~/.local/share/ecoflow-exporter. Uninstall: --uninstall.
set -euo pipefail
name=ecoflow-exporter
data="${XDG_DATA_HOME:-$HOME/.local/share}/$name"
bin="$HOME/.local/bin/$name"
unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$name.service"

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now "$name.service" 2>/dev/null || true
  rm -f "$unit" "$bin"
  systemctl --user daemon-reload
  echo "Removed the service and the binary. Your data is still in $data (delete it yourself)."
  exit 0
fi

src="${1:?usage: install-linux.sh <path to ecoflow-exporter binary> | --uninstall}"
"$src" --self-check
mkdir -p "$data" "$(dirname "$bin")" "$(dirname "$unit")"
chmod 700 "$data"
install -m 755 "$src" "$bin"
[ -f "$data/.env" ] || printf '# See .env.example in the repository. The status page is http://127.0.0.1:9101/\n' > "$data/.env"
chmod 600 "$data/.env"
cat > "$unit" <<UNIT
[Unit]
Description=EcoFlow dashboard exporter
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$data
ExecStart=$bin
Restart=always
RestartSec=10
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now "$name.service"
echo "Running. Status page: http://127.0.0.1:9101/  Logs: journalctl --user -u $name -f"
echo "To keep it running after you log out: sudo loginctl enable-linger $USER"
