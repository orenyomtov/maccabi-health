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

Use the CLI when you can run shell commands and reach the internet. Each read is a short command you can script and take as JSON. Use the MCP server only when you cannot run shell commands.

## CLI

Install once: `npm install -g maccabi-health`. Then every command is `maccabi ...`. If `maccabi` is not found, prefix the same arguments with `npx --yes --package maccabi-health maccabi`.

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

`maccabi` lists every command. `maccabi help COMMAND --json` is one command's flags and which ids to copy from an earlier result. Do not load `maccabi help` with no command unless the index is not enough. Add `--json --no-input` to every command except `mcp`. Failure leaves stdout empty and prints `{"error":{"code","message","exitCode"}}` on stderr. Exit 3 means sign in again. Exit 2 means the flags are wrong.

Copy ids from JSON you already hold. Do not invent them or pair an id from one row with an id from another. `--limit` and `--offset` slice a fetched response. They do not ask for older pages. Check the session first with `maccabi status --verify --json --no-input`.

You can read labs and one test's past values, prescriptions, visits, referrals, doctor correspondence, vaccinations, certificates, billing summaries, imaging-study metadata, and the original PDFs the portal serves. Keep the original Hebrew unless the user asks for a translation. Summarize only what came back.

Recent blood tests: `maccabi latest-labs --json --no-input`, then `maccabi help lab-comparison --json` and call it with a `test_id` from that result. `maccabi labs --limit 10 --json --no-input` is the longer list. PDF commands take `--out` and write a file. Do not fetch document URLs yourself.

## MCP

Same questions: תעודת זהות, then the code. `maccabi_login_start` sends the text. `maccabi_login_verify` finishes it. One try per code.

If those tools are missing, install the server yourself with `npx`, not a global install. If you cannot, ask the user to, and give them the command for their app.

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

Call `maccabi_capabilities` first. A list row carries a `ref`. `maccabi_detail` reads it, `maccabi_document` returns its PDF, and `next` already has the following arguments. Follow `next`. Do not combine a `ref` from one row with an id from another.

## Privacy

These are real medical records. Do not commit them, put them in an issue or pull request, or read the session file into the chat. That includes the תעודת זהות, the SMS code, and the session file.

## When something is wrong

Troubleshoot a failed command, a missing record, or a feature that does not work. Then open an issue with the command, the error code, and what you expected: https://github.com/orenyomtov/maccabi-health/issues

A fix and a pull request is better than an issue alone.
