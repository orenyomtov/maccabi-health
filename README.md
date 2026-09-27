# Maccabi Health

**Ask an AI assistant for a second look at your own lab results, doctor visits, and prescriptions.**

[![npm](https://img.shields.io/npm/v/maccabi-health.svg)](https://www.npmjs.com/package/maccabi-health)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/orenyomtov/maccabi-health/blob/main/LICENSE)

Read your own records from Maccabi Healthcare Services, the Israeli health fund, through a CLI or an AI assistant: laboratory history, doctor correspondence, visits, prescriptions, referrals, and supported original PDFs.

Unofficial and unaffiliated with Maccabi. You need your ID number (תעודת זהות) and access to the phone that receives the login code via SMS.

## Getting started

Copy this to your agent. Then you can ask it about your records, for example: "analyze my blood tests, and tell me if my cholesterol is a problem"

```text
Read the Maccabi Health skill which explains how you can access my medical records:
https://raw.githubusercontent.com/orenyomtov/maccabi-health/main/skills/maccabi-health/SKILL.md
```

Agents like Claude Code, Cowork, Codex, Cursor, Instinct, Muse, and ChatGPT Work can follow that.

Another option to get started is to run `npx skills add orenyomtov/maccabi-health` which installs that skill into Cursor, Claude Code, Codex and other local agents.

## Install and sign in

```sh
npm install -g maccabi-health
maccabi-health login
maccabi-health labs --limit 10
```

Or, without a global install:

```sh
npx -y maccabi-health login
npx -y maccabi-health labs --limit 10
```

`maccabi-health login` asks for your ID and the SMS code in the terminal.

If `maccabi-health` is not on your PATH after a global install, use the absolute path to the bin or stick with `npx`.

## Sessions expire

Maccabi ends every session an hour after login, activity or not. A finished `maccabi-health login` starts a background keep-alive for that hour (a renewal every 240 seconds) and then returns, so later commands keep working until the hour is up. `maccabi-health login --no-keep-alive` skips it. `maccabi-health logout` stops it. The background process cannot extend the hour. Measurements are in [SESSION-LIFETIME.md](https://github.com/orenyomtov/maccabi-health/blob/main/docs/research/SESSION-LIFETIME.md).

## Privacy

Every record you read here is real medical data. Anything you hand to an assistant becomes part of that model's context and goes wherever that model runs.

## Agent with a shell

```text
Use the `maccabi-health` CLI to read my Maccabi records. 
Install with `npm install -g maccabi-health`. 
Run `maccabi-health` for the command index, `maccabi-health help` for the full reference, and `maccabi-health help COMMAND --json` for one command's exact arguments.
```

The CLI is usually the better surface there: no tool-cap fights, and JSON out of a pipe is something an agent can already filter and loop over.

## MCP

```sh
claude mcp add maccabi-health -- npx -y maccabi-health mcp
codex mcp add maccabi-health -- npx -y maccabi-health mcp
gemini mcp add maccabi-health npx -y maccabi-health mcp
```

Cursor, in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "maccabi-health": {
      "command": "npx",
      "args": ["-y", "maccabi-health", "mcp"]
    }
  }
}
```

`maccabi-health mcp --http` serves loopback Streamable HTTP with OAuth; see [MCP.md](https://github.com/orenyomtov/maccabi-health/blob/main/docs/MCP.md).

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

## Something not working?

Fix the bug and send a pull request. That is better than only opening an issue: each account has different records, so the maintainer often cannot reproduce what you saw. See [Contributing](https://github.com/orenyomtov/maccabi-health/blob/main/CONTRIBUTING.md).

[Open an issue](https://github.com/orenyomtov/maccabi-health/issues) if you cannot fix it. Never paste medical records, ID numbers, cookies or session files. Security problems go through [SECURITY.md](https://github.com/orenyomtov/maccabi-health/blob/main/SECURITY.md).

[All docs](https://github.com/orenyomtov/maccabi-health/tree/main/docs) · [Authentication](https://github.com/orenyomtov/maccabi-health/blob/main/docs/AUTH.md) · [CLI guide](https://github.com/orenyomtov/maccabi-health/blob/main/docs/CLI.md) · [MCP transports](https://github.com/orenyomtov/maccabi-health/blob/main/docs/MCP.md) · [Changelog](https://github.com/orenyomtov/maccabi-health/blob/main/CHANGELOG.md) · [API sources](https://github.com/orenyomtov/maccabi-health/blob/main/docs/API-SOURCES.md) · [Contributing](https://github.com/orenyomtov/maccabi-health/blob/main/CONTRIBUTING.md) · [MIT license](https://github.com/orenyomtov/maccabi-health/blob/main/LICENSE)
