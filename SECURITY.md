# Security

[Українська версія](SECURITY.uk.md)

This is a hobby, non-commercial project provided **as is, without warranty** (see [LICENSE](LICENSE)). Reports are welcome and handled on a best-effort basis.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private reporting instead: the repository's **Security** tab, **Report a vulnerability**. Include what is affected, how to reproduce it and what an attacker gains. Only the `main` branch and the latest release are supported.

## Security model of the exporter

| Concern | How it is handled |
| --- | --- |
| EcoFlow password | Sent only to EcoFlow's login API. Stored either in your `.env` or encrypted (AES-256-GCM) in `/data/credentials.json`; the key is held by your Supabase project, per exporter, and deleted when you revoke the exporter. See [README, "Where your credentials go"](README.md#where-your-credentials-go). |
| Supabase access | The exporter signs in as **you** through Supabase's OAuth 2.1 server (PKCE, loopback redirect): anon key plus your token, never `service_role`. Tokens live in `/data/oauth.json` (mode 0600). Revoke an exporter on the dashboard's **Exporters** page. |
| Local status page | Listens on (or, in Docker, is published on) `127.0.0.1` only; answers only to `localhost` / IP host names (DNS rebinding protection, `UI_ALLOWED_HOSTS` for more); the credentials form and sample buttons answer only through a loopback host name and, natively, only to a loopback peer address, so a forged `Host` header from the LAN does not get in. |
| Decoder packs and release list | Data only, never code; Ed25519 signatures checked against keys in `src/packs/verify.ts` (plus `DECODER_PUBLIC_KEYS`); the exporter never updates itself. |
| Shared data | Model census and samples are opt-in with a consent shown on the status page; serial numbers, account id and e-mail are masked before anything leaves the machine, and the upload is blocked if an identifier is still found. |
| Builds | GitHub Actions pinned by commit SHA, `contents: read` by default. Images and binaries carry a signed build provenance attestation (`gh attestation verify`). |
| Dependencies | Exact versions only, 7-day quarantine for new npm releases, install scripts allow-listed, images by digest (`make deps-check`). |

Known limits: while the exporter is **not** revoked, whoever copies the whole `/data` volume also has `oauth.json` and can fetch the key; malware on the same machine can read the process memory.
