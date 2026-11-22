# Running the exporter without Docker

**English** · [Українська](uk/NATIVE.md)

The exporter also comes as **one executable file** per OS and CPU, with a small installer that
runs it as a background service (issue #45, phase 1). It is the same code as the Docker image,
built with Node's [Single Executable Applications](https://nodejs.org/api/single-executable-applications.html):
a bundle of `src/`, the `.proto` and the status page, injected into a copy of the pinned Node
22 binary. Nothing else to install.

| File | For |
| --- | --- |
| `ecoflow-exporter-linux-x64`, `ecoflow-exporter-linux-arm64` | Linux PCs, Raspberry Pi (64-bit) |
| `ecoflow-exporter-darwin-arm64` | Macs with Apple silicon |
| `ecoflow-exporter-win-x64.exe` | Windows 10/11 |

They are attached to each GitHub release (`exporter-binaries.yml`), each with a `.sha256` file.
Check it before running: `shasum -a 256 -c ecoflow-exporter-<target>.sha256`.

## Install

The service runs as your user, keeps its data (`.env`, login token, encrypted EcoFlow
credentials, buffer) in its own folder, and serves the status page on
**http://127.0.0.1:9101/**, where you log in and enter the EcoFlow account (no `.env` editing
needed).

```bash
bash packaging/install-linux.sh ./ecoflow-exporter-linux-x64      # systemd user service
bash packaging/install-macos.sh ./ecoflow-exporter-darwin-arm64   # launchd agent
```

```powershell
powershell -ExecutionPolicy Bypass -File packaging\install-windows.ps1 .\ecoflow-exporter-win-x64.exe   # task at logon
```

| OS | Data and `.env` | Logs | Uninstall |
| --- | --- | --- | --- |
| Linux | `~/.local/share/ecoflow-exporter` | `journalctl --user -u ecoflow-exporter` | `install-linux.sh --uninstall` |
| macOS | `~/Library/Application Support/ecoflow-exporter` | `exporter.log` in that folder | `install-macos.sh --uninstall` |
| Windows | `%LOCALAPPDATA%\ecoflow-exporter` | Task Scheduler history | `install-windows.ps1 -Uninstall` |

Uninstalling keeps the data folder; delete it yourself to remove the token and credentials. Put
`SUPABASE_URL` and `SUPABASE_ANON_KEY` into the `.env` there (see `.env.example`).

On Linux, `sudo loginctl enable-linger $USER` keeps the service running when you are logged out.
On Windows the task starts at logon; a machine that should collect data without anyone logged in
is better served by Docker or Linux.

## Signing

The binaries are **not code-signed** yet: macOS gets an ad-hoc signature (the installer removes
the download quarantine), Windows SmartScreen may warn. Signing needs an Apple Developer ID
(yearly fee, plus notarisation) and a Windows certificate or signing service; that is a cost
decision for the project, open on #45. The `.sha256` files and the release on GitHub are what
you can check today.

## Sleep

The exporter can only record while the computer is awake. A sleeping laptop leaves gaps, as in
issue #14. Since EcoFlow's MQTT is a cloud service, the exporter does not have to be near the
station: any always-on machine works (mini PC, Raspberry Pi, NAS with Docker). On a laptop, keep
it on power and stop it from sleeping (macOS: `caffeinate -s` while on power, or the Battery
settings; Windows: Power settings). Holding a "no idle sleep" lock from the app itself is planned
with the tray app.

## Building it yourself

```bash
npm ci
npm run sea                                 # build/sea/ecoflow-exporter[.exe] for this OS/arch
build/sea/ecoflow-exporter --self-check     # proto and status page load from the binary
```

Build with the pinned Node 22 (the binary is a copy of the Node that runs the build).

## Next (phase 2)

A small tray app (Tauri) with status, "Open dashboard", autostart and the platform's signed
updater, supervising this service. Not started; it waits for the signing decision above.
