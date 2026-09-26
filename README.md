# Maccabi Health

[![npm](https://img.shields.io/npm/v/maccabi-health.svg)](https://www.npmjs.com/package/maccabi-health)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/orenyomtov/maccabi-health/blob/main/LICENSE)

Read your own records from Maccabi Healthcare Services, the Israeli health fund, through a CLI or an AI assistant: laboratory history, doctor correspondence, visits, prescriptions, referrals, and supported original PDFs.

Unofficial and unaffiliated with Maccabi. Read-oriented: no booking, prescription renewal, request submission, payments, or profile changes. You need [Node.js 22 or later](https://nodejs.org/en/download), a Maccabi member account, and a phone that receives the SMS code. Output stays in the original Hebrew.

## Install and sign in

```sh
npm install -g maccabi-health
maccabi login
maccabi labs --limit 10 --json
```

Or, without a global install:

```sh
npx --yes --package maccabi-health maccabi login
npx --yes --package maccabi-health maccabi labs --limit 10 --json
```

`maccabi login` asks for your ID and the SMS code in the terminal, so neither enters a model's context. The session file is `session.json` in `~/.config/maccabi-mcp` (on Windows, `%APPDATA%\maccabi-mcp`), mode 0600. Anyone who can read it can read your records until it expires. The stdio MCP server uses that same file. `maccabi mcp --http` does not: sign-in happens in the browser and is stored separately. Details in [AUTH.md](https://github.com/orenyomtov/maccabi-health/blob/main/docs/AUTH.md).

If `maccabi` is not on your PATH after a global install, use the absolute path to the bin or stick with `npx`.

## Sessions expire

Maccabi ends an idle session well under an hour, and ends every session about an hour after login, activity or not. A finished `maccabi login` starts a background keep-alive for that hour (a renewal every 240 seconds) and then returns, so later commands keep working until the hour is up. `maccabi login --no-keep-alive` skips it. `maccabi logout` stops it. The background process cannot extend the hour. Measurements are in [SESSION-LIFETIME.md](https://github.com/orenyomtov/maccabi-health/blob/main/docs/research/SESSION-LIFETIME.md).

## Privacy

Every record you read here is real medical data. Anything you hand to an assistant becomes part of that model's context and goes wherever that model runs.

## Agent with a shell

```text
Use the `maccabi` CLI to read my Maccabi records. Run `maccabi` for the command index and
`maccabi help COMMAND --json` for one command's exact arguments. Every command except `mcp` takes --json.
```

The CLI is usually the better surface there: no tool-cap fights, and JSON out of a pipe is something an agent can already filter and loop over.

## MCP

```json
{
  "mcpServers": {
    "maccabi": {
      "command": "npx",
      "args": ["-y", "maccabi-health", "mcp"]
    }
  }
}
```

If you installed globally, `"command": "maccabi"` with `"args": ["mcp"]` does the same thing. Run `maccabi login` in a terminal first. Starting the server does not sign you in.

<details>
<summary>Claude Code</summary>

Run `maccabi login` in a terminal first. Starting the server does not sign you in.

```sh
claude mcp add maccabi --scope user -- npx -y maccabi-health mcp
```

The `--` separates Claude Code's own flags from the server command, and it is required here because `npx -y` has a flag of its own. `--scope user` makes the server available in every project without writing anything into a repository; drop it for the current project only. Do not use `--scope project`, which writes `.mcp.json` into the repo.
</details>

<details>
<summary>Claude Desktop</summary>

Run `maccabi login` in a terminal first. Starting the server does not sign you in.

Settings → Developer → Edit Config, then paste the standard config above into:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Quit Claude Desktop completely (Cmd+Q, or from the tray on Windows) and reopen it. Closing the window is not enough.

If the server does not show up, it is almost always `spawn npx ENOENT`: GUI apps do not read your shell profile, so nvm, fnm, mise and Homebrew paths are missing and bare `npx` is not on the path. Run `which npx` and use that absolute path as `"command"`. Logs are at `~/Library/Logs/Claude/mcp-server-maccabi.log` on macOS and `%APPDATA%\Claude\logs\` on Windows.
</details>

<details>
<summary>Cursor</summary>

Run `maccabi login` in a terminal first. Starting the server does not sign you in.

Create `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (this project):

```json
{
  "mcpServers": {
    "maccabi": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "maccabi-health", "mcp"]
    }
  }
}
```

Cursor caps the agent at roughly 40 tools across every enabled server, and this one exposes 38. It fits on its own, but only just: enable anything else alongside it and Cursor may quietly drop tools, with no error. Enable it alone, or use the CLI instead. Cursor's agent has a shell.
</details>

<details>
<summary>VS Code / Copilot</summary>

Run `maccabi login` in a terminal first. Starting the server does not sign you in.

Command Palette → `MCP: Open User Configuration`, or `.vscode/mcp.json` for one workspace. VS Code uses `servers`, not `mcpServers`:

```json
{
  "servers": {
    "maccabi": {
      "command": "npx",
      "args": ["-y", "maccabi-health", "mcp"]
    }
  }
}
```
</details>

<details>
<summary>Codex CLI</summary>

Run `maccabi login` in a terminal first. Starting the server does not sign you in.

```toml
# ~/.codex/config.toml
[mcp_servers.maccabi]
command = "npx"
args = ["-y", "maccabi-health", "mcp"]
```
</details>

<details>
<summary>Windows</summary>

Run `maccabi login` in a terminal first. Starting the server does not sign you in.

Some clients cannot spawn `npx` directly on Windows, because it is a `.cmd` shim rather than an executable. Wrap it:

```json
{
  "mcpServers": {
    "maccabi": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "maccabi-health", "mcp"]
    }
  }
}
```
</details>

`maccabi mcp --http` serves loopback Streamable HTTP with OAuth; see [MCP.md](https://github.com/orenyomtov/maccabi-health/blob/main/docs/MCP.md). HTTP does not read the CLI session.

## Library

ESM-only: `package.json` declares `import` and no `require`.

```js
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MaccabiReaders, MaccabiTransport, safeClinical } from "maccabi-health";

const directory = process.env.MACCABI_CONFIG_DIR ?? join(homedir(), ".config", "maccabi-mcp");
const path = join(directory, "session.json");
const { session, owner } = JSON.parse(await readFile(path, "utf8"));

const readers = await MaccabiReaders.create(new MaccabiTransport({ session }), owner);
const result = await readers.listTests();
console.log(safeClinical(result.data));
```

Readers hand back the upstream record as it arrived. Apply `safeClinical` yourself before you log, store or forward a result; the CLI and MCP already do.

## Capabilities

| Read | Examples |
| --- | --- |
| Test results | Values, dates, units, ranges, historical comparisons and PDFs |
| Medication | Prescriptions, dispensing records and eligible PDFs |
| Medical records | Visit notes, vaccinations, referrals and summaries |
| Correspondence | Supported doctor inquiries, replies and documents |
| Billing | Quarterly reports and report PDFs |
| Imaging | Study list, series, and per-image metadata. Preview JPEGs and raw pixel files are CLI-only; only 8-bit ultrasound has been checked live |
| Other reads | Certificates, notifications, settings, and public provider search (often blocked by a bot challenge) |

See the [full capability reference](https://github.com/orenyomtov/maccabi-health/blob/main/docs/CAPABILITIES.md).

## Sign out

```sh
maccabi logout --all
```

## Something not working?

[Open an issue](https://github.com/orenyomtov/maccabi-health/issues). Never paste medical records, ID numbers, cookies or session files. Security problems go through [SECURITY.md](https://github.com/orenyomtov/maccabi-health/blob/main/SECURITY.md).

[All docs](https://github.com/orenyomtov/maccabi-health/tree/main/docs) · [Authentication](https://github.com/orenyomtov/maccabi-health/blob/main/docs/AUTH.md) · [CLI guide](https://github.com/orenyomtov/maccabi-health/blob/main/docs/CLI.md) · [MCP transports](https://github.com/orenyomtov/maccabi-health/blob/main/docs/MCP.md) · [Changelog](https://github.com/orenyomtov/maccabi-health/blob/main/CHANGELOG.md) · [API sources](https://github.com/orenyomtov/maccabi-health/blob/main/docs/API-SOURCES.md) · [Contributing](https://github.com/orenyomtov/maccabi-health/blob/main/CONTRIBUTING.md) · [MIT license](https://github.com/orenyomtov/maccabi-health/blob/main/LICENSE)
