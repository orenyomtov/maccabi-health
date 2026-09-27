# Changelog

## Unreleased

- `maccabi-health login --http` opens the browser sign-in form on a Cloudflare tunnel, returns immediately, and writes the normal CLI session file. `--no-tunnel` and `--no-background` turn those defaults off.

## 0.1.1

- The command is `maccabi-health`. The `maccabi` binary from 0.1.0 is not installed.
- CLI errors are always JSON on stderr. `version` prints one plain line.
- The local HTTP server renews each signed-in member's session, including sessions already on disk, and stops that member's renewal on logout.
- A stable GitHub release publishes the package and the official MCP registry listing.

## 0.1.0

First public release.

- CLI (`maccabi`) and an MCP server for reading your own Maccabi Healthcare records. Unofficial, and read-only: no booking, prescription renewal, payments, or profile changes.
- SMS login in a terminal. The session file is a credential. A finished login starts a one-hour keep-alive that holds off the idle timeout. It does not extend the absolute cap, about an hour from login, so a new SMS is required after that.
- Laboratory results, prescriptions, visits, referrals, correspondence, billing, certificates, and imaging-study metadata. Original PDFs where the portal serves them. Imaging preview and pixel files are CLI-only, and only 8-bit ultrasound has been checked live.
- MCP over stdio uses the CLI session. `maccabi mcp --http` is loopback Streamable HTTP with browser sign-in and separate session files. A CLI login does not carry over.
