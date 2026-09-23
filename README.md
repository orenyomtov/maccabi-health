# Maccabi Health

[![npm](https://img.shields.io/npm/v/maccabi-health.svg)](https://www.npmjs.com/package/maccabi-health)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Read your Maccabi Healthcare records through a CLI or an AI assistant: laboratory history, doctor correspondence, visits, prescriptions, referrals, and supported original PDFs.

**Unofficial and unaffiliated with Maccabi.** Read-oriented: no booking, prescription renewal, request submission, payments, or profile changes.

## Install

Needs [Node.js 22.19 or later](https://nodejs.org/en/download).

```sh
npm install -g maccabi-health
maccabi login
```

Or without installing anything: `npx --yes --package maccabi-health maccabi login`, and the same for any command below.

Run `maccabi login` in your own terminal. It asks for your ID number and the SMS code as masked prompts and saves the session to `~/.config/maccabi-mcp/session.json` (mode 0600). That file is a credential: anyone who can read it can read your records. `maccabi login --id DIGITS` then `maccabi login --code DIGITS` signs in without a terminal, but puts both values in argv and shell history.

Then read something:

```sh
maccabi labs --limit 10 --json
```

Sessions are short-lived, on two separate clocks. Maccabi ends an idle session well under an hour, and ends every session about an hour after login, activity or not. Expect to sign in again. `maccabi keep-alive --interval 240 --duration 3600` holds off the first clock and cannot touch the second (both flags are required); [the session lifetime notes](https://github.com/orenyomtov/maccabi-health/blob/main/docs/research/SESSION-LIFETIME.md) have the measurements.

Every record you read here is real medical data, and anything you hand to an assistant (lab values, diagnoses, medication, doctor correspondence) becomes part of that model's context and goes wherever that model runs. Pick the client and model accordingly.

## If your agent can run shell commands

Skip the MCP setup and point it at the CLI:

```text
Use the `maccabi` CLI to read my Maccabi records. Run `maccabi` for the command index and
`maccabi help COMMAND --json` for one command's exact arguments. Every command takes --json.
```

```sh
maccabi labs --limit 10 --json
maccabi prescriptions --json | jq '.data | length'
maccabi referrals --json | jq '.data[] | {referral_date, displaying_name}'
```

This is usually the better surface for Claude Code, Codex, Cursor's agent and anything else with a bash tool. Bare `maccabi` prints a one-line-per-command index of about 5 KB; the MCP server's 42 tool schemas are about 35 KB before the agent does anything, and per-command help is smaller again (`maccabi help labs` is 1.4 KB). Beyond the size, JSON coming out of a pipe is something an agent can already filter, loop over and diff without learning a tool inventory.

The tradeoff: the CLI is a new process per command, so there is no persistent session state, discovery costs one extra round trip, and the agent needs permission to run a binary at all. Where none of that is available (Claude Desktop, hosted assistants, anything without a shell), the MCP server is the right surface, and the next section covers it.

## If your agent speaks MCP

One config works in almost every client:

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

If you installed globally, `"command": "maccabi"` with `"args": ["mcp"]` does the same thing and skips the `npx` lookup. Either way, run `maccabi login` in a terminal first. Starting the server does not sign you in.

<details>
<summary>Claude Code</summary>

```sh
claude mcp add maccabi --scope user -- npx -y maccabi-health mcp
```

The `--` separates Claude Code's own flags from the server command, and it is required here because `npx -y` has a flag of its own. `--scope user` makes the server available in every project without writing anything into a repository; drop it for the current project only. Do not use `--scope project`, which writes `.mcp.json` into the repo.
</details>

<details>
<summary>Claude Desktop</summary>

Settings → Developer → Edit Config, then paste the standard config above into:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Quit Claude Desktop completely (Cmd+Q, or from the tray on Windows) and reopen it. Closing the window is not enough.

If the server does not show up, it is almost always `spawn npx ENOENT`: GUI apps do not read your shell profile, so nvm, fnm, mise and Homebrew paths are missing and bare `npx` is not on the path. Run `which npx` and use that absolute path as `"command"`. Logs are at `~/Library/Logs/Claude/mcp-server-maccabi.log` on macOS and `%APPDATA%\Claude\logs\` on Windows.
</details>

<details>
<summary>Cursor</summary>

Create `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (this project) with the standard config plus `"type": "stdio"`.

Cursor caps the agent at roughly 40 tools across every enabled server, and this one exposes 42. Enable it on its own, expect Cursor to quietly drop some tools, or use the CLI instead. Cursor's agent has a shell.
</details>

<details>
<summary>VS Code / Copilot</summary>

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

```toml
# ~/.codex/config.toml
[mcp_servers.maccabi]
command = "npx"
args = ["-y", "maccabi-health", "mcp"]
```
</details>

<details>
<summary>Windows</summary>

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

Once it is connected, ask your assistant for cholesterol history with dates, units and ranges, for doctor notes and their replies, or for a referral and its available documents.

A list tool returns rows, and every row carries a `ref`. `maccabi_detail` reads the record behind one and `maccabi_document` returns its original PDF. Every result carries a `next` list naming the calls that follow it, arguments already filled in. `maccabi_capabilities` describes the whole surface in one call. [MCP transports](docs/MCP.md) covers stdio, the loopback HTTP endpoint and the tool surface in full.

`maccabi mcp` runs stdio; `maccabi mcp --http` serves `http://127.0.0.1:8765/mcp`. The HTTP endpoint needs an OAuth-capable MCP client and opens a browser window for the sign-in, so your ID number and SMS code never reach the model.

If you would rather not do any of this by hand, paste `Install maccabi-health and connect it to this agent by following https://github.com/orenyomtov/maccabi-health.` into your coding agent.

## Capabilities

| Read | Examples |
| --- | --- |
| Test results | Values, dates, units, ranges, historical comparisons and PDFs |
| Medication | Prescriptions, dispensing records and eligible PDFs |
| Medical records | Visit notes, vaccinations, referrals and summaries |
| Correspondence | Supported doctor inquiries, replies and documents |
| Billing | Quarterly reports and report PDFs |
| Other reads | Certificates, notifications, settings and public provider search |

See the [full capability reference](docs/CAPABILITIES.md) for commands and supported branches.

## Something not working?

If a read fails, a record is missing, the output looks wrong, or you want something this cannot do yet, [open an issue](https://github.com/orenyomtov/maccabi-health/issues). Say which command or MCP tool you used and quote the error code. The errors themselves tell you when a failure is this package's fault rather than yours.

Never paste medical records, ID numbers, cookies or session files into an issue. Security problems go through the private route in [SECURITY.md](SECURITY.md), not the issue tracker.

[Authentication](docs/AUTH.md) · [CLI guide](docs/CLI.md) · [MCP transports](docs/MCP.md) · [API sources](docs/API-SOURCES.md) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
