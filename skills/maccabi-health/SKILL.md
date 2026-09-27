---
name: maccabi-health
description: Reads the user's own Maccabi Healthcare records (labs, visits, prescriptions, referrals, imaging, and documents). Use when the user mentions Maccabi, מכבי, maccabi4u, their Israeli health-fund records, blood tests, lab results, or asks an agent to look at those records. Asks the user for their תעודת זהות and the SMS code.
license: MIT
compatibility: Prefer a global maccabi CLI when commands can run and the internet is reachable. Otherwise use the MCP server via npx.
metadata:
  version: "0.1.0"
---

# Maccabi Health

Read the user's own Maccabi Healthcare records. Unofficial. Support read-only operations.

Use the CLI when you can run shell commands and reach the internet. Each read is a short command you can script and even get the output as JSON. Use the MCP server only when you cannot run shell commands.

## CLI

Install once: `npm install -g maccabi-health`. Then every command is `maccabi ...`. If `maccabi` is not found, run `npx -y maccabi-health` with the same arguments.

Ask for their תעודת זהות and put those digits in the command. `000000000` is a placeholder. Do not send it.

```sh
maccabi login --id 000000000 --json --no-input
```

`--id` and `--code` are separate commands. Never pass both at once. If several phones are registered, the command lists numbered choices and sends nothing. Ask which one, then repeat with `--phone N`.

Ask for the code from the text. `000000` is a placeholder. Do not send it.

```sh
maccabi login --code 000000 --json --no-input
```

One try per code. A wrong code ends that text. Do not submit it again. Ask if they want a new text and start over with `--id`. The code expires after ten minutes. A login lasts about an hour, then ask the same way again.

`maccabi` lists the commands. `maccabi help` is the full reference, about 6,000 tokens:

```text
maccabi help COMMAND   usage, flags, notes and caveats for one command (add --json)
maccabi help           every command in full (add --json for the discovery document)
```

Add `--json --no-input` on every command except `mcp`.

Take those ids from that result. Do not invent one, and do not mix an id from one row with an id from another. `--limit` only shortens the result you already fetched. Before the first read, `maccabi status --verify --json --no-input` checks the login. Exit 3 means sign in again.

You can read labs and one test's past values, prescriptions, visits, referrals, doctor correspondence, vaccinations, certificates, billing summaries, imaging-study metadata, and the original PDFs the portal serves. Keep the original Hebrew unless the user asks for a translation. Summarize only what came back.

Recent blood tests: `maccabi latest-labs --json --no-input`, then `maccabi help lab-comparison --json` and call it with a `test_id` from that result. `maccabi labs --limit 10 --json --no-input` is the longer list. PDF commands take `--out` and write a file. Do not fetch document URLs yourself.

## MCP

Same questions: תעודת זהות, then the code. `maccabi_login_start` sends the text. `maccabi_login_verify` finishes it. One try per code.

If the mcp is not yet installed, install it first. If you cannot, ask the user to, and give them the command for their app.

Claude Code needs the `--`. `--scope user` keeps it out of the project:

```sh
claude mcp add maccabi --scope user -- npx -y maccabi-health mcp
```

Codex:

```sh
codex mcp add maccabi -- npx -y maccabi-health mcp
```

Cursor has no install command. Merge this into `~/.cursor/mcp.json` without removing other servers:

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

A list row carries a `ref`. `maccabi_detail` reads it, `maccabi_document` returns its PDF, and `next` already has the following arguments. Follow `next`. Do not combine a `ref` from one row with an id from another.

## Privacy

These are real medical records. Handle them with the appropriate care.

## When something is wrong

Troubleshoot a failed command, a feature, or a feature that does not work. Then open an issue with the command, the error code, and what you expected: https://github.com/orenyomtov/maccabi-health/issues

Even better, if you can, fix the problem and submit a pull request to share the fix with everyone!
