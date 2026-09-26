# Changelog

## 0.1.0

First public release.

- CLI (`maccabi`) and an MCP server for reading your own Maccabi Healthcare records. Unofficial, and read-only: no booking, prescription renewal, payments, or profile changes.
- SMS login in a terminal. The session file is a credential. A finished login starts a one-hour keep-alive that holds off the idle timeout. It does not extend the absolute cap, about an hour from login, so a new SMS is required after that.
- Laboratory results, prescriptions, visits, referrals, correspondence, billing, certificates, and imaging-study metadata. Original PDFs where the portal serves them. Imaging preview and pixel files are CLI-only, and only 8-bit ultrasound has been checked live.
- MCP over stdio uses the CLI session. `maccabi mcp --http` is loopback Streamable HTTP with browser sign-in and separate session files. A CLI login does not carry over.
